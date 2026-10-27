/**
 * The fit (#90): the engine's weights, fitted rather than chosen.
 *
 * A seeded, bounded random search over the engine's own configuration object (#56),
 * maximising the web category's CC plus ScanMatch as #88 measures them, with the result
 * committed as data at `packages/engine/config/calibrated.json`. `docs/fitting.md` records
 * the search space, the objective, the seed, the cost and the one command that repeats it.
 */

export { FitError, OBJECTIVE, objectiveOf } from './objective.js';
export type {
  Objective,
  ObjectiveMetricId,
  ObjectiveTerm,
  ObjectiveTermValue,
  ObjectiveValue,
} from './objective.js';

export {
  CALIBRATED_SCHEMA_VERSION,
  FIT_DEFAULTS,
  SEARCH_COST,
  SEARCH_KIND,
  SEARCH_SPACE,
  calibratedRecordOf,
  comparableFit,
  defaultAt,
  fit,
  gridCandidates,
} from './search.js';
export type {
  BoundReached,
  CalibratedFileRecord,
  Candidate,
  CorpusFigures,
  FitOptions,
  FitProgress,
  FitResult,
  ScoredCandidate,
  SearchParameter,
} from './search.js';
