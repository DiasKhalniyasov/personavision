/**
 * The swarm: the whole run, not one session.
 *
 * Every persona the audience generated, each on every seed group, against every variant —
 * four people × three seeds × two variants is the demo's twenty-four sessions — with **the
 * same people and the same seeds on both variants**, so the comparison is never confounded
 * by who was tested. A path-2 run drives a **holdout** besides: more people, on seeds of
 * their own, through both sides (`holdout.ts`). Both of those promises are checked on the
 * plan before anything is written, rather than rested on a planner that happens not to break
 * them. The plan is `planSwarm`'s and is a value a caller can count before anything runs:
 * `packages/cli` writes the open run's per-variant totals from it rather than restating the
 * arithmetic.
 *
 * What this module owns, and what it leaves alone:
 *
 * - **It runs the sessions and closes the run.** The open `run.json` is its caller's — the
 *   command or the platform that knows the audience, the task and the engine mode writes
 *   it, and writes a run that could not start as `failed` (#54). This appends each session
 *   as it lands and moves the run from `open` to `finished` when they all have.
 * - **It carries on when a session breaks.** A throw or a passed timeout is recorded as
 *   that session's automation failure, which `docs/FLOW.md` section 8 excludes from every
 *   score, and the remaining sessions still run and are still written. One bad page costs
 *   one session, not a run.
 * - **It writes as it goes.** A session's file, its id, its progress entry, the areas it
 *   looked at and what it spent land in one write per session, so a run stopped halfway
 *   leaves a directory that still validates and the Running screen reads a run that is
 *   still open. `aggregate.json` goes with them (`aggregateRun`, #293), so the results page
 *   has figures to read while the test is still running.
 * - **It is bounded by its caller, not by itself.** How many sessions may be in flight at
 *   once arrives as `concurrency`, and the pool holds it: a hundred sessions ten at a time,
 *   proved at that number rather than assumed. `DEFAULT_CONCURRENCY` is only what a caller
 *   that names none gets. The per-site cap — ten, `docs/FLOW.md` section 13 — is
 *   `packages/platform`'s, because it is a fact about the site being driven and the platform
 *   is what starts runs; this package states no per-site number at all.
 * - **It decides nothing about a session.** The outcome, its step, its reason and its
 *   attribution are `decideOutcome`'s (#35), and a session's own fields are `runSession`'s
 *   (#44). What is added here belongs to the run: the numbering, the counts, the areas of
 *   interest `run.json` declares, and the model cost.
 *
 * `docs/FLOW.md` sections 2, 5 and 8; step #8; ticket #49.
 */

import {
  DEFAULT_SESSION_BUDGET,
  SessionBudget,
  toAutomationFailure,
  toScreenshotEntries,
} from '@personavision/browser';
import { rm } from 'node:fs/promises';
import {
  appendFinishedSession,
  readRun,
  runPaths,
  writeAggregate,
  writeRun,
  writeSession,
} from '@personavision/contract';
import { totalUsage } from '@personavision/provider';
import { aggregateComputedAt, composeAggregate } from '@personavision/scoring';
import { engineOnTheRecord, sameCalibration } from './calibration.js';
import {
  holdoutDrives,
  holdoutPersonaIds,
  holdoutRefusal,
  NO_HOLDOUT,
  sameSeedsOnBothSides,
} from './holdout.js';
import { runSession } from './run-session.js';
import { chooseRunner } from './runner/choose.js';
import { EXPIRED, withinTimeout } from './runner/within.js';
import { brokenSession, stepNamed } from './runner/session.js';
import type { Capture, CaptureSource, TaskDefinition, Variant } from '@personavision/browser';
import type { Persona, Run, RunArtifact, RunUsage, Session } from '@personavision/contract';
import type { Aoi, EngineConfigOverrides, Segmenter } from '@personavision/engine';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionUsage,
  ProviderMode,
} from '@personavision/provider';
import type { SwarmHoldout } from './holdout.js';
import type { AutomationFailure, OutcomePolicy, SessionOutcome } from './outcome.js';
import type { SessionProviders } from './run-session.js';
import type { JobsTransport } from './runner/jobs.js';
import type { RunnerWhere } from './runner/choose.js';
import type { SessionRunner, WalkedSession } from './runner/types.js';

/**
 * How many sessions run at once when a caller names no bound. **Not a cap on a site.**
 *
 * Four, because the bound is a bound on *browsers*: twenty-four sessions must not take
 * twenty-four times one session, and four Chromium instances with their pages fit on a
 * laptop where twenty-four would swap. A replaying run can afford far more and says so.
 * Four is the number for the one caller that names none — `packages/cli`, whose runs are
 * the demo's two dozen sessions on the machine the command was typed on, where that
 * laptop's memory is the whole of the constraint.
 *
 * **How many browsers may be open against one site at once is not this package’s to say.**
 * That number is a fact about the site being driven and about the machine driving it —
 * `docs/FLOW.md` section 13 sets it at ten, "a hundred browsers at once on one small site is
 * a load test nobody asked for" — and section 13 puts every such cap in **one place,
 * `packages/platform`**, which is what starts a run and is the only layer that knows which
 * site it is, whether that site is verified and how recently it was driven. It reaches the
 * swarm as `concurrency`, an input, and the swarm holds whatever it is given: a hundred
 * sessions ten at a time, proved at that number in `test/run-swarm.test.ts`.
 *
 * The swarm does not import the platform to read it. That would invert the dependency —
 * the platform is what starts runs — and would put a per-site number in the one package
 * that must work for any caller, the CLI included.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * How long a session is given, after every cap inside it has fired, to write itself up.
 *
 * The caps inside a session are the ones that produce a good record: its budget ends an
 * overrun page operation and its decision deadline ends a reply that never came, and either
 * way the session itself writes a file that says so. The race around the whole of it is the
 * backstop for a session that cannot even do that, and it waits this much longer so that it
 * is never the one that fires first. What has to fit in it: letting go of the decision layer
 * (`LET_GO_MS` of it), closing the page, and writing one file.
 */
const WRITE_UP_GRACE_MS = 1_000;

/**
 * How long the decision layer gets to let go of a call nobody is waiting for.
 *
 * A session's decider holds every turn still in flight and its `close` waits for them, which
 * is right for a turn that is still coming and wrong for one the session has already given up
 * on: nothing can cancel a request, so that wait never ends. `runSession` closes the decider
 * in a `finally`, so an unbounded wait there costs the whole session — the page it holds is
 * never closed and the file it was about to write is never written. Capped, the wait ends, the
 * page closes, and the session records the reply that never arrived.
 *
 * It is a cap on *waiting*, not on flushing: a decider that closes promptly — every normal
 * session — is never cut short, because it is already closed before this fires.
 */
const LET_GO_MS = 400;

/**
 * A cap, made usable, as `packages/browser`'s budget makes its own: floored to a whole
 * number of milliseconds, at least one, and anything unreadable — a `NaN` from a mistyped
 * flag — falling back to the default rather than to no cap at all. `Math.max(1, NaN)` is
 * `NaN`, and a `NaN` pool size is a swarm that silently runs nobody.
 */
const capOf = (given: number | undefined, fallback: number): number => {
  if (given === undefined || !Number.isFinite(given)) return fallback;
  return Math.max(1, Math.floor(given));
};

/** `S-01`, `S-02` … `S-NN`: a session's id, and the name of its file under `sessions/`. */
const sessionIdAt = (position: number): string => `S-${String(position).padStart(2, '0')}`;

/** One planned session: who walks which variant on which seed, under which id. */
export interface SwarmSession {
  readonly sessionId: string;
  readonly persona: Persona;
  readonly variant: Variant;
  readonly seed: number;
}

/** What the swarm is: the people, the seeds and the variants it crosses. */
export interface SwarmPlanInput {
  readonly variants: readonly Variant[];
  /** Generated from the run's audience, and recorded in `run.json` by value (#31). */
  readonly personas: readonly Persona[];
  readonly seedGroups: readonly number[];
  /**
   * The people the change was never chosen against, on the seeds they were sampled on
   * (`holdout.ts`, `docs/FLOW.md` section 15, point 4). Absent on a path-1 run, which is
   * every run the swarm drove before this: no holdout people, no holdout sessions, and a
   * plan identical to the one this planner has always produced.
   */
  readonly holdout?: SwarmHoldout;
}

/**
 * The run's sessions, numbered.
 *
 * **Variant, then person, then seed**, which is the order the committed example run is
 * numbered in: `S-01 … S-12` walk variant A and `S-13 … S-24` variant B, each person's
 * three seeds together. The order is a promise, not a detail — a session id is how a
 * finding, a screen and a reader address one simulated person, so the same plan numbers the
 * same session the same way on every machine and on every re-run.
 *
 * Every variant gets the same people on the same seeds, because the loop crosses one list
 * of people and one list of seeds with the variants rather than drawing per variant.
 */
export const planSwarm = ({
  variants,
  personas,
  seedGroups,
  holdout = NO_HOLDOUT,
}: SwarmPlanInput): readonly SwarmSession[] => {
  const planned: SwarmSession[] = [];
  const take = (persona: Persona, variant: Variant, seed: number): void => {
    planned.push({ sessionId: sessionIdAt(planned.length + 1), persona, variant, seed });
  };
  for (const variant of variants) {
    for (const persona of personas) {
      for (const seed of seedGroups) take(persona, variant, seed);
    }
    // The holdout's people come after the main set's, inside the same variant: a variant's
    // sessions stay one contiguous block of ids, which is what the committed example run's
    // numbering promises and what a reader counting `S-13 … S-28` reads. Each of them is
    // driven once, on the seed they were sampled on, rather than on every seed group — the
    // seed is the unspent thing about a holdout person (`holdout.ts`).
    for (const { persona, seed } of holdoutDrives(holdout)) take(persona, variant, seed);
  }
  return planned;
};

/** A session has started. The run's own counts are here so a caller renders one claim. */
export interface SwarmSessionStarted {
  readonly kind: 'session-started';
  readonly sessionId: string;
  /** The person, as the run's `personas` name them: a log line reads a name, not an id. */
  readonly personaName: string;
  readonly variant: string;
  readonly seed: number;
  readonly finishedSessions: number;
  readonly totalSessions: number;
}

/** A session has landed and is on disk, with the outcome the artifact now carries. */
export interface SwarmSessionFinished {
  readonly kind: 'session-finished';
  readonly sessionId: string;
  readonly personaName: string;
  readonly variant: string;
  readonly seed: number;
  /** `decideOutcome`'s, stored and reported unmodified: status, step, reason, attribution. */
  readonly outcome: SessionOutcome;
  /**
   * Wall-clock milliseconds this session took in this process — what "took 1.2 s" means in
   * a log. It is not the session's `durationMs`, which is the time the agent spent looking.
   */
  readonly elapsedMs: number;
  readonly finishedSessions: number;
  readonly totalSessions: number;
}

/**
 * The event stream, as each session starts and finishes.
 *
 * The same facts reach disk through the run artifact's progress block, and a reader that
 * can wait for the file reads them there (#18). This is for the caller that is driving the
 * run and prints as it goes (#54), so that the CLI and the Running screen are two faces of
 * one run rather than two sources of truth.
 */
export type SwarmProgress = SwarmSessionStarted | SwarmSessionFinished;

export interface RunSwarmInput extends SwarmPlanInput {
  /** The open run directory: `run.json` is already there, with status `open`. */
  readonly runDir: string;
  /** The task every session walks, as the browser step declares it. */
  readonly task: TaskDefinition;
  readonly source: CaptureSource;
  readonly providers: SessionProviders;
  /**
   * How many sessions may be in flight at once — **the caller’s number**, and the only
   * bound the pool holds. Never more than this many sessions are between their
   * `session-started` and `session-finished` events, at a hundred sessions as at eight.
   *
   * Defaults to `DEFAULT_CONCURRENCY`, which is a default for a small run and not a cap on
   * a site: the per-site cap is `packages/platform`’s (`docs/FLOW.md` section 13), and it
   * is passed in here rather than read from there.
   */
  readonly concurrency?: number;
  /**
   * The site this run was launched against, and whether it was verified at that moment, for
   * the swarm to put on the record before its first session (`run.json`'s `site` block,
   * #243).
   *
   * It arrives as an input for the same reason the audience and the concurrency do: only the
   * platform knows which site is being driven and what its verification state was when the
   * caps were decided, and the state is read there **once, at launch**. The swarm neither
   * resolves it nor re-reads it — a re-read mid-run would record something that was not true
   * when the sessions started — and nothing in this package branches on it. It is a fact
   * written down, not a switch.
   *
   * Absent for a caller with no site, which is `personavision run`: it has no workspace and
   * no site, and the run it writes carries no block at all.
   */
  readonly site?: Run['site'];
  /**
   * How long one session may take, in wall-clock milliseconds. One deadline, held three
   * ways, because what matters is not only that an overrun ends but that it ends with a
   * record of itself:
   *
   * 1. the session's own `SessionBudget`, which ends an overrun **page operation** with a
   *    typed failure naming the cap;
   * 2. a deadline on each **decision**, which is the one call of the loop that goes through
   *    no budget and the one most likely to hang in model mode — a reply that does not
   *    arrive in the time the session has left is a failure the session itself records,
   *    with the screens and areas it had reached;
   * 3. a race around the whole of it, a grace period later, for a session that cannot even
   *    write itself up. That one is written by the swarm, as an automation failure, because
   *    there is nothing left to ask.
   */
  readonly sessionTimeoutMs?: number;
  readonly segmenter?: Segmenter;
  readonly weights?: EngineConfigOverrides;
  readonly outcomePolicy?: OutcomePolicy;
  readonly maxScreens?: number;
  /**
   * The clock, which is the one thing a reproducible run cannot derive: it stamps each
   * session's `startedAt` and records when the run finished. A test passes its own.
   *
   * The caps are **not** measured on it. A run that fixes its clock to get reproducible
   * timestamps would otherwise be fixing its deadlines too — a session's remaining time
   * would never go down — so what a session has left, and how long it took, are read from
   * the process clock.
   */
  readonly now?: () => Date;
  /**
   * Called as each session starts and as it lands, in order. The landing is reported from
   * inside the run's own turn at `run.json`, so a handler that reads the artifact reads the
   * run exactly as this session left it — and it is awaited, so a handler that writes
   * somewhere of its own is not racing the next session. A handler that throws stops the
   * run, because a caller that has lost track of a run is not one to carry on reporting to:
   * a caller whose printing can fail guards it itself.
   */
  readonly onProgress?: (event: SwarmProgress) => void | Promise<void>;
  /**
   * The environment the **runner** is chosen from: `PV_RUNNER` unset or `local` is the
   * swarm's own pool, which is the default everywhere, and `cloud-run` is one Cloud Run job
   * execution per session (`runner/choose.ts`, #317). Defaults to `process.env`; a test
   * passes its own and touches nothing global.
   *
   * It is read in exactly one place and nothing downstream of it branches on the answer.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The Jobs API transport a remote run goes through, for a test and for a coordinator
   * authorised its own way. The default is built **only** when none is given, and only for a
   * run that asked for `cloud-run`: a local run never constructs a cloud client at all.
   */
  readonly jobsTransport?: JobsTransport;
}

export interface SwarmResult {
  /** Every session the run produced, in plan order — the excluded ones included. */
  readonly sessions: readonly Session[];
  /** The run as it now stands: finished, with its counts, its log and its totals. */
  readonly run: Run;
  /**
   * The run's holdout list: exactly the people this run drove as the holdout, in the order
   * the generator drew them, and empty on a run that drove none.
   *
   * It is the people the swarm was handed, which is the people it drove: the plan is this
   * module's own, so there is no path by which a name here has no sessions behind it.
   *
   * It is handed back rather than written, because the one field that records it —
   * `improve.holdout.personaIds` — sits in the block that names the pull request, the
   * preview and the recommendation, and the contract holds a recorded holdout to also
   * recording whether it confirmed the gain. The swarm knows none of that: it knows who ran.
   * The loop (#306) writes the block once scoring has judged it (#304).
   */
  readonly holdoutPersonaIds: readonly string[];
}

export const runSwarm = async (input: RunSwarmInput): Promise<SwarmResult> => {
  const holdout = input.holdout ?? NO_HOLDOUT;
  const planned = planSwarm(input);
  if (planned.length === 0) {
    throw new Error(
      `${input.runDir}: this swarm plans no sessions (${input.personas.length} ${input.personas.length === 1 ? 'person' : 'people'}, ${input.seedGroups.length} seed groups, ${input.variants.length} variants), so there is no run to make`,
    );
  }

  // Refused before the run is opened, so a refusal writes nothing at all: what is being
  // refused is a comparison, and a directory half-written from one is worse than none.
  const refused = holdoutRefusal(holdout, input) ?? sameSeedsOnBothSides(planned);
  if (refused !== null) throw new Error(`${input.runDir}: ${refused}`);

  const clock = input.now ?? ((): Date => new Date());
  const concurrency = capOf(input.concurrency, DEFAULT_CONCURRENCY);
  const timeoutMs = capOf(input.sessionTimeoutMs, DEFAULT_SESSION_BUDGET.wallClockMs);

  // The one place a runner is chosen, and the one place a remote run with nowhere to put its
  // output is refused — before the run is opened, so a refusal writes nothing at all.
  const chosen = chooseRunner(
    {
      ...(input.env === undefined ? {} : { env: input.env }),
      engineMode: input.providers.decision.mode,
    },
    input.jobsTransport,
  );
  const runner: SessionRunner = chosen.runner ?? walkOne;

  const opened = await openRun(
    input.runDir,
    planned,
    input.providers.decision.mode,
    { where: chosen.where, image: chosen.image, concurrency },
    input.site,
  );
  const startedAt = opened.startedAt ?? clock().toISOString();

  const sessions: Session[] = [];
  const takeTurn = inTurn();
  let finishedSessions = 0;

  /** One session, start to finish: run it, record it, and say so. */
  const walk = async (plan: SwarmSession, position: number): Promise<void> => {
    await input.onProgress?.({
      kind: 'session-started',
      sessionId: plan.sessionId,
      personaName: plan.persona.name,
      variant: plan.variant.id,
      seed: plan.seed,
      finishedSessions,
      totalSessions: planned.length,
    });

    const walked = await runner({
      runDir: input.runDir,
      runId: opened.runId,
      sessionId: plan.sessionId,
      persona: plan.persona,
      variant: plan.variant,
      seed: plan.seed,
      task: input.task,
      startedAt: clock().toISOString(),
      timeoutMs,
      source: input.source,
      providers: input.providers,
      outcomePolicy: input.outcomePolicy,
      maxScreens: input.maxScreens,
      weights: input.weights,
      segmenter: input.segmenter,
    });
    sessions[position] = walked.session;

    // `run.json` is one file every session of the swarm would have to queue at, so they do:
    // the append is a read, a change and a write, and two at once would lose one of them.
    await takeTurn(async () => {
      try {
        await appendFinishedSession(input.runDir, walked.session, {
          personaName: plan.persona.name,
          usage: walked.usage,
          aois: walked.aois,
          screenshots: walked.screenshots,
        });
      } catch (error) {
        // The session's own file is already on disk — `runSession` writes it, and the
        // appending writer parses before it writes anything — so a failed append would
        // leave a session `run.json` does not list, which makes the whole directory
        // unreadable. That is the one state writing a session at a time exists to avoid,
        // so the file goes with the write that failed, and the failure is still thrown.
        await rm(runPaths(input.runDir).session(plan.sessionId), { force: true }).catch(
          () => undefined,
        );
        throw error;
      }
      finishedSessions += 1;
      // The run has claimed this session: its id, its progress entry and its areas are this
      // record's, so the file has to be too. A session the race gave up on is still running
      // and writes its own when it lands, so the run writes its record again over it.
      if (walked.landsLate !== null) {
        const ours = walked.session;
        void walked.landsLate.then(() => writeSession(input.runDir, ours)).catch(() => undefined);
      }
      // The figures, over the sessions that now exist (#293). Inside the turn, because the
      // file is composed from the `run.json` and the sessions this write just left behind,
      // and because two of these at once would interleave in one file. Before the progress
      // event, so that a reader woken by the landing finds the figures of it.
      //
      // Best-effort, and the one `catch` here that drops what it caught: a session that
      // walked is worth more than a figure that can be computed again, and the next landing
      // re-composes the whole file from the directory, so a transient failure heals itself.
      // A failure that is not transient is not lost either — the closing write below is the
      // same call with no landing after it to heal it, and that one throws.
      await aggregateRun(input.runDir).catch(() => undefined);
      await input.onProgress?.({
        kind: 'session-finished',
        sessionId: plan.sessionId,
        personaName: plan.persona.name,
        variant: plan.variant.id,
        seed: plan.seed,
        outcome: walked.session.outcome,
        elapsedMs: walked.elapsedMs,
        finishedSessions,
        totalSessions: planned.length,
      });
    });
  };

  let next = 0;
  /**
   * The first failure of the bookkeeping, which is not a session breaking.
   *
   * A session that breaks is recorded as an automation failure and the run goes on; a
   * `run.json` that cannot be written is a run nobody can read, so the swarm stops taking
   * sessions. It stops rather than abandons: the sessions already in flight finish and land
   * first, and the one whose write failed is swept, so that what is left on disk is a run
   * that still reads — which is the whole point of writing a session at a time.
   */
  const stoppedBy: unknown[] = [];
  const workers = Array.from({ length: Math.min(concurrency, planned.length) }, async () => {
    // One cursor, taken a session at a time: a worker that finishes early takes the next
    // session rather than waiting for a batch, and no more than `concurrency` are ever in
    // flight because there are no more workers than that.
    while (stoppedBy.length === 0 && next < planned.length) {
      const position = next;
      next += 1;
      try {
        await walk(planned[position] as SwarmSession, position);
      } catch (error) {
        stoppedBy.push(error);
        throw error;
      }
    }
  });
  // Every worker is waited for, and what the swarm throws is the failure that stopped it —
  // the first one in time, and not whichever worker a later knock-on rejection belongs to.
  await Promise.allSettled(workers);
  if (stoppedBy.length > 0) throw stoppedBy[0];

  const run = await closeRun(input.runDir, planned, startedAt, clock);
  // Once more, now that the run is closed: over the final set of sessions, and carrying a
  // finished `runStatus` rather than the `open` every mid-run write left. It is the same
  // whole re-composition as every write before it, which is what makes the file the run is
  // left with the file a re-aggregation of this directory produces.
  //
  // This one throws. There is no landing after it to re-compose the file, so a failure here
  // is the only chance a caller has to learn that the run's figures are missing or stale —
  // and the run is safe on disk either way: `run.json` is already `finished`, every session
  // is written, and the figures can be landed by calling this again over the directory.
  await aggregateRun(input.runDir);

  return { sessions, run, holdoutPersonaIds: holdoutPersonaIds(holdout) };
};

/**
 * The run's own aggregate, composed over the sessions on disk and landed through the
 * contract's writer (#293). The swarm calls it as each session lands and once more when the
 * run closes; anything holding a run directory can call it to re-aggregate one.
 *
 * **Every call is a whole re-composition, never an increment.** That looks wasteful and is
 * not. The composition is a pure fold over sessions already parsed, which beside a browser
 * session costs nothing, and it buys the one property the file is worth having: the
 * `aggregate.json` a run is left with is identical to the one a re-aggregation of the same
 * directory produces, because they are the same call. Updating the file in place would mean
 * two code paths over the same figures — the incremental one and the re-aggregating one —
 * and two code paths can disagree, which for a file whose whole job is that two screens
 * cannot disagree about a number would be the wrong way round.
 *
 * It reads the directory rather than taking the sessions it is handed, for the same reason:
 * what the file claims to be of is what is on disk. `runStatus` is the status of the
 * `run.json` it just read, so a file written mid-run says `open` and the one written after
 * the run closes says `finished`, and a reader is never told a partial figure is final.
 *
 * **It takes no clock either**, which is the other half of the same property: `computedAt`
 * is read off the run by `aggregateComputedAt`, the rule `personavision aggregate` composes
 * by (#294), so re-aggregating a directory this left behind gives those bytes back instead
 * of a fresh timestamp.
 *
 * A run that never started has no aggregate at all, which is this being unreachable rather
 * than anything written here: a refusal happens before the run is opened, and a run recorded
 * as `failed` is written by its creator with no sessions and no figures. A file of zeroes
 * nobody measured is worse than no file.
 */
export const aggregateRun = async (runDir: string): Promise<void> => {
  const { run, sessions } = await readRun(runDir);
  await writeAggregate(
    runDir,
    composeAggregate({ run, sessions, computedAt: aggregateComputedAt(run) }),
  );
};

/**
 * The swarm's own runner: one session in this process, which is what `PV_RUNNER` unset means
 * and what every test, the acceptance suite and the demo run on.
 */
const walkOne: SessionRunner = async (request) => {
  const { timeoutMs, startedAt } = request;
  const provider = request.providers.decision;
  const aois: Aoi[] = [];
  const captures: Capture[] = [];
  const usages: DecisionUsage[] = [];

  const startedMs = Date.now();
  /** What is left of this session's own deadline, which is what a decision gets. */
  const remainingMs = (): number => Math.max(1, startedMs + timeoutMs - Date.now());
  const spent = (): WalkedSession['usage'] => runUsageOf(usages, provider.mode);
  // Copied, not handed over: a session the race gave up on goes on capturing screens, and
  // what the run declares has to be what it was told at the time.
  const seen = (): Pick<WalkedSession, 'aois' | 'screenshots' | 'elapsedMs'> => ({
    aois: [...aois],
    screenshots: toScreenshotEntries(captures),
    elapsedMs: Math.max(0, Date.now() - startedMs),
  });

  const settled = runSession({
    runDir: request.runDir,
    runId: request.runId,
    sessionId: request.sessionId,
    variant: request.variant,
    persona: request.persona,
    seed: request.seed,
    task: request.task,
    source: request.source,
    providers: { decision: answersWithin(provider, remainingMs) },
    segmenter: request.segmenter,
    budget: new SessionBudget({ wallClockMs: timeoutMs }),
    maxScreens: request.maxScreens,
    weights: request.weights,
    startedAt,
    outcomePolicy: request.outcomePolicy,
    onScreen: (screen) => {
      // The areas of interest `run.json` declares are the engine's, built from the capture
      // the session looked at: a session's fixations name these ids, and a run that
      // declared the capture's own element ids instead would leave every one of them
      // dangling. The screens are the projection `packages/browser` publishes, because the
      // geometry the overlays register to is the capture's and nothing else's.
      aois.push(...screen.aois);
      captures.push(screen.capture);
      if (screen.decision !== null) usages.push(screen.decision.usage);
    },
  }).then(
    (session) => ({ kind: 'session', session }) as const,
    (error: unknown) => ({ kind: 'error', error }) as const,
  );

  const finished = await withinTimeout(settled, timeoutMs + WRITE_UP_GRACE_MS);
  if (finished === EXPIRED) {
    // Every cap inside the session fired a grace period ago and it has still not written
    // itself up, so the run writes it up instead. The session is not cancelled — nothing
    // here can cancel a page operation — so if it ever does land, `runSession` writes its
    // own file over the one the run has just recorded. The run's index, its progress entry
    // and its declared areas are this session's, so the file has to be this one too: the
    // last word on disk is the record the rest of the artifact agrees with.
    const ours = brokenSession(request, {
      kind: 'wall_clock_timeout',
      detail: `the session passed its ${timeoutMs / 1000} s cap with no answer`,
      step: stepNamed(captures),
    });
    // Handed back rather than chained here: the run's record is only worth re-asserting once
    // the run has actually claimed this session, and a session whose append failed was swept.
    return { session: ours, usage: spent(), ...seen(), landsLate: settled };
  }
  if (finished.kind === 'error') {
    return {
      session: brokenSession(request, ourBreakage(finished.error, captures)),
      usage: spent(),
      ...seen(),
      landsLate: null,
    };
  }
  return { session: finished.session, usage: spent(), ...seen(), landsLate: null };
};

/**
 * The decision layer, with the session's deadline on every call.
 *
 * `runSession` asks the decision layer for one decision per screen and awaits it under no
 * budget: the budget caps page operations, and a model call is not one. So a provider that
 * never answers would hold a session open for as long as it liked, which is the failure the
 * swarm's own race exists for — but a race the swarm wins abandons a session that has
 * screens, fixations and actions worth keeping, and writes a session with none.
 *
 * Capped here instead, the same overrun is a failure the session records itself, on the
 * screen it happened on, with everything it had reached: `runSession` catches a decision
 * that throws and ends the session as our breakage, which is what a reply that never came
 * is. The race stays, a grace period further out, for a session that hangs somewhere else.
 *
 * **`close` is capped too, and that is what makes the rest of it work.** A session's decider
 * holds the turns still in flight and its `close` waits for all of them, so the call this
 * wrapper stopped waiting for is one `close` would wait for for ever — in a `finally` of
 * `runSession`, which would cost the session its page and its file after all. Both caps are
 * needed or neither does anything.
 *
 * The stateless `decide` is capped with it, so a provider reached either way answers within
 * one session's deadline or not at all.
 */
const answersWithin = (provider: DecisionProvider, remainingMs: () => number): DecisionProvider => {
  const within =
    (decide: (context: DecisionContext) => Promise<Decision>) =>
    async (context: DecisionContext): Promise<Decision> => {
      const withinMs = remainingMs();
      const answer = await withinTimeout(
        decide(context).then(
          (decision) => ({ kind: 'value', decision }) as const,
          (error: unknown) => ({ kind: 'error', error }) as const,
        ),
        withinMs,
      );
      if (answer === EXPIRED) {
        throw new Error(`no answer in the ${withinMs} ms this session had left`);
      }
      if (answer.kind === 'error') throw answer.error;
      return answer.decision;
    };
  return {
    ...provider,
    decide: within((context) => provider.decide(context)),
    beginSession: (identity, scope) => {
      // the scope carries the session's trajectory file (#139): dropping it here wrote none
      const session = provider.beginSession(identity, scope);
      return {
        ...session,
        decide: within((context) => session.decide(context)),
        close: async () => {
          // Settled either way, because what a close failed at is the decider's to report
          // and not a reason to hold the session open.
          const closing = session.close().then(
            () => undefined,
            () => undefined,
          );
          await withinTimeout(closing, LET_GO_MS);
        },
      };
    },
  };
};

/**
 * A thrown session, in the shape `decideOutcome` reads.
 *
 * `runSession` already maps the driver's own failures and rethrows only what it cannot
 * place — a bug of ours, not a page's. There is no kind for that in the artifact's
 * vocabulary, and inventing one would put a word in `docs/FLOW.md` section 8's list that
 * nothing else uses, so it is recorded as the navigation that never completed, which is
 * what the walk saw, with the error's own message as the detail. The kind is never stored;
 * the detail is what a person reads.
 */
const ourBreakage = (error: unknown, captures: readonly Capture[]): AutomationFailure => {
  const step = stepNamed(captures);
  const attempting = 'running the session';
  const mapped = toAutomationFailure(error, attempting);
  if (mapped !== null) return { kind: mapped.reason, detail: mapped.message, step };
  const said = error instanceof Error ? error.message : String(error);
  return { kind: 'navigation_error', detail: `${attempting}: ${said}`, step };
};

/**
 * What the run's decisions cost, as `run.json`'s `usage` block records it.
 *
 * An offline run made no model call and so records none: `engine.mode` and this count are
 * the same fact about one run, and the contract rejects an artifact where they disagree. It
 * is recorded as zeroes rather than left out, because "this run cost nothing" is a fact and
 * an absent total is an unknown one.
 */
const runUsageOf = (usages: readonly DecisionUsage[], mode: ProviderMode): RunUsage =>
  totalUsage(mode === 'model' ? usages : []);

/**
 * The open run, read before anything is written, with the plan checked against it and the
 * engine put on the record.
 */
interface OpenedRun {
  readonly runId: string;
  readonly startedAt: string | undefined;
}

/** Where this run's sessions ran, as `run.json`'s own `runner` block records it. */
interface RunnerOnTheRecord {
  readonly where: RunnerWhere;
  readonly image: string | null;
  readonly concurrency: number;
}

/**
 * Whether the site already on the record says what the swarm was handed.
 *
 * A caller that handed over **no** site agrees with whatever is written, which is what keeps
 * this from unwriting a creator's own block: `personavision run` passes none, and a run
 * opened with a block by some future creator is left exactly as it was written. A caller that
 * handed one over agrees only if both halves match, so a block that disagrees is corrected to
 * what was true at launch rather than left to be read as the launch's own answer.
 */
const sameSite = (recorded: Run['site'], handed: Run['site']): boolean =>
  handed === undefined ||
  (recorded?.url === handed.url && recorded.verifiedAtLaunch === handed.verifiedAtLaunch);

/**
 * The site as the artifact declares it: the two fields, and whatever else came with them
 * left behind.
 *
 * The caller hands over what it resolved, and what it resolved is likely to be bigger than
 * this — the platform's own `SiteAtLaunch` carries the stored record's `id` beside the URL,
 * and a run directory names no row in anybody's database (`docs/FLOW.md` section 8). Such an
 * object is **structurally assignable** to this input and TypeScript checks excess properties
 * only on object literals, so a caller passing its own value straight through compiles. If it
 * reached the writer, `writeRun`'s strict parse would refuse the whole artifact at `site/id`
 * and lose the run over a field nobody wanted on it.
 *
 * So the block is rebuilt from its declared fields at the one place that writes it. That
 * makes "a run directory carries no platform record id" a property of this seam rather than
 * something every caller has to remember, and it holds for a caller this package has never
 * seen.
 */
const siteOnTheRecord = (site: NonNullable<Run['site']>): NonNullable<Run['site']> => ({
  url: site.url,
  verifiedAtLaunch: site.verifiedAtLaunch,
});

const openRun = async (
  runDir: string,
  planned: readonly SwarmSession[],
  mode: ProviderMode,
  runner: RunnerOnTheRecord,
  site: Run['site'],
): Promise<OpenedRun> => {
  const artifact = await readRun(runDir);
  const { run } = artifact;
  if (run.status !== 'open') {
    throw new Error(
      `${runDir}: this run's status is ${run.status === undefined ? 'absent' : `"${run.status}"`}, and a swarm runs into a run that is open`,
    );
  }
  // What a run says it ran on is part of its record, and the decision layer it is handed is
  // what it ran on: a run's mode is never silently changed. Refused here, because both
  // alternatives are worse — a model provider into an offline run is rejected by the writer
  // on the first session, in a message about usage rather than about the mode, and an offline
  // provider into a model run is not rejected at all and records a model run that cost
  // nothing.
  if (run.engine.mode !== mode) {
    throw new Error(
      `${runDir}: this run records the ${run.engine.mode} engine and the swarm was handed a ${mode} decision layer`,
    );
  }
  // A run records by value every person it drove, and the session log the writer derives is
  // written from that list: a session whose person the run never recorded is refused by
  // `appendFinishedSession` mid-run, which leaves the half-written directory writing a
  // session at a time exists to avoid. So it is refused here, before anything runs. The
  // holdout is the new way to get it wrong — its people are recorded as ids into the same
  // list, which is what the contract means by "a holdout is people the run generated" —
  // and the check is over everybody planned, because the main set can be wrong the same way.
  const generated = new Set(run.personas.map((persona) => persona.id));
  const stranger = planned.find((plan) => !generated.has(plan.persona.id));
  if (stranger !== undefined) {
    throw new Error(
      `${runDir}: this run records ${run.personas.length} personas and "${stranger.persona.id}" is not one of them: a run carries by value every person it drove, the holdout included, and its session log is written from them`,
    );
  }
  // Checked here rather than discovered on the session that overruns the plan: the writer
  // refuses a session the run left no room for, and refusing the twentieth would leave a
  // directory holding sessions `run.json` does not list. The total is its own claim and not
  // part of the per-variant split, so it is held on its own: a run that declared eight and is
  // handed twelve would otherwise have its total raised one session at a time by the writer,
  // and the Running screen would read "8 of 8" and then "9 of 9".
  //
  // A run that declared no plan at all is left alone: the writer grows its total as sessions
  // land, which is the one bar a run that never said how many to expect shows.
  const { progress } = run;
  if (progress !== undefined && progress.totalSessions > 0) {
    if (progress.totalSessions !== planned.length) {
      throw new Error(
        `${runDir}: this run plans ${progress.totalSessions} sessions and the swarm plans ${planned.length}`,
      );
    }
  }
  for (const row of progress?.perVariant ?? []) {
    const mine = planned.filter((plan) => plan.variant.id === row.variant).length;
    if (mine !== row.totalSessions) {
      throw new Error(
        `${runDir}: this run plans ${row.totalSessions} sessions on variant "${row.variant}" and the swarm plans ${mine}`,
      );
    }
  }
  await recordEngine(runDir, artifact, runner, site);
  return { runId: run.runId, startedAt: run.startedAt };
};

/**
 * Which engine ran, what it scored, **where its sessions ran** and **what site they ran
 * against**, on the record before the first session runs (#92, #317, #243).
 *
 * Three fields are one claim about the engine: `engine.version` names it and `calibration`
 * carries the figures it was measured at, which is what the header badge states on every
 * screen. They come from the engine this build imports, because nothing else knows which
 * engine is about to walk the sessions — a creator can only guess at its version, and a stale
 * figure beside a new engine is exactly the fabrication `docs/FLOW.md`'s badge must never
 * show.
 *
 * It happens here, in the swarm's own turn at `run.json` and before any session has landed,
 * so the value a reader sees while the run is open is the value the finished run carries: the
 * badge does not change number mid-run. A run whose creator already wrote these fields from
 * `engineOnTheRecord` — which is how a run should be opened, and the only way a run that
 * failed to start can carry them at all — is left exactly as it was written.
 *
 * The `runner` block is the swarm's own and nothing else writes it, so in practice this write
 * does happen once per run: only the swarm knows which runner it was handed, and a creator
 * that guessed at it would be guessing at the one field that says which code drove the run.
 *
 * The `site` block rides along in the same write for a plainer reason: it is the other fact
 * about a launch that a reader of the finished directory cannot recover from the sessions, and
 * recording it beside the engine is one write rather than two. It is written **only when a
 * caller handed one over**, so a run with no site — `personavision run`, which has no
 * workspace — carries no block, and an absent block stays what the contract says it is: a run
 * that did not say, and never a claim that its site was unverified. A run that fails before
 * the swarm is reached therefore records no site either; the only thing that knows a site at
 * all is the layer that resolved it.
 *
 * The write is the whole artifact, as `closeRun`'s is, because `run.json` has no writer of
 * its own and `packages/contract` is not this ticket's to change. It is reached before the
 * first session, where a run the swarm walks holds none.
 */
const recordEngine = async (
  runDir: string,
  artifact: RunArtifact,
  runner: RunnerOnTheRecord,
  site: Run['site'],
): Promise<void> => {
  const { run } = artifact;
  const engine = engineOnTheRecord();
  const agrees =
    run.engine.version === engine.version &&
    sameCalibration(run.calibration, engine.calibration) &&
    run.runner?.where === runner.where &&
    run.runner.image === runner.image &&
    run.runner.concurrency === runner.concurrency &&
    sameSite(run.site, site);
  if (agrees) return;
  await writeRun(runDir, {
    ...artifact,
    run: {
      ...run,
      engine: { ...run.engine, version: engine.version },
      calibration: engine.calibration,
      runner,
      // Spread conditionally rather than assigned, so that a caller with no site leaves the
      // field exactly as it found it instead of writing `site: undefined` over a block
      // somebody else put there.
      ...(site === undefined ? {} : { site: siteOnTheRecord(site) }),
    },
  });
};

/**
 * The run, closed: `finished`, with the time it stopped and its sessions in plan order.
 *
 * The ids are appended in the order the sessions landed, which with a pool is the order
 * they happened to finish in; `sessionIds` is the artifact's authoritative order, and the
 * Sessions screen lists `S-01` first. So they are sorted back into the plan's order here,
 * once, when the run is no longer being appended to. The progress log keeps its own order,
 * which is the order they finished in and is what it is for.
 */
const closeRun = async (
  runDir: string,
  planned: readonly SwarmSession[],
  startedAt: string,
  clock: () => Date,
): Promise<Run> => {
  const artifact = await readRun(runDir);
  const landed = new Set(artifact.run.sessionIds);
  const run: Run = {
    ...artifact.run,
    status: 'finished',
    startedAt,
    finishedAt: clock().toISOString(),
    sessionIds: planned.map((plan) => plan.sessionId).filter((sessionId) => landed.has(sessionId)),
  };
  await writeRun(runDir, { ...artifact, run });
  return run;
};

/** Nobody's turn: the queue every write of `run.json` takes a place in. */
const inTurn = (): (<T>(job: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const mine = tail.then(job, job);
    // The next in line waits for this one either way: a write that threw must not take the
    // queue down with it, and its caller still sees the throw.
    tail = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };
};
