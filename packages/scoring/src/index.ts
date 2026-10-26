/**
 * `@personavision/scoring` — the friction score, the verdict and the findings.
 *
 * Owns the component weights and turns sessions into a friction score, its components, the
 * per-seed-group spread and the verdict. The score band thresholds themselves are read from
 * `docs/design/tokens.css`, never restated here.
 *
 * Pure functions over contract-typed data: no disk, no network, no browser. Every field
 * name comes from `@personavision/contract`, which is this package's only dependency.
 *
 * The whole agreed surface is declared here, including the functions that are not built
 * yet (`verdict`), whose bodies throw and name the ticket that fills them. That is
 * deliberate scaffolding, not an oversight: #27 replaces one body and does not have to
 * edit this file. `findings` was one of them until #28 built it, and
 * `evaluateAgainstPlantedDefects` until #29. `findingRuleIdOf` is #28's one addition to
 * this surface — `findings.json` carries no field for the rule behind a finding, and the
 * planted-defect evaluation matches by rule, so the rule is read back off the finding's
 * id through that function.
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

export { findings, findingRuleIdOf } from './findings/index.js';
export type { Finding, FindingsGenerator } from './findings/index.js';

export { evaluateAgainstPlantedDefects } from './evaluate.js';
export type { PlantedDefect, PlantedDefectEvaluation, PlantedDefectEvaluator } from './evaluate.js';
