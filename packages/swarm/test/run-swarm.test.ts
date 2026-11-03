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
import {
  readRun,
  runPaths,
  runSchema,
  sessionSchema,
  validate,
  writeRun,
} from '@personavision/contract';
import { createOfflineDeterministicProvider, FREE_USAGE } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY, planSwarm, runSwarm } from '../src/index.js';
import {
  FOUR_PEOPLE,
  oneDeviceCaptureSet,
  peopleOnMobile,
  providerThat,
  runVariant,
  sweep,
  TASK,
  temporaryRunDir,
  withNothingRunning,
  writeOpenRun,
} from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run, Session } from '@personavision/contract';
import type { Decision, DecisionUsage } from '@personavision/provider';
import type {
  RunSwarmInput,
  SwarmProgress,
  SwarmSession,
  SwarmSessionFinished,
} from '../src/index.js';

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

/**
 * The concurrency a hundred-agent run is given, as its caller hands it over.
 *
 * Ten, which is `docs/FLOW.md` section 13's cap on browsers open against one site: "a
 * hundred browsers at once on one small site is a load test nobody asked for". It is written
 * here, in the caller's position, and not imported from the swarm — the swarm states no
 * per-site number of its own, section 13 puts every such cap in `packages/platform`, and
 * #241 owns the wiring that carries the real one over the API. A test is a caller, so the
 * test states it.
 */
const TEN_AT_A_TIME = 10;

/**
 * A hundred *sessions*: fifty generated people on one seed, against both variants.
 *
 * A swarm runs every person against every variant — the comparison is the point — so a
 * hundred sessions over two variants is fifty people, and `progress` then has two
 * per-variant totals to agree with rather than one, which is what #275 asks it to agree on.
 *
 * **A hundred sessions is not the same number as `docs/FLOW.md` section 13's hundred
 * agents.** An agent is a person, section 13 caps a verified site's run at the audience's
 * `size` and at most a hundred of them, and section 11 puts path 1 on one variant and path 2
 * on two — so the documented maximum is a hundred sessions on path 1 and **two hundred** on
 * path 2. What is proved here is the hundred this ticket asked for. Two hundred sessions, and
 * in particular the one queue at `run.json` under that many, is not proved by this file.
 */
const FIFTY_PEOPLE: readonly Persona[] = peopleOnMobile(50);

const ONE_SEED = [11];

/** The hundred-session plan, as a caller counts it before anything runs. */
const hundredSessionSwarm = (over: Partial<RunSwarmInput> = {}): RunSwarmInput =>
  swarmOver({
    personas: FIFTY_PEOPLE,
    seedGroups: ONE_SEED,
    concurrency: TEN_AT_A_TIME,
    ...over,
  });

const openHundred = (): Promise<Run> => open({ personas: FIFTY_PEOPLE, seedGroups: ONE_SEED });

/**
 * `run.json` as a reader with nothing but the file sees it: read off disk and parsed against
 * the contract's own schema, rather than through `readRun`, which reads the whole directory.
 *
 * The difference matters while a run is open and sessions are landing in parallel.
 * `runSession` writes a session's own file and `appendFinishedSession` lists it in
 * `run.json` a moment later, so at any concurrency above one the directory briefly holds a
 * session `run.json` does not list yet — which `validate` rightly reports, because in a
 * finished run it would mean a lost session. What is promised during the run is narrower and
 * is what the Running screen depends on: every session file is complete the moment it
 * appears, and `run.json` is a valid run at every point. Those are the two things read here.
 */
const runJsonOnDisk = async (): Promise<Run> =>
  runSchema.parse(JSON.parse(await readFile(runPaths(runDir).run, 'utf8')));

const sessionFileOnDisk = async (sessionId: string): Promise<Session> =>
  sessionSchema.parse(JSON.parse(await readFile(runPaths(runDir).session(sessionId), 'utf8')));

/**
 * How long a hundred-session test is given before it is called hung.
 *
 * Thirty seconds, which is about thirty-five times what either test costs on an idle
 * machine, because what it has to tolerate is not the work but the machine: both have been
 * seen to take four times as long on a laptop running a dozen other things, and at that
 * point vitest's own five-second default killed one of them and reported a failure that was
 * the machine's load and not the swarm.
 *
 * It is a real cap and not only a formality. These tests name no `sessionTimeoutMs`, so each
 * session gets `DEFAULT_SESSION_BUDGET.wallClockMs` — a minute — and the swarm's race around
 * it a second longer still; one genuinely hung session therefore trips *this* cap long before
 * its own, and a hundred of them would be ten minutes. So a swarm that stalls is reported
 * here, as a timeout, with nothing said about which session stalled. That is the trade: a
 * timeout at thirty seconds means something is wrong, where a timeout at five meant only
 * that the machine was busy. A stall diagnosed from a bare timeout is the one case worth
 * re-running under `--maxWorkers=2` before believing.
 */
const A_HUNDRED_SESSIONS_TIMEOUT_MS = 30_000;

describe('runSwarm at a hundred sessions', () => {
  /**
   * **Wall clock: about 0.8 s** on an idle machine — a hundred replayed sessions take
   * roughly half of it and the two hundred reads and schema parses this test makes while
   * the run is open take the rest. The whole of what this ticket adds to the suite is that
   * plus about 0.5 s for the crash below and under 0.1 s for the two eight-session tests
   * after it: **under 1.5 s**, and the suite's total grows by no more, because nothing that
   * was already here is slowed down.
   *
   * It downloads nothing, opens no browser and makes no model call: `withNothingRunning`
   * breaks every way of launching a process and of opening a socket for the duration, so
   * the figure is arithmetic over committed bytes and cannot depend on a network.
   */
  it(
    'walks a hundred sessions ten at a time, each one complete as it lands',
    async () => {
      const input = hundredSessionSwarm();
      const planned = planSwarm(input);
      expect(planned).toHaveLength(100);
      // Counted off the plan before anything has run, which is what the acceptance asks
      // `progress` to agree with: `packages/cli` writes the open run's totals from exactly
      // this, so the two are one claim rather than two.
      const plannedPerVariant = VARIANTS.map((variant) => ({
        variant: variant.id,
        totalSessions: planned.filter((plan) => plan.variant.id === variant.id).length,
      }));
      expect(plannedPerVariant).toEqual([
        { variant: 'A', totalSessions: 50 },
        { variant: 'B', totalSessions: 50 },
      ]);

      await openHundred();
      const flight = watchFlight();
      const landedWhileOpen: number[] = [];
      const validated: string[] = [];

      const { sessions, run } = await withNothingRunning(() =>
        runSwarm({
          ...input,
          onProgress: async (event) => {
            flight.record(event);
            if (event.kind !== 'session-finished') return;
            // Observed from the landing rather than from the start, because the landing is
            // reported from inside the run's own turn at `run.json`: the one moment a reader
            // is promised the file as this session left it. `writeFile` is not atomic, so an
            // observation taken outside that turn could catch a half-written file and would
            // be testing Node rather than the swarm.
            const stillOpen = await runJsonOnDisk();
            expect(stillOpen.status).toBe('open');
            expect(stillOpen.finishedAt).toBeUndefined();
            expect(stillOpen.progress?.finishedSessions).toBe(event.finishedSessions);
            expect(stillOpen.progress?.totalSessions).toBe(100);
            expect(stillOpen.sessionIds).toContain(event.sessionId);
            // Complete the moment it appears, not merely present: parsed against the
            // contract's session schema, and carrying the outcome the run just reported.
            const file = await sessionFileOnDisk(event.sessionId);
            expect(file.sessionId).toBe(event.sessionId);
            expect(file.outcome).toEqual(event.outcome);
            landedWhileOpen.push(event.finishedSessions);
            validated.push(file.sessionId);
          },
        }),
      );

      // A hundred sessions, finished, and a hundred session files on disk.
      expect(sessions).toHaveLength(100);
      expect(sessions.map((session) => session.sessionId)).toEqual(
        planned.map((plan) => plan.sessionId),
      );
      expect(run.status).toBe('finished');
      expect(run.sessionIds).toEqual(planned.map((plan) => plan.sessionId));
      const files = await landed();
      expect(files).toHaveLength(100);
      expect(new Set(files)).toEqual(new Set(planned.map((plan) => plan.sessionId)));
      expect(await validate(runDir)).toEqual([]);

      // Ten at a time: never more in flight than the caller named, and more than one at a
      // time, so the test cannot pass by having run them one after another. It is in fact
      // exactly ten, and not by luck of timing: the pool starts its workers together and the
      // one cursor keeps them fed, so the bound is reached rather than approached.
      expect(flight.peak).toBeLessThanOrEqual(TEN_AT_A_TIME);
      expect(flight.peak).toBeGreaterThan(1);
      expect(flight.peak).toBe(TEN_AT_A_TIME);

      // Written as they land: a hundred observations of an open run, each one session further
      // on, each with that session's file already complete beside it.
      expect(landedWhileOpen).toEqual(Array.from({ length: 100 }, (_unused, index) => index + 1));
      expect(validated).toHaveLength(100);
      expect(new Set(validated).size).toBe(100);

      // And `progress` ends where the plan said it would, per variant and overall.
      expect(run.progress?.totalSessions).toBe(100);
      expect(run.progress?.finishedSessions).toBe(100);
      expect(run.progress?.sessions).toHaveLength(100);
      expect(run.progress?.perVariant).toEqual(
        plannedPerVariant.map((row) => ({ ...row, finishedSessions: row.totalSessions })),
      );
    },
    A_HUNDRED_SESSIONS_TIMEOUT_MS,
  );

  /** **Wall clock: about 0.5 s** on an idle machine — a hundred sessions, one of them dead. */
  it(
    'costs one session, not a run, when one session is killed mid-run',
    async () => {
      const input = hundredSessionSwarm();
      // Exactly one of the hundred. `breaksFor` breaks every session of one person, which over
      // two variants is two of them; naming the variant as well picks one. Which one is a fact
      // about the plan and not about the machine: variant then person then seed, so the
      // twenty-fifth person's variant-B session is the seventy-fifth of the run.
      const doomed = plannedSession(input, 'B', 'person-25');
      expect(doomed.sessionId).toBe('S-75');

      await openHundred();

      const { sessions, run } = await runSwarm({
        ...input,
        source: breaksOneSession(source, doomed),
      });

      // One recorded automation failure, and it is the session that was killed.
      const broken = sessions.filter((session) => session.outcome.status === 'automation_failure');
      expect(broken.map((session) => session.sessionId)).toEqual([doomed.sessionId]);
      expect(broken[0]?.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      expect(broken[0]?.outcome.reason).toContain('this browser died mid-run');
      // Nothing happened in it, so there is nothing of it in any figure to exclude.
      expect(broken[0]?.screens).toEqual([]);
      expect(broken[0]?.fixations).toEqual([]);
      expect(broken[0]?.saccades).toEqual([]);
      expect(broken[0]?.actions).toEqual([]);

      // Ninety-nine complete sessions, every one of them the product's rather than ours.
      const walked = sessions.filter((session) => session.sessionId !== doomed.sessionId);
      expect(walked).toHaveLength(99);
      for (const session of walked) {
        expect(session.outcome.attribution).toBe('product');
        expect(session.screens.length).toBeGreaterThan(0);
      }

      // The run still reaches finished, still lists the excluded session, and still reads.
      expect(run.status).toBe('finished');
      expect(run.sessionIds).toHaveLength(100);
      expect(run.sessionIds).toContain(doomed.sessionId);
      expect(await validate(runDir)).toEqual([]);

      // Excluded from every figure the swarm writes, as `docs/FLOW.md` section 8 requires:
      // every screen the run declares and every area on it was reached by a session that
      // counts, and an offline run's cost is zero whatever broke.
      const reached = new Set(
        walked.flatMap((session) =>
          session.screens.map((screen) => `${session.variant}/${screen.step}`),
        ),
      );
      for (const shot of run.screenshots) expect(reached).toContain(`${shot.variant}/${shot.step}`);
      for (const aoi of run.aois) expect(reached).toContain(`${aoi.variant}/${aoi.step}`);
      expect(run.usage).toMatchObject({ calls: 0, estimatedCostUsd: 0 });
      // And the progress entry the Running screen reads says whose failure it was.
      const entry = run.progress?.sessions.find((one) => one.sessionId === doomed.sessionId);
      expect(entry?.attribution).toBe('automation');
      expect(entry?.status).toBe('automation_failure');
    },
    A_HUNDRED_SESSIONS_TIMEOUT_MS,
  );
});

/**
 * What the pool is bounded by, and what a run's counters add up to — both over the
 * eight-session default above rather than a hundred, because neither question needs a
 * hundred sessions to answer and a reader debugging a failure here should not go looking
 * for a problem of scale.
 */
describe('the bound, and the counters a run leaves behind', () => {
  it('leaves counters a reader can compute the automation-failure share from', async () => {
    await open();

    // Half of eight, which is well over a fifth. What the threshold is, and what is done
    // about a run that crosses it, belong to `@personavision/contract` and to its own
    // ticket; neither number is restated here. What this asserts is that `run.json` alone
    // carries the two counters the share is computed from.
    await runSwarm(swarmOver({ source: breaksFor(source, 'careful') }));

    const run = await runJsonOnDisk();
    const entries = run.progress?.sessions ?? [];
    const finished = run.progress?.finishedSessions ?? 0;
    const ours = entries.filter((entry) => entry.attribution === 'automation');

    expect(finished).toBe(8);
    expect(entries).toHaveLength(8);
    expect(ours).toHaveLength(4);
    expect(ours.length / finished).toBe(0.5);
    // Every entry names an attribution, so the share is over the whole run rather than over
    // the entries that happen to carry one.
    expect(entries.filter((entry) => entry.attribution !== undefined)).toHaveLength(8);
  });

  it('bounds a run whose caller named no bound by DEFAULT_CONCURRENCY', async () => {
    // Unchanged in value: four is the number for the one caller that names none, which is
    // `packages/cli` and its small runs on the machine the command was typed on. It is not
    // the per-site cap — the caller's ten above is — and this package holds no per-site
    // number at all (`docs/FLOW.md` section 13 puts them in `packages/platform`).
    expect(DEFAULT_CONCURRENCY).toBe(4);

    await open();
    const flight = watchFlight();

    await runSwarm(swarmOver({ concurrency: undefined, onProgress: flight.record }));

    expect(flight.peak).toBe(DEFAULT_CONCURRENCY);
  });
});

/** One planned session, addressed the way a test means to break it. */
const plannedSession = (input: RunSwarmInput, variant: string, personaId: string): SwarmSession => {
  const plan = planSwarm(input).find(
    (one) => one.variant.id === variant && one.persona.id === personaId,
  );
  if (plan === undefined) {
    throw new Error(`this swarm plans no session for "${personaId}" on variant "${variant}"`);
  }
  return plan;
};

/**
 * A source that will not open a page for one session: one person, on one variant.
 *
 * `breaksFor` below breaks every session of one person, which is what a broken persona looks
 * like. A crash that is meant to cost one session has to be one session, so the variant is
 * named too — and a capture source is handed a variant and a device and never a persona, so
 * the person is named by their device's label.
 */
const breaksOneSession = (inner: CaptureSource, plan: SwarmSession): CaptureSource => ({
  ...inner,
  openSession: async (variant, device) => {
    if (variant.id === plan.variant.id && device.name.endsWith(plan.persona.id)) {
      throw new Error('this browser died mid-run');
    }
    return inner.openSession(variant, device);
  },
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

/**
 * The site a run was launched against, on the record before its first session (#243).
 *
 * The swarm resolves no site and reads none: the value arrives from the layer that decided
 * the caps, and all the swarm owes it is one write, early enough that the open run a reader
 * finds mid-flight already says what the finished one will. Nothing here branches on it —
 * the same sessions run against a verified site and an unverified one, which is the whole
 * point of recording rather than gating.
 */
describe('the site on the record', () => {
  const NORTHWIND = { url: 'https://northwind.example/cart', verifiedAtLaunch: true };

  /** The site as `run.json` holds it at the moment the first session starts. */
  const siteWhenTheFirstSessionStarts = async (
    over: Partial<RunSwarmInput> = {},
  ): Promise<Run['site'] | 'no session started'> => {
    let atFirstSession: Run['site'] | 'no session started' = 'no session started';
    let seen = false;
    await runSwarm(
      swarmOver({
        ...over,
        onProgress: async (event) => {
          if (event.kind !== 'session-started' || seen) return;
          seen = true;
          atFirstSession = (await readRun(runDir)).run.site;
        },
      }),
    );
    return atFirstSession;
  };

  it('writes what it was handed before the first session, and leaves it there', async () => {
    await open();

    expect(await siteWhenTheFirstSessionStarts({ site: NORTHWIND })).toEqual(NORTHWIND);
    expect((await readRun(runDir)).run.site).toEqual(NORTHWIND);
  });

  it('records an unverified site as unverified rather than as nothing', async () => {
    await open();
    const unverified = { url: 'https://northwind.example/cart', verifiedAtLaunch: false };

    const { run } = await runSwarm(swarmOver({ site: unverified }));

    expect(run.site).toEqual(unverified);
    expect((await readRun(runDir)).run.site?.verifiedAtLaunch).toBe(false);
  });

  it('writes no block at all for a caller that has no site', async () => {
    await open();

    expect(await siteWhenTheFirstSessionStarts()).toBeUndefined();
    const { run } = await readRun(runDir);
    expect(run.site).toBeUndefined();
    expect(await validate(runDir)).toEqual([]);
  });

  it('leaves a block its creator already wrote exactly as it found it', async () => {
    await open();
    const artifact = await readRun(runDir);
    await writeRun(runDir, { ...artifact, run: { ...artifact.run, site: NORTHWIND } });

    // Handed nothing, so there is nothing to correct: a creator that knew the site is not
    // overruled by a swarm that does not.
    await runSwarm(swarmOver());

    expect((await readRun(runDir)).run.site).toEqual(NORTHWIND);
  });

  it('drives the same sessions whether the site was verified or not', async () => {
    const sessionsOf = async (site: Run['site']): Promise<unknown> => {
      await sweep(runDir);
      runDir = await temporaryRunDir();
      await open();
      const { sessions } = await runSwarm(swarmOver({ site }));
      return sessions.map((session) => [session.sessionId, session.outcome.status]);
    };

    expect(await sessionsOf({ ...NORTHWIND, verifiedAtLaunch: false })).toEqual(
      await sessionsOf(NORTHWIND),
    );
  });
});
