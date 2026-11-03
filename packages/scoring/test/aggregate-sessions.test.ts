import { runSchema, sessionSchema, type Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  composeAggregate,
  distributionOf,
  funnelOfSlice,
  funnelSliceSpecs,
  pathsOfSlice,
  quantileMs,
  scoredSessions,
  screenFiguresOfSlice,
  screenIndexAt,
  screenSliceSpecs,
  stepWalk,
  timingOfSlice,
} from '../src/index.js';
import {
  buildHundredSessionRun,
  smallRun,
  smallRunSessions,
} from './fixtures/aggregate.js';

const sessionOf = (sessionId: string): Session => {
  const found = smallRunSessions.find((session) => session.sessionId === sessionId);
  if (found === undefined) throw new Error(`the fixture carries no ${sessionId}`);
  return found;
};

describe('who counts', () => {
  it('leaves the automation failure out and reports how many there were', () => {
    const { sessions, excludedAutomationFailures } = scoredSessions(smallRunSessions);

    expect(sessions.map((session) => session.sessionId)).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
      'S-06',
    ]);
    expect(excludedAutomationFailures).toBe(1);
  });

  it('drops an automation failure the pipeline forgot to exclude, and keeps the count', () => {
    const forgotten = smallRunSessions.map((session) =>
      session.outcome.status === 'automation_failure'
        ? { ...session, outcome: { ...session.outcome, excludedFromScores: false } }
        : session,
    );
    const { sessions, excludedAutomationFailures } = scoredSessions(forgotten);

    expect(sessions.map((session) => session.sessionId)).not.toContain('S-05');
    expect(excludedAutomationFailures).toBe(1);
  });
});

describe('the step walk', () => {
  it('spans every screen of an ordinary session, from zero to the session s duration', () => {
    expect(stepWalk(sessionOf('S-01'))).toEqual([
      { screenIndex: 0, step: 'landing', startMs: 0, endMs: 4000, durationMs: 4000 },
      { screenIndex: 1, step: 'prompt', startMs: 4000, endMs: 9000, durationMs: 5000 },
      { screenIndex: 2, step: 'generate', startMs: 9000, endMs: 15_000, durationMs: 6000 },
      { screenIndex: 3, step: 'preview', startMs: 15_000, endMs: 20_000, durationMs: 5000 },
    ]);
  });

  it('reports a screen nobody looked at as reached with nothing measured', () => {
    const walk = stepWalk(sessionOf('S-06'));

    expect(walk).toEqual([
      { screenIndex: 0, step: 'landing', startMs: 0, endMs: 2000, durationMs: 2000 },
      { screenIndex: 1, step: 'prompt', startMs: 2000, endMs: 6000, durationMs: 4000 },
      // Reached, and never looked at: the span is empty and the time is null, not zero.
      { screenIndex: 2, step: 'generate', startMs: 6000, endMs: 6000, durationMs: null },
      { screenIndex: 3, step: 'preview', startMs: 6000, endMs: 10_000, durationMs: 4000 },
    ]);
  });

  it('keeps a revisit as two spans of its own step', () => {
    const walk = stepWalk(sessionOf('S-04'));

    expect(walk.map((span) => span.step)).toEqual([
      'landing',
      'prompt',
      'generate',
      'prompt',
      'preview',
    ]);
    expect(walk.map((span) => span.durationMs)).toEqual([3000, 5000, 5000, 5000, 7000]);
  });

  it('gives an action to the screen whose span contains it', () => {
    const session = sessionOf('S-04');
    const walk = stepWalk(session);
    const back = session.actions.find((action) => action.type === 'back');

    expect(back?.tMs).toBe(12_500);
    expect(screenIndexAt(walk, back?.tMs ?? 0)).toBe(2);
    expect(screenIndexAt(walk, 0)).toBe(0);
    // An action at the very end of a session belongs to the last screen it had.
    expect(screenIndexAt(walk, session.durationMs)).toBe(4);
  });
});

describe('the slices', () => {
  it('enumerates every (version, segment) the run has people for, and no more', () => {
    expect(
      funnelSliceSpecs(smallRun, smallRunSessions).map((slice) => [
        slice.key,
        slice.variant,
        slice.segment,
        slice.label,
        slice.sessions.length,
      ]),
    ).toEqual([
      ['all', null, null, 'Every segment', 5],
      ['segment:desktop', null, 'desktop', 'Desktop 1', 1],
      ['segment:phone', null, 'phone', 'Phone 4', 4],
      ['variant:A', 'A', null, 'Current flow 3', 3],
      ['variant:B', 'B', null, 'Redesign candidate 2', 2],
      ['variant:A|segment:desktop', 'A', 'desktop', 'Current flow · desktop 1', 1],
      ['variant:A|segment:phone', 'A', 'phone', 'Current flow · phone 2', 2],
      // (B, desktop) is a combination no session falls in, so it is not a slice at all.
      ['variant:B|segment:phone', 'B', 'phone', 'Redesign candidate · phone 2', 2],
    ]);
  });

  it('enumerates every (segment, outcome) the same way, and never automation_failure', () => {
    const slices = screenSliceSpecs(smallRun, smallRunSessions);

    expect(
      slices.map((slice) => [
        slice.key,
        slice.segment,
        slice.outcome,
        slice.label,
        slice.sessions.length,
      ]),
    ).toEqual([
      ['all', null, null, 'Every outcome', 5],
      ['segment:desktop', 'desktop', null, 'Desktop 1', 1],
      ['segment:phone', 'phone', null, 'Phone 4', 4],
      ['outcome:success', null, 'success', 'Completed 2', 2],
      ['outcome:abandoned', null, 'abandoned', 'Gave up 2', 2],
      ['outcome:failed', null, 'failed', 'Failed 1', 1],
      ['segment:desktop|outcome:failed', 'desktop', 'failed', 'Failed · desktop 1', 1],
      ['segment:phone|outcome:success', 'phone', 'success', 'Completed · phone 2', 2],
      ['segment:phone|outcome:abandoned', 'phone', 'abandoned', 'Gave up · phone 2', 2],
    ]);
    expect(slices.map((slice) => slice.outcome)).not.toContain('automation_failure');
  });

  it('always carries the slice of everybody on both axes', () => {
    const funnel = funnelSliceSpecs(smallRun, smallRunSessions);
    const screens = screenSliceSpecs(smallRun, smallRunSessions);

    expect(
      funnel.filter((slice) => slice.variant === null && slice.segment === null),
    ).toHaveLength(1);
    expect(
      screens.filter((slice) => slice.segment === null && slice.outcome === null),
    ).toHaveLength(1);
  });

  it('reads the segments off the people the scored sessions carry', () => {
    // Drop the one desktop session that counts: the only desktop person left is the
    // automation failure, which is in no figure, so desktop is no longer a segment.
    const withoutDesktop = smallRunSessions.filter((session) => session.sessionId !== 'S-03');

    expect(
      [...new Set(funnelSliceSpecs(smallRun, withoutDesktop).map((slice) => slice.segment))],
    ).toEqual([null, 'phone']);
    expect(
      [...new Set(screenSliceSpecs(smallRun, withoutDesktop).map((slice) => slice.segment))],
    ).toEqual([null, 'phone']);
  });

  it('offers no version to filter by on a run that declares one', () => {
    const { run, sessions } = buildHundredSessionRun();

    expect(run.variants).toHaveLength(1);
    expect(funnelSliceSpecs(run, sessions).map((slice) => slice.variant)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('is no slices at all when nothing was scored', () => {
    const broken = smallRunSessions.filter((session) => session.sessionId === 'S-05');

    expect(funnelSliceSpecs(smallRun, broken)).toEqual([]);
    expect(screenSliceSpecs(smallRun, broken)).toEqual([]);
  });
});

describe('quantiles and bins', () => {
  it('interpolates between order statistics, the way a spreadsheet does', () => {
    const sample = [10, 20, 30, 40];

    expect(quantileMs(sample, 0.25)).toBe(18);
    expect(quantileMs(sample, 0.5)).toBe(25);
    expect(quantileMs(sample, 0.75)).toBe(33);
    expect(quantileMs(sample, 0.9)).toBe(37);
  });

  it('reads an unsorted sample the same way as a sorted one', () => {
    expect(quantileMs([40, 10, 30, 20], 0.5)).toBe(25);
  });

  it('answers a one-element sample with that element, and an empty one with null', () => {
    expect(quantileMs([1234], 0.25)).toBe(1234);
    expect(quantileMs([1234], 0.9)).toBe(1234);
    expect(quantileMs([], 0.5)).toBeNull();
    expect(distributionOf([])).toBeNull();
  });

  it('draws twelve bars over the whole sample, with the bar the median falls in', () => {
    expect(distributionOf([0, 100, 200, 300])).toEqual({
      sampleCount: 4,
      p25Ms: 75,
      p50Ms: 150,
      p75Ms: 225,
      p90Ms: 270,
      binWidthMs: 26,
      bins: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      medianBin: 5,
    });
  });

  it('keeps the slowest sample inside the bars the quantiles are read off', () => {
    const samples = [[5000], [0, 0, 0], [1, 2, 3, 4, 5], [240, 12_000, 12_000, 36_000]];

    for (const sample of samples) {
      const distribution = distributionOf(sample);
      if (distribution === null) throw new Error('a sample with entries has a distribution');
      const { bins, binWidthMs, sampleCount, p50Ms, p90Ms } = distribution;
      expect(bins.reduce((total, bin) => total + bin, 0)).toBe(sampleCount);
      expect(Math.floor(p50Ms / binWidthMs)).toBe(distribution.medianBin);
      expect(p90Ms).toBeLessThan(bins.length * binWidthMs);
    }
  });
});

describe('the surface the figures fill', () => {
  it('fails loudly, naming the ticket that fills it, rather than returning zeroes', () => {
    const slice = funnelSliceSpecs(smallRun, smallRunSessions)[0];
    const screenSlice = screenSliceSpecs(smallRun, smallRunSessions)[0];
    if (slice === undefined || screenSlice === undefined) {
      throw new Error('the fixture has slices');
    }

    expect(() => funnelOfSlice({ run: smallRun, slice })).toThrow(/#289/);
    expect(() => pathsOfSlice({ slice })).toThrow(/#289/);
    expect(() => timingOfSlice({ run: smallRun, slice })).toThrow(/#290/);
    expect(() => screenFiguresOfSlice({ run: smallRun, slice: screenSlice })).toThrow(/#291/);
    expect(() =>
      composeAggregate({
        run: smallRun,
        sessions: smallRunSessions,
        computedAt: '2026-11-03T09:21:00.000Z',
      }),
    ).toThrow(/#292/);
  });
});

describe('the fixtures', () => {
  it('parses the small run and its sessions against the contract', () => {
    expect(() => runSchema.parse(smallRun)).not.toThrow();
    for (const session of smallRunSessions) {
      expect(() => sessionSchema.parse(session)).not.toThrow();
    }
  });

  it('parses the hundred-session run and its sessions against the contract', () => {
    const { run, sessions } = buildHundredSessionRun();

    expect(sessions).toHaveLength(100);
    expect(() => runSchema.parse(run)).not.toThrow();
    for (const session of sessions) {
      expect(() => sessionSchema.parse(session)).not.toThrow();
    }
    const { excludedAutomationFailures, sessions: scored } = scoredSessions(sessions);
    expect(excludedAutomationFailures).toBe(7);
    expect(scored).toHaveLength(93);
  });
});
