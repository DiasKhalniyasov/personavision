/**
 * The download, end to end, against a stub origin served from this process over loopback.
 *
 * Nothing here reaches the public internet and nothing downloads the real 12.9 GB archive:
 * every test builds its own bytes, serves them, and asserts on what landed in a temporary
 * cache root that is removed afterwards. The port is whatever the operating system gives
 * the stub, so two suites can run side by side.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readArchiveDirectory } from '../src/dataset/archive.js';
import type { CacheEnvironment } from '../src/dataset/cache.js';
import { DatasetFetchError, fetchDataset, withoutSecrets } from '../src/dataset/fetch.js';
import type { FetchDatasetOptions } from '../src/dataset/fetch.js';
import type {
  ArchiveLayout,
  DatasetManifest,
  FileChecksum,
  ManifestFile,
  RecordedChecksum,
} from '../src/dataset/manifest.js';
import { formatJsonDocument } from '../src/dataset/verify.js';
import { makeZip } from './helpers/make-zip.js';
import { startStubOrigin } from './helpers/stub-origin.js';
import type { StubOrigin } from './helpers/stub-origin.js';

const DATASET_ID = 'stub-dataset';

const temporaryRoots: string[] = [];
const origins: StubOrigin[] = [];

afterEach(async () => {
  await Promise.all(origins.splice(0).map((origin) => origin.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A cache root under the system temporary directory, removed after the test. */
const temporaryCache = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'personavision-fetch-'));
  temporaryRoots.push(root);
  return root;
};

const serve = async (files: Record<string, Buffer>, options = {}): Promise<StubOrigin> => {
  const origin = await startStubOrigin({ files, ...options });
  origins.push(origin);
  return origin;
};

const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex');

const environmentFor = (cacheRoot: string): Partial<CacheEnvironment> => ({
  env: { PERSONAVISION_CALIBRATION_CACHE: cacheRoot },
});

const recordedMd5 = (bytes: Buffer): RecordedChecksum => ({
  state: 'recorded',
  algorithm: 'md5',
  value: md5(bytes),
  source: 'publisher-metadata',
  recordedOn: '2026-10-26',
  note: "The publisher's claim about the bytes.",
});

const DECLARED_LAYOUT: ArchiveLayout = {
  root: { state: 'unknown', reason: 'nothing here has opened the archive' },
  verifiedAgainstArchive: false,
  note: 'documented by the publisher, not read from the archive',
  entries: [
    { path: 'images', kind: 'directory', holds: 'every screenshot' },
    { path: 'scanpaths/paths_1s', kind: 'directory', holds: 'human scanpaths at one second' },
    { path: 'info.csv', kind: 'file', holds: 'one row per screenshot' },
  ],
};

/** A manifest shaped like the committed one, pointed at a stub origin. */
const manifestFor = (
  files: readonly ManifestFile[],
  layout = DECLARED_LAYOUT,
): DatasetManifest => ({
  schemaVersion: 1,
  dataset: {
    id: DATASET_ID,
    name: 'UEyes (stub)',
    title: 'A stand-in for the UEyes benchmark, built in the test process',
    participants: 62,
    screenshots: 1980,
    categories: ['webpage', 'desktop', 'mobile', 'poster'],
    viewingDurationsSeconds: [1, 3, 7],
    paper: {
      citation:
        'Jiang et al. 2023. UEyes: Understanding Visual Saliency across User Interface Types.',
      doi: '10.1145/3544548.3581096',
      url: 'https://doi.org/10.1145/3544548.3581096',
    },
    source: {
      host: 'a stub origin on loopback',
      recordUrl: 'https://zenodo.org/records/8010312',
      versionDoi: '10.5281/zenodo.8010312',
      conceptDoi: '10.5281/zenodo.8010311',
      publishedOn: '2023-06-06',
      resolvedOn: '2026-10-26',
      resolvedFrom: ['the test process'],
      note: 'A stand-in, so that no test reaches the public internet.',
    },
    licence: {
      spdxId: 'CC-BY-4.0',
      name: 'Creative Commons Attribution 4.0 International',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      source: "The Zenodo record's own licence field.",
      attribution: 'UEyes dataset, Jiang et al., CC BY 4.0',
      requires: ['Credit the creators wherever a figure measured on this dataset is published.'],
      forbids: ['Implying that the creators endorse this product.'],
      notVendoredBecause: 'The screenshots depict third-party interfaces.',
    },
  },
  files,
  layout,
});

/** The archive every test downloads unless it needs a different tree. */
const ARCHIVE = makeZip([
  { path: 'images', kind: 'directory' },
  { path: 'images/webpage-one.png', data: Buffer.from('a screenshot, in spirit'), deflate: true },
  { path: 'images/webpage-two.png', data: Buffer.alloc(4096, 7), deflate: true },
  {
    path: 'scanpaths/paths_1s/webpage-one.csv',
    data: Buffer.from('index,tMs,durationMs,x,y\n0,0,220,12,30\n'),
  },
  {
    path: 'info.csv',
    data: Buffer.from(
      'image,category,viewportWidth,viewportHeight\nwebpage-one.png,webpage,1280,800\n',
    ),
  },
]);

const archiveFile = (origin: StubOrigin, query = ''): ManifestFile => ({
  path: 'stub_dataset.zip',
  url: origin.url('stub_dataset.zip', query),
  sizeBytes: ARCHIVE.length,
  mediaType: 'application/zip',
  archive: 'zip',
  checksum: recordedMd5(ARCHIVE),
});

const lines: string[] = [];
const collect = (line: string): void => {
  lines.push(line);
};
const logged = (): string => lines.join('\n');

const run = async (
  manifest: DatasetManifest,
  cacheRoot: string,
  options: Partial<FetchDatasetOptions> = {},
): ReturnType<typeof fetchDataset> => {
  lines.length = 0;
  return fetchDataset({
    manifest,
    environment: environmentFor(cacheRoot),
    log: collect,
    retry: { attempts: 3, delayMs: 0 },
    now: () => new Date('2026-10-27T09:00:00.000Z'),
    ...options,
  });
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('fetching the dataset into the cache', () => {
  it('downloads every file, verifies it, and reports per-file progress', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });

    const result = await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'stub_dataset.zip',
      state: 'downloaded',
      verifiedAgainstManifest: true,
      checksum: { algorithm: 'md5', value: md5(ARCHIVE) },
    });
    expect(logged()).toContain('stub_dataset.zip');
    expect(logged()).toMatch(/stub_dataset\.zip {2}[\d.]+ \w?B of [\d.]+ \w?B \(100%\)/);
    expect(logged()).toContain(`verified (md5 ${md5(ARCHIVE)})`);
  });

  it('writes nothing outside the cache root it was given', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });

    const result = await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(result.cacheRoot).toBe(join(cacheRoot, DATASET_ID));
    expect(result.downloads.startsWith(cacheRoot)).toBe(true);
    expect(result.extracted.startsWith(cacheRoot)).toBe(true);
    expect(await readdir(cacheRoot)).toEqual([DATASET_ID]);
  });

  it('unpacks the archive into the layout the manifest describes', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });

    const result = await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(result.extractions[0]).toMatchObject({ state: 'unpacked', root: { state: 'root' } });
    expect(await readFile(join(result.extracted, 'images', 'webpage-one.png'), 'utf8')).toBe(
      'a screenshot, in spirit',
    );
    expect((await stat(join(result.extracted, 'images', 'webpage-two.png'))).size).toBe(4096);
    expect(await exists(join(result.extracted, 'scanpaths', 'paths_1s', 'webpage-one.csv'))).toBe(
      true,
    );
  });

  it('strips the directory the entries sit under, which an unknown root does not contradict', async () => {
    const cacheRoot = await temporaryCache();
    const wrapped = makeZip([
      { path: 'UEyes_dataset/images/webpage-one.png', data: Buffer.from('one') },
      { path: 'UEyes_dataset/scanpaths/paths_1s/one.csv', data: Buffer.from('index\n') },
      { path: 'UEyes_dataset/info.csv', data: Buffer.from('image\n') },
    ]);
    const origin = await serve({ 'stub_dataset.zip': wrapped });
    const file: ManifestFile = {
      ...archiveFile(origin),
      sizeBytes: wrapped.length,
      checksum: recordedMd5(wrapped),
    };

    const result = await run(manifestFor([file]), cacheRoot);

    expect(result.extractions[0]?.root).toEqual({ state: 'directory', path: 'UEyes_dataset' });
    expect(await readFile(join(result.extracted, 'info.csv'), 'utf8')).toBe('image\n');
    expect(await exists(join(result.extracted, 'UEyes_dataset'))).toBe(false);
  });
});

describe('what the command tells the person running it', () => {
  it('states the licence and what the download costs before it fetches a byte', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });

    await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(logged()).toContain('Downloading it is accepting that licence. It requires:');
    expect(logged()).toContain(
      'Credit the creators wherever a figure measured on this dataset is published.',
    );
    expect(logged()).toContain('Implying that the creators endorse this product.');
    expect(logged()).toContain('no account, no credential, no payment');
    expect(logged()).toContain(`will be written to ${join(cacheRoot, DATASET_ID)}`);
    expect(logged()).toContain('nothing into this repository');
  });

  it('reports how far through a long archive the unpacking is', async () => {
    const cacheRoot = await temporaryCache();
    const many = makeZip([
      { path: 'images', kind: 'directory' },
      ...Array.from({ length: 250 }, (_, index) => ({
        path: `images/webpage-${index}.png`,
        data: Buffer.from(`screenshot ${index}`),
      })),
      { path: 'scanpaths/paths_1s/one.csv', data: Buffer.from('index\n') },
      { path: 'info.csv', data: Buffer.from('image\n') },
    ]);
    const origin = await serve({ 'stub_dataset.zip': many });

    const result = await run(
      manifestFor([
        { ...archiveFile(origin), sizeBytes: many.length, checksum: recordedMd5(many) },
      ]),
      cacheRoot,
    );

    expect(result.extractions[0]?.entries).toBe(253);
    expect(logged()).toMatch(/unpacked \d+ of 253 entries \(\d+%\)/);
    expect(await readFile(join(result.extracted, 'images', 'webpage-249.png'), 'utf8')).toBe(
      'screenshot 249',
    );
  });
});

describe('an interrupted transfer', () => {
  it('resumes from the bytes already written and produces a byte-identical file', async () => {
    const cacheRoot = await temporaryCache();
    const half = Math.floor(ARCHIVE.length / 2);
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE }, { cutAfter: [half] });

    const result = await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(result.files[0]?.interruptions).toBe(1);
    expect(result.files[0]?.resumedFromBytes).toBeGreaterThan(0);
    expect(origin.requests).toHaveLength(2);
    expect(origin.requests[0]?.range).toBeNull();
    expect(origin.requests[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(logged()).toContain('resuming at');

    const downloaded = await readFile(join(result.downloads, 'stub_dataset.zip'));
    expect(downloaded.equals(ARCHIVE)).toBe(true);
  });

  it('picks up where a previous run of the command stopped', async () => {
    const cacheRoot = await temporaryCache();
    const half = Math.floor(ARCHIVE.length / 2);
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE }, { cutAfter: [half] });
    const manifest = manifestFor([archiveFile(origin)]);

    await expect(run(manifest, cacheRoot, { retry: { attempts: 1, delayMs: 0 } })).rejects.toThrow(
      DatasetFetchError,
    );
    const part = join(cacheRoot, DATASET_ID, 'downloads', 'stub_dataset.zip.part');
    expect((await stat(part)).size).toBeGreaterThan(0);
    expect((await stat(part)).size).toBeLessThan(ARCHIVE.length);

    const result = await run(manifest, cacheRoot);

    expect(origin.requests[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(result.files[0]?.resumedFromBytes).toBeGreaterThan(0);
    const downloaded = await readFile(join(result.downloads, 'stub_dataset.zip'));
    expect(downloaded.equals(ARCHIVE)).toBe(true);
    expect(await exists(part)).toBe(false);
  });

  it('starts again from the first byte when the origin ignores the range', async () => {
    const cacheRoot = await temporaryCache();
    const half = Math.floor(ARCHIVE.length / 2);
    const origin = await serve(
      { 'stub_dataset.zip': ARCHIVE },
      { cutAfter: [half], ignoreRanges: true },
    );

    const result = await run(manifestFor([archiveFile(origin)]), cacheRoot);

    expect(logged()).toContain('the origin does not support resuming');
    const downloaded = await readFile(join(result.downloads, 'stub_dataset.zip'));
    expect(downloaded.equals(ARCHIVE)).toBe(true);
  });
});

describe('a checksum that does not match', () => {
  it('fails with a named reason, quarantines the file, and a retry recovers', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const wrong = 'f'.repeat(32);
    const file = archiveFile(origin);
    const broken = manifestFor([
      { ...file, checksum: { ...recordedMd5(ARCHIVE), value: wrong } as FileChecksum },
    ]);

    const failure = await run(broken, cacheRoot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatasetFetchError);
    expect((failure as DatasetFetchError).failures[0]?.path).toBe('stub_dataset.zip');
    expect((failure as DatasetFetchError).message).toContain(wrong);
    expect((failure as DatasetFetchError).message).toContain(md5(ARCHIVE));
    expect((failure as DatasetFetchError).message).toContain('quarantine');

    const downloads = join(cacheRoot, DATASET_ID, 'downloads');
    expect(await readdir(downloads)).toEqual([]);
    expect(await readdir(join(cacheRoot, DATASET_ID, 'quarantine'))).toHaveLength(1);
    expect(await exists(join(cacheRoot, DATASET_ID, 'dataset'))).toBe(false);

    const result = await run(manifestFor([file]), cacheRoot);
    expect(result.files[0]?.verifiedAgainstManifest).toBe(true);
    expect(await exists(join(result.extracted, 'info.csv'))).toBe(true);
  });

  it('refuses a cached copy whose size is not the one the manifest records', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    await run(manifestFor([archiveFile(origin)]), cacheRoot);

    const downloaded = join(cacheRoot, DATASET_ID, 'downloads', 'stub_dataset.zip');
    await writeFile(downloaded, ARCHIVE.subarray(0, 10));

    const failure = await run(manifestFor([archiveFile(origin)]), cacheRoot).catch(
      (error: unknown) => error,
    );

    expect((failure as DatasetFetchError).message).toContain('10 bytes');
    expect(await exists(downloaded)).toBe(false);
  });
});

describe('a cache that is already complete', () => {
  it('downloads nothing on a second run and says it is already present', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin)]);

    await run(manifest, cacheRoot);
    const afterFirst = origin.requests.length;

    const result = await run(manifest, cacheRoot);

    expect(origin.requests).toHaveLength(afterFirst);
    expect(result.files[0]?.state).toBe('already-present');
    expect(result.extractions[0]?.state).toBe('already-unpacked');
    expect(logged()).toContain('already present and verified');
    expect(logged()).toContain('Nothing to do');
  });

  it('hashes the file again when it has been touched since it was verified', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin)]);
    await run(manifest, cacheRoot);

    const receipt = join(cacheRoot, DATASET_ID, 'downloads', 'stub_dataset.zip.verified.json');
    const written = JSON.parse(await readFile(receipt, 'utf8')) as { mtimeMs: number };
    await writeFile(receipt, JSON.stringify({ ...written, mtimeMs: written.mtimeMs + 1 }));

    const result = await run(manifest, cacheRoot);

    expect(result.files[0]?.state).toBe('already-present');
    expect(logged()).toContain(`verified (md5 ${md5(ARCHIVE)})`);
  });
});

describe('an origin that cannot be reached', () => {
  it('fails naming the files it could not fetch and leaves no half-extracted tree', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin)]);
    await origin.close();
    origins.splice(origins.indexOf(origin), 1);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatasetFetchError);
    expect((failure as DatasetFetchError).failures).toEqual([
      expect.objectContaining({ path: 'stub_dataset.zip' }),
    ]);
    expect((failure as DatasetFetchError).message).toContain('stub_dataset.zip');
    expect(await exists(join(cacheRoot, DATASET_ID, 'dataset'))).toBe(false);
    expect(await exists(join(cacheRoot, DATASET_ID, '.staging'))).toBe(false);
  });

  it('reports a refusal from the origin by its status', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE }, { refuseWith: 503 });

    const failure = await run(manifestFor([archiveFile(origin)]), cacheRoot).catch(
      (error: unknown) => error,
    );

    expect((failure as DatasetFetchError).message).toContain('503');
  });
});

describe('secret hygiene', () => {
  it('logs no URL query string, and sends no credential', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin, '?token=a-secret-token&download=1')]);

    await run(manifest, cacheRoot);

    expect(origin.requests[0]?.query).toBe('?token=a-secret-token&download=1');
    expect(logged()).not.toContain('a-secret-token');
    expect(logged()).not.toContain('token=');
    expect(logged()).not.toContain('?');
    expect(origin.requests.every((request) => request.authorization === null)).toBe(true);
  });

  it('keeps the query string out of a failure as well', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE }, { refuseWith: 500 });
    const manifest = manifestFor([archiveFile(origin, '?token=a-secret-token')]);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain('a-secret-token');
    expect(logged()).not.toContain('a-secret-token');
  });

  it('strips the query, the fragment and any user information from a URL', () => {
    expect(withoutSecrets('https://user:pw@example.org/a/b?token=x#y')).toBe(
      'https://example.org/a/b',
    );
    expect(withoutSecrets('not a url')).toBe('[an unparseable URL]');
  });

  it('refuses a download location that is not https', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([
      { ...archiveFile(origin), url: 'http://example.org/stub_dataset.zip' },
    ]);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect((failure as DatasetFetchError).message).toContain('https');
    expect(origin.requests).toHaveLength(0);
  });
});

describe('a file the manifest records no checksum for', () => {
  const unverified: FileChecksum = {
    state: 'unverified',
    reason: 'nobody has hashed a local copy',
  };

  it('is refused before anything is fetched', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([{ ...archiveFile(origin), checksum: unverified }]);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatasetFetchError);
    expect((failure as DatasetFetchError).message).toContain('--record-checksums');
    expect(origin.requests).toHaveLength(0);
    expect(await exists(join(cacheRoot, DATASET_ID))).toBe(false);
  });

  it('is hashed and written into the manifest by --record-checksums, and printed', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([{ ...archiveFile(origin), checksum: unverified }]);
    const manifestPath = join(cacheRoot, 'manifest.json');
    await writeFile(manifestPath, formatJsonDocument(manifest), 'utf8');

    const result = await run(manifest, cacheRoot, { recordChecksums: true, manifestPath });

    const sha256 = createHash('sha256').update(ARCHIVE).digest('hex');
    expect(result.files[0]?.verifiedAgainstManifest).toBe(false);
    expect(result.manifestChanges).toHaveLength(1);
    expect(result.manifestChanges[0]).toMatchObject({
      filePath: 'stub_dataset.zip',
      written: true,
      after: {
        state: 'recorded',
        algorithm: 'sha256',
        value: sha256,
        source: 'local-download',
        recordedOn: '2026-10-27',
      },
    });
    expect(logged()).toContain(`+   "value": "${sha256}"`);

    const rewritten = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
    expect(rewritten.files[0]?.checksum).toMatchObject({ state: 'recorded', value: sha256 });
  });

  it('flips a publisher checksum to a local one once a local copy has confirmed it', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin)]);
    const manifestPath = join(cacheRoot, 'manifest.json');
    await writeFile(manifestPath, formatJsonDocument(manifest), 'utf8');

    const result = await run(manifest, cacheRoot, { recordChecksums: true, manifestPath });

    expect(result.manifestChanges[0]?.after).toMatchObject({
      algorithm: 'md5',
      value: md5(ARCHIVE),
      source: 'local-download',
    });
    expect(result.manifestChanges[0]?.before).toMatchObject({ source: 'publisher-metadata' });
  });

  it('never records a checksum over one that does not match the bytes', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([
      { ...archiveFile(origin), checksum: { ...recordedMd5(ARCHIVE), value: 'a'.repeat(32) } },
    ]);
    const manifestPath = join(cacheRoot, 'manifest.json');
    const before = formatJsonDocument(manifest);
    await writeFile(manifestPath, before, 'utf8');

    await expect(run(manifest, cacheRoot, { recordChecksums: true, manifestPath })).rejects.toThrow(
      DatasetFetchError,
    );

    expect(await readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('will not rewrite a manifest that is not in this repository’s formatting', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([{ ...archiveFile(origin), checksum: unverified }]);
    const manifestPath = join(cacheRoot, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const result = await run(manifest, cacheRoot, { recordChecksums: true, manifestPath });

    expect(result.manifestChanges[0]?.written).toBe(false);
    expect(logged()).toContain('pnpm format');
    expect(await readFile(manifestPath, 'utf8')).toBe(JSON.stringify(manifest));
  });
});

describe('an archive whose layout contradicts the manifest', () => {
  it('fails naming the difference rather than extracting anyway', async () => {
    const cacheRoot = await temporaryCache();
    const different = makeZip([
      { path: 'pictures/webpage-one.png', data: Buffer.from('one') },
      { path: 'info.csv', data: Buffer.from('image\n') },
    ]);
    const origin = await serve({ 'stub_dataset.zip': different });
    const manifest = manifestFor([
      {
        ...archiveFile(origin),
        sizeBytes: different.length,
        checksum: recordedMd5(different),
      },
    ]);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatasetFetchError);
    const message = (failure as DatasetFetchError).message;
    expect(message).toContain('`images`');
    expect(message).toContain('`scanpaths/paths_1s`');
    expect(message).toContain('`pictures`');
    expect(await exists(join(cacheRoot, DATASET_ID, 'dataset'))).toBe(false);
    expect(await exists(join(cacheRoot, DATASET_ID, '.staging'))).toBe(false);
  });

  it('reports a root the manifest asserts and the archive does not have', async () => {
    const cacheRoot = await temporaryCache();
    const origin = await serve({ 'stub_dataset.zip': ARCHIVE });
    const manifest = manifestFor([archiveFile(origin)], {
      ...DECLARED_LAYOUT,
      root: { state: 'directory', path: 'UEyes_dataset' },
    });

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect((failure as DatasetFetchError).message).toContain('UEyes_dataset');
    expect((failure as DatasetFetchError).message).toContain('at the archive root');
  });
});

describe('the archive reader', () => {
  const writeArchive = async (bytes: Buffer): Promise<string> => {
    const root = await temporaryCache();
    const path = join(root, 'archive.zip');
    await writeFile(path, bytes);
    return path;
  };

  it('reads an archive written with the zip64 records the real one needs', async () => {
    const path = await writeArchive(
      makeZip([{ path: 'info.csv', data: Buffer.from('a,b\n') }], { zip64: true }),
    );

    const entries = await readArchiveDirectory(path);

    expect(entries).toEqual([
      expect.objectContaining({ path: 'info.csv', kind: 'file', sizeBytes: 4 }),
    ]);
  });

  it('refuses a member whose path would be written outside the cache', async () => {
    const path = await writeArchive(makeZip([{ path: '../escape.csv', data: Buffer.from('x') }]));

    await expect(readArchiveDirectory(path)).rejects.toThrow(/outside the cache/);
  });

  it('refuses a member that is a symbolic link', async () => {
    const path = await writeArchive(
      makeZip([
        {
          path: 'info.csv',
          data: Buffer.from('/etc/passwd'),
          versionMadeBy: (3 << 8) | 20,
          externalAttributes: 0xa1ff * 0x10000,
        },
      ]),
    );

    await expect(readArchiveDirectory(path)).rejects.toThrow(/symbolic link/);
  });

  it('refuses a file that is not a zip archive at all', async () => {
    const path = await writeArchive(Buffer.from('not a zip, just some bytes'));

    await expect(readArchiveDirectory(path)).rejects.toThrow(/not a zip archive/);
  });

  it('fails on the entry whose bytes are corrupt', async () => {
    const cacheRoot = await temporaryCache();
    const corrupt = makeZip([
      { path: 'images', kind: 'directory' },
      { path: 'images/one.png', data: Buffer.from('one'), brokenCrc: 1 },
      { path: 'scanpaths/paths_1s/one.csv', data: Buffer.from('index\n') },
      { path: 'info.csv', data: Buffer.from('image\n') },
    ]);
    const origin = await serve({ 'stub_dataset.zip': corrupt });
    const manifest = manifestFor([
      { ...archiveFile(origin), sizeBytes: corrupt.length, checksum: recordedMd5(corrupt) },
    ]);

    const failure = await run(manifest, cacheRoot).catch((error: unknown) => error);

    expect((failure as DatasetFetchError).message).toContain('corrupt');
    expect(await exists(join(cacheRoot, DATASET_ID, 'dataset'))).toBe(false);
  });
});

describe('the committed manifest', () => {
  it('is printed by the recorder exactly as this repository formats it', async () => {
    const path = fileURLToPath(new URL('../src/dataset/manifest.json', import.meta.url));
    const text = await readFile(path, 'utf8');

    expect(formatJsonDocument(JSON.parse(text))).toBe(text);
  });
});
