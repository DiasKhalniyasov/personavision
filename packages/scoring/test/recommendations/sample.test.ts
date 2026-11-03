import { SCHEMA_VERSION, sessionSchema, type Persona, type Session } from '@personavision/contract';
import { describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_SIZE,
  SAMPLE_STRATEGY,
  sampleSessions,
  WHOLE_RUN_STRATEGY,
} from '../../src/index.js';

/**
 * The sample Muse Wonder reads.
 *
 * The run these are written over is the one the prototype's Analysis screen prints: a
 * hundred agents, seven of whom hit an automation failure, so the provenance line reads
 * *"Read 20 of 93 sessions"* — ninety-three is what the run is about, not what landed on
 * the disk.
 *
 * The fixture is built here rather than in `test/fixtures/` because sampling reads three
 * things about a session — its id, its outcome and whose it was — and nothing else: a
 * hundred sessions of fixations would say nothing this file asserts. `sessionSchema`
 * parses two of them below, so the fixture is the contract's shape and not merely the
 * type's.
 */

/**
 * The twenty the fixture run and its seed draw, in the order they come back: the three
 * outcomes in turn, each one's segments in turn, and inside a segment the order the seeded
 * random drew them. Written down as values, because "deterministic" asserted by running
 * the function twice only proves it is not random **this** time.
 */
const GOLDEN_IDS: readonly string[] = [
  // Eight who finished, two from each of the four segments.
  'S-09',
  'S-21',
  'S-30',
  'S-18',
  'S-19',
  'S-31',
  'S-04',
  'S-28',
  // Eight who gave up, likewise two from each.
  'S-57',
  'S-61',
  'S-78',
  'S-42',
  'S-55',
  'S-71',
  'S-48',
  'S-68',
  // Four who failed: fifteen sessions over four segments leaves one place each.
  'S-81',
  'S-90',
  'S-83',
  'S-88',
];

const RUN_ID = 'muse-wonder-fixture';

const TRAITS = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

const DEVICE = {
  name: 'iPhone 15',
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  touch: true,
};

/** Four segments, named so that their order in an assertion is the order you would guess. */
const SEGMENTS = [
  'desktop · first-timer',
  'desktop · returning',
  'mobile · first-timer',
  'mobile · returning',
] as const;

type Status = Session['outcome']['status'];

const personaOf = (index: number): Persona => ({
  id: `P-${index}`,
  name: `Person ${index}`,
  audienceId: 'muse-wonder-audience',
  segment: SEGMENTS[(index - 1) % SEGMENTS.length],
  traits: TRAITS,
  device: DEVICE,
});

const sessionOf = (index: number, status: Status): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: `S-${String(index).padStart(2, '0')}`,
  runId: RUN_ID,
  variant: 'A',
  taskId: 'make-a-video',
  kind: 'simulated',
  persona: { id: `P-${index}`, traits: TRAITS, device: DEVICE },
  participant: null,
  seed: index,
  startedAt: '2026-11-03T09:41:00.000Z',
  durationMs: 1000 + index,
  screens: [],
  fixations: [],
  saccades: [],
  actions: [],
  outcome: {
    status,
    step: status === 'success' ? 'preview' : 'waiting',
    reason: '',
    attribution: status === 'automation_failure' ? 'automation' : 'product',
    // Read off the session, never re-derived: `score.ts` holds the pipeline to setting it.
    excludedFromScores: status === 'automation_failure',
  },
  integrity: { selectorFailures: 0, retries: 0 },
});

/** 38 finished, 40 gave up, 15 failed, 7 were automation failures: a hundred agents, 93 of them the run. */
const statusOf = (index: number): Status => {
  if (index <= 38) return 'success';
  if (index <= 78) return 'abandoned';
  if (index <= 93) return 'failed';
  return 'automation_failure';
};

const INDEXES = Array.from({ length: 100 }, (_, position) => position + 1);
const RUN_SESSIONS: readonly Session[] = INDEXES.map((index) => sessionOf(index, statusOf(index)));
const RUN_PERSONAS: readonly Persona[] = INDEXES.map(personaOf);

/** The seed a run of this fixture would carry. */
const SEED = 20261103;

const segmentById = new Map(RUN_PERSONAS.map((persona) => [persona.id, persona.segment]));

const segmentOf = (session: Session): string =>
  segmentById.get(session.persona?.id ?? '') ?? 'no segment';

const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

const idsOf = (sessions: readonly Session[]): string[] =>
  sessions.map((session) => session.sessionId);

describe('sampleSessions', () => {
  it('is written over a fixture in the contract’s own shape', () => {
    expect(() => sessionSchema.parse(RUN_SESSIONS[0])).not.toThrow();
    expect(() => sessionSchema.parse(RUN_SESSIONS[99])).not.toThrow();
  });

  it('reads twenty of the ninety-three the run is about', () => {
    const { sessions, sample } = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);

    expect(sessions).toHaveLength(20);
    expect(sample).toEqual({ read: 20, of: 93, strategy: SAMPLE_STRATEGY, seed: SEED });
  });

  it('takes its size from one named constant, which is the agreed twenty', () => {
    expect(SAMPLE_SIZE).toBe(20);
    expect(sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED).sessions).toHaveLength(SAMPLE_SIZE);
    expect(sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED, 7).sessions).toHaveLength(7);
  });

  it('excludes an automation failure from the sample and from what it counts itself against', () => {
    const { sessions, sample } = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);

    expect(sample.of).toBe(RUN_SESSIONS.length - 7);
    expect(sessions.some((session) => session.outcome.status === 'automation_failure')).toBe(false);
    expect(sessions.some((session) => session.outcome.excludedFromScores)).toBe(false);
  });

  it('carries every outcome the run produced, and only those', () => {
    const { sessions } = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);

    expect(new Set(sessions.map((session) => session.outcome.status))).toEqual(
      new Set(['success', 'abandoned', 'failed']),
    );
  });

  it('shares the twenty places between the outcomes in proportion to the run', () => {
    const { sessions } = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);

    expect(tally(sessions.map((session) => session.outcome.status))).toEqual({
      success: 8,
      abandoned: 8,
      failed: 4,
    });
  });

  it('spreads each outcome’s places over the segments inside it', () => {
    const { sessions } = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);
    const abandoned = sessions.filter((session) => session.outcome.status === 'abandoned');

    expect(tally(abandoned.map(segmentOf))).toEqual({
      'desktop · first-timer': 2,
      'desktop · returning': 2,
      'mobile · first-timer': 2,
      'mobile · returning': 2,
    });
  });

  it('gives the same ids in the same order for the same sessions and seed', () => {
    const first = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);
    const again = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED);

    expect(idsOf(again.sessions)).toEqual(idsOf(first.sessions));
    expect(idsOf(first.sessions)).toEqual(GOLDEN_IDS);
  });

  it('draws a different twenty from a different seed', () => {
    const drawn = sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED + 1);

    expect(drawn.sessions).toHaveLength(20);
    expect(idsOf(drawn.sessions)).not.toEqual(GOLDEN_IDS);
  });

  it('does not depend on the order the sessions were handed to it', () => {
    const reversed = [...RUN_SESSIONS].reverse();

    expect(idsOf(sampleSessions(reversed, RUN_PERSONAS, SEED).sessions)).toEqual(GOLDEN_IDS);
  });

  it('draws from the contract’s seeded random, never from Math.random', () => {
    const forbidden = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random() makes a sample irreproducible between two runs');
    });

    try {
      expect(sampleSessions(RUN_SESSIONS, RUN_PERSONAS, SEED).sessions).toHaveLength(20);
    } finally {
      forbidden.mockRestore();
    }
  });

  it('reads a run smaller than the sample whole, and says that is what it did', () => {
    const tenAndTwoFailures = [...RUN_SESSIONS.slice(0, 10), ...RUN_SESSIONS.slice(94, 96)];
    const { sessions, sample } = sampleSessions(tenAndTwoFailures, RUN_PERSONAS, SEED);

    expect(sample).toEqual({ read: 10, of: 10, strategy: WHOLE_RUN_STRATEGY, seed: SEED });
    expect(idsOf(sessions)).toEqual(idsOf(RUN_SESSIONS.slice(0, 10)));
  });

  it('reads nothing from a run that is nothing but automation failures', () => {
    const { sessions, sample } = sampleSessions(RUN_SESSIONS.slice(93), RUN_PERSONAS, SEED);

    expect(sessions).toEqual([]);
    expect(sample).toEqual({ read: 0, of: 0, strategy: WHOLE_RUN_STRATEGY, seed: SEED });
  });

  it('fills the sample even when a stratum is offered more places than it can hold', () => {
    // Thirteen people who all gave up: ten of them in one segment, and the other three
    // each alone in theirs. Eight places — one to every segment, then the rest in
    // proportion, which offers a segment of one a second place. The place passes on to a
    // segment with room rather than leaving the sample at seven.
    const lopsided = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 2, 3, 4].map((index) =>
      sessionOf(index, 'abandoned'),
    );
    const { sessions, sample } = sampleSessions(lopsided, RUN_PERSONAS, SEED, 8);

    expect(sample).toEqual({ read: 8, of: 13, strategy: SAMPLE_STRATEGY, seed: SEED });
    expect(sessions).toHaveLength(8);
    expect(tally(sessions.map(segmentOf))).toEqual({
      'desktop · first-timer': 5,
      'desktop · returning': 1,
      'mobile · first-timer': 1,
      'mobile · returning': 1,
    });
  });

  it('samples an outcome this module does not name rather than dropping it', () => {
    // The day the contract gains a fourth product outcome, the sessions that carry it are
    // still part of the run `of` counts, so they have to be part of what the sample covers.
    const invented = 'left-at-the-paywall' as Status;
    const widened = [
      ...RUN_SESSIONS.slice(0, 40),
      ...[95, 96, 97, 98, 99].map((index) => sessionOf(index, invented)),
    ];
    const { sessions, sample } = sampleSessions(widened, RUN_PERSONAS, SEED);

    expect(sample.of).toBe(45);
    expect(sessions).toHaveLength(20);
    expect(
      sessions.filter((session) => session.outcome.status === invented).length,
    ).toBeGreaterThan(0);
  });

  it('keeps a session whose persona the run does not name', () => {
    const { sessions, sample } = sampleSessions(RUN_SESSIONS.slice(0, 30), [], SEED);

    expect(sample.of).toBe(30);
    expect(sessions).toHaveLength(20);
    expect(new Set(idsOf(sessions)).size).toBe(20);
  });
});
