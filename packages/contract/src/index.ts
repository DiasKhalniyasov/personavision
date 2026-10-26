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
  SCHEMA_VERSION,
  sessionSchema,
  verdictSchema,
} from './schemas.js';
export type {
  Audience,
  AudienceDevice,
  Findings,
  Persona,
  Run,
  RunRequest,
  Score,
  Session,
  Verdict,
} from './schemas.js';

export { listRunDirs, runDirName, runPaths } from './paths.js';
export type { RunPaths } from './paths.js';

export { readRun, validate, writeRun } from './io.js';
export type { RunArtifact, Violation } from './io.js';

export { createSeededRandom } from './random.js';
