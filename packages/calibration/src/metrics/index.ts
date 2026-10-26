/**
 * The metrics this step scores a prediction with: the four saliency metrics (#83), which read
 * where attention landed, and the two scanpath metrics (#84), which read the order it landed
 * in.
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

export {
  SCANPATH_CHANCE,
  SCANPATH_METRIC_IDS,
  SCANPATH_METRIC_PARAMETERS,
  SCANPATH_METRICS,
  SCANPATH_REGION_COUNT,
  ScanpathMetricError,
  needlemanWunsch,
  regionOfFixation,
  scanMatch,
  scanMatchLetters,
  scanMatchSubstitutionMatrix,
  scanpathMetric,
  scoreScanpath,
  scoreScanpathAgainstHumans,
  sequenceScore,
  visitedRegions,
} from './scanpath.js';
export type {
  AlignedPair,
  Alignment,
  ScanpathAgreement,
  ScanpathGroundTruth,
  ScanpathMetricDescriptor,
  ScanpathMetricId,
  ScanpathMetricInputs,
  ScanpathScores,
} from './scanpath.js';
