/**
 * `@personavision/contract` — the run artifact.
 *
 * This package is the only place in the repository where an artifact field name or a
 * run-directory path is declared: the zod schemas, the types inferred from them, the
 * reader and writer for a run directory, and `validate`. Every other package imports
 * them instead of restating a name.
 */

export {
  audienceSchema,
  changeSchema,
  EVIDENCE_LINK_PARAMS,
  findingsSchema,
  goalSchema,
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
  Audience,
  AudienceAgeGroup,
  AudienceDevice,
  Change,
  Citation,
  EvidenceLinkParam,
  Findings,
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
  writeRun,
  writeSession,
} from './io.js';
export type { RunArtifact, Violation } from './io.js';

export { createSeededRandom } from './random.js';
