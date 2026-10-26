/**
 * `@personavision/calibration` — the one place in this project where a human-likeness figure
 * is produced.
 *
 * It scores the attention engine's predicted saliency maps and scanpaths against the UEyes
 * benchmark (CHI 2023), reports the figures per UI category against two baselines, and fits
 * the engine's configuration to them. The badge the product shows on every screen reads the
 * result, so an honest low number is better than a flattering one.
 *
 * This ticket (#81) is the ground the rest of step #11 stands on: the vocabulary, the dataset
 * manifest and the cache policy. The metrics, the corpus, the download, the conversion, the
 * baselines, the scoring and the fit arrive as later tickets and export from here.
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
  CACHE_ENV_VAR,
  CachePathError,
  cacheRoot,
  datasetCachePaths,
  isContainedRelativePath,
  isDatasetId,
} from './dataset/cache.js';
export type { CacheEnvironment, DatasetCachePaths } from './dataset/cache.js';
