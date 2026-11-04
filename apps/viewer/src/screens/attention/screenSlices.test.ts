import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, aggregateSchema } from '@personavision/contract';
import type { Aggregate, ScreenSlice } from '@personavision/contract';
import {
  ALL_OPTION,
  clicksNowhere,
  clicksOnArea,
  outcomeOptions,
  pickScreenSlice,
  screenFiguresOf,
  scrollBands,
  segmentOptions,
  totalClicks,
} from './screenSlices';

/**
 * The seam between `aggregate.json` and everything the Heatmaps screen draws.
 *
 * It is pure on purpose: the screen's whole promise is that every figure on it is the
 * aggregate's own slice for the composition the reader chose, and that promise is only
 * checkable if picking the slice and reading a figure out of it can be asserted without a
 * browser. The fixtures below are therefore built so that **a browser-side recount would
 * give a different answer** — the clicks of the filtered slice are not the clicks of the
 * whole run, and the scroll bins of one do not sum to the other — so a test that passes is
 * a test that read the slice rather than re-derived it.
 */

const screen = (over: Partial<ScreenSlice['screens'][number]> = {}) => ({
  variant: 'A',
  step: 'cart',
  reached: 4,
  leftHere: 1,
  medianMsOnIt: 8000,
  clicksByAoi: [
    { aoiId: 'A-cart-checkout', clicks: 3 },
    { aoiId: 'A-cart-keep-shopping', clicks: 0 },
    { aoiId: null, clicks: 2 },
  ],
  scrollDepth: { bins: [0, 0, 1, 0, 3, 0, 0, 0, 0, 0], pastFoldSessions: 3 },
  ...over,
});

const slice = (over: Partial<ScreenSlice> = {}): ScreenSlice =>
  ({
    key: 'all',
    segment: null,
    outcome: null,
    label: 'Every outcome',
    sessionCount: 9,
    screens: [screen()],
    ...over,
  }) as ScreenSlice;

const aggregate = (slices: readonly ScreenSlice[]): Aggregate =>
  ({
    schemaVersion: SCHEMA_VERSION,
    runId: 'r',
    computedAt: '2026-11-04T00:00:00.000Z',
    runStatus: 'finished',
    scoredSessionCount: 9,
    excludedAutomationFailures: 1,
    // The contract requires a whole-run funnel slice beside the screen slices. Nothing in
    // this module reads it; it is here so that every fixture below is a file the contract
    // accepts, which is what the last test of this suite asserts.
    funnelSlices: [
      {
        key: 'all',
        variant: null,
        segment: null,
        label: 'Every segment',
        sessionCount: 9,
        funnel: [
          { step: 'cart', reached: 9, completed: 5, abandoned: 4, failed: 0, reachedShare: 1 },
        ],
        biggestDrop: null,
        timing: {
          total: {
            sampleCount: 9,
            p25Ms: 8000,
            p50Ms: 9000,
            p75Ms: 10_000,
            p90Ms: 11_000,
            binWidthMs: 1000,
            bins: [0, 0, 0, 0, 0, 0, 0, 0, 1, 4, 2, 2],
            medianBin: 9,
          },
          perStep: [],
          slowest: [],
        },
        paths: [],
      },
    ],
    screenSlices: slices,
  }) as unknown as Aggregate;

/** The whole run, one outcome, one segment, and the two composed. */
const FULL = aggregate([
  slice(),
  slice({
    key: 'outcome:abandoned',
    outcome: 'abandoned',
    label: 'Gave up 4',
    sessionCount: 4,
    screens: [screen({ reached: 4, leftHere: 4, clicksByAoi: [{ aoiId: 'A-cart-checkout', clicks: 7 }] })],
  }),
  slice({
    key: 'outcome:success',
    outcome: 'success',
    label: 'Completed 5',
    sessionCount: 5,
    screens: [screen({ reached: 5 })],
  }),
  slice({ key: 'segment:phone', segment: 'phone', label: 'Phone 6', sessionCount: 6 }),
  slice({
    key: 'segment:phone|outcome:abandoned',
    segment: 'phone',
    outcome: 'abandoned',
    label: 'Gave up · phone 2',
    sessionCount: 2,
    screens: [
      screen({
        reached: 2,
        clicksByAoi: [{ aoiId: 'A-cart-checkout', clicks: 1 }],
        scrollDepth: { bins: [0, 0, 1, 0, 1, 0, 0, 0, 0, 0], pastFoldSessions: 1 },
      }),
    ],
  }),
]);

describe('the filter strips', () => {
  it('offers every outcome the aggregate sliced, with the slice’s own words and count', () => {
    expect(outcomeOptions(FULL)).toEqual([
      { value: ALL_OPTION, label: 'All 9', sessionCount: 9 },
      { value: 'abandoned', label: 'Gave up 4', sessionCount: 4 },
      { value: 'success', label: 'Completed 5', sessionCount: 5 },
    ]);
  });

  it('offers every segment the same way, and never the composed slices', () => {
    expect(segmentOptions(FULL)).toEqual([
      { value: ALL_OPTION, label: 'All 9', sessionCount: 9 },
      { value: 'phone', label: 'Phone 6', sessionCount: 6 },
    ]);
  });

  it('offers nothing but “All” for a run whose aggregate sliced neither', () => {
    const only = aggregate([slice()]);
    expect(outcomeOptions(only)).toHaveLength(1);
    expect(segmentOptions(only)).toHaveLength(1);
  });
});

describe('picking the slice the filters name', () => {
  it('takes the slice of the composition, not of either filter alone', () => {
    expect(pickScreenSlice(FULL, 'phone', 'abandoned')?.key).toBe(
      'segment:phone|outcome:abandoned',
    );
    expect(pickScreenSlice(FULL, null, 'abandoned')?.key).toBe('outcome:abandoned');
    expect(pickScreenSlice(FULL, 'phone', null)?.key).toBe('segment:phone');
    expect(pickScreenSlice(FULL, null, null)?.key).toBe('all');
  });

  it('answers null for a composition no session satisfies', () => {
    // There is a phone slice and a success slice, and no slice of the two together.
    expect(pickScreenSlice(FULL, 'phone', 'success')).toBeNull();
  });

  it('reads the figures of one version’s step out of the slice', () => {
    const picked = pickScreenSlice(FULL, null, 'abandoned');
    expect(screenFiguresOf(picked, 'A', 'cart')?.leftHere).toBe(4);
    expect(screenFiguresOf(picked, 'B', 'cart')).toBeNull();
    expect(screenFiguresOf(picked, 'A', 'review')).toBeNull();
    expect(screenFiguresOf(null, 'A', 'cart')).toBeNull();
  });
});

describe('the clicks of the slice', () => {
  it('reads one area’s clicks from the slice the filters picked, not from the whole run', () => {
    const whole = screenFiguresOf(pickScreenSlice(FULL, null, null), 'A', 'cart');
    const gaveUp = screenFiguresOf(pickScreenSlice(FULL, null, 'abandoned'), 'A', 'cart');
    const onPhone = screenFiguresOf(pickScreenSlice(FULL, 'phone', 'abandoned'), 'A', 'cart');

    expect(clicksOnArea(whole, 'A-cart-checkout')).toBe(3);
    expect(clicksOnArea(gaveUp, 'A-cart-checkout')).toBe(7);
    expect(clicksOnArea(onPhone, 'A-cart-checkout')).toBe(1);
  });

  it('tells an area with no clicks apart from an area the slice has no row for', () => {
    const whole = screenFiguresOf(pickScreenSlice(FULL, null, null), 'A', 'cart');
    expect(clicksOnArea(whole, 'A-cart-keep-shopping')).toBe(0);
    expect(clicksOnArea(whole, 'B-cart-promo')).toBeNull();
  });

  it('counts the clicks that landed on nothing apart from the clicks on areas', () => {
    const whole = screenFiguresOf(pickScreenSlice(FULL, null, null), 'A', 'cart');
    expect(clicksNowhere(whole)).toBe(2);
    expect(totalClicks(whole)).toBe(5);
  });

  it('reports a screen with no click recorded anywhere as none, not as zeroes', () => {
    const nothing = screen({ clicksByAoi: [{ aoiId: 'A-cart-checkout', clicks: 0 }] });
    expect(totalClicks(nothing)).toBe(0);
    expect(clicksNowhere(nothing)).toBe(0);
  });
});

describe('the scroll-depth bands', () => {
  /**
   * Decision 128: a bin counts the people whose **deepest** band was that one, so the people
   * who saw a band are the people whose deepest band was that one or any lower down. The
   * bands are therefore read from the bottom up, and nothing is counted twice.
   */
  it('reads how many got at least this far, from the deepest-band bins', () => {
    const figures = screen();
    expect(scrollBands(figures).map((band) => band.sawIt)).toEqual([4, 4, 4, 3, 3, 0, 0, 0, 0, 0]);
    expect(scrollBands(figures).map((band) => band.deepestHere)).toEqual([
      0, 0, 1, 0, 3, 0, 0, 0, 0, 0,
    ]);
  });

  it('keeps the bands in page order, top first, each knowing where it sits', () => {
    const bands = scrollBands(screen());
    expect(bands).toHaveLength(10);
    expect(bands[0]?.topPct).toBe(0);
    expect(bands[9]?.topPct).toBe(90);
    expect(bands[0]?.heightPct).toBe(10);
  });

  it('answers nothing at all for a screen whose aggregate recorded no bins', () => {
    expect(scrollBands(screen({ scrollDepth: { bins: [], pastFoldSessions: 0 } }))).toEqual([]);
    expect(scrollBands(null)).toEqual([]);
  });

  it('reports bands nobody reached as a run with no scroll depth recorded', () => {
    const flat = screen({ scrollDepth: { bins: [0, 0, 0], pastFoldSessions: 0 } });
    expect(scrollBands(flat).every((band) => band.sawIt === 0)).toBe(true);
  });
});

describe('the committed fixture', () => {
  it('parses, so these readings are of a file the contract accepts', () => {
    const parsed = aggregateSchema.safeParse(FULL);
    // The issues, not just the failure: a fixture that drifts out of the contract should say
    // which field it drifted on rather than leaving the next reader to bisect it.
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });
});
