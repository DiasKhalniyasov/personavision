/**
 * The objective the fit maximises, recorded with its weights (#90).
 *
 * One stated objective, and it is the **web category's CC plus ScanMatch, equally
 * weighted**. Webpages are what this product is for (#11, user story 8), so a fit that
 * raised a good overall mean by improving posters would be fitting the wrong thing; CC says
 * the predicted map lands where the humans looked and ScanMatch says it does so in their
 * order, and a fit that moved only one of them would have improved half of a scanpath.
 *
 * **Equal weights, because neither figure is worth less than the other.** #90 allows a
 * different split with a reason recorded; there is no reason here, so the split is 0.5/0.5
 * and the two terms travel with the value they produced. The figures are not commensurable —
 * CC runs to 1 on this corpus while ScanMatch sits near its chance level of about 0.4 (#84) —
 * so the sum is a direction to climb and never a score to quote. The badge quotes CC, NSS
 * and ScanMatch themselves (#12, #92), which is why `ObjectiveValue` carries all six metrics
 * beside the one number the search compares candidates by: a fit that raised CC while KLD
 * ran away would be visible rather than hidden inside its own objective.
 *
 * **The ruler is never fitted.** Nothing here reads a metric parameter or a corpus
 * parameter; the objective is computed from what `score` (#88) returns, and the search space
 * (`search.ts`) is the engine's configuration object alone. `test/fit.test.ts` asserts it.
 */

import type { Aggregate, ScoreResult } from '../score/index.js';
import type { SaliencyScores } from '../metrics/index.js';
import type { ScanpathScores } from '../metrics/index.js';
import type { RecordCategory } from '../types.js';

/** A fit that cannot be run, or a result the objective cannot be read from, by name. */
export class FitError extends Error {
  public override readonly name = 'FitError';
}

/** The metrics the objective is built from, by the name `score` reports them under. */
export type ObjectiveMetricId = 'cc' | 'scanMatch';

/** One term of the objective: a metric and what it is worth in the sum. */
export interface ObjectiveTerm {
  readonly metric: ObjectiveMetricId;
  readonly weight: number;
}

/** What a fit maximises, as committed data: the scope, the terms and their weights. */
export interface Objective {
  /** Stable across runs: the committed configuration names the objective it was fitted to. */
  readonly id: string;
  readonly label: string;
  /** The category the figures are read from. Never the overall mean (#11, user story 8). */
  readonly scope: RecordCategory;
  readonly terms: readonly ObjectiveTerm[];
}

export const OBJECTIVE: Objective = Object.freeze({
  id: 'web-cc-scanmatch',
  label: "the web category's CC plus ScanMatch, equally weighted",
  scope: 'webpage',
  terms: Object.freeze([
    Object.freeze({ metric: 'cc', weight: 0.5 }),
    Object.freeze({ metric: 'scanMatch', weight: 0.5 }),
  ]),
});

/** One term's figure and what it contributed, so a value can be read back term by term. */
export interface ObjectiveTermValue extends ObjectiveTerm {
  readonly figure: number;
  readonly contribution: number;
}

/**
 * The objective's value for one scoring run, with everything it was read from.
 *
 * `value` is what candidates are compared by; the six metrics beside it are what a reader
 * checks the climb against, and `records` is how many records of the scope the figures rest
 * on — one, on the committed corpus, which is a fact a reviewer has to see.
 */
export interface ObjectiveValue {
  readonly id: string;
  readonly scope: RecordCategory;
  readonly value: number;
  readonly terms: readonly ObjectiveTermValue[];
  readonly records: number;
  readonly saliency: SaliencyScores;
  readonly scanpath: ScanpathScores;
}

const figureOf = (aggregate: Aggregate, metric: ObjectiveMetricId): number =>
  metric === 'cc' ? aggregate.saliency.cc : aggregate.scanpath.scanMatch;

/**
 * The objective of a scoring run, refused rather than defaulted when the scope has no
 * records.
 *
 * A corpus with no web record cannot answer this objective, and a zero would read as a
 * measurement of the worst possible fit. `score` already reports `null` for a category it
 * holds no record of (#88), so the refusal names the corpus and the scope.
 */
export const objectiveOf = (
  result: ScoreResult,
  objective: Objective = OBJECTIVE,
): ObjectiveValue => {
  const aggregate = result.predictor.categories[objective.scope];
  if (aggregate === null) {
    throw new FitError(
      `the corpus ${result.provenance.corpus.id} scored no ${objective.scope} record, so the objective ${objective.id} has nothing to read; a fit cannot maximise a figure that was never measured`,
    );
  }
  const terms = objective.terms.map((term) => {
    const figure = figureOf(aggregate, term.metric);
    if (!Number.isFinite(figure)) {
      throw new FitError(
        `the ${objective.scope} figure for ${term.metric} is ${String(figure)}; a candidate cannot be compared on a figure that is not a number`,
      );
    }
    return { ...term, figure, contribution: term.weight * figure };
  });

  return {
    id: objective.id,
    scope: objective.scope,
    value: terms.reduce((sum, { contribution }) => sum + contribution, 0),
    terms,
    records: aggregate.records,
    saliency: aggregate.saliency,
    scanpath: aggregate.scanpath,
  };
};
