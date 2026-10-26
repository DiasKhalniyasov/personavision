import type { VariantScore } from './score.js';

/**
 * The ± 1σ band of a friction score, and the numbers the acceptance gate measures against.
 *
 * A friction score is never quoted without its spread (`docs/FLOW.md` section 5), so the
 * question "did this run separate the two variants" is a question about bands and not
 * about medians. That comparison lives here, beside the one place in this package that
 * writes the acceptance table's thresholds down.
 *
 * **This module is deliberately not re-exported from `src/index.ts`.** The band thresholds
 * are presentation and the viewer reads them from `docs/design/tokens.css`; a screen that
 * could import them from the scoring package would quietly become a second source of
 * truth for a colour. The package's own tests import this module directly.
 */

/** One variant's ± 1σ band, in points. */
export interface Band {
  readonly low: number;
  readonly high: number;
}

/** A friction score is points out of 100, which is the range a band of them can occupy. */
const SCALE = { min: 0, max: 100 } as const;
const onScale = (points: number): number => Math.min(Math.max(points, SCALE.min), SCALE.max);

/**
 * A variant's band. `sd` is zero for a single seed group, which makes the band a point —
 * one group has a score but no spread, and a point band is the honest shape of that.
 *
 * **The bounds are held on the 0–100 scale**, because a band of friction scores is a range
 * of friction scores and `-12` is not one. Seed groups scoring 0, 0 and 20 have a median of
 * 0 and a deviation near 12, which would otherwise print as `A -12–12`: half of it outside
 * the scale, and its minus sign against the range dash. Clamping can only pull a bound
 * towards the middle, and a median is itself on the scale, so it never turns two bands that
 * overlapped into two that do not.
 */
export const bandOf = (score: VariantScore): Band => ({
  low: onScale(score.frictionScore.median - score.frictionScore.sd),
  high: onScale(score.frictionScore.median + score.frictionScore.sd),
});

/**
 * Whether two bands are fully apart.
 *
 * The comparison is strict, so bands that meet at a single point **overlap**: two variants
 * whose bands touch at 25 both contain 25, and a result that cannot tell them apart at
 * that one value has not separated them. Two point bands — a run of one seed group per
 * variant — are therefore disjoint exactly when the two medians differ, and the verdict
 * sentence carries how few groups that was.
 */
export const bandsDisjoint = (a: Band, b: Band): boolean => a.high < b.low || b.high < a.low;

/**
 * `docs/FLOW.md` section 5's acceptance table, as numbers — the project's one hard
 * pass-or-fail criterion.
 *
 * The four band thresholds **mirror `docs/design/tokens.css`**: `--score-threshold-good`
 * (25) and `--score-threshold-bad` (60) for the friction score, and
 * `--completion-threshold-good` (0.6) and `--completion-threshold-bad` (0.3) for the
 * completion rate. The tokens are where a screen reads them; this is the one place in this
 * package that states them, because the acceptance test is the one place that asserts
 * them. A change to the table is an edit to the tokens and an edit here, and nowhere else.
 */
export const acceptanceThresholds = {
  /** The clean variant's friction score, at most. */
  frictionCleanAtMost: 25,
  /** The variant carrying the planted defects, at least. */
  frictionDefectiveAtLeast: 60,
  /** Points between the two medians, at least. */
  gapPointsAtLeast: 30,
  /** Seed groups in which the harder variant scored higher, at least. */
  seedGroupsAgreeingAtLeast: 3,
  /** The clean variant's share of scored sessions that finished the task, at least. */
  completionCleanAtLeast: 0.6,
  /** The defective variant's, at most. */
  completionDefectiveAtMost: 0.3,
} as const;
