import { describe, expect, it } from 'vitest';
import {
  agentsLine,
  bytesFigure,
  capLabel,
  clockTime,
  costArithmetic,
  costFigure,
  costLine,
  hostOf,
  minutesFigure,
  NOT_MEASURED,
  NOTHING_TO_PAY,
  observedLabel,
  sessionClock,
  storageArithmetic,
  timeArithmetic,
  timeFigure,
  timeLine,
  tokensFigure,
  usdFigure,
} from '../../../src/screens/newtest/wizard/estimate/figures';
import type {
  CostEstimate,
  StorageEstimate,
  TimeEstimate,
} from '../../../src/screens/newtest/start';

/**
 * The launch step's words, read off the platform's figures.
 *
 * What is asserted here is the one thing this module may do — choose a unit and a sentence —
 * and the three rules the owner settled about them: a range is labelled as a range, a figure
 * with no spread is printed as one figure, and where the bounds came from is said per figure.
 *
 * Nothing here multiplies anything up. The totals are the platform's (#283), and a test that
 * recomputes them is `packages/platform/test/estimate.test.ts`.
 */

const aTime = (over: Partial<Extract<TimeEstimate, { state: 'known' }>> = {}): TimeEstimate => ({
  state: 'known',
  sessions: 100,
  concurrency: 10,
  batches: 10,
  medianSessionMs: 110_000,
  sessionMs: { low: 90_000, high: 150_000 },
  measuredFrom: 'this-site',
  sessionsMeasured: 5,
  browserStartupMs: null,
  ms: { low: 900_000, high: 1_500_000 },
  ...over,
});

const aCost = (over: Partial<Extract<CostEstimate, { state: 'known' }>> = {}): CostEstimate => ({
  state: 'known',
  sessions: 100,
  modelId: 'muse-spark-1.3',
  prices: {
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.15,
    outputPerMillionUsd: 4.25,
    ratesReadOn: '2026-10-27',
  },
  tokensPerSession: {
    low: { inputTokens: 6000, cachedInputTokens: 1000, outputTokens: 400 },
    median: { inputTokens: 6800, cachedInputTokens: 1000, outputTokens: 500 },
    high: { inputTokens: 9000, cachedInputTokens: 2000, outputTokens: 700 },
  },
  measuredFrom: 'this-site',
  runsMeasured: 5,
  usdPerSession: { low: 0.0081, high: 0.012025 },
  usd: { low: 0.81, high: 1.2025 },
  ...over,
});

const aStorage = (
  over: Partial<Extract<StorageEstimate, { state: 'known' }>> = {},
): StorageEstimate => ({
  state: 'known',
  sessions: 100,
  medianBytesPerSession: 14_000_000,
  measuredFrom: 'this-site',
  runsMeasured: 5,
  bytes: 1_400_000_000,
  ...over,
});

describe('the units', () => {
  it('prints minutes from milliseconds, and the median session as a clock', () => {
    expect(minutesFigure({ low: 900_000, high: 1_500_000 }).text).toBe('15–25 min');
    expect(sessionClock(110_000)).toBe('1:50');
    expect(sessionClock(68_000)).toBe('1:08');
  });

  it('prints a range as a range, and a figure with no spread as one figure', () => {
    const range = minutesFigure({ low: 900_000, high: 1_500_000 });
    expect(range.range).toBe(true);

    // Decision 102, as #283 refined it: the first test on a site can produce bounds that are
    // the same figure, and `18–18 min` is a range of a number to itself.
    const point = minutesFigure({ low: 1_080_000, high: 1_080_000 });
    expect(point.text).toBe('18 min');
    expect(point.range).toBe(false);
    // Rounded first and compared after: eleven seconds apart is the same number of minutes.
    expect(minutesFigure({ low: 1_080_000, high: 1_091_000 }).text).toBe('18 min');
  });

  it('prices in dollars, and never as a price of zero', () => {
    expect(usdFigure({ low: 0.81, high: 1.2025 }).text).toBe('$0.81–$1.20');
    expect(usdFigure({ low: 2.1, high: 2.1 })).toEqual({ text: '$2.10', range: false });
    // A bill that rounds to nothing is under a cent: `$0.00` reads as a price somebody checked.
    expect(usdFigure({ low: 0.0004, high: 0.0004 }).text).toBe('under $0.01');
    expect(usdFigure({ low: 0, high: 0 }).text).not.toContain('$0.00');
  });

  it('prints a bound below the unit as "up to", rather than joining a phrase to a figure', () => {
    // `under $0.01–$3.40` and `0–5 min` are each a phrase and a figure with a dash between
    // them, which reads as neither — and both are still ranges, so the label still applies.
    expect(usdFigure({ low: 0.0004, high: 3.4 })).toEqual({ text: 'up to $3.40', range: true });
    // A low bound of nothing at all. Twenty seconds is a minute, not nought: anything that
    // takes any time at all is rounded up to one.
    expect(minutesFigure({ low: 0, high: 300_000 })).toEqual({ text: 'up to 5 min', range: true });
    expect(minutesFigure({ low: 20_000, high: 300_000 }).text).toBe('1–5 min');
  });

  it('prints bytes in the units a disk is sold in, and tokens as the card writes them', () => {
    expect(bytesFigure(1_400_000_000)).toBe('1.4 GB');
    expect(bytesFigure(14_000_000)).toBe('14 MB');
    expect(tokensFigure(6800)).toBe('6.8k');
    expect(tokensFigure(12_000)).toBe('12k');
    expect(tokensFigure(500)).toBe('500');
  });

  it('names the host a launch is about, and survives a draft holding something else', () => {
    expect(hostOf('https://app.clipforge.example/create')).toBe('app.clipforge.example');
    expect(hostOf('http://localhost:4173/create')).toBe('localhost:4173');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('draws a retry time on the reader’s own clock from the instant beside the sentence', () => {
    const at = new Date('2026-11-04T10:12:00.000Z');
    expect(clockTime(at.toISOString())).toBe(
      new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(at),
    );
    expect(clockTime('whenever')).toBeNull();
  });
});

describe('the line under each figure', () => {
  it('says the concurrency is the per-site cap when the run will really run at it', () => {
    expect(agentsLine(10, 10)).toBe('10 at a time, the per-site cap');
  });

  it('says so when the run will run below the cap, rather than calling it the cap', () => {
    // Decision 118: the estimate is quoted at the speed the run will keep, so a deployment
    // holding itself below the cap must not have its figure called the per-site cap.
    expect(agentsLine(2, 10)).toBe('2 at a time, under the per-site cap of 10');
  });

  it('labels the time as a range, and says where the median came from', () => {
    expect(timeLine(aTime())).toBe('A range · 10 batches × a 1:50 median session');
    // Decision 79's own words for a site nobody has tested yet.
    expect(timeLine(aTime({ measuredFrom: 'other-sites' }))).toBe(
      'A range · 10 batches × a 1:50 typical session, not yet measured here',
    );
  });

  it('labels the cost as a range, and names the model the price row is for', () => {
    expect(costLine(aCost())).toBe('A range · ~6.8k tokens a session at the muse-spark-1.3 price');
    expect(costLine(aCost({ measuredFrom: 'other-sites' }))).toContain('not yet measured here');
  });

  it('gives a figure that could not be computed the platform’s own reason', () => {
    const reason = 'no finished test on the model engine has recorded a session';
    expect(timeFigure({ state: 'unknown', reason })).toBe(NOT_MEASURED);
    expect(timeLine({ state: 'unknown', reason })).toBe(reason);
  });

  it('says an offline run has nothing to pay, rather than a price', () => {
    const cost: CostEstimate = { state: 'nothing-to-pay', reason: 'it calls no model' };
    expect(costFigure(cost)).toBe(NOTHING_TO_PAY);
    expect(costFigure(cost)).not.toContain('$');
  });
});

describe('what the estimate is made of', () => {
  it('states the time arithmetic, and the figures it names are the ones above it', () => {
    const made = timeArithmetic(aTime());

    expect(made).toContain('100 sessions ÷ 10 concurrent');
    expect(made).toContain('the 1:50 median session on this site');
    expect(made).toContain('over 5 finished sessions');
    expect(made).toContain('A range, because a session that gives up early is faster');
  });

  it('does not print a start-up nobody has timed, and does print one that was', () => {
    // `browserStartupMs` is `null` on every estimate today (#246 measures it), so the
    // prototype's "plus a minute to start the browsers" has to stay off the card.
    expect(timeArithmetic(aTime())).not.toContain('start the browsers');
    expect(timeArithmetic(aTime({ browserStartupMs: 60_000 }))).toContain(
      'plus 1:00 a batch to start the browsers',
    );
  });

  it('says where a borrowed median came from in the card too', () => {
    expect(timeArithmetic(aTime({ measuredFrom: 'other-sites' }))).toContain(
      'across the tests we have run on other sites, not yet measured here',
    );
  });

  it('states the cost arithmetic, the tokens and the prices it was read from', () => {
    const made = costArithmetic(aCost());

    expect(made).toContain('around 6.8k input and 500 output tokens a session');
    expect(made).toContain('docs/meta-model-api.md');
    expect(made).toContain('muse-spark-1.3');
    // A **date** and not an instant, so it names the same day in every time zone: in a zone
    // west of Greenwich, reading `2026-10-27` locally would cite rates read on the 26th.
    expect(made).toContain('27 Oct');
  });

  it('states an offline run’s cost as nothing, and never as a price of zero', () => {
    const made = costArithmetic({
      state: 'nothing-to-pay',
      reason: 'the offline deterministic engine calls no model, so this test is billed nothing',
    });

    expect(made).toContain('calls no model');
    expect(made).toContain('Nothing is not a price of zero');
    expect(made).not.toContain('$0.00');
  });

  it('states the storage, and says when nothing has measured it', () => {
    expect(storageArithmetic(aStorage())).toBe(
      'About 1.4 GB of video: 100 sessions × ~14 MB each, kept inside the run directory.',
    );
    // Owner decision 101: not measured yet, and nothing quoted.
    const unknown = storageArithmetic({
      state: 'unknown',
      reason: 'no finished test has recorded the video a session writes',
    });
    expect(unknown.startsWith(NOT_MEASURED)).toBe(true);
    expect(unknown).toContain('kept inside the run directory');
    expect(unknown).not.toMatch(/\d\s?(GB|MB)/);
  });
});

describe('a refused launch', () => {
  it('says what the observed figure is, which is not the same for every cap', () => {
    // `caps.ts` observes the agents a launch asked for, but for the hourly cap it observes
    // the runs the site has already had — a figure about the hour, not about this launch.
    expect(observedLabel('agentsPerRun')).toBe('This launch');
    expect(observedLabel('runsPerSitePerHour')).toBe('Already this hour');
  });

  it('names each cap in words, and prints an unknown one as the platform spelt it', () => {
    expect(capLabel('agentsPerRun')).toBe('agents in one run');
    expect(capLabel('runsPerSitePerHour')).toBe('runs an hour on this site');
    expect(capLabel('concurrentSessionsPerSite')).toBe('browsers at a time on this site');
    expect(capLabel('somethingNewer')).toBe('somethingNewer');
  });
});
