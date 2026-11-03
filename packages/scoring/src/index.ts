/**
 * `@personavision/scoring` — the friction score, the verdict, the findings and the
 * recommendations.
 *
 * Owns the component weights and turns sessions into a friction score, its components, the
 * per-seed-group spread and the verdict. The score band thresholds themselves are read from
 * `docs/design/tokens.css`, never restated here.
 *
 * Pure functions over contract-typed data: no disk, no network, no browser. Every field
 * name comes from `@personavision/contract`, which is this package's only dependency.
 *
 * The whole agreed surface was declared here before any of it was built, so that #27, #28
 * and #29 could be worked at the same time rather than queueing behind one barrel file:
 * each replaced one body and none of them had to edit this file. All three are built now —
 * `findings` by #28, `evaluateAgainstPlantedDefects` by #29 and `verdict` by #27 — and
 * nothing in that group throws any more. `findingRuleIdOf` is #28's one addition to this
 * surface: `findings.json` carries no field for the rule behind a finding, and the
 * planted-defect evaluation matches by rule, so the rule is read back off the finding's id
 * through it.
 *
 * The **recommendations** surface below is declared the same way, by #252: `sampleSessions`
 * is built, and `buildRecommendations` and `writeUp` throw and name the ticket that fills
 * them (#258 and #260). Each lives in its own file under `recommendations/`, so neither of
 * those tickets edits this file or `recommendations/index.ts` and the two can run at the
 * same time. `recommendations/index.ts` is where that surface is written down.
 *
 * The **aggregate** surface below is declared that way a third time, by #288:
 * `aggregate/sessions.ts` — the one reading of a session every figure of the aggregate
 * shares, and the place a quantile is defined — is built, and the five figure modules
 * throw and name the tickets that fill them (#289, #290, #291 and #292). Each lives in
 * its own file under `aggregate/`, so none of those tickets edits this file or
 * `aggregate/index.ts`, which is where that surface is written down.
 */

export { FINDING_RULE_IDS, scoringConfig } from './config.js';
export type {
  ComponentWeights,
  FindingRuleId,
  FindingThresholds,
  Normalisation,
  ScoringConfig,
  Severity,
} from './config.js';

export { score } from './score.js';
export type { Aoi, AoiMetric, Task, VariantScore } from './score.js';

export { verdict } from './verdict.js';
export type { VerdictWriter } from './verdict.js';

export { judgeHoldout } from './holdout.js';
export type { ChangeUnderTest, HoldoutInput, HoldoutLine } from './holdout.js';

export { findings, findingRuleIdOf } from './findings/index.js';
export type { Finding, FindingsGenerator } from './findings/index.js';

export { evaluateAgainstPlantedDefects } from './evaluate.js';
export type { PlantedDefect, PlantedDefectEvaluation, PlantedDefectEvaluator } from './evaluate.js';

export {
  buildRecommendations,
  SAMPLE_SIZE,
  SAMPLE_STRATEGY,
  sampleSessions,
  WHOLE_RUN_STRATEGY,
  writeUp,
} from './recommendations/index.js';
export type {
  RecommendationsBuilder,
  RecommendationsInput,
  SessionSample,
  SessionSampler,
  WriteUpGenerator,
  WriteUpInput,
} from './recommendations/index.js';

export {
  BIN_COUNT,
  composeAggregate,
  distributionOf,
  funnelOfSlice,
  funnelSliceSpecs,
  pathsOfSlice,
  quantileMs,
  SCORED_OUTCOMES,
  scoredSessions,
  screenFiguresOfSlice,
  screenIndexAt,
  screenSliceSpecs,
  segmentOf,
  stepWalk,
  timingOfSlice,
} from './aggregate/index.js';
export type {
  AggregateComposer,
  AggregateInput,
  FunnelBuilder,
  FunnelInput,
  FunnelSliceSpec,
  PathsBuilder,
  PathsInput,
  ScoredOutcome,
  ScoredSessions,
  ScreenFiguresBuilder,
  ScreenFiguresInput,
  ScreenSliceSpec,
  StepSpan,
  TimingBuilder,
  TimingInput,
} from './aggregate/index.js';
