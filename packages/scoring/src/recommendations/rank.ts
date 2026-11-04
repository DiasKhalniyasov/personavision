import type { Aggregate, Recommendation, Run } from '@personavision/contract';

/**
 * The order the recommendations are stored in, and the two keys it is read from
 * (`docs/FLOW.md` section 14; the decision on #224).
 *
 * **Who a change would reach comes first, and how far through the funnel it sits breaks the
 * tie** — a loss on the last screen before success is worth more than the same loss on the
 * first, because the people who got that far spent everything it took to get there. The
 * rank is stored, dense and unique: the screen renders the order it finds and never computes
 * one (#258).
 *
 * Both keys are read **off the aggregate's own funnel** and nowhere else. `peopleAffected` is
 * not a number this package counts from the session list on the side and not a number a model
 * reports: it is the `reached` of the step in the whole-run funnel slice, which is the figure
 * the Funnel screen draws its bar from. That is the whole point of reading it here — the
 * ranking key and the funnel the reader is looking at cannot disagree, because there is one
 * number and one place it comes from.
 */

/** A recommendation before this module: everything but the two fields it is here to write. */
export type UnrankedRecommendation = Omit<Recommendation, 'rank' | 'peopleAffected'>;

/** The whole-run funnel, reduced to what the ranking asks of it. */
export interface WholeRunFunnel {
  /** How many people reached each step, by step id. A step the funnel has no row for is absent. */
  readonly reached: ReadonlyMap<string, number>;
  /** How far through the funnel each step sits, 0 first. Absent for a step the funnel omits. */
  readonly depth: ReadonlyMap<string, number>;
}

/**
 * The run's own funnel, as the ranking reads it: the slice that filters to nobody — every
 * version and every segment — which is the one the Funnel screen opens on.
 *
 * The step order comes from that slice when it has one, because `aggregateSchema` stores its
 * rows *"in the order `run.json`'s own `steps` declares them"* and a depth read off the rows
 * is therefore the funnel's own depth rather than a second opinion about it. A run whose
 * aggregate holds no slice at all — one that scored nothing, where the schema forbids a slice
 * of zeroes — falls back to the declared steps, so a step is still placed rather than
 * compared as a missing number.
 */
export const wholeRunFunnel = (aggregate: Aggregate, run: Run): WholeRunFunnel => {
  const slice = aggregate.funnelSlices.find(
    (candidate) => candidate.variant === null && candidate.segment === null,
  );
  const steps = slice?.funnel.map((row) => row.step) ?? run.steps.map((step) => step.id);
  return {
    reached: new Map(slice?.funnel.map((row) => [row.step, row.reached] as const) ?? []),
    depth: new Map(steps.map((step, index) => [step, index] as const)),
  };
};

/**
 * The ranked recommendations: worst first, with `peopleAffected` stamped from the funnel and
 * `rank` stamped from the position.
 *
 * Three keys, in this order:
 *
 * 1. **`peopleAffected` descending** — how many people reached the step a change sits on.
 * 2. **Funnel depth descending** — the later step first, where the same number of people is
 *    at stake on two of them.
 * 3. **The recommendation's id**, by code unit, which is a total order that is the same in
 *    every engine. It is deliberately **not** insertion order: the order a reply happened to
 *    list two tied recommendations in is not a fact about the run, and sorting by it would
 *    make the stored rank depend on how a model chose to enumerate them.
 *
 * A step the funnel has no row for is reached by nobody in this run, so `peopleAffected` is
 * 0 and the recommendation sorts last among its depth — stated as a zero the funnel agrees
 * with rather than guessed at from somewhere else. A step the funnel does not declare at all
 * is placed after every step it does, for the same reason: last, not `NaN`.
 */
export const rankRecommendations = (
  written: readonly UnrankedRecommendation[],
  funnel: WholeRunFunnel,
): Recommendation[] =>
  written
    .map((recommendation) => ({
      ...recommendation,
      peopleAffected: funnel.reached.get(recommendation.step) ?? 0,
    }))
    .sort(
      (left, right) =>
        right.peopleAffected - left.peopleAffected ||
        (funnel.depth.get(right.step) ?? -1) - (funnel.depth.get(left.step) ?? -1) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
