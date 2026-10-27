/**
 * The two baselines a score can mean something against (#87), and the one function that
 * renders fixations into a saliency map.
 *
 * A similarity figure with nothing beside it is decoration. These two give it a floor and a
 * reference: the random-fixation baseline is what a predictor that looks in the wrong places
 * scores, and the centre-bias prior is what a predictor that knows only where pictures
 * usually get looked at scores. [`../../docs/baselines.md`](../../docs/baselines.md) states
 * what each one is and is not evidence of, and #88 reports both beside the engine's figure.
 *
 * Both satisfy the `Predictor` seam `src/types.ts` declares, and neither imports
 * `packages/engine`: the map rendering mirrors the engine's documented kernel in data and in
 * the doc, which is the only way two packages can be held together when one may not read the
 * other.
 */

export { BaselineError, MAP_RENDERING, mapResolution, renderSaliencyMap } from './render-map.js';
export type { MapPoint, MapRenderingParameters } from './render-map.js';

export {
  CENTRE_BIAS_PRIOR,
  centreBiasBaseline,
  centreBiasPeakCell,
  centreBiasPrior,
} from './centre-bias.js';

export {
  BASELINE_SCANPATH,
  RANDOM_FIXATION_UNIFORMITY,
  randomFixationBaseline,
  sampleDurationMs,
  scanpathOf,
} from './random-fixations.js';
