/**
 * `@personavision/contract` — the run artifact.
 *
 * This package is the only place in the repository where an artifact field name or a
 * run-directory path is declared: the zod schemas, the types inferred from them, the
 * reader and writer for a run directory, and `validate`. Every other package imports
 * them instead of restating a name.
 */

export {
  aggregateSchema,
  audienceSchema,
  AUTOMATION_FAILURE_NOTICE_SHARE,
  automationFailureNoticeIsDue,
  changeSchema,
  EVIDENCE_LINK_PARAMS,
  findingsSchema,
  goalSchema,
  HEATMAP_OVERLAYS,
  holdoutVerdictSchema,
  improveSchema,
  modelModeSchema,
  personaSchema,
  previewSchema,
  recommendationsSchema,
  runRequestSchema,
  runSchema,
  runUsageSchema,
  SCHEMA_VERSION,
  sessionSchema,
  sessionVideoSchema,
  verdictSchema,
  VIDEO_CAP_MS,
  videoCapSchema,
  ZERO_USAGE,
} from './schemas.js';
export type {
  AgeGroup,
  Aggregate,
  Audience,
  AudienceAgeGroup,
  AudienceDevice,
  Change,
  Citation,
  Distribution,
  EvidenceLinkParam,
  Findings,
  FunnelSlice,
  Gender,
  GenderSplit,
  Goal,
  GoalAuthor,
  Holdout,
  HoldoutFigures,
  HoldoutVerdict,
  Improve,
  ModelMode,
  Persona,
  Preview,
  PullRequest,
  Recommendation,
  Recommendations,
  Run,
  RunFailure,
  RunProgress,
  RunRequest,
  RunStatus,
  RunUsage,
  SampleProvenance,
  Score,
  ScreenSlice,
  Session,
  SessionProgress,
  SessionVideo,
  Verdict,
  VariantProgress,
  VideoCap,
  WriteUpClaim,
} from './schemas.js';

export { runDirName, runPaths } from './paths.js';
export type { RunPaths } from './paths.js';

export {
  appendFinishedSession,
  listRunDirs,
  readRun,
  validate,
  writeAggregate,
  writeRun,
  writeSession,
} from './io.js';
export type { RunArtifact, Violation } from './io.js';

export { validateRecommendations } from './recommendations.js';
export type { CitedRun } from './recommendations.js';

export {
  createGoogleStorageTransport,
  createObjectVideoStore,
  NO_LONGER_KEPT,
  NO_LONGER_KEPT_STATE,
  selectVideoStore,
  SIGNED_URL_TTL_SECONDS,
  VIDEO_BUCKET_ENV,
  videoObjectName,
  VideoStoreRefused,
} from './video-store.js';
export type {
  ObjectVideoStoreOptions,
  SelectVideoStoreOptions,
  VideoLocation,
  VideoObjectTransport,
  VideoStore,
} from './video-store.js';

export { createSeededRandom } from './random.js';
