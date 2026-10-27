import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  CACHE_ENV_VAR,
  datasetCachePaths,
  loadCorpus,
  loadManifest,
} from '@personavision/calibration';
import type { GroundTruthRecord } from '@personavision/calibration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personavision } from './cli-process.js';

/**
 * `personavision calibrate`, asserted by running the command.
 *
 * Every test here drives the real process: the argv a person types, the exit code the shell
 * sees and the bytes on the streams. Nothing calls `calibrateFetchCommand` and friends
 * directly, because what this ticket promises is a command surface and a function call
 * would assert past it.
 *
 * **Nothing reaches the network and no port is hard-coded.** The one test that fetches
 * points the command at a manifest whose download location is a loopback port that was
 * opened, read and closed — so the connection is refused on this machine and no packet
 * leaves it. **No secret is read or printed**: the dataset is open access, and the stub
 * manifest's URL carries a query string precisely so that the output can be asserted not to
 * contain it.
 *
 * **Nothing writes outside a temporary cache.** `--cache` points the dataset cache at a
 * directory this file removes, and `fit --write` writes to `--out` in that directory, never
 * to the engine's committed `config/calibrated.json` — which one test asserts is untouched.
 */

/** Scoring and fitting pay for sharp's warm-up in a fresh process; the suite runs beside others. */
const SLOW = 60_000;

/** The committed fit is 128 candidates; a test wants a search it can run several times. */
const FEW_CANDIDATES = 2;

let temp: string;

/** A cache root of its own per test, so two of them cannot see each other's dataset. */
const cacheDir = async (name: string): Promise<string> => {
  const dir = join(temp, name);
  await mkdir(dir, { recursive: true });
  return dir;
};

/** Where `--cache <dir>` puts this dataset, read from the package rather than restated. */
const datasetRoot = (cache: string): string =>
  datasetCachePaths(loadManifest().dataset.id, { env: { [CACHE_ENV_VAR]: cache } }).root;

/** Not a secret: a stand-in for one, so the output can be asserted not to carry it. */
const SECRET_IN_THE_URL = 'not-a-real-token';

/** A port nothing is listening on: opened so the operating system chooses it, then closed. */
const closedLoopbackPort = (): Promise<number> =>
  new Promise((found, failed) => {
    const server = createServer();
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        failed(new Error('the stub server was given no port'));
        return;
      }
      server.close(() => found(address.port));
    });
  });

/**
 * The committed manifest with its one file pointed at a closed loopback port.
 *
 * It goes through the same `parseManifest` the committed one does, so the URL is `https://`
 * and the checksum is recorded — what changes is only where the bytes would come from. The
 * query string is there to be asserted absent from the output.
 */
const stubManifest = async (): Promise<string> => {
  const port = await closedLoopbackPort();
  const manifest = JSON.parse(JSON.stringify(loadManifest())) as {
    files: { url: string; sizeBytes: number }[];
  };
  const file = manifest.files[0];
  if (file === undefined) throw new Error('the committed manifest lists no file');
  file.url = `https://127.0.0.1:${String(port)}/UEyes_dataset.zip?token=${SECRET_IN_THE_URL}`;
  file.sizeBytes = 64;
  const path = join(temp, 'stub-manifest.json');
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return path;
};

/**
 * A converted dataset in the cache, as `calibrate fetch` writes one: the ground truth in
 * `converted/corpus.json`, with its images beside it and its paths relative to it.
 *
 * The records are the committed corpus's, which is what makes this a test of the reading
 * and not of the arithmetic: the figures it produces are the ones the committed corpus
 * produces, measured through a different door.
 */
const writeConvertedDataset = async (
  cache: string,
  records: readonly GroundTruthRecord[],
): Promise<string> => {
  const convertedDir = join(datasetRoot(cache), 'converted');
  const imagesDir = join(convertedDir, 'images');
  await mkdir(imagesDir, { recursive: true });
  const written = await Promise.all(
    records.map(async (record) => {
      const image = join(imagesDir, `${record.id}.png`);
      await copyFile(record.imagePath, image);
      return { ...record, imagePath: relative(convertedDir, image) };
    }),
  );
  const path = join(convertedDir, 'corpus.json');
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        dataset: { id: 'ueyes', label: 'the converted UEyes dataset' },
        records: written,
      },
      null,
      2,
    )}\n`,
  );
  return path;
};

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'personavision-calibrate-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('personavision calibrate --help', () => {
  it('lists the three subcommands and documents every exit code', async () => {
    const { code, stdout } = await personavision(['calibrate', '--help'], temp);

    expect(code).toBe(0);
    for (const subcommand of ['fetch', 'score', 'fit']) expect(stdout).toContain(subcommand);
    for (const line of [
      '0  done',
      '1  a flag or a value this command cannot accept',
      '2  the dataset could not be fetched',
      '3  the dataset in the cache could not be converted into sessions',
      '4  there is no converted dataset in the cache',
      '5  the calibrated configuration could not be written',
    ]) {
      expect(stdout).toContain(line);
    }
  });

  it('names every flag of fetch and what it does', async () => {
    const { code, stdout } = await personavision(['calibrate', 'fetch', '--help'], temp);

    expect(code).toBe(0);
    for (const flag of ['--cache', '--manifest', '--record-checksums', '--convert-only']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('Exit codes:');
  });

  it('names every flag of score and what it does', async () => {
    const { code, stdout } = await personavision(['calibrate', 'score', '--help'], temp);

    expect(code).toBe(0);
    for (const flag of ['--dataset', '--cache', '--seed']) expect(stdout).toContain(flag);
    expect(stdout).toContain('Exit codes:');
  });

  it('names every flag of fit and what it does', async () => {
    const { code, stdout } = await personavision(['calibrate', 'fit', '--help'], temp);

    expect(code).toBe(0);
    for (const flag of ['--write', '--out', '--seed', '--candidates']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('Exit codes:');
  });

  it('exits 1 on a value it cannot accept, rather than fitting at NaN', async () => {
    const { code, stderr } = await personavision(['calibrate', 'fit', '--seed', 'tomorrow'], temp);

    expect(code).toBe(1);
    expect(stderr).toContain('--seed tomorrow is not a whole number');
  });
});

describe('personavision calibrate fetch', () => {
  it(
    'exits 2 naming the file it could not fetch, and prints no query string',
    async () => {
      const cache = await cacheDir('fetch-refused');
      const manifest = await stubManifest();

      const { code, stdout, stderr } = await personavision(
        ['calibrate', 'fetch', '--cache', cache, '--manifest', manifest],
        temp,
      );

      expect(code).toBe(2);
      expect(stderr).toContain('could not bring UEyes into the cache');
      expect(stderr).toContain('UEyes_dataset.zip');
      expect(stderr).toContain('ECONNREFUSED');
      // The licence is printed before a byte is fetched, because downloading is accepting it.
      expect(stdout).toContain('CC-BY-4.0');
      // No URL query string is ever logged: a publisher's link can carry a token.
      expect(`${stdout}${stderr}`).not.toContain(SECRET_IN_THE_URL);
      expect(`${stdout}${stderr}`).not.toContain('?');
    },
    SLOW,
  );

  it(
    'exits 3 when there is nothing unpacked to convert, naming the command that unpacks it',
    async () => {
      const cache = await cacheDir('fetch-nothing-unpacked');

      const { code, stderr } = await personavision(
        ['calibrate', 'fetch', '--convert-only', '--cache', cache],
        temp,
      );

      expect(code).toBe(3);
      expect(stderr).toContain('there is no unpacked dataset at');
      expect(stderr).toContain('personavision calibrate fetch');
    },
    SLOW,
  );

  it(
    'exits 3 over an unpacked tree it cannot read, naming what has to happen',
    async () => {
      const cache = await cacheDir('fetch-unreadable-tree');
      const extracted = join(datasetRoot(cache), 'dataset');
      await mkdir(join(extracted, 'images'), { recursive: true });
      await writeFile(join(extracted, 'info.csv'), 'image\n');

      const { code, stdout, stderr } = await personavision(
        ['calibrate', 'fetch', '--convert-only', '--cache', cache],
        temp,
      );

      expect(code).toBe(3);
      // The count is printed even when it is zero: a figure without one is not reported.
      expect(stdout).toContain('read 0 records from');
      expect(stderr).toContain('could not be converted into sessions');
      expect(stderr).toContain('verifiedAgainstArchive');
      expect(stderr).toContain('fabricate ground truth');
    },
    SLOW,
  );
});

describe('personavision calibrate score', () => {
  it(
    'scores the committed corpus per category and overall, with the counts and the baselines',
    async () => {
      const { code, stdout } = await personavision(['calibrate', 'score'], temp);

      expect(code).toBe(0);
      // The corpus says what it is in its own heading, not in a footnote.
      expect(stdout).toContain('the committed synthetic corpus');
      expect(stdout).toContain('not a published UEyes score');
      expect(stdout).toContain('4 records, seed 1');
      // The web category is named rather than folded into the average.
      expect(stdout).toContain('webpage — 1 record (what this product is for');
      for (const category of ['desktop', 'mobile', 'poster']) {
        expect(stdout).toContain(`${category} — 1 record`);
      }
      expect(stdout).toContain(
        'overall, every category of the committed synthetic corpus — 4 records',
      );
      // Both baselines, each with the records its margin rests on.
      expect(stdout).toContain('over the centre-bias prior (4 records)');
      expect(stdout).toContain('over random fixations (4 records)');
      for (const metric of ['cc', 'nss', 'kld', 'auc-judd', 'scanMatch', 'sequenceScore']) {
        expect(stdout).toContain(metric);
      }
    },
    SLOW,
  );

  it(
    'exits 4 when --dataset is asked for and there is no converted dataset, naming the command that makes one',
    async () => {
      const cache = await cacheDir('score-no-dataset');

      const { code, stderr } = await personavision(
        ['calibrate', 'score', '--dataset', '--cache', cache],
        temp,
      );

      expect(code).toBe(4);
      expect(stderr).toContain('there is no converted dataset in the cache');
      expect(stderr).toContain('personavision calibrate fetch');
    },
    SLOW,
  );

  it(
    'scores the converted dataset in the cache when --dataset finds one, and does not call it synthetic',
    async () => {
      const cache = await cacheDir('score-dataset');
      await writeConvertedDataset(cache, loadCorpus());

      const { code, stdout } = await personavision(
        ['calibrate', 'score', '--dataset', '--cache', cache, '--seed', '1'],
        temp,
      );

      expect(code).toBe(0);
      expect(stdout).toContain('the converted UEyes dataset');
      expect(stdout).not.toContain('not a published UEyes score');
      expect(stdout).toContain('4 records, seed 1');
      expect(stdout).toContain('webpage — 1 record');
    },
    SLOW,
  );

  it(
    'exits 4 naming the record and the field when the corpus in the cache is malformed',
    async () => {
      const cache = await cacheDir('score-malformed-dataset');
      const corpus = await writeConvertedDataset(cache, loadCorpus());
      const parsed = JSON.parse(await readFile(corpus, 'utf8')) as {
        records: Record<string, unknown>[];
      };
      // A record that lost its ground truth: the realistic accident is a truncated file or
      // a cache written by an older reader, and either way it must not reach a metric.
      delete parsed.records[1]?.saliencyMap;
      await writeFile(corpus, JSON.stringify(parsed, null, 2));

      const { code, stderr } = await personavision(
        ['calibrate', 'score', '--dataset', '--cache', cache],
        temp,
      );

      expect(code).toBe(4);
      expect(stderr).toContain('is not a corpus this can score');
      expect(stderr).toContain('desktop-two-panels');
      expect(stderr).toContain('saliencyMap');
      // A failure a developer is meant to read: the message is the whole output.
      expect(stderr).not.toContain('at Array.map');
    },
    SLOW,
  );

  it(
    'prints a sentence rather than a number when the corpus is empty',
    async () => {
      const cache = await cacheDir('score-empty-dataset');
      await writeConvertedDataset(cache, []);

      const { code, stdout } = await personavision(
        ['calibrate', 'score', '--dataset', '--cache', cache],
        temp,
      );

      expect(code).toBe(0);
      expect(stdout).toContain('holds no record, so there is no figure to print');
      expect(stdout).toContain('personavision calibrate fetch');
      expect(stdout).not.toMatch(/\bcc \d/);
    },
    SLOW,
  );
});

describe('personavision calibrate fit', () => {
  /** The committed fit, which no test may overwrite. */
  const committedConfig = new URL('../../engine/config/calibrated.json', import.meta.url);

  it(
    'prints the best configuration with its objective, and writes nothing without --write',
    async () => {
      const before = await readFile(committedConfig, 'utf8');

      const { code, stdout } = await personavision(
        ['calibrate', 'fit', '--candidates', String(FEW_CANDIDATES), '--seed', '3'],
        temp,
      );

      expect(code).toBe(0);
      expect(stdout).toContain('objective web-cc-scanmatch');
      // Every figure carries the records behind it, the objective's scope included.
      expect(stdout).toContain('measured over 1 webpage record of the committed synthetic corpus');
      expect(stdout).toContain('improvement');
      expect(stdout).toContain('the change it would make to');
      expect(stdout).toContain('nothing was written. Pass --write to write it.');
      // It says so when the run is not the committed fit, so an exploratory figure is not
      // mistaken for the one the product ships.
      expect(stdout).toContain('this is not the committed fit');
      expect(await readFile(committedConfig, 'utf8')).toBe(before);
    },
    SLOW,
  );

  it(
    'writes the calibrated configuration with --write and prints where',
    async () => {
      const before = await readFile(committedConfig, 'utf8');
      const out = join(await cacheDir('fit-write'), 'calibrated.json');

      const { code, stdout } = await personavision(
        [
          'calibrate',
          'fit',
          '--write',
          '--out',
          out,
          '--candidates',
          String(FEW_CANDIDATES),
          '--seed',
          '3',
        ],
        temp,
      );

      expect(code).toBe(0);
      expect(stdout).toContain(`wrote ${out}`);
      const written = JSON.parse(await readFile(out, 'utf8')) as {
        weights: Record<string, unknown>;
        fit: { seed: number; candidates: number; values: Record<string, number> };
      };
      expect(written.fit.seed).toBe(3);
      expect(written.fit.candidates).toBe(FEW_CANDIDATES);
      expect(Object.keys(written.fit.values).length).toBeGreaterThan(0);
      expect(written.weights).toBeTypeOf('object');
      // The engine's committed configuration is untouched: --out is where this one went.
      expect(await readFile(committedConfig, 'utf8')).toBe(before);
    },
    SLOW,
  );
});
