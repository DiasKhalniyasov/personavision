import type { Aggregate, ScreenSlice } from '@personavision/contract';
import { ALL } from '@/screens/sessions/filters';

/**
 * The seam between `aggregate.json` and the Heatmaps screen: which slice the filters name,
 * and how a figure is read out of it.
 *
 * **Nothing here computes a figure.** `aggregate.json` is stored pre-sliced — one row for
 * the whole run, one per segment, one per outcome and one per pair of the two — precisely so
 * that a screen composing two filters picks a row and prints what is in it. A browser that
 * re-aggregated a hundred sessions to answer *where did the people who failed click* would
 * be able to disagree with the summary about the same audience, which `docs/adr/0001`
 * forbids and `docs/FLOW.md` section 14 is written against.
 *
 * So the rule this module keeps is narrow and total: it **finds** and it **reads**. The one
 * piece of arithmetic in it is the scroll bands, and it is arithmetic over one stored
 * histogram rather than over anybody's sessions — see `scrollBands`.
 */

/** One screen of one version, as a slice stores it. */
export type ScreenFigures = ScreenSlice['screens'][number];

/** How a session ended, as the filter offers it. Never `automation_failure`. */
export type ScoredOutcome = NonNullable<ScreenSlice['outcome']>;

/**
 * What a strip's first button carries: every outcome, or every segment.
 *
 * `null` is "every" in the stored slices and in the URL, where the parameter is simply
 * absent. It is a value of its own here because a segmented control needs something to
 * press, and `null` is not a thing a `value` attribute can hold.
 */
export const ALL_OPTION = ALL;

/** One button of a filter strip: what it narrows to, its words, and how many people. */
export interface FilterOption {
  /** The stored slice's own `segment` or `outcome`, or `ALL_OPTION` for the first button. */
  readonly value: string;
  /** The words on the button. The slice's own `label`, which carries its count. */
  readonly label: string;
  /** How many sessions this option alone narrows the run to. */
  readonly sessionCount: number;
}

/**
 * The slice that is every segment and every outcome: the whole run, and the denominator of
 * both strips' first button.
 */
const everySlice = (aggregate: Aggregate): ScreenSlice | undefined =>
  aggregate.screenSlices.find((slice) => slice.segment === null && slice.outcome === null);

/**
 * The first button of either strip.
 *
 * Its count is the whole run's, and its word is this screen's own — the prototype's `All 93`
 * — because the stored labels name one filter each and there is no stored row whose words
 * are "every segment" for *this* file's strips. Every other button's words are the slice's.
 */
const allOption = (aggregate: Aggregate): FilterOption => {
  const every = everySlice(aggregate);
  const sessionCount = every?.sessionCount ?? aggregate.scoredSessionCount;
  return { value: ALL_OPTION, label: `All ${sessionCount}`, sessionCount };
};

/**
 * The outcome strip, and the segment strip, each from the slices that narrow by that filter
 * **alone**.
 *
 * A button's count is therefore the run-wide count of the people that outcome or that
 * segment is, not of the composition with the other strip — which is what
 * `#screen-heatmaps` draws (*All 93 · Gave up 41 · Completed 38* beside *Phone 67 · Desktop
 * 26*: the two strips' counts do not narrow each other). What the composition amounts to is
 * said once, in words, in the line above the stage.
 *
 * A composed slice is never offered as a button: it is what pressing two buttons resolves
 * to, not a third place to press.
 */
const optionsOf = (
  aggregate: Aggregate,
  narrows: (slice: ScreenSlice) => string | null,
  alone: (slice: ScreenSlice) => boolean,
): readonly FilterOption[] => {
  const options: FilterOption[] = [allOption(aggregate)];
  for (const slice of aggregate.screenSlices) {
    const value = narrows(slice);
    if (value === null || !alone(slice)) continue;
    options.push({ value, label: slice.label, sessionCount: slice.sessionCount });
  }
  return options;
};

/** How each session of the run ended, as the aggregate sliced it. */
export const outcomeOptions = (aggregate: Aggregate): readonly FilterOption[] =>
  optionsOf(
    aggregate,
    (slice) => slice.outcome,
    (slice) => slice.segment === null,
  );

/** The audience's own segments, as the aggregate sliced them. */
export const segmentOptions = (aggregate: Aggregate): readonly FilterOption[] =>
  optionsOf(
    aggregate,
    (slice) => slice.segment,
    (slice) => slice.outcome === null,
  );

/**
 * The slice the two filters name, or `null` when no session satisfies both.
 *
 * `null` is a **result**: a run can hold a phone slice and a failed slice and no slice of
 * the people who are both, because the aggregate stores no row for a filter nobody falls in
 * (`aggregateSchema`). The screen states that in words rather than drawing an empty frame.
 */
export const pickScreenSlice = (
  aggregate: Aggregate,
  segment: string | null,
  outcome: string | null,
): ScreenSlice | null =>
  aggregate.screenSlices.find(
    (slice) => slice.segment === segment && slice.outcome === outcome,
  ) ?? null;

/**
 * The figures of one version's step inside a slice, or `null` when the slice holds no row
 * for it — a step nobody in these people ever reached on this version.
 */
export const screenFiguresOf = (
  slice: ScreenSlice | null,
  variant: string,
  step: string,
): ScreenFigures | null =>
  slice?.screens.find((screen) => screen.variant === variant && screen.step === step) ?? null;

/**
 * How many clicks landed in one area of interest, or `null` when the slice carries no row
 * for that area at all.
 *
 * The two are different answers and the table prints them differently. A row of `0` is a
 * measured absence — nobody pressed it — and no row is an area these figures are not about,
 * which is what an area of the *other* version looks like from here.
 */
export const clicksOnArea = (figures: ScreenFigures | null, aoiId: string): number | null =>
  figures?.clicksByAoi.find((entry) => entry.aoiId === aoiId)?.clicks ?? null;

/**
 * The clicks that landed on nothing the page explained — the prototype's *9 landed on empty
 * space where a progress indicator would be*. Stored as the row whose `aoiId` is `null`.
 */
export const clicksNowhere = (figures: ScreenFigures | null): number =>
  figures?.clicksByAoi.find((entry) => entry.aoiId === null)?.clicks ?? 0;

/** Every click this slice recorded on this screen, areas and empty space alike. */
export const totalClicks = (figures: ScreenFigures | null): number =>
  figures?.clicksByAoi.reduce((sum, entry) => sum + entry.clicks, 0) ?? 0;

/** One band of the page, and how far down the page it sits. */
export interface ScrollBand {
  /** Its place in the stored bins, from the top of the page. */
  readonly index: number;
  /** How many people's deepest point was inside this band: the stored bin. */
  readonly deepestHere: number;
  /** How many people saw this band at all. */
  readonly sawIt: number;
  /** Where its top edge is, as a percentage of the page. */
  readonly topPct: number;
  /** How tall it is, as a percentage of the page. */
  readonly heightPct: number;
}

/**
 * The scroll-depth bands of one screen, from the bins the aggregate stored.
 *
 * **Decision 128** fixes what a bin means: equal bands from the top of the page, and a
 * person falls in the band their *view* reached — the furthest point they saw. So a bin is
 * how many people got **exactly** that far and no further, and the people who saw a band are
 * the people whose deepest band was that one or any below it. Reading the bins from the
 * bottom up is what turns the stored histogram into something that can be shaded over a
 * page, which is what that decision asked the overlay for.
 *
 * That running total is the only arithmetic in this file, and it is over one stored row
 * rather than over anybody's sessions: the same bins always give the same bands, and no
 * figure here could disagree with the aggregate about how many people there were.
 */
export const scrollBands = (figures: ScreenFigures | null): readonly ScrollBand[] => {
  const bins = figures?.scrollDepth.bins ?? [];
  if (bins.length === 0) return [];

  const heightPct = 100 / bins.length;
  const bands: ScrollBand[] = [];
  let deeper = 0;
  // From the bottom of the page up, so each band carries the people below it, then put back
  // into page order: top first, which is the order a layer draws them in.
  for (let index = bins.length - 1; index >= 0; index -= 1) {
    deeper += bins[index] ?? 0;
    bands[index] = {
      index,
      deepestHere: bins[index] ?? 0,
      sawIt: deeper,
      topPct: index * heightPct,
      heightPct,
    };
  }
  return bands;
};

/** Whether this screen's figures record any scroll depth at all. */
export const hasScrollDepth = (figures: ScreenFigures | null): boolean =>
  scrollBands(figures).some((band) => band.sawIt > 0);

/** How many of a slice's people reached one step of one version, or `null` for no row. */
export const reachedOf = (
  slice: ScreenSlice | null,
  variant: string,
  step: string,
): number | null => screenFiguresOf(slice, variant, step)?.reached ?? null;
