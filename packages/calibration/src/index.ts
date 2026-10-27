/**
 * `@personavision/calibration` — the one place in this project where a human-likeness figure
 * is produced.
 *
 * It scores the attention engine's predicted saliency maps and scanpaths against the UEyes
 * benchmark (CHI 2023), reports the figures per UI category against two baselines, and fits
 * the engine's configuration to them. The badge the product shows on every screen reads the
 * result, so an honest low number is better than a flattering one.
 *
 * #81 laid the ground the rest of step #11 stands on: the vocabulary, the dataset manifest and
 * the cache policy, and #82 the committed synthetic corpus every later ticket tests against.
 * #83 adds the four saliency metrics a predicted map is compared with a human one by, and
 * #84 the two scanpath metrics that read the order attention was paid in rather than only
 * where it landed. #85 brings the real benchmark onto the machine: one resumable,
 * checksum-verified download into the cache outside this repository. #86 converts a record
 * of it into the project's own session shape, as `kind: "real"` with a participant, so a
 * human's free viewing and a simulated session are two files of one shape. #87 adds the two
 * baselines a figure is quoted against — the centre-bias prior and random fixations — with
 * the one map-rendering function that mirrors the engine's documented kernel. The scoring
 * and the fit arrive as later tickets and export from here.
 *
 * **The dependency runs one way.** This package reads `@personavision/contract` and may later
 * read the engine; nothing in `packages/engine` or `apps/viewer` reads this package, because
 * the engine is pure and the viewer only formats. `test/dependency-direction.test.ts` asserts
 * it.
 */

export { RECORD_CATEGORIES, VIEWING_DURATIONS_SECONDS } from './types.js';
export type {
  Display,
  Fixation,
  GroundTruthRecord,
  ImageSize,
  Prediction,
  Predictor,
  PredictorImage,
  RecordCategory,
  SaliencyMap,
  SaliencyNormalisation,
  Scanpath,
  ViewingDurationSeconds,
  Viewport,
} from './types.js';

export {
  CORPUS_RECORD_NAMES,
  CorpusError,
  loadCorpus,
  loadCorpusCategory,
  loadCorpusRecord,
} from './corpus.js';
export type { CorpusRecordData, CorpusRecordName } from './corpus.js';

export {
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  describeChecksum,
  loadManifest,
  parseManifest,
  recordedChecksum,
  unverifiedFiles,
} from './dataset/manifest.js';
export type {
  ArchiveLayout,
  ArchiveRoot,
  ChecksumAlgorithm,
  ChecksumSource,
  DatasetDescription,
  DatasetLicence,
  DatasetManifest,
  DatasetPaper,
  DatasetSource,
  FileChecksum,
  LayoutEntry,
  ManifestFile,
  RecordedChecksum,
  UnverifiedChecksum,
} from './dataset/manifest.js';

export {
  SALIENCY_METRIC_IDS,
  SALIENCY_METRIC_PARAMETERS,
  SALIENCY_METRICS,
  SaliencyMetricError,
  aucJudd,
  cc,
  kld,
  nss,
  poolFixations,
  resampleSaliencyMap,
  saliencyMetric,
  scoreSaliency,
} from './metrics/index.js';
export type {
  MetricDirection,
  SaliencyGroundTruth,
  SaliencyMetricDescriptor,
  SaliencyMetricId,
  SaliencyMetricInputs,
  SaliencyScores,
} from './metrics/index.js';

export {
  SCANPATH_CHANCE,
  SCANPATH_METRIC_IDS,
  SCANPATH_METRIC_PARAMETERS,
  SCANPATH_METRICS,
  SCANPATH_REGION_COUNT,
  ScanpathMetricError,
  needlemanWunsch,
  regionOfFixation,
  scanMatch,
  scanMatchLetters,
  scanMatchSubstitutionMatrix,
  scanpathMetric,
  scoreScanpath,
  scoreScanpathAgainstHumans,
  sequenceScore,
  visitedRegions,
} from './metrics/index.js';
export type {
  AlignedPair,
  Alignment,
  ScanpathAgreement,
  ScanpathGroundTruth,
  ScanpathMetricDescriptor,
  ScanpathMetricId,
  ScanpathMetricInputs,
  ScanpathScores,
} from './metrics/index.js';

export {
  CACHE_ENV_VAR,
  CachePathError,
  cacheRoot,
  datasetCachePaths,
  isContainedRelativePath,
  isDatasetId,
} from './dataset/cache.js';
export type { CacheEnvironment, DatasetCachePaths } from './dataset/cache.js';

// The download (#85). The command is one function; the zip reader, the quarantine and the
// manifest edit `--record-checksums` makes are its own business and are reached through it.
export {
  DEFAULT_CHECKSUM_ALGORITHM,
  VerificationError,
  hashFile,
  verifyFile,
} from './dataset/verify.js';
export type { ChecksumVerdict, ManifestChecksumChange } from './dataset/verify.js';

export { COMMITTED_MANIFEST_PATH, DatasetFetchError, fetchDataset } from './dataset/fetch.js';
export type {
  ExtractionOutcome,
  FetchDatasetOptions,
  FetchDatasetResult,
  FetchFailure,
  FileOutcome,
} from './dataset/fetch.js';

// The baselines (#87): the floor and the reference a human-likeness figure is quoted
// against, plus the one map-rendering function both of them and #88 state their maps by.
export {
  BASELINE_SCANPATH,
  BaselineError,
  CENTRE_BIAS_PRIOR,
  MAP_RENDERING,
  RANDOM_FIXATION_UNIFORMITY,
  centreBiasBaseline,
  centreBiasPeakCell,
  centreBiasPrior,
  mapResolution,
  randomFixationBaseline,
  renderSaliencyMap,
  sampleDurationMs,
  scanpathOf,
} from './baselines/index.js';
export type { MapPoint, MapRenderingParameters } from './baselines/index.js';

// The conversion (#86): a UEyes record becomes sessions with `kind: "real"`, which the
// contract's session schema accepts beside a simulated one.
export { ConversionError, convertRecord, convertRecords } from './convert/index.js';
export type {
  ConversionRejection,
  ConversionReport,
  ConvertOptions,
  ConvertedSession,
  RawDisplay,
  RawFixation,
  RawImage,
  RawRecord,
  RawScanpath,
} from './convert/index.js';
