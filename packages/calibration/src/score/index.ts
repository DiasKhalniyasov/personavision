/**
 * Scoring (#88): the one place a human-likeness figure is produced.
 *
 * The engine is scored through its published `predict` beside both baselines (#87) over a
 * corpus (#82), with the saliency metrics (#83) and the scanpath metrics (#84), and the
 * figures come back per record, per category and overall with the provenance they have to be
 * quoted with. The fit (#90) maximises what `score` returns and the committed report (#89)
 * prints it.
 */

export {
  CENTRE_BIAS_PREDICTOR_ID,
  COMMITTED_CORPUS_ID,
  ENGINE_PREDICTOR_ID,
  RANDOM_FIXATION_PREDICTOR_ID,
  SCORING_BUDGET,
  ScoreError,
  centreBiasPredictor,
  committedCorpus,
  comparableFigures,
  defaultBaselines,
  enginePredictor,
  randomFixationPredictor,
  score,
} from './score.js';
export type {
  Aggregate,
  CategoryAggregates,
  EnginePredictorOptions,
  MapKernelDivergence,
  MapKernelProvenance,
  Margin,
  MarginFigures,
  PredictorFigures,
  PredictorProvenance,
  RecordFailure,
  RecordFigures,
  ScoreOptions,
  ScoreProgress,
  ScoreProvenance,
  ScoreResult,
  ScoredCorpus,
  ScoredPredictor,
} from './score.js';
