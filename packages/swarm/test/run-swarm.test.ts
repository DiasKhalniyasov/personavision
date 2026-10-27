/**
 * The swarm: a whole run of sessions, bounded, resilient, and written as they land.
 *
 * Every test here runs the real loop over a capture set derived from the committed one,
 * with the offline deterministic provider — no browser, no socket, no key — and asserts
 * what is observable: what came back, what is on disk, and whether the run directory
 * validates while the run is still open. Nothing asserts a prompt string or reaches into a
 * provider.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import { createFixtureSource } from '@personavision/browser';
import { readRun, runPaths, validate } from '@personavision/contract';
import { createOfflineDeterministicProvider, FREE_USAGE } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSwarm, runSwarm } from '../src/index.js';
import {
  FOUR_PEOPLE,
  oneDeviceCaptureSet,
  providerThat,
  runVariant,
  sweep,
  TASK,
  temporaryRunDir,
  withNothingRunning,
  writeOpenRun,
} from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run } from '@personavision/contract';
import type { Decision, DecisionUsage } from '@personavision/provider';
import type { RunSwarmInput, SwarmProgress, SwarmSessionFinished } from '../src/index.js';

const VARIANTS: ReadonlyArray<Run['variants'][number]> = [runVariant('A'), runVariant('B')];

/** Two of the demo's four, so that eight sessions make a whole run quickly. */
const TWO_PEOPLE: readonly Persona[] = [FOUR_PEOPLE[0] as Persona, FOUR_PEOPLE[1] as Persona];

const SEEDS = [11, 23];

/** A time that does not move, because a reproducible run's one input is the clock. */
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

/** A swarm over the open run its caller wrote, with nobody watching. */
const swarmOver = (over: Partial<RunSwarmInput> = {}): RunSwarmInput => ({
  runDir,
  variants: VARIANTS,
  personas: TWO_PEOPLE,
  seedGroups: SEEDS,
  task: TASK,
  source,
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  concurrency: 3,
  now: () => new Date(NOON),
  ...over,
});

/** The open run the caller writes before the swarm runs into it. */
const open = (over: Partial<Parameters<typeof writeOpenRun>[1]> = {}): Promise<Run> =>
  writeOpenRun(runDir, {
    personas: TWO_PEOPLE,
    variants: VARIANTS,
    seedGroups: SEEDS,
    ...over,
  });

/** An agent that gives up on the first screen, so a session is one screen and one decision. */
const GIVES_UP: Decision = {
  intent: 'This is not worth the trouble.',
  action: { kind: 'abandon', targetElementId: null },
  usage: FREE_USAGE,
};

/** A reply that never comes: the one failure a session's own budget never sees. */
const NEVER_ANSWERS = new Promise<never>(() => undefined) as unknown as Decision;

/** A reply that comes, eventually — after the session that asked for it has given up. */
const answeredIn = (ms: number): Decision =>
  new Promise<Decision>((resolve) => {
    // Unreferenced, so a reply nobody is waiting for does not hold the test runner open.
    setTimeout(() => resolve(GIVES_UP), ms).unref();
  }) as unknown as Decision;

describe('planSwarm', () => {
  it('numbers the sessions S-01 … S-NN, variant then person then seed', () => {
    const planned = planSwarm({ variants: VARIANTS, personas: FOUR_PEOPLE, seedGroups: [1, 2, 3] });

    expect(planned).toHaveLength(24);
    expect(planned.map((plan) => plan.sessionId)).toEqual(
      Array.from({ length: 24 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`),
    );
    // The committed example run is numbered this way: A first, each person's seeds together.
    const addressed = planned.map((plan) => [
      plan.sessionId,
      plan.variant.id,
      plan.persona.id,
      plan.seed,
    ]);
    expect(addressed[0]).toEqual(['S-01', 'A', 'rushed', 1]);
    expect(addressed[1]).toEqual(['S-02', 'A', 'rushed', 2]);
    expect(addressed[8]).toEqual(['S-09', 'A', 'firsttime', 3]);
    expect(addressed[12]).toEqual(['S-13', 'B', 'rushed', 1]);
    expect(addressed[23]).toEqual(['S-24', 'B', 'price', 3]);
  });

  it('runs the same people on the same seeds against every variant', () => {
    const planned = planSwarm({ variants: VARIANTS, personas: FOUR_PEOPLE, seedGroups: [1, 2, 3] });
    const walkedBy = (variant: string): string[] =>
      planned
        .filter((plan) => plan.variant.id === variant)
        .map((plan) => `${plan.persona.id} · ${plan.seed}`)
        .sort();

    expect(walkedBy('A')).toEqual(walkedBy('B'));
    expect(new Set(walkedBy('A')).size).toBe(12);
  });
});

describe('runSwarm', () => {
  it('returns the run’s sessions and writes every one of them to the run directory', async () => {
    await open();

    const { sessions, run } = await runSwarm(swarmOver());

    expect(sessions.map((session) => session.sessionId)).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
      'S-05',
      'S-06',
      'S-07',
      'S-08',
    ]);
    expect(sessions.map((session) => [session.variant, session.persona?.id, session.seed])).toEqual(
      [
        ['A', 'rushed', 11],
        ['A', 'rushed', 23],
        ['A', 'careful', 11],
        ['A', 'careful', 23],
        ['B', 'rushed', 11],
        ['B', 'rushed', 23],
        ['B', 'careful', 11],
        ['B', 'careful', 23],
      ],
    );
    // Written, not only returned: the run directory is the artifact every screen reads.
    expect(run.sessionIds).toEqual(sessions.map((session) => session.sessionId));
    const { sessions: onDisk } = await readRun(runDir);
    expect(onDisk.map((session) => session.sessionId)).toEqual(run.sessionIds);
    expect(onDisk.map((session) => session.outcome)).toEqual(
      sessions.map((session) => session.outcome),
    );
    expect(await validate(runDir)).toEqual([]);
  });

  it('holds the sessions in flight to the concurrency it was given', async () => {
    await open();
    const flight = watchFlight();

    await runSwarm(swarmOver({ concurrency: 3, onProgress: flight.record }));

    expect(flight.peak).toBe(3);
  });

  it('runs one session at a time when asked for one', async () => {
    await open();
    const flight = watchFlight();

    await runSwarm(swarmOver({ concurrency: 1, onProgress: flight.record }));

    expect(flight.peak).toBe(1);
  });

  it('leaves a directory that validates after every session it has landed', async () => {
    await open();
    const landed: number[] = [];

    await runSwarm(
      swarmOver({
        concurrency: 1,
        // Each call is the state an interrupted run would be found in: an open run, the
        // sessions that have landed, and nothing else being written.
        onProgress: async (event) => {
          if (event.kind !== 'session-finished') return;
          expect(await validate(runDir)).toEqual([]);
          const { run } = await readRun(runDir);
          expect(run.status).toBe('open');
          expect(run.finishedAt).toBeUndefined();
          expect(run.progress?.finishedSessions).toBe(event.finishedSessions);
          landed.push(event.finishedSessions);
        },
      }),
    );

    expect(landed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('records a session that throws as an automation failure and still runs the rest', async () => {
    await open();

    const { sessions } = await runSwarm(swarmOver({ source: breaksFor(source, 'careful') }));

    const broken = sessions.filter((session) => session.persona?.id === 'careful');
    expect(broken).toHaveLength(4);
    for (const session of broken) {
      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      expect(session.outcome.reason).toContain('the fixture site is on fire');
      expect(session.screens).toEqual([]);
    }
    const walked = sessions.filter((session) => session.persona?.id === 'rushed');
    expect(walked).toHaveLength(4);
    for (const session of walked) {
      expect(session.outcome.attribution).toBe('product');
      expect(session.screens.length).toBeGreaterThan(0);
    }
    const { sessions: onDisk, run } = await readRun(runDir);
    expect(onDisk).toHaveLength(8);
    // The excluded sessions are the run's too: its own list leaves none of them out.
    expect(run.sessionIds).toHaveLength(8);
    for (const session of broken) expect(run.sessionIds).toContain(session.sessionId);
    expect(await validate(runDir)).toEqual([]);
  });

  it('records a decision that never arrives as that session\u2019s automation failure', async () => {
    await open({ personas: [TWO_PEOPLE[0] as Persona], seedGroups: [11] });
    let asked = 0;
    const stalls = providerThat(() => {
      asked += 1;
      return asked === 1 ? NEVER_ANSWERS : GIVES_UP;
    });

    const { sessions, run } = await runSwarm(
      swarmOver({
        personas: [TWO_PEOPLE[0] as Persona],
        seedGroups: [11],
        concurrency: 1,
        providers: { decision: stalls },
        sessionTimeoutMs: 500,
      }),
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.outcome).toMatchObject({
      status: 'automation_failure',
      attribution: 'automation',
      excludedFromScores: true,
    });
    expect(sessions[0]?.outcome.reason).toContain('never arrived');
    // Capped inside the session, so what it had reached is kept rather than thrown away.
    expect(sessions[0]?.screens).toHaveLength(1);
    expect(sessions[0]?.fixations.length).toBeGreaterThan(0);
    // The session that came after it still ran, and is still in the run.
    expect(sessions[1]?.outcome.status).toBe('abandoned');
    expect(run.sessionIds).toEqual(['S-01', 'S-02']);
    expect(await validate(runDir)).toEqual([]);
  });

  it('keeps the record when a decision arrives after the session\u2019s deadline', async () => {
    await open({ personas: [TWO_PEOPLE[0] as Persona], seedGroups: [11] });
    let asked = 0;
    const lateByTwoSeconds = providerThat(() => {
      asked += 1;
      return asked === 1 ? answeredIn(2_000) : GIVES_UP;
    });

    const { sessions } = await runSwarm(
      swarmOver({
        personas: [TWO_PEOPLE[0] as Persona],
        seedGroups: [11],
        concurrency: 1,
        providers: { decision: lateByTwoSeconds },
        sessionTimeoutMs: 500,
      }),
    );

    expect(sessions[0]?.outcome.status).toBe('automation_failure');
    // The late answer cannot overwrite the session the run recorded, because the session
    // itself recorded it: nothing was abandoned, so nothing lands behind the run's back.
    expect(await validate(runDir)).toEqual([]);
    const { sessions: onDisk } = await readRun(runDir);
    expect(onDisk.map((session) => session.outcome.status)).toEqual([
      'automation_failure',
      'abandoned',
    ]);
  });

  it('writes up a session that hangs where no cap inside it reaches', async () => {
    await open({ personas: [TWO_PEOPLE[0] as Persona], seedGroups: [11] });
    // Closing the page is the one call of a session that goes through no budget: a source
    // that never returns from it hangs the session after its own caps have had their say.
    let closes = 0;
    const neverCloses: CaptureSource = {
      ...source,
      close: async (page) => {
        closes += 1;
        return closes === 1 ? new Promise<void>(() => undefined) : source.close(page);
      },
    };

    const { sessions, run } = await runSwarm(
      swarmOver({
        personas: [TWO_PEOPLE[0] as Persona],
        seedGroups: [11],
        concurrency: 1,
        source: neverCloses,
        sessionTimeoutMs: 400,
      }),
    );

    expect(sessions[0]?.outcome).toMatchObject({
      status: 'automation_failure',
      attribution: 'automation',
      excludedFromScores: true,
    });
    expect(sessions[0]?.outcome.reason).toContain('cap');
    expect(sessions[1]?.outcome.status).not.toBe('automation_failure');
    expect(run.sessionIds).toEqual(['S-01', 'S-02']);
    expect(await validate(runDir)).toEqual([]);
  });

  it('appends a progress entry per finished session, with the counts beneath it', async () => {
    await open();

    const { run } = await runSwarm(swarmOver());

    expect(run.progress?.totalSessions).toBe(8);
    expect(run.progress?.finishedSessions).toBe(8);
    expect(run.progress?.perVariant).toEqual([
      { variant: 'A', totalSessions: 4, finishedSessions: 4 },
      { variant: 'B', totalSessions: 4, finishedSessions: 4 },
    ]);

    const entries = run.progress?.sessions ?? [];
    expect(entries).toHaveLength(8);
    const entry = entries.find((one) => one.sessionId === 'S-01');
    const session = (await readRun(runDir)).sessions.find((one) => one.sessionId === 'S-01');
    expect(entry).toEqual({
      sessionId: 'S-01',
      personaName: 'Rushed buyer',
      variant: 'A',
      seed: 11,
      finishedAt: expect.any(String),
      durationMs: session?.durationMs,
      status: session?.outcome.status,
      step: session?.outcome.step,
      reason: session?.outcome.reason,
      attribution: session?.outcome.attribution,
    });
  });

  it('reports every session as it starts and as it finishes', async () => {
    await open();
    const events: SwarmProgress[] = [];

    await runSwarm(swarmOver({ concurrency: 1, onProgress: (event) => void events.push(event) }));

    expect(events.filter((event) => event.kind === 'session-started')).toHaveLength(8);
    const finished = events.filter(
      (event): event is SwarmSessionFinished => event.kind === 'session-finished',
    );
    expect(finished.map((event) => event.finishedSessions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(finished[0]).toMatchObject({
      sessionId: 'S-01',
      personaName: 'Rushed buyer',
      variant: 'A',
      seed: 11,
      totalSessions: 8,
    });
    // The event reports the outcome the session was written with, not one of its own.
    const { sessions } = await readRun(runDir);
    expect(finished.map((event) => event.outcome)).toEqual(
      finished.map(
        (event) => sessions.find((session) => session.sessionId === event.sessionId)?.outcome,
      ),
    );
    expect(finished.every((event) => Number.isFinite(event.elapsedMs))).toBe(true);
  });

  it('moves the run from open to finished', async () => {
    const opened = await open();
    expect(opened.status).toBe('open');
    expect(opened.finishedAt).toBeUndefined();

    const { run } = await runSwarm(swarmOver());

    expect(run.status).toBe('finished');
    expect(run.startedAt).toBe(NOON);
    expect(run.finishedAt).toBe(NOON);
    expect((await readRun(runDir)).run.status).toBe('finished');
  });

  it('declares the areas its sessions looked at and the screens they captured', async () => {
    await open();

    const { sessions, run } = await runSwarm(swarmOver());

    const lookedAt = new Set(
      sessions.flatMap((session) =>
        session.fixations.map((fixation) => fixation.aoiId).filter((aoiId) => aoiId !== null),
      ),
    );
    expect(lookedAt.size).toBeGreaterThan(0);
    const declared = run.aois.map((aoi) => aoi.id);
    for (const aoiId of lookedAt) expect(declared).toContain(aoiId);
    // One row per area and one per screen, however many of the eight sessions saw them.
    expect(new Set(declared).size).toBe(declared.length);
    expect(run.screenshots.length).toBeGreaterThan(1);
    expect(new Set(run.screenshots.map((shot) => `${shot.variant}/${shot.step}`)).size).toBe(
      run.screenshots.length,
    );
    for (const shot of run.screenshots) {
      expect(shot.path).toBe(runPaths('').screenshot(shot.variant, shot.step));
      expect(shot.pageHeight).toBeGreaterThan(0);
    }
  });

  it('totals what the run’s decisions cost', async () => {
    await open({
      engine: {
        mode: 'model',
        modelMode: 'contributor',
        provider: 'meta-model-api',
        models: { decision: 'muse-spark-1.3-contributor', segmentation: 'none', planning: 'none' },
        weights: { alpha: 1, beta: 1, gamma: 1 },
        version: 'test',
      },
    });
    const usage: DecisionUsage = {
      inputTokens: 400,
      cachedInputTokens: 300,
      outputTokens: 60,
      reasoningTokens: 50,
      estimatedCostUsd: 0.0014,
    };
    const onTheModel = providerThat(
      () => ({ ...GIVES_UP, usage, model: { mode: 'contributor', modelId: 'muse-spark-1.3' } }),
      { mode: 'model', name: 'meta-model-api' },
    );

    const { run, sessions } = await runSwarm(swarmOver({ providers: { decision: onTheModel } }));

    const decisions = sessions.reduce((total, session) => total + session.screens.length, 0);
    expect(decisions).toBe(8);
    expect(run.usage).toEqual({
      calls: 8,
      inputTokens: 3_200,
      cachedInputTokens: 2_400,
      outputTokens: 480,
      reasoningTokens: 400,
      estimatedCostUsd: expect.closeTo(0.0112, 8),
    });
  });

  it('records no model call and no cost for an offline run', async () => {
    await open();

    const { run, sessions } = await runSwarm(swarmOver());

    expect(sessions.some((session) => session.screens.length > 0)).toBe(true);
    expect(run.usage).toEqual({
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it('refuses a plan the run left no room for, and a run that is not open', async () => {
    await open();

    await expect(runSwarm(swarmOver({ seedGroups: [11, 23, 31] }))).rejects.toThrow(
      /plans 8 sessions and the swarm plans 12/,
    );
    expect((await readRun(runDir)).run.sessionIds).toEqual([]);

    expect((await runSwarm(swarmOver())).run.status).toBe('finished');
    await expect(runSwarm(swarmOver())).rejects.toThrow(/"finished".+run that is open/);
  });

  it('stops taking sessions when the run index cannot be written', async () => {
    await open();

    const swarm = runSwarm(
      swarmOver({
        concurrency: 1,
        onProgress: async (event) => {
          // The run's index, gone from under it: the next append has nothing to append to.
          if (event.kind === 'session-finished' && event.finishedSessions === 2) {
            await rm(runPaths(runDir).run);
          }
        },
      }),
    );

    await expect(swarm).rejects.toThrow(/run\.json/);
    // The swarm stopped rather than walking the rest into a run it could not index, and the
    // session whose write failed was swept: a session file `run.json` does not list would
    // make the whole directory unreadable, which is what writing one at a time avoids.
    expect(await landed()).toEqual(['S-01', 'S-02']);
  });

  it('refuses a swarm with nobody in it', async () => {
    await open();

    await expect(runSwarm(swarmOver({ personas: [] }))).rejects.toThrow(/plans no sessions/);
  });

  it('walks twenty-four sessions with no browser, no socket and no key', async () => {
    const seedGroups = [1, 2, 3];
    await open({ personas: FOUR_PEOPLE, seedGroups });
    const input = swarmOver({ personas: FOUR_PEOPLE, seedGroups, concurrency: 6 });
    expect(input.providers.decision.mode).toBe('offline');

    const { sessions, run } = await withNothingRunning(() => runSwarm(input));

    expect(sessions).toHaveLength(24);
    expect(sessions.map((session) => session.sessionId)).toEqual(
      planSwarm(input).map((plan) => plan.sessionId),
    );
    expect(run.sessionIds).toHaveLength(24);
    expect(run.progress?.finishedSessions).toBe(24);
    expect(run.status).toBe('finished');
    // A run nobody can read is not a run: twenty-four sessions on disk, agreeing.
    expect(await validate(runDir)).toEqual([]);
    const written = JSON.parse(await readFile(runPaths(runDir).run, 'utf8')) as { usage: unknown };
    expect(written.usage).toMatchObject({ calls: 0, estimatedCostUsd: 0 });
  });
});

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

/**
 * A source that will not open a page for one of the people. A capture source is handed a
 * variant and a device and never a persona, so the person is named by their device's label.
 */
const breaksFor = (inner: CaptureSource, personaId: string): CaptureSource => ({
  ...inner,
  openSession: async (variant, device) => {
    if (device.name.endsWith(personaId)) throw new Error('the fixture site is on fire');
    return inner.openSession(variant, device);
  },
});
