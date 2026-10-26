/**
 * The sampling half of the engine: the draws that make a sequence of looks human-like,
 * the viewing history those looks accumulate, and `sampleFixations`, which composes them
 * with salience and relevance into the scanpath a session stores.
 */

export {
  drawFixationDurationMs,
  drawLandingPoint,
  drawSaccadeAmplitudePx,
  nextFixationStart,
  saccadeDurationMsFor,
} from './distributions.js';
export type { FixationClock, LandingPoint, NextFixationStart } from './distributions.js';

export {
  heldByInhibition,
  historyByArea,
  historyTermFor,
  inHistoryOrder,
  isDeliberateReturn,
} from './history.js';
export type { AreaHistory, HistoryFixation, ViewingHistory } from './history.js';

export { sampleFixations, screenFixationCount } from './sample-fixations.js';
export type {
  SampleFixationsInput,
  SampledFixation,
  SampledSaccade,
  SampledScanpath,
  SamplerArea,
} from './sample-fixations.js';
