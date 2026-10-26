import { readCompletionThreshold } from '@/tokens';

/**
 * The completion figure: which band it falls in, and the two numbers it is shown as.
 *
 * The rate itself is **stored** — `scores[].completionRate`, written by the scoring step
 * (`docs/FLOW.md` section 5) — and nothing here recomputes it from the sessions. What is
 * here is the formatting the Verdict screen leads with: the share as *N in 10*, the same
 * share as a percentage, and the band whose colour the figure is drawn in.
 *
 * The thresholds are the tokens' own, read through `src/tokens.ts`, so moving
 * `--completion-threshold-good` in `docs/design/tokens.css` moves the product and this
 * module holds no number of its own. It sits beside the figures rather than in
 * `src/tokens.ts` because banding a completion rate is this screen's reading of those
 * thresholds, where `scoreBand` is every screen's reading of the score's.
 */

/** The bands `docs/design/tokens.css` names with its `--completion-*` colours. */
export type CompletionBand = 'good' | 'warn' | 'bad';

/**
 * A rate that is not a share between 0 and 1 is a broken artifact, not a figure to draw.
 * It throws for the reason `scoreBand` does: a missing or malformed rate banded by a
 * fallback would render as a clean result.
 */
function assertShare(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(
      `A completion rate is a share of the audience between 0 and 1 (got ${JSON.stringify(rate)}). ` +
        'Banding a missing or malformed rate would show it as a figure somebody measured.',
    );
  }
}

/**
 * The band a completion rate falls in, by the thresholds the tokens declare. A completion
 * rate runs 0..1 and higher is better — the opposite of the friction score — so `good` is
 * at or above the good threshold and `bad` at or below the bad one, both boundaries
 * included, as `docs/design/prototype.html` bands it.
 */
export function completionBand(rate: number): CompletionBand {
  assertShare(rate);

  if (rate >= readCompletionThreshold('good')) return 'good';
  if (rate <= readCompletionThreshold('bad')) return 'bad';
  return 'warn';
}

/**
 * The figure itself: the share out of ten, which is how the product says it
 * (`docs/FLOW.md` section 1 — *8 in 10 of your audience*, never *0.818182*).
 */
export function inTen(rate: number): number {
  assertShare(rate);
  return Math.round(rate * 10);
}

/** The same share as a percentage, which is the number the reader repeats. */
export function percent(rate: number): number {
  assertShare(rate);
  return Math.round(rate * 100);
}
