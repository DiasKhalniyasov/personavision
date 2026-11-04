import { aggregateSchema, SCHEMA_VERSION } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { funnelSliceSpecs, timingOfSlice, type FunnelSliceSpec } from '../src/index.js';
import { buildHundredSessionRun, smallRun, smallRunSessions } from './fixtures/aggregate.js';

/**
 * The time of a slice, over the small fixture whose clock is written down by hand:
 *
 * | session | version | segment | duration | landing | prompt | generate | preview |
 * | ------- | ------- | ------- | -------- | ------- | ------ | -------- | ------- |
 * | S-01    | A       | phone   | 20 000   | 4 000   | 5 000  | 6 000    | 5 000   |
 * | S-02    | A       | phone   | 12 000   | 3 000   | 4 000  | 5 000    | —       |
 * | S-03    | A       | desktop |  6 000   | 2 000   | 4 000  | —        | —       |
 * | S-04    | B       | phone   | 25 000   | 3 000   | 10 000 | 5 000    | 7 000   |
 * | S-05    | B       | desktop |  4 000   | the automation failure: in no figure          |
 * | S-06    | B       | phone   | 10 000   | 2 000   | 4 000  | *nobody looked* | 4 000 |
 *
 * S-04's prompt is 10 000 because it walked that step twice — 5 000 ms before the `back` and
 * 5 000 ms after it — and one session is one sample. S-06's generate screen was reached with
 * no fixation of its own, so it is in no sample at all.
 */

const sliceOf = (key: string): FunnelSliceSpec => {
  const found = funnelSliceSpecs(smallRun, smallRunSessions).find((slice) => slice.key === key);
  if (found === undefined) throw new Error(`the fixture carries no slice "${key}"`);
  return found;
};

const timingOf = (key: string) => timingOfSlice({ run: smallRun, slice: sliceOf(key) });

describe('the time of the whole run', () => {
  it('spreads the session durations, by value, with the bar the median falls in', () => {
    // [6 000, 10 000, 12 000, 20 000, 25 000]: the 90th interpolates 20 000 and 25 000 at 0.6.
    expect(timingOf('all').total).toEqual({
      sampleCount: 5,
      p25Ms: 10_000,
      p50Ms: 12_000,
      p75Ms: 20_000,
      p90Ms: 23_000,
      binWidthMs: 2084,
      bins: [0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1],
      medianBin: 5,
    });
  });

  it('spreads the time per step, by value, one row per step in the order run.json declares them', () => {
    expect(timingOf('all').perStep).toEqual([
      {
        step: 'landing',
        distribution: {
          sampleCount: 5,
          p25Ms: 2000,
          p50Ms: 3000,
          p75Ms: 3000,
          p90Ms: 3600,
          binWidthMs: 334,
          bins: [0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 1],
          medianBin: 8,
        },
      },
      {
        step: 'prompt',
        distribution: {
          sampleCount: 5,
          p25Ms: 4000,
          p50Ms: 4000,
          p75Ms: 5000,
          p90Ms: 8000,
          binWidthMs: 834,
          bins: [0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 1],
          medianBin: 4,
        },
      },
      {
        // Three samples, not four: S-03 never reached it and S-06's screen was never looked at.
        step: 'generate',
        distribution: {
          sampleCount: 3,
          p25Ms: 5000,
          p50Ms: 5000,
          p75Ms: 5500,
          p90Ms: 5800,
          binWidthMs: 501,
          bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1],
          medianBin: 9,
        },
      },
      {
        step: 'preview',
        distribution: {
          sampleCount: 3,
          p25Ms: 4500,
          p50Ms: 5000,
          p75Ms: 6000,
          p90Ms: 6600,
          binWidthMs: 584,
          bins: [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1],
          medianBin: 8,
        },
      },
    ]);
  });

  it('lists the slowest sessions with the step the time went on, as a span and not a share', () => {
    expect(timingOf('all').slowest).toEqual([
      // S-04 walked prompt twice: 10 000 ms of its 25 000 went on that one step.
      { sessionId: 'S-04', totalMs: 25_000, dominantStep: 'prompt', dominantStepMs: 10_000 },
      { sessionId: 'S-01', totalMs: 20_000, dominantStep: 'generate', dominantStepMs: 6000 },
      { sessionId: 'S-02', totalMs: 12_000, dominantStep: 'generate', dominantStepMs: 5000 },
      // Prompt and preview are tied at 4 000 ms, and run.json declares prompt first.
      { sessionId: 'S-06', totalMs: 10_000, dominantStep: 'prompt', dominantStepMs: 4000 },
      { sessionId: 'S-03', totalMs: 6000, dominantStep: 'prompt', dominantStepMs: 4000 },
    ]);
  });

  it('stores a timing block the contract parses, slowest first and every span inside its session', () => {
    const slice = sliceOf('all');

    expect(() =>
      aggregateSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: smallRun.runId,
        computedAt: '2026-11-03T09:21:00.000Z',
        runStatus: 'finished',
        scoredSessionCount: 5,
        excludedAutomationFailures: 1,
        funnelSlices: [
          {
            key: slice.key,
            variant: slice.variant,
            segment: slice.segment,
            label: slice.label,
            sessionCount: slice.sessions.length,
            funnel: [
              {
                step: 'landing',
                reached: 5,
                completed: 2,
                abandoned: 2,
                failed: 1,
                reachedShare: 1,
              },
            ],
            biggestDrop: null,
            timing: timingOf('all'),
            paths: [],
          },
        ],
        // The heatmaps side of the file is #291's and #292's; one slice of everybody is here
        // because the contract holds the file to having one, not because this figure reads it.
        screenSlices: [
          {
            key: 'all',
            segment: null,
            outcome: null,
            label: 'Every outcome',
            sessionCount: 5,
            screens: [
              {
                variant: 'A',
                step: 'landing',
                reached: 3,
                leftHere: 0,
                medianMsOnIt: 3000,
                clicksByAoi: [],
                scrollDepth: { bins: [3, 0, 0, 0], pastFoldSessions: 0 },
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('a step one session was timed on', () => {
  it('reports that session s own span as all four quantiles, of a sample of one', () => {
    // The desktop slice is S-03 alone: 2 000 ms on landing, 4 000 ms on prompt.
    expect(timingOf('segment:desktop').perStep).toEqual([
      {
        step: 'landing',
        distribution: {
          sampleCount: 1,
          p25Ms: 2000,
          p50Ms: 2000,
          p75Ms: 2000,
          p90Ms: 2000,
          binWidthMs: 167,
          bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
          medianBin: 11,
        },
      },
      {
        step: 'prompt',
        distribution: {
          sampleCount: 1,
          p25Ms: 4000,
          p50Ms: 4000,
          p75Ms: 4000,
          p90Ms: 4000,
          binWidthMs: 334,
          bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
          medianBin: 11,
        },
      },
    ]);
  });
});

describe('a step with nothing measured on it', () => {
  it('has no distribution at all, rather than four zeroes', () => {
    const steps = timingOf('segment:desktop').perStep.map((row) => row.step);

    // S-03 stopped on prompt, so the two steps after it have no spread — and a spread of
    // nothing is not stored, by the contract's own rule.
    expect(steps).toEqual(['landing', 'prompt']);
    expect(steps).not.toContain('generate');
    expect(steps).not.toContain('preview');
  });

  it('leaves a screen nobody looked at out of the sample instead of entering it as zero', () => {
    // (B, phone) is S-04 and S-06. Both reached generate; only S-04 was timed on it, because
    // S-06's generate screen has no fixation of its own.
    const generate = timingOf('variant:B|segment:phone').perStep.find(
      (row) => row.step === 'generate',
    );

    expect(generate?.distribution.sampleCount).toBe(1);
    expect(generate?.distribution.p25Ms).toBe(5000);
    expect(generate?.distribution.p50Ms).toBe(5000);
    expect(generate?.distribution.p90Ms).toBe(5000);
  });
});

describe('the slowest sessions', () => {
  it('is shorter than five where the slice holds fewer sessions', () => {
    expect(timingOf('variant:A|segment:phone').slowest).toEqual([
      { sessionId: 'S-01', totalMs: 20_000, dominantStep: 'generate', dominantStepMs: 6000 },
      { sessionId: 'S-02', totalMs: 12_000, dominantStep: 'generate', dominantStepMs: 5000 },
    ]);
  });

  it('breaks a tie by session id, so the file is the same on every machine', () => {
    const { run, sessions } = buildHundredSessionRun();
    const slice = funnelSliceSpecs(run, sessions).find((candidate) => candidate.key === 'all');
    if (slice === undefined) throw new Error('the hundred-session run has a slice of everybody');

    const slowest = timingOfSlice({ run, slice }).slowest;

    // Three sessions lasted 21 500 ms and three lasted 21 250 ms: the first three rows are the
    // longer tie in id order, and the last two are the first two of the shorter one.
    expect(slowest.map((row) => row.sessionId)).toEqual(['S-28', 'S-56', 'S-84', 'S-20', 'S-48']);
    expect(slowest.map((row) => row.totalMs)).toEqual([21_500, 21_500, 21_500, 21_250, 21_250]);
    expect(timingOfSlice({ run, slice }).slowest).toEqual(slowest);
  });
});

describe('an automation failure', () => {
  it('is in no distribution and in no slowest row', () => {
    const timing = timingOf('variant:B');

    // S-05 is the (B, desktop) session our own harness broke: version B's two scored sessions
    // are S-04 and S-06, and its 4 000 ms is in neither the total nor the slowest table.
    expect(timing.total.sampleCount).toBe(2);
    expect(timing.slowest.map((row) => row.sessionId)).toEqual(['S-04', 'S-06']);
    expect(timing.total.p25Ms).toBe(13_750);
    expect(timingOf('all').total.sampleCount).toBe(5);
  });

  it('is dropped here too, rather than trusted to have been dropped already', () => {
    const slice = sliceOf('variant:B');
    const broken = smallRunSessions.find((session) => session.sessionId === 'S-05');
    if (broken === undefined) throw new Error('the fixture carries S-05');

    const timing = timingOfSlice({
      run: smallRun,
      slice: { ...slice, sessions: [...slice.sessions, broken] },
    });

    expect(timing.total.sampleCount).toBe(2);
    expect(timing.slowest.map((row) => row.sessionId)).not.toContain('S-05');
  });

  it('leaves a slice of nothing but automation failures with no figure to report', () => {
    const slice = sliceOf('variant:B');
    const broken = smallRunSessions.find((session) => session.sessionId === 'S-05');
    if (broken === undefined) throw new Error('the fixture carries S-05');

    expect(() => timingOfSlice({ run: smallRun, slice: { ...slice, sessions: [broken] } })).toThrow(
      /no scored session/,
    );
  });
});
