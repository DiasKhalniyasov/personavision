import type { FindingRuleId } from './config.js';
import type { Finding } from './findings/index.js';

/**
 * Planted-defect precision and recall: is the findings list right, rather than asserted
 * to be right.
 *
 * The demo shop declares the defects it was built with, and a run's findings are scored
 * against that list. Matching is **by rule id and area of interest**, never by string
 * similarity on claim text: a reworded claim must not change a measured score.
 */

/** One defect a variant was built with, as the demo shop declares it. */
export interface PlantedDefect {
  readonly id: string;
  /** The rule that should find it. */
  readonly ruleId: FindingRuleId;
  readonly variant: string;
  readonly step: string;
  /** `null` when the whole step is the defect rather than one area of it. */
  readonly aoiId: string | null;
  /** What was planted, in words, for the report — never matched against. */
  readonly description: string;
}

/** What the evaluation answers. `matched` pairs each found defect with the finding that found it. */
export interface PlantedDefectEvaluation {
  /** Of the findings, the share that name a planted defect. */
  readonly precision: number;
  /** Of the planted defects, the share a finding named. */
  readonly recall: number;
  readonly matched: ReadonlyArray<{ readonly defectId: string; readonly findingId: string }>;
}

/** The signature #29 implements. */
export type PlantedDefectEvaluator = (
  findings: readonly Finding[],
  defects: readonly PlantedDefect[],
) => PlantedDefectEvaluation;

/**
 * Not built yet: **#29** fills this in. It is declared here, with its agreed signature and
 * the declared-defect shape, so that the demo step can write its defect list against this
 * type before the evaluation exists.
 */
export const evaluateAgainstPlantedDefects: PlantedDefectEvaluator = () => {
  throw new Error(
    'evaluateAgainstPlantedDefects() is not implemented yet: planted-defect precision and recall are ticket #29',
  );
};
