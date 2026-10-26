/**
 * The metrics this step scores a prediction with: the four saliency metrics here (#83), and
 * the two scanpath metrics (#84) exporting from this file when they land.
 *
 * One figure's worth of vocabulary lives in one place, so #88 imports the metrics from here
 * and #89 prints a figure next to the direction it reads in.
 */

export {
  SALIENCY_METRIC_IDS,
  SALIENCY_METRIC_PARAMETERS,
  SALIENCY_METRICS,
  SaliencyMetricError,
  aucJudd,
  cc,
  kld,
  nss,
  poolFixations,
  resampleSaliencyMap,
  saliencyMetric,
  scoreSaliency,
} from './saliency.js';
export type {
  MetricDirection,
  SaliencyGroundTruth,
  SaliencyMetricDescriptor,
  SaliencyMetricId,
  SaliencyMetricInputs,
  SaliencyScores,
} from './saliency.js';
