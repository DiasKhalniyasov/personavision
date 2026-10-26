/**
 * `@personavision/engine` — the session engine.
 *
 * Drives a persona through a variant and emits a session: screens, fixations, saccades,
 * actions and an outcome, in both the offline deterministic mode and the model-backed one,
 * and aggregates a run's sessions into the per-area-of-interest numbers the screens read.
 *
 * The engine is **pure**: a capture plus state in, fixations out. It reads no file, opens
 * no socket and calls no model — see `packages/engine/README.md`.
 */

export { aoiId, buildAois, defaultSegmenter, noSegmenter } from './aois/index.js';
export type {
  AoiIdentity,
  Awaitable,
  BuildAoisInput,
  SegmentedArea,
  Segmenter,
  SegmenterInput,
} from './aois/index.js';

export { aggregate } from './aggregate.js';
export type { Aoi, AoiMetric } from './aggregate.js';

export { defaultEngineConfig, resolveEngineConfig } from './config.js';
export type {
  EngineConfig,
  EngineConfigOverrides,
  GoalVerbRoleWeights,
  ResolvedEngineConfig,
  RolePriors,
  TraitResponse,
} from './config.js';

export {
  CONVENTIONAL_CONTROL_ROLES,
  fixationCountFor,
  fixationDurationMedianMsFor,
  personaSamplingParams,
  rolePriorFor,
} from './persona.js';
export type { PersonaSamplingParams, PersonaTraits } from './persona.js';

export {
  drawFixationDurationMs,
  drawLandingPoint,
  drawSaccadeAmplitudePx,
  nextFixationStart,
  saccadeDurationMsFor,
} from './sampling/distributions.js';
export type { FixationClock, LandingPoint, NextFixationStart } from './sampling/distributions.js';

export type {
  BoundingBox,
  Capture,
  CaptureElement,
  ElementSource,
  Goal,
  Viewport,
} from './types.js';
