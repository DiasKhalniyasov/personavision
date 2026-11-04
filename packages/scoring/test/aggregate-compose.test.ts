import {
  aggregateSchema,
  SCHEMA_VERSION,
  type Aggregate,
  type Run,
  type Session,
} from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { composeAggregate } from '../src/index.js';
import {
  buildHundredSessionRun,
  DESKTOP_SEGMENT,
  PHONE_SEGMENT,
  smallRun,
  smallRunSessions,
} from './fixtures/aggregate.js';

/**
 * The composition itself, over the two fixtures of this step: the small run whose every
 * figure is counted by hand, and the hundred-session run that is here for scale.
 *
 * What is asserted here is what only exists **across** the figures — the agreement with
 * `run.json`'s own `scores[]`, that the slices sum to the whole, that a figure asked of a
 * segment is the figure over that segment's sessions, that two compositions of the same
 * sessions are the same bytes, and that the file a screen fetches is small. Each figure's
 * own values belong to `aggregate-funnel.test.ts`, `aggregate-timing.test.ts`,
 * `aggregate-paths.test.ts` and `aggregate-screens.test.ts`, and are not restated here.
 */

/** Passed in rather than read from a clock, so a composition is a pure function of its input. */
const COMPUTED_AT = '2026-11-03T09:21:00.000Z';

const compose = (run: Run, sessions: readonly Session[]): Aggregate =>
  composeAggregate({ run, sessions, computedAt: COMPUTED_AT });

const smallAggregate = (): Aggregate => compose(smallRun, smallRunSessions);

/**
 * The small run with a field `run.json` need not carry left off it: a run that has not
 * stopped records no `finishedAt`, and a run written before that step recorded no `status`.
 */
const smallRunWithout = (...absent: ReadonlyArray<'status' | 'finishedAt'>): Run => {
  const run: Run = { ...smallRun };
  for (const field of absent) delete run[field];
  return run;
};

/** The same run, still running. */
const openSmallRun = (): Run => ({ ...smallRunWithout('finishedAt'), status: 'open' });

/** What `writeAggregate` puts on disk: the bytes a screen fetches, to the byte. */
const serialized = (aggregate: Aggregate): string => `${JSON.stringify(aggregate, null, 2)}\n`;

const funnelSlice = (aggregate: Aggregate, key: string): Aggregate['funnelSlices'][number] => {
  const found = aggregate.funnelSlices.find((slice) => slice.key === key);
  if (found === undefined) throw new Error(`the aggregate carries no funnel slice "${key}"`);
  return found;
};

const screenSlice = (aggregate: Aggregate, key: string): Aggregate['screenSlices'][number] => {
  const found = aggregate.screenSlices.find((slice) => slice.key === key);
  if (found === undefined) throw new Error(`the aggregate carries no screen slice "${key}"`);
  return found;
};

/**
 * The completion rate this aggregate implies for a slice: how many of the people in it
 * finished the last step of the run, over the people the slice is of. It is read off the
 * funnel's own last row rather than recounted from the sessions, because the point of the
 * agreement test is that **the stored figure** says what the summary says.
 */
const impliedCompletionRate = (slice: Aggregate['funnelSlices'][number]): number => {
  const last = slice.funnel[slice.funnel.length - 1];
  if (last === undefined) throw new Error(`the funnel of slice "${slice.key}" holds no step`);
  return last.completed / slice.sessionCount;
};

/** The `scores[]` row `run.json` already carries for a version. */
const storedScore = (run: Run, variant: string): Run['scores'][number] => {
  const found = run.scores.find((score) => score.variant === variant);
  if (found === undefined) throw new Error(`run.json carries no score for version "${variant}"`);
  return found;
};

const segmentOfSession = (run: Run, session: Session): string | null =>
  run.personas.find((persona) => persona.id === session.persona?.id)?.segment ?? null;

describe('the golden composition over the small fixture', () => {
  it('carries the file’s own fields, the scored count and the failures it left out', () => {
    const aggregate = smallAggregate();

    expect(aggregate.schemaVersion).toBe(SCHEMA_VERSION);
    expect(aggregate.runId).toBe('aggregate-fixture-run');
    expect(aggregate.computedAt).toBe(COMPUTED_AT);
    expect(aggregate.runStatus).toBe('finished');
    // Six sessions landed; one of them was our harness breaking, and it is in no figure.
    expect(aggregate.scoredSessionCount).toBe(5);
    expect(aggregate.excludedAutomationFailures).toBe(1);
  });

  it('composes every slice the two screens offer, in the order the file declares them', () => {
    const aggregate = smallAggregate();

    // The whole run, then the segments, then the versions, then the pairs — and *(B,
    // desktop)* is absent because no session falls in it.
    expect(aggregate.funnelSlices.map((slice) => slice.key)).toEqual([
      'all',
      'segment:desktop',
      'segment:phone',
      'variant:A',
      'variant:B',
      'variant:A|segment:desktop',
      'variant:A|segment:phone',
      'variant:B|segment:phone',
    ]);
    // The whole run, then the segments, then the outcomes in the contract's own order, then
    // the pairs that anybody falls in.
    expect(aggregate.screenSlices.map((slice) => slice.key)).toEqual([
      'all',
      'segment:desktop',
      'segment:phone',
      'outcome:success',
      'outcome:abandoned',
      'outcome:failed',
      'segment:desktop|outcome:failed',
      'segment:phone|outcome:success',
      'segment:phone|outcome:abandoned',
    ]);
  });

  it('states the funnel of the whole run by value, with the drop and the words of its filter', () => {
    const whole = funnelSlice(smallAggregate(), 'all');

    expect(whole.variant).toBeNull();
    expect(whole.segment).toBeNull();
    expect(whole.label).toBe('Every segment');
    expect(whole.sessionCount).toBe(5);
    expect(whole.funnel).toEqual([
      { step: 'landing', reached: 5, completed: 5, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 5, completed: 4, abandoned: 0, failed: 1, reachedShare: 1 },
      { step: 'generate', reached: 4, completed: 3, abandoned: 1, failed: 0, reachedShare: 0.8 },
      { step: 'preview', reached: 3, completed: 2, abandoned: 1, failed: 0, reachedShare: 0.6 },
    ]);
    expect(whole.biggestDrop).toEqual({
      step: 'prompt',
      left: 1,
      ofReached: 5,
      reason: 'the prompt was rejected',
    });
    expect(whole.paths).toEqual([
      { steps: ['landing', 'prompt', 'generate', 'preview'], sessionCount: 2 },
    ]);
    expect(whole.timing.total.sampleCount).toBe(5);
    expect(whole.timing.total.p50Ms).toBe(12_000);
    expect(whole.timing.slowest.map((row) => row.sessionId)).toEqual([
      'S-04',
      'S-01',
      'S-02',
      'S-06',
      'S-03',
    ]);
  });

  it('composes one row per version and step into every screen slice', () => {
    const whole = screenSlice(smallAggregate(), 'all');

    expect(whole.label).toBe('Every outcome');
    expect(whole.sessionCount).toBe(5);
    // Two versions × four steps, whether anybody in the slice got there or not.
    expect(whole.screens.map((screen) => `${screen.variant}/${screen.step}`)).toEqual([
      'A/landing',
      'A/prompt',
      'A/generate',
      'A/preview',
      'B/landing',
      'B/prompt',
      'B/generate',
      'B/preview',
    ]);
  });

  it('parses against the contract’s own aggregate schema, so a composition that would not write is caught here', () => {
    expect(() => aggregateSchema.parse(smallAggregate())).not.toThrow();
    const { run, sessions } = buildHundredSessionRun();
    expect(() => aggregateSchema.parse(compose(run, sessions))).not.toThrow();
  });
});

describe('the agreement with the summary', () => {
  it('implies, for each version of the small run, the completionRate stored in scores[]', () => {
    const aggregate = smallAggregate();

    for (const variant of ['A', 'B']) {
      const score = storedScore(smallRun, variant);
      const slice = funnelSlice(aggregate, `variant:${variant}`);

      expect(slice.sessionCount).toBe(score.scoredSessionCount);
      expect(impliedCompletionRate(slice)).toBeCloseTo(score.completionRate, 10);
    }
  });

  it('implies the stored completionRate over a hundred sessions, where scores[] counted them its own way', () => {
    const { run, sessions } = buildHundredSessionRun();
    const score = storedScore(run, 'A');
    // A path-1 run declares one version, so the whole run is that version's slice.
    const whole = funnelSlice(compose(run, sessions), 'all');

    expect(whole.sessionCount).toBe(score.scoredSessionCount);
    expect(whole.sessionCount).toBe(93);
    expect(impliedCompletionRate(whole)).toBeCloseTo(score.completionRate, 10);
  });
});

describe('the slices sum to the whole', () => {
  const sums = (run: Run, sessions: readonly Session[]): void => {
    const aggregate = compose(run, sessions);
    const bySegment = aggregate.funnelSlices.filter(
      (slice) => slice.variant === null && slice.segment !== null,
    );
    const byOutcome = aggregate.screenSlices.filter(
      (slice) => slice.segment === null && slice.outcome !== null,
    );

    // Every session walked by somebody the run names falls in exactly one segment slice and
    // exactly one outcome slice, so each enumeration adds up to the run.
    expect(bySegment.reduce((total, slice) => total + slice.sessionCount, 0)).toBe(
      aggregate.scoredSessionCount,
    );
    expect(byOutcome.reduce((total, slice) => total + slice.sessionCount, 0)).toBe(
      aggregate.scoredSessionCount,
    );
    // And no slice is a widening of the run it narrows.
    for (const slice of [...aggregate.funnelSlices, ...aggregate.screenSlices]) {
      expect(slice.sessionCount).toBeGreaterThan(0);
      expect(slice.sessionCount).toBeLessThanOrEqual(aggregate.scoredSessionCount);
    }
  };

  it('adds the segment and outcome slices of the small run back to the whole', () => {
    sums(smallRun, smallRunSessions);
  });

  it('adds them back over a hundred sessions', () => {
    const { run, sessions } = buildHundredSessionRun();
    sums(run, sessions);
  });

  it('asks a figure of a segment and gets the figure over only that segment’s sessions', () => {
    const whole = smallAggregate();
    const phoneOnly = compose(
      smallRun,
      smallRunSessions.filter((session) => segmentOfSession(smallRun, session) === PHONE_SEGMENT),
    );
    const sliced = funnelSlice(whole, `segment:${PHONE_SEGMENT}`);
    const alone = funnelSlice(phoneOnly, 'all');

    expect(sliced.sessionCount).toBe(alone.sessionCount);
    expect(sliced.funnel).toEqual(alone.funnel);
    expect(sliced.biggestDrop).toEqual(alone.biggestDrop);
    expect(sliced.timing).toEqual(alone.timing);
    expect(sliced.paths).toEqual(alone.paths);
    expect(screenSlice(whole, `segment:${PHONE_SEGMENT}`).screens).toEqual(
      screenSlice(phoneOnly, 'all').screens,
    );
  });

  it('asks the same of the segment that carries one session', () => {
    const whole = smallAggregate();
    const desktopOnly = compose(
      smallRun,
      smallRunSessions.filter((session) => segmentOfSession(smallRun, session) === DESKTOP_SEGMENT),
    );
    const sliced = funnelSlice(whole, `segment:${DESKTOP_SEGMENT}`);
    const alone = funnelSlice(desktopOnly, 'all');

    // The desktop sessions are one scored session and one automation failure, so the
    // segment slice of the whole run and the whole of that segment are the same single walk.
    expect(sliced.sessionCount).toBe(1);
    expect(alone.sessionCount).toBe(1);
    expect(sliced.funnel).toEqual(alone.funnel);
    expect(sliced.timing).toEqual(alone.timing);
  });
});

describe('determinism', () => {
  it('composes the same sessions twice into an identical value and identical bytes', () => {
    expect(smallAggregate()).toEqual(smallAggregate());
    expect(serialized(smallAggregate())).toBe(serialized(smallAggregate()));
  });

  it('re-composes a hundred sessions into the same bytes, ties and all', () => {
    const once = buildHundredSessionRun();
    const twice = buildHundredSessionRun();

    expect(serialized(compose(twice.run, twice.sessions))).toBe(
      serialized(compose(once.run, once.sessions)),
    );
  });

  it('fixes the key order of the file, so the bytes do not move when a figure module does', () => {
    expect(Object.keys(smallAggregate())).toEqual([
      'schemaVersion',
      'runId',
      'computedAt',
      'runStatus',
      'scoredSessionCount',
      'excludedAutomationFailures',
      'funnelSlices',
      'screenSlices',
    ]);
    expect(Object.keys(funnelSlice(smallAggregate(), 'all'))).toEqual([
      'key',
      'variant',
      'segment',
      'label',
      'sessionCount',
      'funnel',
      'biggestDrop',
      'timing',
      'paths',
    ]);
    expect(Object.keys(screenSlice(smallAggregate(), 'all'))).toEqual([
      'key',
      'segment',
      'outcome',
      'label',
      'sessionCount',
      'screens',
    ]);
  });
});

describe('an open run', () => {
  it('composes over the sessions that exist and says the run was open', () => {
    const landed = smallRunSessions.slice(0, 3);
    const aggregate = compose(openSmallRun(), landed);

    expect(aggregate.runStatus).toBe('open');
    // The counts are of what is on disk at this moment, not of what the run will hold.
    expect(aggregate.scoredSessionCount).toBe(3);
    expect(funnelSlice(aggregate, 'all').sessionCount).toBe(3);
    expect(funnelSlice(aggregate, 'all').timing.total.sampleCount).toBe(3);
    // Nobody has walked version B yet, so it has no slice: a filter over nobody is no button.
    expect(aggregate.funnelSlices.map((slice) => slice.key)).not.toContain('variant:B');
    expect(() => aggregateSchema.parse(aggregate)).not.toThrow();
  });

  it('reads a run that recorded no status as open, so no partial figure is called final', () => {
    const aggregate = compose(smallRunWithout('status'), smallRunSessions.slice(0, 3));

    expect(aggregate.runStatus).toBe('open');
    expect(() => aggregateSchema.parse(aggregate)).not.toThrow();
  });
});

describe('the automation failures', () => {
  it('reports how many the harness broke and holds them out of every figure', () => {
    const aggregate = smallAggregate();
    const slowest = aggregate.funnelSlices.flatMap((slice) =>
      slice.timing.slowest.map((row) => row.sessionId),
    );

    expect(aggregate.excludedAutomationFailures).toBe(1);
    expect(aggregate.scoredSessionCount).toBe(5);
    // S-05 is the session our harness broke: it is in no table and in no slice.
    expect(slowest).not.toContain('S-05');
    expect(aggregate.screenSlices.map((slice) => slice.outcome)).not.toContain(
      'automation_failure',
    );
    expect(aggregate.funnelSlices.map((slice) => slice.key)).not.toContain(
      'variant:B|segment:desktop',
    );
  });

  it('reports the seven of a hundred sessions the harness broke', () => {
    const { run, sessions } = buildHundredSessionRun();
    const aggregate = compose(run, sessions);

    expect(aggregate.excludedAutomationFailures).toBe(7);
    expect(aggregate.scoredSessionCount).toBe(93);
  });

  it('claims no figure for a run whose every session was an automation failure', () => {
    const broken = smallRunSessions.filter(
      (session) => session.outcome.status === 'automation_failure',
    );
    const aggregate = compose(smallRun, broken);

    expect(broken.length).toBeGreaterThan(0);
    expect(aggregate.excludedAutomationFailures).toBe(broken.length);
    expect(aggregate.scoredSessionCount).toBe(0);
    // Never a zero nobody measured: no slice at all rather than a row of zeroes.
    expect(aggregate.funnelSlices).toEqual([]);
    expect(aggregate.screenSlices).toEqual([]);
    expect(() => aggregateSchema.parse(aggregate)).not.toThrow();
  });

  it('composes a run with no sessions yet into zero counts and no slices, without throwing', () => {
    const aggregate = compose(openSmallRun(), []);

    expect(aggregate.scoredSessionCount).toBe(0);
    expect(aggregate.excludedAutomationFailures).toBe(0);
    expect(aggregate.funnelSlices).toEqual([]);
    expect(aggregate.screenSlices).toEqual([]);
    expect(() => aggregateSchema.parse(aggregate)).not.toThrow();
  });
});

describe('size', () => {
  /**
   * The ceiling a screen fetches in one request: 128 KiB. The hundred-session run
   * serialises to about 55 KB today, so the ceiling leaves a figure room to grow and still
   * fails before the file stops being one fetch — and the message reports the real number,
   * so a later change that pushes against it says by how much.
   */
  const CEILING_BYTES = 128 * 1024;

  it('serialises a hundred sessions, with a path-1 audience’s segments, small enough for one request', () => {
    const { run, sessions } = buildHundredSessionRun();
    const bytes = Buffer.byteLength(serialized(compose(run, sessions)), 'utf8');

    expect(
      bytes,
      `the aggregate of a hundred sessions serialises to ${bytes} bytes, and a screen fetches it in one request up to ${CEILING_BYTES}`,
    ).toBeLessThanOrEqual(CEILING_BYTES);
  });
});
