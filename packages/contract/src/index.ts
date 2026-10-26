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
  findingsSchema,
  personaSchema,
  runRequestSchema,
  runSchema,
  runUsageSchema,
  SCHEMA_VERSION,
  sessionSchema,
  verdictSchema,
  ZERO_USAGE,
} from './schemas.js';
export type {
  Audience,
  AudienceDevice,
  Findings,
  Persona,
  Run,
  RunFailure,
  RunProgress,
  RunRequest,
  RunStatus,
  RunUsage,
  Score,
  Session,
  SessionProgress,
  Verdict,
  VariantProgress,
} from './schemas.js';

export { listRunDirs, runDirName, runPaths } from './paths.js';
export type { RunPaths } from './paths.js';

export { appendFinishedSession, readRun, validate, writeRun } from './io.js';
export type { RunArtifact, Violation } from './io.js';

export { createSeededRandom } from './random.js';
