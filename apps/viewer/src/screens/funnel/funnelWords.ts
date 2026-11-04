import type { Aggregate, FunnelSlice, Run } from '@personavision/contract';
import { timeLabel } from '@/screens/replay/position';

/**
 * The words and the figures of `#screen-funnel`, written once, here.
 *
 * **Nothing in this module computes a figure.** Every number it formats is a field
 * `aggregate.json` stores — a count, the one share the pipeline rounded (`reachedShare`),
 * the four quantiles of a distribution and its bins (`docs/adr/0001`). There is no division
 * here, no subtraction of one row from the next and no percentile maths: a screen that
 * worked a figure out itself is a screen that can disagree with the summary.
 *
 * Two consequences a reader can see:
 *
 * - **A funnel row prints the four stored counts and the one stored share.** The prototype's
 *   note reads *"93 reached · 5 left"*, and the 5 is a subtraction of the next row from this
 *   one; what is stored per row is `reached`, `completed`, `abandoned` and `failed`, so that
 *   is what the row says. The three non-reached shares are not stored and so are not
 *   printed. The drop itself is stated where the pipeline stored it: `biggestDrop`.
 * - **A step nothing was measured on says so in words.** A distribution of nothing is not
 *   stored (the contract forbids it), so such a step has no row in the timing table and is
 *   named under it instead — never four dashes, and never a zero.
 *
 * The clock is the replay's own `timeLabel`, so `0:41` means the same thing on every screen
 * of the product.
 */

/** One row of the stored funnel. */
export type FunnelStep = FunnelSlice['funnel'][number];
/** One spread, as the aggregate stores it: four quantiles and the bars they were read off. */
export type Distribution = FunnelSlice['timing']['total'];
/** One row of the stored slowest-sessions table. */
export type SlowestSession = FunnelSlice['timing']['slowest'][number];

/** `100%` … `0%`: the stored share, formatted and never recomputed. */
const share = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
/** A seconds reading for the spread's alternative text: `2.5 s`. */
const secs = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** The label `run.json` gives a step, or the stored id when the run never declared it. */
export const stepLabel = (run: Run, step: string): string =>
  run.steps.find((candidate) => candidate.id === step)?.label ?? step;

/**
 * Which sessions every figure on this screen is over, and what is outside all of them.
 *
 * Automation failures are in none of the figures — the pipeline excluded them when it
 * aggregated — so the count they were excluded from is stated beside the count that is left
 * (`docs/FLOW.md` section 8). A run that broke nobody says only the first half.
 */
export function scoredLine(aggregate: Aggregate): string {
  const scored = `${whole.format(aggregate.scoredSessionCount)} scored ${plural(aggregate.scoredSessionCount, 'session', 'sessions')}`;
  const broken = aggregate.excludedAutomationFailures;
  if (broken === 0) return `${scored} · our automation broke none of them`;
  return `${scored} · the ${whole.format(broken)} our automation broke ${plural(broken, 'is', 'are')} excluded`;
}

/** Which segment the screen is showing, in the segment's own stored name. */
export function showingLine(slice: FunnelSlice, aggregate: Aggregate): string {
  if (slice.segment === null) return 'Showing every segment of the audience.';
  return `Showing the ${slice.segment} segment: ${whole.format(slice.sessionCount)} of the ${whole.format(aggregate.scoredSessionCount)} scored ${plural(aggregate.scoredSessionCount, 'session', 'sessions')}.`;
}

/**
 * A `?segment=` naming nobody.
 *
 * A slice no session falls in is not stored, so a filter that matches none of them has no
 * figures at all — and a funnel of zeroes would read as a measurement somebody took.
 */
export const noSuchSegment = (segment: string): string =>
  `No session of this test is in the “${segment}” segment, so there is no funnel for it — not a zero, and not an empty chart.`;

/** `22 reached · 100%`: the count that got there, and the stored share of the slice. */
export const reachedNote = (row: FunnelStep): string =>
  `${whole.format(row.reached)} reached · ${share.format(row.reachedShare)}`;

/**
 * `19 completed · 3 abandoned · 0 failed`: what became of the people who reached it.
 *
 * The three are never merged (`docs/FLOW.md` section 8) and never added together: each is
 * its own stored count.
 */
export const outcomeNote = (row: FunnelStep): string =>
  `${whole.format(row.completed)} completed · ${whole.format(row.abandoned)} abandoned · ${whole.format(row.failed)} failed`;

/** `The biggest drop is the Review screen: 7 of 18.` — the stored drop, in the step's words. */
export const biggestDropSentence = (
  drop: NonNullable<FunnelSlice['biggestDrop']>,
  label: string,
): string =>
  `The biggest drop is the ${label} screen: ${whole.format(drop.left)} of ${whole.format(drop.ofReached)}.`;

/**
 * The section's lede: the stored end-to-end median, and the stored slowest session.
 *
 * The prototype writes *"A distribution, not a mean"*. The word itself is left out here —
 * no mean appears anywhere on this screen, the denial included — and the sentence says the
 * same thing in the figures it does print: a middle and a tail, and no single number.
 */
export function spreadLede(slice: FunnelSlice): string {
  const middle = `End to end, the middle of them took ${timeLabel(slice.timing.total.p50Ms)}`;
  const slowest = slice.timing.slowest[0];
  const tail = slowest === undefined ? '' : `, and the slowest took ${timeLabel(slowest.totalMs)}`;
  return `A distribution and not one number: the median is the dark bar. ${middle}${tail}.`;
}

/**
 * The spread said in words, for a reader who cannot see the bars.
 *
 * It carries the same numbers the bars are drawn from — every bin count, the bar width, and
 * which bar the median falls in — beside the four quantiles the row already prints, because
 * the bins are nowhere else on the screen in words.
 */
export function distributionAlternative(distribution: Distribution): string {
  const bars = distribution.bins.map((count) => whole.format(count)).join(', ');
  return `${whole.format(distribution.bins.length)} bars of ${secs.format(distribution.binWidthMs / 1000)} s each, over ${whole.format(distribution.sampleCount)} ${plural(distribution.sampleCount, 'session', 'sessions')}: ${bars}. The median is in bar ${whole.format(distribution.medianBin + 1)}. The 25th is ${timeLabel(distribution.p25Ms)}, the median ${timeLabel(distribution.p50Ms)}, the 75th ${timeLabel(distribution.p75Ms)} and the 90th ${timeLabel(distribution.p90Ms)}.`;
}

/** The steps of this slice's funnel that nothing was timed on, named rather than dashed. */
export function untimedLine(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  const named =
    labels.length === 1
      ? (labels[0] as string)
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] as string}`;
  return `Nothing was timed on ${named}: nobody of this slice was measured there, so there is no spread to draw.`;
}

/** `0:24 of it on Payment`: where one slow session's time went, as stored. */
export const whereTheTimeWent = (session: SlowestSession, label: string): string =>
  `${timeLabel(session.dominantStepMs)} of it on ${label}`;

/** A slice whose timing recorded no session to list. */
export const noSlowestSessions = (): string =>
  'This test recorded no session times for this slice, so there is no slowest session to list.';

/** The figure a cell prints, as a clock: `0:41`. */
export const clock = (ms: number): string => timeLabel(ms);

/**
 * A length as a CSS percentage, to two places.
 *
 * A stored share times a hundred is a binary float — `0.8182` becomes
 * `81.82000000000001` — and that noise would reach the shipped DOM as the width of a bar.
 * Two places is finer than a pixel on any bar this screen draws, and the trailing zeroes
 * go, so `0.5` is `50%` rather than `50.00%`.
 */
export const percentage = (value: number): string =>
  `${String(Number.parseFloat((value * 100).toFixed(2)))}%`;

/** The width of one funnel bar: the stored `reachedShare`, and nothing else. */
export const barWidth = (row: FunnelStep): string => percentage(row.reachedShare);

/** The height of one bar of a `.dist`, as a share of the tallest bar of the same spread. */
export function barHeights(distribution: Distribution): readonly string[] {
  // Not a figure: the tallest bar of a drawing is how tall the drawing is. Every *number* a
  // reader reads comes from `distributionAlternative` and the row's four cells.
  const tallest = Math.max(...distribution.bins, 1);
  return distribution.bins.map((count) => percentage(count / tallest));
}

/**
 * A run that computed an aggregate and scored nobody.
 *
 * This is **not** the same absence as a run with no aggregate at all, and must not read like
 * it: the test ran, the pipeline aggregated it, and every session it produced is outside
 * every figure — which for this screen means our own automation broke all of them
 * (`docs/FLOW.md` section 8). So the sentence says that, and states the count it is about
 * rather than printing a funnel of zeroes.
 */
export function nothingScored(aggregate: Aggregate): string {
  const broken = aggregate.excludedAutomationFailures;
  const whose =
    broken === 0
      ? 'It recorded no session this screen could read'
      : `The ${whole.format(broken)} ${plural(broken, 'session', 'sessions')} it ran ${plural(broken, 'was', 'were')} broken by our own automation, and an automation failure is outside every figure`;
  return `${whose}, so there is no funnel and no timing for it — not a zero, and not an empty chart. Run the test again and both will be here.`;
}
