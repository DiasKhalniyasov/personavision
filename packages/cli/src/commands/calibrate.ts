/**
 * `personavision calibrate` — the step that produces the human-likeness figure, from one
 * command.
 *
 * Everything this product shows rests on one claim: the simulated gaze resembles human
 * gaze. `packages/calibration` is where that claim is measured, and this is the surface
 * that makes it usable by someone who has not read it — three subcommands over the three
 * things the step does:
 *
 * - **`fetch`** brings UEyes onto the machine, into a cache outside this repository, and
 *   converts what it finds into the project's own session shape.
 * - **`score`** scores the engine over a corpus, per category and overall, against the two
 *   baselines a figure means nothing without.
 * - **`fit`** searches the engine's configuration against the benchmark and writes the
 *   result as committed data.
 *
 * **Every figure is printed with the record count behind it.** A mean over four records and
 * a mean over four hundred read identically otherwise, and the committed corpus is
 * synthetic — so the corpus says so in its own heading, and an empty corpus gets a sentence
 * rather than a zero. The web category is named on its own line rather than folded into the
 * average, because webpages are what this product is for.
 *
 * **No secret is read, needed or printed.** UEyes is open access; the download reads no
 * credential and `fetchDataset` strips every URL's query string before it reaches the log,
 * because a publisher's link can carry a token.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CACHE_ENV_VAR,
  COMMITTED_MANIFEST_PATH,
  DatasetFetchError,
  FIT_DEFAULTS,
  RECORD_CATEGORIES,
  calibratedRecordOf,
  committedCorpus,
  convertRecords,
  datasetCachePaths,
  enginePredictor,
  fetchDataset,
  fit,
  loadManifest,
  parseManifest,
  score,
} from '@personavision/calibration';
import type {
  Aggregate,
  CacheEnvironment,
  DatasetManifest,
  FitResult,
  GroundTruthRecord,
  MarginFigures,
  RawRecord,
  SaliencyScores,
  ScanpathScores,
  ScoreResult,
  ScoredCorpus,
} from '@personavision/calibration';
import { CliError } from '../cli-error.js';

/**
 * What the shell sees, and what each code means. `--help` prints this table, and
 * `test/calibrate.test.ts` asserts every one of them against a real process.
 *
 * `usage` is `CliError`'s own default and commander's, so a bad flag and a bad value answer
 * the same way the rest of this command line does.
 */
export const CALIBRATE_EXIT_CODES = Object.freeze({
  /** The command did what it was asked. */
  ok: 0,
  /** A flag or a value this command cannot accept. */
  usage: 1,
  /** The dataset could not be fetched: the failure names every file and why. */
  fetchFailed: 2,
  /** The dataset in the cache could not be converted into sessions. */
  notConvertible: 3,
  /** `score --dataset` was asked for and there is no converted dataset in the cache. */
  noConvertedDataset: 4,
  /** `fit --write` could not write the calibrated configuration. */
  notWritten: 5,
});

/** The lines `--help` prints under every subcommand, so one table answers for all three. */
export const EXIT_CODE_HELP = [
  'Exit codes:',
  '  0  done',
  '  1  a flag or a value this command cannot accept',
  '  2  the dataset could not be fetched (fetch)',
  '  3  the dataset in the cache could not be converted into sessions (fetch)',
  '  4  there is no converted dataset in the cache (score --dataset)',
  '  5  the calibrated configuration could not be written (fit --write)',
].join('\n');

/** Where the converted dataset is written, inside the dataset's own cache directory. */
const CONVERTED_DIRECTORY = 'converted';
/** The ground truth `score --dataset` reads, written by the conversion beside the sessions. */
const CORPUS_FILE = 'corpus.json';
/** The sessions the conversion writes, one file per participant per record. */
const SESSIONS_DIRECTORY = 'sessions';
/** The shape of `corpus.json`, so a reader can refuse a file written by another version. */
const CORPUS_SCHEMA_VERSION = 1;

type Log = (line: string) => void;

const toStdout: Log = (line) => process.stdout.write(`${line}\n`);

/**
 * The cache the dataset lives in, as `--cache` may redirect it.
 *
 * `packages/calibration` resolves the cache from the environment — `$PERSONAVISION_CALIBRATION_CACHE`,
 * then the operating system's cache directory — and never from this repository. `--cache`
 * sets that variable for this process only, so there is one rule about where 12.9 GB lands
 * and one place it is written down.
 */
const cacheEnvironment = (cache: string | undefined): Partial<CacheEnvironment> =>
  cache === undefined ? {} : { env: { ...process.env, [CACHE_ENV_VAR]: resolve(cache) } };

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** A figure, to four places: enough to see a fit move and few enough to read in a row. */
const figure = (value: number): string => value.toFixed(4);

/** A margin, signed, because the sign is the whole point of a margin. */
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;

const metricRow = (
  saliency: SaliencyScores,
  scanpath: ScanpathScores,
  format: (value: number) => string,
): string =>
  [
    `cc ${format(saliency.cc)}`,
    `nss ${format(saliency.nss)}`,
    `kld ${format(saliency.kld)}`,
    `auc-judd ${format(saliency.aucJudd)}`,
    `scanMatch ${format(scanpath.scanMatch)}`,
    `sequenceScore ${format(scanpath.sequenceScore)}`,
  ].join('  ');

/** `1 record` / `4 records`, and an explicit plural for a noun `s` does not make. */
const plural = (count: number, noun: string, many = `${noun}s`): string =>
  `${String(count)} ${count === 1 ? noun : many}`;

// ---------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------

export interface CalibrateFetchOptions {
  /** A cache root other than the one the environment resolves. */
  readonly cache?: string;
  /** A dataset manifest other than the committed one. */
  readonly manifest?: string;
  /** Hash a fresh download and write the result into the manifest as a reviewable change. */
  readonly recordChecksums?: boolean;
  /** Skip the download and convert what is already unpacked in the cache. */
  readonly convertOnly?: boolean;
  readonly log?: Log;
}

/**
 * The manifest this run reads: the committed one, or the file `--manifest` names.
 *
 * A manifest from a file goes through `parseManifest`, which holds it to exactly the rules
 * the committed one meets — an `https://` download location, a recorded checksum per file,
 * a dataset id that is one directory name. So pointing the command at a corrected layout or
 * a staged copy cannot smuggle in a plain-HTTP origin or a file nothing can verify.
 */
const manifestFor = async (
  path: string | undefined,
): Promise<{ readonly manifest: DatasetManifest; readonly path: string }> => {
  if (path === undefined) return { manifest: loadManifest(), path: COMMITTED_MANIFEST_PATH };
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (cause) {
    throw new CliError(
      `--manifest ${path} cannot be read: ${(cause as Error).message}. Pass a dataset manifest shaped as packages/calibration/src/dataset/manifest.json.`,
    );
  }
  try {
    return { manifest: parseManifest(JSON.parse(text)), path: absolute };
  } catch (cause) {
    throw new CliError(`--manifest ${path} is not a dataset manifest: ${(cause as Error).message}`);
  }
};

/**
 * One record of the extracted dataset: what the conversion reads, and what the scoring does.
 *
 * `raw` is #86's `RawRecord` — one row of `info.csv` with the participant logs that belong
 * to it — and `groundTruth` is the humans' aggregated saliency map and their scanpaths,
 * which is what a prediction is scored against. They travel together because a record is
 * only usable when both are readable: converting a record whose ground truth could not be
 * read would put a session in the cache that nothing can score.
 */
interface DatasetRecord {
  readonly raw: RawRecord;
  readonly groundTruth: GroundTruthRecord;
}

interface DatasetRecords {
  readonly records: readonly DatasetRecord[];
  /** Why the tree, or part of it, could not be read — each line naming what to do about it. */
  readonly unreadable: readonly string[];
}

/**
 * The extracted dataset's own files, read into records.
 *
 * **This is the seam that is still open, and it is open deliberately.** #86 declared
 * `RawRecord` as *this project's* name for what a reader of the dataset's files hands over
 * and said, in as many words, that the reader which first opens the real archive maps the
 * real columns onto it. Nobody has opened the archive: `manifest.json` still records
 * `layout.verifiedAgainstArchive: false`, and #85's own decision is that the first person
 * to run the download against the real 12.9 GB archive gets a named list of layout
 * differences and corrects the manifest by hand, in a reviewed change.
 *
 * So there are no column names for `info.csv` and no format for `eyetracker_logs/` that
 * this repository has ever seen, and inventing them here would fabricate ground truth —
 * the one thing a calibration step may not do. The command therefore reads what it can,
 * says what it cannot, and exits non-zero: an unconvertible dataset in the cache is not a
 * success. Everything downstream of this function is finished and waits on it — the
 * conversion is called below, its rejections are printed, and the sessions and the corpus
 * are written — so landing a reader is a change to this function and to nothing else.
 */
const readDatasetRecords = async (
  manifest: DatasetManifest,
  extracted: string,
): Promise<DatasetRecords> => {
  if (!(await directoryExists(extracted))) {
    return {
      records: [],
      unreadable: [
        `there is no unpacked dataset at ${extracted}. Run \`personavision calibrate fetch\` without --convert-only to download, verify and unpack it first.`,
      ],
    };
  }
  const entries = (await readdir(extracted)).sort();
  return {
    records: [],
    unreadable: [
      [
        `${manifest.dataset.name} is unpacked at ${extracted} (${plural(entries.length, 'entry', 'entries')} at its root) and nothing here can read its own file formats yet.`,
        `  ${manifest.dataset.id}'s archive has never been opened by this project: packages/calibration/src/dataset/manifest.json records \`layout.verifiedAgainstArchive: false\`, so there are no column names for info.csv and no format for eyetracker_logs/ that have been read rather than guessed.`,
        '  Guessing them would fabricate ground truth, which is the one thing a calibration step may not do. What has to happen, in order:',
        '    1. open the archive and compare its tree with `layout.entries` in the manifest — the download already fails naming every difference;',
        '    2. correct `layout` by hand, set `root` and `verifiedAgainstArchive: true`, and commit that as a reviewed change;',
        '    3. map the real columns onto `RawRecord` and the real saliency maps onto `GroundTruthRecord` in `readDatasetRecords` (packages/cli/src/commands/calibrate.ts).',
        '  The conversion itself is finished and is called from here: once records arrive, the sessions and the corpus are written and every rejected record is printed with its reason.',
      ].join('\n'),
    ],
  };
};

/** The corpus file `score --dataset` reads: ground truth, with image paths relative to it. */
interface CorpusFile {
  readonly schemaVersion: number;
  readonly dataset: { readonly id: string; readonly label: string };
  /** `imagePath` is relative to this file's own directory, so the cache can be moved. */
  readonly records: readonly GroundTruthRecord[];
}

/**
 * Writes the converted dataset into the cache: the sessions, and the ground truth beside
 * them.
 *
 * Two files, because they answer two questions. The sessions are what #86 produces — a
 * human's free viewing in the same shape as a simulated session, which is what makes the
 * two comparable at all. The corpus is the humans' saliency maps and scanpaths, which is
 * what a prediction is scored *against*: `score --dataset` reads this file and nothing else.
 */
const writeConverted = async (
  convertedDir: string,
  manifest: DatasetManifest,
  sessions: readonly { readonly session: unknown; readonly recordId: string }[],
  records: readonly GroundTruthRecord[],
): Promise<void> => {
  const sessionsDir = join(convertedDir, SESSIONS_DIRECTORY);
  await mkdir(sessionsDir, { recursive: true });
  await Promise.all(
    sessions.map((converted, position) =>
      writeFile(
        join(sessionsDir, `S-${String(position + 1).padStart(2, '0')}.json`),
        `${JSON.stringify(converted.session, null, 2)}\n`,
      ),
    ),
  );
  const corpus: CorpusFile = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    dataset: { id: manifest.dataset.id, label: manifest.dataset.name },
    records: records.map((record) => ({
      ...record,
      imagePath: relative(convertedDir, record.imagePath),
    })),
  };
  await writeFile(join(convertedDir, CORPUS_FILE), `${JSON.stringify(corpus, null, 2)}\n`);
};

/**
 * `personavision calibrate fetch` — UEyes onto the machine, and into this project's own
 * session shape.
 *
 * The download, the verification and the unpacking are `fetchDataset`'s, which prints the
 * licence before it fetches a byte and resumes an interrupted transfer from the bytes on
 * disk. What this adds is the half the step needs after it: the records are read out of the
 * unpacked tree, converted, and written into the cache beside it, with every record that
 * was rejected named with its reason.
 */
export const calibrateFetchCommand = async ({
  cache,
  manifest: manifestPath,
  recordChecksums = false,
  convertOnly = false,
  log = toStdout,
}: CalibrateFetchOptions = {}): Promise<void> => {
  const { manifest, path: resolvedManifestPath } = await manifestFor(manifestPath);
  const environment = cacheEnvironment(cache);
  const paths = datasetCachePaths(manifest.dataset.id, environment);

  if (convertOnly) {
    log(`skipping the download: converting what is already unpacked at ${paths.extracted}`);
  } else {
    try {
      const result = await fetchDataset({
        manifest,
        environment,
        log,
        recordChecksums,
        manifestPath: resolvedManifestPath,
      });
      log('');
      log(`${manifest.dataset.name} is in the cache at ${result.cacheRoot}`);
      for (const file of result.files) {
        const state = file.state === 'downloaded' ? 'downloaded' : 'already present and verified';
        const verified = file.verifiedAgainstManifest
          ? `${file.checksum.algorithm} verified against the manifest`
          : `${file.checksum.algorithm} ${file.checksum.value} recorded`;
        log(`  ${file.path} — ${state}, ${verified}`);
      }
      for (const extraction of result.extractions) {
        const state = extraction.state === 'unpacked' ? 'unpacked' : 'already unpacked';
        log(`  ${extraction.path} — ${state}, ${plural(extraction.entries, 'entry', 'entries')}`);
      }
      for (const change of result.manifestChanges) {
        log(
          change.written
            ? `  recorded a checksum for ${change.filePath} in ${resolvedManifestPath} — review and commit it`
            : `  did not record a checksum for ${change.filePath}: ${change.notWrittenBecause ?? 'the manifest was not rewritten'}`,
        );
      }
    } catch (error) {
      if (!(error instanceof DatasetFetchError)) throw error;
      throw new CliError(error.message, CALIBRATE_EXIT_CODES.fetchFailed);
    }
  }

  log('');
  log(`converting ${manifest.dataset.name} into sessions`);
  const { records, unreadable } = await readDatasetRecords(manifest, paths.extracted);
  const { sessions, rejections } = convertRecords(records.map(({ raw }) => raw));
  const convertedDir = join(paths.root, CONVERTED_DIRECTORY);
  const converted = new Set(sessions.map(({ recordId }) => recordId));
  const scorable = records
    .map(({ groundTruth }) => groundTruth)
    .filter(({ id }) => converted.has(id));

  log(`  read ${plural(records.length, 'record')} from ${paths.extracted}`);
  if (sessions.length > 0) {
    await writeConverted(convertedDir, manifest, sessions, scorable);
    log(
      `  wrote ${plural(sessions.length, 'session')} into ${join(convertedDir, SESSIONS_DIRECTORY)}`,
    );
    log(
      `  wrote ${plural(scorable.length, 'record')} of ground truth into ${join(convertedDir, CORPUS_FILE)}`,
    );
  }
  for (const rejection of rejections) {
    log(`  rejected ${rejection.recordId} at ${rejection.field}: ${rejection.reason}`);
  }
  if (unreadable.length > 0) {
    throw new CliError(
      [
        `${manifest.dataset.name} in the cache could not be converted into sessions:`,
        ...unreadable,
      ].join('\n'),
      CALIBRATE_EXIT_CODES.notConvertible,
    );
  }
  log(
    `  ${plural(sessions.length, 'session')} and ${plural(rejections.length, 'rejected record')}`,
  );
};

// ---------------------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------------------

export interface CalibrateScoreOptions {
  /** Score the converted dataset in the cache instead of the committed corpus. */
  readonly dataset?: boolean;
  readonly cache?: string;
  /** The seed every prediction is made at, so two runs produce identical figures. */
  readonly seed?: number;
  readonly log?: Log;
  /** Where the engine's figures are printed to; progress goes to stderr, not into a pipe. */
  readonly progress?: Log;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `width` × `height`, or `null` when the value is not a positive size. */
const positiveSize = (
  value: unknown,
): { readonly width: number; readonly height: number } | null =>
  isObject(value) &&
  typeof value.width === 'number' &&
  typeof value.height === 'number' &&
  value.width > 0 &&
  value.height > 0
    ? { width: value.width, height: value.height }
    : null;

/**
 * One record of `corpus.json`, checked for what the scoring depends on.
 *
 * It is not a schema validator — the reader that writes this file is the only thing that
 * writes it, and `packages/calibration` holds every rule about what a record means. What
 * this catches is the realistic accident: a truncated file, a cache written by an older
 * version of the reader, a record hand-edited in the cache. Without it a missing field
 * reaches a metric and comes back as a Node stack trace about `path.resolve`, which names
 * neither the file nor the record — and a `CliError` exists precisely so that the message
 * is the whole output.
 */
const parseCorpusRecord = (
  corpusPath: string,
  position: number,
  value: unknown,
): GroundTruthRecord => {
  const refuse = (field: string, expectation: string): never => {
    const named =
      isObject(value) && typeof value.id === 'string' ? value.id : `records[${String(position)}]`;
    throw new CliError(
      `${corpusPath} is not a corpus this can score: record ${named} — ${field} ${expectation}. Delete the converted directory and run \`personavision calibrate fetch\` again.`,
      CALIBRATE_EXIT_CODES.noConvertedDataset,
    );
  };
  if (!isObject(value)) return refuse(`records[${String(position)}]`, 'is not an object');
  if (typeof value.id !== 'string' || value.id === '') return refuse('id', 'is not a name');
  if (
    typeof value.category !== 'string' ||
    !(RECORD_CATEGORIES as readonly string[]).includes(value.category)
  ) {
    return refuse('category', `is not one of ${RECORD_CATEGORIES.join(', ')}`);
  }
  if (typeof value.imagePath !== 'string' || value.imagePath === '') {
    return refuse('imagePath', 'is not a path to the image the humans saw');
  }
  if (positiveSize(value.imageSize) === null) return refuse('imageSize', 'is not a positive size');
  if (!isObject(value.display)) {
    return refuse(
      'display',
      'is missing, and a prediction is made at the resolution the humans saw and never at a default',
    );
  }
  const map = value.saliencyMap;
  const resolution = positiveSize(map);
  if (!isObject(map) || resolution === null) {
    return refuse('saliencyMap', 'has no positive resolution');
  }
  const cells = resolution.width * resolution.height;
  if (!Array.isArray(map.values) || map.values.length !== cells) {
    return refuse('saliencyMap.values', `is not ${String(cells)} cells`);
  }
  if (!Array.isArray(value.scanpaths) || value.scanpaths.length === 0) {
    return refuse(
      'scanpaths',
      'is empty, and a record with no human gaze is nothing to score against',
    );
  }
  return value as unknown as GroundTruthRecord;
};

/**
 * The converted dataset in the cache, as a corpus to score.
 *
 * Absent, this names the command that produces one rather than scoring the committed corpus
 * instead: a figure quoted as a UEyes score when it was measured on four synthetic records
 * would be exactly the dishonesty this step exists to prevent.
 */
const loadConvertedCorpus = async (
  manifest: DatasetManifest,
  root: string,
): Promise<ScoredCorpus> => {
  const convertedDir = join(root, CONVERTED_DIRECTORY);
  const corpusPath = join(convertedDir, CORPUS_FILE);
  if (!(await fileExists(corpusPath))) {
    throw new CliError(
      [
        `there is no converted dataset in the cache: ${corpusPath} is not there.`,
        '`personavision calibrate fetch` is the command that produces one — it downloads and verifies the dataset, then converts it into sessions and the ground truth this reads.',
        'Without it, `personavision calibrate score` scores the committed synthetic corpus, whose figures are not a published UEyes score.',
      ].join('\n'),
      CALIBRATE_EXIT_CODES.noConvertedDataset,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(corpusPath, 'utf8'));
  } catch (cause) {
    throw new CliError(
      `${corpusPath} is not readable as a converted corpus: ${(cause as Error).message}. Delete it and run \`personavision calibrate fetch\` again.`,
      CALIBRATE_EXIT_CODES.noConvertedDataset,
    );
  }
  if (!isObject(parsed) || parsed.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    throw new CliError(
      `${corpusPath} is version ${JSON.stringify(isObject(parsed) ? parsed.schemaVersion : null)}, and this command writes and reads version ${String(CORPUS_SCHEMA_VERSION)}. Run \`personavision calibrate fetch\` again to rewrite it.`,
      CALIBRATE_EXIT_CODES.noConvertedDataset,
    );
  }
  if (!Array.isArray(parsed.records)) {
    throw new CliError(
      `${corpusPath} carries no list of records. Run \`personavision calibrate fetch\` again to rewrite it.`,
      CALIBRATE_EXIT_CODES.noConvertedDataset,
    );
  }
  const dataset = isObject(parsed.dataset) ? parsed.dataset : {};
  const records = parsed.records.map((value, position) => {
    const record = parseCorpusRecord(corpusPath, position, value);
    // Written relative so the cache can be moved; resolved here so a predictor reads bytes.
    return { ...record, imagePath: resolve(convertedDir, record.imagePath) };
  });
  return {
    id: typeof dataset.id === 'string' ? dataset.id : manifest.dataset.id,
    label: typeof dataset.label === 'string' ? dataset.label : manifest.dataset.name,
    // Converted UEyes records are the real thing: a figure measured on them is comparable.
    synthetic: false,
    records,
  };
};

/** One scope's figures, with the record count they rest on, and both margins under them. */
const aggregateLines = (
  heading: string,
  note: string,
  aggregate: Aggregate | null,
  margins: readonly { readonly label: string; readonly figures: MarginFigures | null }[],
): readonly string[] => {
  if (aggregate === null) {
    return [`${heading} — no record produced a figure, so there is none to print${note}`];
  }
  return [
    `${heading} — ${plural(aggregate.records, 'record')}${note}`,
    `  ${metricRow(aggregate.saliency, aggregate.scanpath, figure)}`,
    ...(aggregate.ceiling === null
      ? ['  human-to-human ceiling: none — no record of this scope has two participants to agree']
      : [
          `  human-to-human ceiling over ${plural(aggregate.ceilingRecords, 'record')}: scanMatch ${figure(aggregate.ceiling.scanMatch)}  sequenceScore ${figure(aggregate.ceiling.sequenceScore)}`,
        ]),
    ...margins.map(({ label, figures }) =>
      figures === null
        ? `  over ${label}: no record both scored, so there is no margin`
        : `  over ${label} (${plural(figures.records, 'record')}): ${metricRow(figures.saliency, figures.scanpath, signed)}`,
    ),
  ];
};

const scoreLines = (result: ScoreResult): readonly string[] => {
  const label = (baselineId: string): string =>
    result.baselines.find(({ id }) => id === baselineId)?.label ?? baselineId;
  const lines: string[] = [];

  for (const category of RECORD_CATEGORIES) {
    lines.push(
      ...aggregateLines(
        category,
        // The web category is named rather than folded into the average: webpages are what
        // this product is for, and a good mean over four categories can hide a bad one.
        category === 'webpage' ? ' (what this product is for: the category the badge quotes)' : '',
        result.predictor.categories[category],
        result.margins.map((margin) => ({
          label: label(margin.baselineId),
          figures: margin.categories[category],
        })),
      ),
      '',
    );
  }
  lines.push(
    ...aggregateLines(
      `overall, every category of ${result.provenance.corpus.label}`,
      '',
      result.predictor.overall,
      result.margins.map((margin) => ({
        label: label(margin.baselineId),
        figures: margin.overall,
      })),
    ),
  );
  return lines;
};

/**
 * `personavision calibrate score` — how human-like the engine is right now, per category
 * and overall, with the baselines and the record counts a figure is only meaningful beside.
 */
export const calibrateScoreCommand = async ({
  dataset = false,
  cache,
  seed = 1,
  log = toStdout,
  progress = (line) => process.stderr.write(`${line}\n`),
}: CalibrateScoreOptions = {}): Promise<void> => {
  const manifest = loadManifest();
  const corpus = dataset
    ? await loadConvertedCorpus(
        manifest,
        datasetCachePaths(manifest.dataset.id, cacheEnvironment(cache)).root,
      )
    : committedCorpus();

  log(
    `scoring the engine over ${corpus.label}${corpus.synthetic ? ' — synthetic records, so these figures are not a published UEyes score' : ''}`,
  );
  if (corpus.records.length === 0) {
    log(
      `${corpus.label} holds no record, so there is no figure to print. \`personavision calibrate fetch\` is the command that fills it.`,
    );
    return;
  }
  log(`  ${plural(corpus.records.length, 'record')}, seed ${String(seed)}`);
  log(
    '  higher is better for cc, nss, auc-judd, scanMatch and sequenceScore; kld is lower-is-better, so a negative kld margin is the good one',
  );
  log('');

  const result = await score({
    predictor: enginePredictor(),
    corpus,
    seed,
    onProgress: ({ message }) => progress(message),
  });

  for (const line of scoreLines(result)) log(line);
  for (const failure of result.predictor.failures) {
    log(`  ${failure.recordId} (${failure.category}) produced no figure: ${failure.reason}`);
  }
};

// ---------------------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------------------

export interface CalibrateFitOptions {
  /** Write the fitted configuration. Without it nothing is written. */
  readonly write?: boolean;
  /** Where to write it; the engine's own `config/calibrated.json` by default. */
  readonly out: string;
  readonly seed?: number;
  readonly candidates?: number;
  readonly log?: Log;
  readonly progress?: Log;
}

/** The searched parameters whose fitted value differs from the committed one, by path. */
const valueChanges = (
  committed: Readonly<Record<string, number>> | null,
  fitted: Readonly<Record<string, number>>,
): readonly string[] =>
  Object.entries(fitted).flatMap(([path, value]) => {
    const was = committed?.[path];
    if (was === value) return [];
    return [`  ${path}  ${was === undefined ? '(not recorded)' : String(was)} → ${String(value)}`];
  });

const fitLines = (result: FitResult): readonly string[] => {
  const { best, defaults, objective } = result;
  return [
    `objective ${objective.id} (${objective.label})`,
    `  measured over ${plural(best.objective.records, `${objective.scope} record`)} of ${result.corpus.label}`,
    `  defaults    ${figure(defaults.objective.value)}  cc ${figure(defaults.objective.saliency.cc)}  scanMatch ${figure(defaults.objective.scanpath.scanMatch)}`,
    `  fitted      ${figure(best.objective.value)}  cc ${figure(best.objective.saliency.cc)}  scanMatch ${figure(best.objective.scanpath.scanMatch)}`,
    `  improvement ${signed(best.objective.value - defaults.objective.value)} at candidate ${String(best.candidate.index)}`,
    ...(result.fitted.overall === null
      ? ['  over the whole corpus: no record produced a figure']
      : [
          `  over the whole corpus (${plural(result.fitted.overall.records, 'record')}): ${metricRow(result.fitted.overall.saliency, result.fitted.overall.scanpath, figure)}`,
        ]),
    `  ${plural(result.enginePasses, 'engine pass', 'engine passes')} in ${String(Math.round(result.elapsedMs))} ms`,
    ...(result.pinned.length === 0
      ? []
      : [
          `  left at the engine's default, because the objective could not tell them apart: ${result.pinned.join(', ')}`,
        ]),
    ...result.atBound.map(
      ({ path, bound, value }) =>
        `  ON ITS BOUND: ${path} is ${String(value)}, the ${bound} of its range — the bound chose it, not the data`,
    ),
  ];
};

/**
 * `personavision calibrate fit` — the engine's weights fitted rather than chosen.
 *
 * A seeded, bounded search over the engine's own configuration object, maximising the web
 * category's CC plus ScanMatch. **Nothing is written without `--write`**: the command prints
 * the change it would make and touches no file, because a fit is a claim about the product
 * and overwriting the committed one from an exploratory run is how that claim gets lost.
 */
export const calibrateFitCommand = async ({
  write = false,
  out,
  seed = FIT_DEFAULTS.seed,
  candidates = FIT_DEFAULTS.candidates,
  log = toStdout,
  progress = (line) => process.stderr.write(`${line}\n`),
}: CalibrateFitOptions): Promise<void> => {
  const committedFit = FIT_DEFAULTS.seed === seed && FIT_DEFAULTS.candidates === candidates;
  log(
    `fitting the engine over the committed corpus: ${plural(candidates, 'candidate')} beside the defaults, seed ${String(seed)}`,
  );
  if (!committedFit) {
    log(
      `  this is not the committed fit (seed ${String(FIT_DEFAULTS.seed)}, ${plural(FIT_DEFAULTS.candidates, 'candidate')}); \`${FIT_DEFAULTS.command}\` is the one command that reproduces that one`,
    );
  }

  const result = await fit({ seed, candidates, onProgress: ({ message }) => progress(message) });
  const record = calibratedRecordOf(result);
  const text = `${JSON.stringify(record, null, 2)}\n`;

  log('');
  for (const line of fitLines(result)) log(line);
  log('');

  let committedValues: Readonly<Record<string, number>> | null = null;
  if (await fileExists(out)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(out, 'utf8'));
      const fitBlock = isObject(parsed) && isObject(parsed.fit) ? parsed.fit : null;
      committedValues =
        fitBlock !== null && isObject(fitBlock.values)
          ? (fitBlock.values as Readonly<Record<string, number>>)
          : null;
    } catch {
      // A file this command cannot read is still a file it would replace: say so below
      // rather than refusing, and let the change be "every value".
      committedValues = null;
    }
  }
  const changes = valueChanges(committedValues, record.fit.values);

  if (!write) {
    log(`the change it would make to ${out}:`);
    if (changes.length === 0) {
      log('  none — the fitted values are the ones already recorded there');
    } else {
      for (const change of changes) log(change);
    }
    log('nothing was written. Pass --write to write it.');
    return;
  }

  try {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
  } catch (cause) {
    throw new CliError(
      `the calibrated configuration could not be written to ${out}: ${(cause as Error).message}`,
      CALIBRATE_EXIT_CODES.notWritten,
    );
  }
  for (const change of changes) log(change);
  log(`wrote ${out}`);
};
