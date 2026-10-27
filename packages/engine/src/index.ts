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

export { aggregate } from './aggregate.js';
export type { Aoi, AoiMetric } from './aggregate.js';

export {
  aoiId,
  buildAois,
  DEFAULT_SAM_TIMEOUT_MS,
  defaultSegmenter,
  heuristicSegmenter,
  noSegmenter,
  SAM_CREDENTIAL_ENV,
  SAM_RESPONSES_ENDPOINT,
  SAM_UNAVAILABLE_REASONS,
  samSegmenter,
  UNNAMED_SEGMENT_LABEL,
} from './aois/index.js';
export type {
  AoiIdentity,
  BuildAoisInput,
  HeuristicSegmenterOptions,
  ImageReader,
  RasterImage,
  SamContentPart,
  SamHttpRequest,
  SamHttpResponse,
  SamRequestBody,
  SamScreenshotReader,
  SamSegmentation,
  SamSegmenterOptions,
  SamTransport,
  SamUnavailable,
  SamUnavailableReason,
  SegmentedArea,
  Segmenter,
  SegmenterInput,
} from './aois/index.js';

export { defaultEngineConfig, resolveEngineConfig } from './config.js';
export type {
  CalibratedMetrics,
  CalibratedRecord,
  EngineConfig,
  EngineConfigOverrides,
  GoalVerbRoleWeights,
  PredictionConfig,
  ResolvedEngineConfig,
  RolePriors,
  SegmentationConfig,
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

export { predict } from './predict.js';
export type {
  Display,
  ImageSize,
  PredictedFixation,
  PredictedScanpath,
  Prediction,
  PredictOptions,
  PredictorImage,
  SaliencyMap,
  SaliencyNormalisation,
} from './predict.js';

export { relevanceByArea } from './relevance.js';
export type { RelevanceArea, RelevanceHints, RelevanceInput } from './relevance.js';

export {
  SALIENCE_TERMS,
  readScreenshotPixels,
  salienceByArea,
  salienceTermsByArea,
} from './salience.js';
export type {
  AreaSalience,
  PageBox,
  SalienceInput,
  SalienceTerm,
  SalienceTerms,
  ScreenshotPixels,
} from './salience.js';

export {
  drawFixationDurationMs,
  drawLandingPoint,
  drawSaccadeAmplitudePx,
  heldByInhibition,
  historyByArea,
  historyTermFor,
  inHistoryOrder,
  isDeliberateReturn,
  nextFixationStart,
  saccadeDurationMsFor,
  sampleFixations,
  screenFixationCount,
} from './sampling/index.js';
export type {
  AreaHistory,
  FixationClock,
  HistoryFixation,
  LandingPoint,
  NextFixationStart,
  SampleFixationsInput,
  SampledFixation,
  SampledSaccade,
  SampledScanpath,
  SamplerArea,
  ViewingHistory,
} from './sampling/index.js';

export type {
  BoundingBox,
  Capture,
  CaptureElement,
  ElementSource,
  Goal,
  Viewport,
} from './types.js';

export { ENGINE_VERSION } from './version.js';
