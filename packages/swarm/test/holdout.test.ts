/**
 * Baseline, change and holdout in one run, on the same seeds (#303).
 *
 * A path-2 run drives three things through two variants: the main set on the run's seed
 * groups, and the holdout on seeds of its own. What is asserted here is what a reader of the
 * finished directory can check — who was driven, on which seeds, on which side, and what the
 * run says about them — and the refusals that happen before any of it is written.
 *
 * Offline like every other suite here: the committed capture set replays the pages, the
 * offline deterministic provider decides, and no browser, socket or key is reached for.
 */

import { readdir } from 'node:fs/promises';
import { createFixtureSource } from '@personavision/browser';
import {
  AUTOMATION_FAILURE_NOTICE_SHARE,
  readRun,
  runPaths,
  runSchema,
  writeRun,
} from '@personavision/contract';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSwarm, runSwarm, sameSeedsOnBothSides } from '../src/index.js';
import {
  FOUR_PEOPLE,
  oneDeviceCaptureSet,
  personOnMobile,
  runVariant,
  sweep,
  TASK,
  temporaryRunDir,
  withNothingRunning,
  writeOpenRun,
} from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run, Session } from '@personavision/contract';
import type { RunSwarmInput, SwarmHoldout, SwarmProgress, SwarmSession } from '../src/index.js';

const VARIANTS: ReadonlyArray<Run['variants'][number]> = [runVariant('A'), runVariant('B')];

/** The main set: two of the demo's four, on the run's own seed groups. */
const TWO_PEOPLE: readonly Persona[] = [FOUR_PEOPLE[0] as Persona, FOUR_PEOPLE[1] as Persona];
const SEEDS = [11, 23];

/**
 * The holdout, as `generateHoldout` hands one over: the same audience, marked ids, and a
 * seed each that is none of the run's. The numbers are the only thing that matters about
 * them — they are not 11 or 23, so these people were never read when the change was chosen.
 */
const HOLDOUT: SwarmHoldout = {
  personas: [
    personOnMobile('rushed', { id: 'holdout-rushed', name: 'Rushed buyer (holdout)' }),
    personOnMobile('careful', { id: 'holdout-careful', name: 'Careful comparer (holdout)' }),
  ],
  seeds: [8_117, 2_399],
};

const HELD_OUT_IDS = ['holdout-rushed', 'holdout-careful'];

const NOON = '2026-10-27T12:00:00.000Z';

let runDir: string;
let captures: string;
let source: CaptureSource;

beforeEach(async () => {
  runDir = await temporaryRunDir();
  captures = await oneDeviceCaptureSet();
  source = createFixtureSource(captures);
});

afterEach(async () => {
  await sweep(runDir);
  await sweep(captures);
});

/** A swarm over the open run its caller wrote, driving the holdout with the main set. */
const swarmOver = (over: Partial<RunSwarmInput> = {}): RunSwarmInput => ({
  runDir,
  variants: VARIANTS,
  personas: TWO_PEOPLE,
  seedGroups: SEEDS,
  holdout: HOLDOUT,
  task: TASK,
  source,
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  concurrency: 3,
  now: () => new Date(NOON),
  ...over,
});

/** The open run the caller writes before the swarm runs into it, holdout people and all. */
const open = (over: Partial<Parameters<typeof writeOpenRun>[1]> = {}): Promise<Run> =>
  writeOpenRun(runDir, {
    personas: TWO_PEOPLE,
    variants: VARIANTS,
    seedGroups: SEEDS,
    holdout: HOLDOUT.personas,
    ...over,
  });

/** Who walked which variant on which seed, as the sessions on disk record it. */
const driven = (sessions: readonly Session[], variant: string): string[] =>
  sessions
    .filter((session) => session.variant === variant)
    .map((session) => `${String(session.persona?.id)} · ${String(session.seed)}`)
    .sort();

const heldOut = (sessions: readonly Session[]): Session[] =>
  sessions.filter((session) => HELD_OUT_IDS.includes(String(session.persona?.id)));

/** The session files in the run directory, whatever `run.json` says about them. */
const landed = async (): Promise<string[]> =>
  (await readdir(runPaths(runDir).sessionsDir)).map((file) => file.replace(/\.json$/, '')).sort();

/** The peak number of sessions in flight at once, counted off the events. */
const watchFlight = (): { record: (event: SwarmProgress) => void; peak: number } => {
  const flight = {
    inFlight: 0,
    peak: 0,
    record: (event: SwarmProgress): void => {
      flight.inFlight += event.kind === 'session-started' ? 1 : -1;
      flight.peak = Math.max(flight.peak, flight.inFlight);
    },
  };
  return flight;
};

/** A source that will not open a page for one of the people, named by their device label. */
const breaksFor = (inner: CaptureSource, personaId: string): CaptureSource => ({
  ...inner,
  openSession: async (variant, device) => {
    if (device.name.endsWith(personaId)) throw new Error('the fixture site is on fire');
    return inner.openSession(variant, device);
  },
});

describe('planSwarm with a holdout', () => {
  it('numbers the holdout after the main set inside each variant, once on each own seed', () => {
    const planned = planSwarm({
      variants: VARIANTS,
      personas: TWO_PEOPLE,
      seedGroups: SEEDS,
      holdout: HOLDOUT,
    });

    // Four main sessions and two holdout sessions per variant: a variant's ids stay one
    // contiguous block, which is what the example run's numbering promises.
    expect(planned.map((plan) => plan.sessionId)).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
      'S-05',
      'S-06',
      'S-07',
      'S-08',
      'S-09',
      'S-10',
      'S-11',
      'S-12',
    ]);
    expect(
      planned.map((plan) => [plan.sessionId, plan.variant.id, plan.persona.id, plan.seed]),
    ).toEqual([
      ['S-01', 'A', 'rushed', 11],
      ['S-02', 'A', 'rushed', 23],
      ['S-03', 'A', 'careful', 11],
      ['S-04', 'A', 'careful', 23],
      ['S-05', 'A', 'holdout-rushed', 8_117],
      ['S-06', 'A', 'holdout-careful', 2_399],
      ['S-07', 'B', 'rushed', 11],
      ['S-08', 'B', 'rushed', 23],
      ['S-09', 'B', 'careful', 11],
      ['S-10', 'B', 'careful', 23],
      ['S-11', 'B', 'holdout-rushed', 8_117],
      ['S-12', 'B', 'holdout-careful', 2_399],
    ]);
  });

  it('plans exactly what it planned before when no holdout is asked for', () => {
    const asked = { variants: VARIANTS, personas: TWO_PEOPLE, seedGroups: SEEDS };

    expect(planSwarm(asked)).toEqual(planSwarm({ ...asked, holdout: { personas: [], seeds: [] } }));
    expect(planSwarm(asked)).toHaveLength(8);
  });
});

describe('a run driven with a holdout', () => {
  it('drives both variants from the same seeds, person by person, holdout included', async () => {
    await open();

    const { sessions, run, holdoutPersonaIds } = await runSwarm(swarmOver());

    expect(sessions).toHaveLength(12);
    // The one promise the comparison rests on, asserted off the written sessions rather
    // than off the plan: the same people on the same seeds, so that the only difference
    // between the two sides is the code.
    expect(driven(sessions, 'A')).toEqual(driven(sessions, 'B'));
    expect(driven(sessions, 'A')).toEqual([
      'careful · 11',
      'careful · 23',
      'holdout-careful · 2399',
      'holdout-rushed · 8117',
      'rushed · 11',
      'rushed · 23',
    ]);
    // The main set is driven on the run's own seed groups and the holdout on seeds the
    // change was never chosen against.
    const mainSeeds = sessions
      .filter((session) => !HELD_OUT_IDS.includes(String(session.persona?.id)))
      .map((session) => session.seed);
    expect([...new Set(mainSeeds)].sort((a, b) => Number(a) - Number(b))).toEqual(SEEDS);
    expect([...new Set(heldOut(sessions).map((session) => session.seed))].sort()).toEqual(
      [...HOLDOUT.seeds].sort(),
    );
    expect(run.sessionIds).toHaveLength(12);
    expect(holdoutPersonaIds).toEqual(HELD_OUT_IDS);
  });

  it('writes a holdout session as an ordinary session, with its own screens and outcome', async () => {
    await open();

    await runSwarm(swarmOver());

    // Read back through the contract, which is what validates a session file.
    const { sessions } = await readRun(runDir);
    const theirs = heldOut(sessions);
    expect(theirs).toHaveLength(4);
    expect(theirs.map((session) => session.sessionId).sort()).toEqual([
      'S-05',
      'S-06',
      'S-11',
      'S-12',
    ]);
    for (const session of theirs) {
      // Nothing about the file says "holdout": what marks them is the run's holdout list.
      expect(session.kind).toBe('simulated');
      expect(session.screens.length).toBeGreaterThan(0);
      expect(session.outcome.status).toBeDefined();
      expect(session.runId).toBe(sessions[0]?.runId);
      const entry = (await readRun(runDir)).run.progress?.sessions.find(
        (one) => one.sessionId === session.sessionId,
      );
      expect(entry?.status).toBe(session.outcome.status);
    }
    // And the areas the holdout looked at are the run's own, like any other session's.
    const { run } = await readRun(runDir);
    expect(run.aois.length).toBeGreaterThan(0);
  });

  it('reads back through the contract with the holdout block and the holdout figures', async () => {
    await open();

    const { sessions, holdoutPersonaIds } = await runSwarm(swarmOver());

    // The loop (#306) writes this block once scoring has judged the holdout (#304). What is
    // asserted here is that the run the swarm wrote carries the people it names, and that
    // the figures computed from the holdout's own sessions are accepted beside them.
    const artifact = await readRun(runDir);
    const figuresOf = (variant: string): NonNullable<Run['scores'][number]['holdout']> => {
      const ours = heldOut(sessions).filter((session) => session.variant === variant);
      const scored = ours.filter((session) => !session.outcome.excludedFromScores);
      const counted = (status: string): number =>
        scored.filter((session) => session.outcome.status === status).length;
      return {
        completionRate: counted('success') / scored.length,
        outcomeCounts: {
          success: counted('success'),
          abandoned: counted('abandoned'),
          failed: counted('failed'),
          automationFailure: ours.length - scored.length,
        },
        scoredSessionCount: scored.length,
      };
    };
    const run: Run = {
      ...artifact.run,
      scores: ['A', 'B'].map((variant) => scoreRow(variant, figuresOf(variant))),
      verdict: { ...artifact.run.verdict, holdout: 'confirmed' },
      improve: {
        recommendationId: 'R-1',
        changedFile: 'src/checkout/Cart.tsx',
        pullRequest: {
          repository: 'northwind/shop',
          number: 41,
          url: 'https://github.test/northwind/shop/pull/41',
          title: 'Move the checkout control above the fold',
        },
        preview: { url: 'https://preview.test/pr-41' },
        baselineVariant: 'A',
        changeVariant: 'B',
        holdout: { personaIds: [...holdoutPersonaIds], confirmed: true },
      },
    };

    const parsed = runSchema.safeParse(run);
    expect(parsed.error?.issues ?? []).toEqual([]);

    // Written and read again, because the directory is the artifact every screen reads.
    await writeRun(runDir, { ...artifact, run });
    const reread = await readRun(runDir);
    expect(reread.run.improve?.holdout.personaIds).toEqual(HELD_OUT_IDS);
    expect(reread.run.scores.map((score) => score.holdout?.scoredSessionCount)).toEqual(
      ['A', 'B'].map((variant) => figuresOf(variant).scoredSessionCount),
    );
  });

  it('runs the holdout inside the run’s own bound, not beside it', async () => {
    await open();
    const flight = watchFlight();

    await runSwarm(swarmOver({ concurrency: 2, onProgress: flight.record }));

    // Twelve sessions, four of them the holdout's, two in flight at a time. A holdout that
    // ran outside the pool would peak above this — at three with one extra, at six if it
    // ran as a swarm of its own — and the per-site cap the platform passes down would be
    // exceeded by exactly the holdout.
    expect(flight.peak).toBe(2);
    expect(await landed()).toHaveLength(12);
  });

  it('counts the holdout towards the run’s own plan', async () => {
    // A caller that declared only the main set's eight and then drove a holdout would be
    // writing a run whose bar reads "8 of 8" and then "9 of 9": the holdout is more people,
    // not an exemption, so it is in the total the run declares.
    await open({ totalPerVariant: TWO_PEOPLE.length * SEEDS.length });

    await expect(runSwarm(swarmOver())).rejects.toThrow(/plans 8 sessions and the swarm plans 12/);
    expect(await landed()).toEqual([]);
  });

  it('excludes an automation failure among the holdout, and leaves the share readable', async () => {
    await open();

    // One holdout person, broken on both sides: two of the holdout's four sessions, which
    // is half and well over the share above which a run says it is about our own harness.
    // That share is `@personavision/contract`'s and is imported rather than restated; what
    // is said above the summary about a run that crosses it belongs to the results screen,
    // as it does for the run as a whole (`run-swarm.test.ts`). What this asserts is that
    // the holdout's own two counters are there to compute the share from.
    const { sessions } = await runSwarm(swarmOver({ source: breaksFor(source, 'holdout-rushed') }));

    const ours = heldOut(sessions);
    const excluded = ours.filter((session) => session.outcome.excludedFromScores);
    expect(excluded.map((session) => session.sessionId).sort()).toEqual(['S-05', 'S-11']);
    for (const session of excluded) {
      expect(session.outcome.status).toBe('automation_failure');
      expect(session.outcome.attribution).toBe('automation');
    }
    // The holdout's figures are the holdout's people, and the failures are not among them.
    expect(ours.length - excluded.length).toBe(2);
    expect(excluded.length / ours.length).toBeGreaterThan(AUTOMATION_FAILURE_NOTICE_SHARE);

    // The run says whose failure it was, for the holdout as for anybody else.
    const { run } = await readRun(runDir);
    const entries = (run.progress?.sessions ?? []).filter((entry) =>
      ['S-05', 'S-11'].includes(entry.sessionId),
    );
    expect(entries.map((entry) => entry.attribution)).toEqual(['automation', 'automation']);
    // And the main set is untouched by it: a broken holdout is not a broken run.
    const main = sessions.filter((session) => !HELD_OUT_IDS.includes(String(session.persona?.id)));
    expect(main.filter((session) => session.outcome.excludedFromScores)).toEqual([]);
  });

  it('is offline: no browser, no socket, no key', async () => {
    await open();

    const { sessions, holdoutPersonaIds } = await withNothingRunning(() => runSwarm(swarmOver()));

    expect(sessions).toHaveLength(12);
    expect(holdoutPersonaIds).toEqual(HELD_OUT_IDS);
  });

  it('hands back no holdout list when none was asked for', async () => {
    await writeOpenRun(runDir, { personas: TWO_PEOPLE, variants: VARIANTS, seedGroups: SEEDS });

    const { sessions, holdoutPersonaIds } = await runSwarm(swarmOver({ holdout: undefined }));

    expect(sessions).toHaveLength(8);
    expect(holdoutPersonaIds).toEqual([]);
    const { run } = await readRun(runDir);
    expect(run.improve).toBeUndefined();
  });
});

describe('what the swarm refuses, before a run is written', () => {
  /** Every refusal leaves the open run exactly as its caller wrote it. */
  const nothingWritten = async (): Promise<void> => {
    expect(await landed()).toEqual([]);
    const { run } = await readRun(runDir);
    expect(run.status).toBe('open');
    expect(run.sessionIds).toEqual([]);
    expect(run.progress?.finishedSessions).toBe(0);
  };

  it('refuses a holdout read beside nobody', async () => {
    await writeOpenRun(runDir, {
      personas: HOLDOUT.personas,
      variants: VARIANTS,
      seedGroups: SEEDS,
      totalPerVariant: HOLDOUT.personas.length,
    });

    await expect(runSwarm(swarmOver({ personas: [] }))).rejects.toThrow(
      /holds out 2 people and drives nobody else/,
    );
    await nothingWritten();
  });

  it('refuses a holdout drawn on a seed the change was chosen on', async () => {
    await open();

    await expect(
      runSwarm(swarmOver({ holdout: { ...HOLDOUT, seeds: [8_117, 23] } })),
    ).rejects.toThrow(/the holdout's seed 23 is one of the seeds the change was chosen on/);
    await nothingWritten();
  });

  it('refuses a holdout that holds out one of the main set', async () => {
    await open();

    await expect(
      runSwarm(
        swarmOver({
          holdout: { personas: [TWO_PEOPLE[0] as Persona], seeds: [8_117] },
        }),
      ),
    ).rejects.toThrow(/"rushed" is in the main set and in the holdout/);
    await nothingWritten();
  });

  it('refuses a holdout whose people and seeds are not pairwise', async () => {
    await open();

    await expect(
      runSwarm(swarmOver({ holdout: { personas: HOLDOUT.personas, seeds: [8_117] } })),
    ).rejects.toThrow(/carries 2 people and 1 seed:/);
    await nothingWritten();
  });

  it('refuses a holdout the run itself never recorded', async () => {
    // The people the run carries by value are the people a holdout may name: the contract
    // refuses `improve.holdout.personaIds` that names anybody else, so the swarm refuses to
    // drive them rather than leaving the loop a run it cannot write.
    await writeOpenRun(runDir, {
      personas: TWO_PEOPLE,
      variants: VARIANTS,
      seedGroups: SEEDS,
      totalPerVariant: TWO_PEOPLE.length * SEEDS.length + HOLDOUT.personas.length,
    });

    await expect(runSwarm(swarmOver())).rejects.toThrow(/"holdout-rushed" is not one of them/);
    await nothingWritten();
  });
});

describe('sameSeedsOnBothSides', () => {
  const plan = (rows: ReadonlyArray<[string, string, number]>): SwarmSession[] =>
    rows.map(([variant, personaId, seed], index) => ({
      sessionId: `S-${String(index + 1).padStart(2, '0')}`,
      persona: { ...(FOUR_PEOPLE[0] as Persona), id: personaId },
      variant: { id: variant, url: `https://fixture.test/${variant}` },
      seed,
    }));

  it('passes the plan the planner produces, holdout and all', () => {
    expect(sameSeedsOnBothSides(planSwarm(swarmOver()))).toBeNull();
  });

  it('passes a run of one variant, which has no other side to differ from', () => {
    expect(sameSeedsOnBothSides(plan([['A', 'rushed', 11]]))).toBeNull();
  });

  it('names the person a side drives that the other does not', () => {
    const reason = sameSeedsOnBothSides(
      plan([
        ['A', 'rushed', 11],
        ['A', 'careful', 11],
        ['B', 'rushed', 11],
      ]),
    );

    expect(reason).toContain('variant "A" drives "careful" and variant "B" does not');
  });

  it('names the person, the seeds and both sides', () => {
    const reason = sameSeedsOnBothSides(
      plan([
        ['A', 'rushed', 11],
        ['B', 'rushed', 12],
      ]),
    );

    expect(reason).toContain('"rushed"');
    expect(reason).toContain('on seeds 12');
    expect(reason).toContain('drives them on 11');
    expect(reason).toContain('the only difference between them is the code');
  });
});

/**
 * A `scores` row for one variant, carrying the holdout's figures beside its own.
 *
 * `@personavision/scoring` is what produces these (#304 reads them); what this builds is the
 * smallest row the contract accepts, so that the holdout block can be read back from a real
 * run directory. The variant's own figures are written as one scored success, which is the
 * arithmetic the contract holds every rate to.
 */
const scoreRow = (
  variant: string,
  holdout: NonNullable<Run['scores'][number]['holdout']>,
): Run['scores'][number] => ({
  variant,
  taskId: TASK.id,
  frictionScore: { median: 20, sd: 0 },
  completionRate: 1,
  components: {
    taskFailureRate: 0,
    abandonment: 0,
    timeToFirstFixationPrimary: { worstStep: 'cart', medianSeconds: 1, value: 0.1 },
    deadEndRevisits: 0,
  },
  outcomeCounts: { success: 1, abandoned: 0, failed: 0, automationFailure: 0 },
  scoredSessionCount: 1,
  perSeedGroup: [{ seed: 11, frictionScore: 20 }],
  holdout,
});
