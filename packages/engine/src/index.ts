/**
 * `@personavision/engine` — the session engine.
 *
 * Drives a persona through a variant and emits a session: screens, fixations, saccades,
 * actions and an outcome, in both the offline deterministic mode and the model-backed one,
 * and aggregates a run's sessions into the per-area-of-interest numbers the screens read.
 */

export { aggregate } from './aggregate.js';
export type { Aoi, AoiMetric } from './aggregate.js';
