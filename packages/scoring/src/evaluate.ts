import type { FindingRuleId } from './config.js';
import { findingRuleIdOf, type Finding } from './findings/index.js';

/**
 * Planted-defect precision and recall: is the findings list right, rather than asserted
 * to be right.
 *
 * The demo shop declares the defects it was built with, and a run's findings are scored
 * against that list. Matching is **by rule id and area of interest**, never by string
 * similarity on claim text: a reworded claim must not change a measured score.
 *
 * This is the measurement that keeps the demo honest. "The top three findings are the
 * three planted defects" is a claim about the product that the demo makes out loud, and
 * this function is the only place it is computed — a reader who distrusts the claim can
 * run the numbers rather than take the sentence's word for it.
 */

/**
 * One defect a variant was built with, as the demo shop declares it.
 *
 * **This is the input the demo shop step (#10) provides.** The shop declares one of these
 * per defect it was built with, naming the rule from `FINDING_RULE_IDS` that should find
 * it and the area of interest it lives in. Everything that is matched against is
 * structural: `description` is for the report and is never read by the evaluation, so the
 * shop may reword it freely.
 */
export interface PlantedDefect {
  readonly id: string;
  /** The rule that should find it. One of `FINDING_RULE_IDS`. */
  readonly ruleId: FindingRuleId;
  readonly variant: string;
  readonly step: string;
  /** `null` when the whole step is the defect rather than one area of it. */
  readonly aoiId: string | null;
  /** What was planted, in words, for the report — never matched against. */
  readonly description: string;
}

/**
 * What the evaluation answers.
 *
 * `matched` has **one entry per declared defect, in declared order**: `findingId` names
 * the finding credited to it, or is `null` when nothing found it. That is what makes a
 * miss readable — a recall of 0.67 says a defect was missed and this says which.
 */
export interface PlantedDefectEvaluation {
  /** Of the findings, the share that name a planted defect. */
  readonly precision: number;
  /** Of the planted defects, the share a finding named. */
  readonly recall: number;
  readonly matched: ReadonlyArray<{
    readonly defectId: string;
    readonly findingId: string | null;
  }>;
}

/** The signature #29 implements. */
export type PlantedDefectEvaluator = (
  findings: readonly Finding[],
  defects: readonly PlantedDefect[],
) => PlantedDefectEvaluation;

/**
 * A finding the product is answerable for, which is what precision is about.
 *
 * The informational note is a finding too, and it names no defect because it is about the
 * run's own shape — our simulation's problem rather than a false claim about the product.
 * Counting it would make precision fall every time we said something honest about our own
 * coverage, so findings attributed to `automation` are neither hits nor false positives:
 * they are not in the denominator at all.
 */
const isAboutTheProduct = (finding: Finding): boolean => finding.attribution !== 'automation';

/**
 * Does this finding name this declared defect?
 *
 * Four structural fields, and no text: the rule behind the finding (read through
 * `findingRuleIdOf`, since `findings.json` carries no field for it) and the area of
 * interest it concerns, which takes all three of variant, step and `aoiId` to identify.
 * `aoiId` alone is not enough, because a rule about a whole step reports `aoiId: null` and
 * two steps of two variants would then look alike.
 *
 * A rule fires at most once per variant, so at most one finding can satisfy this for a
 * given defect and the match never has to choose between two candidates.
 */
const names = (finding: Finding, defect: PlantedDefect): boolean =>
  findingRuleIdOf(finding) === defect.ruleId &&
  finding.variant === defect.variant &&
  finding.step === defect.step &&
  finding.aoiId === defect.aoiId;

/**
 * Precision and recall over a run's findings, against the defects the shop declares.
 *
 * The degenerate cases are defined rather than left to float, and none of them is `NaN`:
 *
 * - **No findings about the product**: precision is 1 — nothing was claimed, so nothing
 *   claimed was wrong. Recall carries the story, and the pair reads "said nothing, found
 *   nothing". Precision alone is never a verdict on a run.
 * - **No declared defects**: recall is 1 — there was nothing to find. Precision is then 0
 *   whenever anything was found, because no finding can name a defect that was declared.
 * - **A finding that names two declared defects**: both defects are credited to it, and it
 *   counts once towards precision. One finding that names two planted defects did find
 *   both of them, and it is still a single claim about the product.
 */
export const evaluateAgainstPlantedDefects: PlantedDefectEvaluator = (findings, defects) => {
  const aboutTheProduct = findings.filter(isAboutTheProduct);

  const matched = defects.map((defect) => ({
    defectId: defect.id,
    findingId: aboutTheProduct.find((finding) => names(finding, defect))?.id ?? null,
  }));

  const found = matched.filter((entry) => entry.findingId !== null);
  const hits = new Set(found.map((entry) => entry.findingId));

  return {
    precision: aboutTheProduct.length === 0 ? 1 : hits.size / aboutTheProduct.length,
    recall: defects.length === 0 ? 1 : found.length / defects.length,
    matched,
  };
};
