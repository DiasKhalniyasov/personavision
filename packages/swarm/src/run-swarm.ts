/**
 * The swarm: the whole run, not one session.
 *
 * Every persona the audience generated, each on every seed group, against every variant —
 * four people × three seeds × two variants is the demo's twenty-four sessions — with **the
 * same people and the same seeds on both variants**, so the comparison is never confounded
 * by who was tested. The plan is `planSwarm`'s and is a value a caller can count before
 * anything runs: `packages/cli` writes the open run's per-variant totals from it rather
 * than restating the arithmetic.
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
 *   still open.
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
  SCHEMA_VERSION,
  writeRun,
  writeSession,
} from '@personavision/contract';
import { totalUsage } from '@personavision/provider';
import { decideOutcome } from './outcome.js';
import { runSession } from './run-session.js';
import type { Capture, CaptureSource, TaskDefinition, Variant } from '@personavision/browser';
import type { Persona, Run, RunUsage, Session } from '@personavision/contract';
import type { Aoi, EngineConfigOverrides, Segmenter } from '@personavision/engine';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionUsage,
  ProviderMode,
} from '@personavision/provider';
import type { AutomationFailure, OutcomePolicy, SessionOutcome } from './outcome.js';
import type { SessionProviders } from './run-session.js';

/**
 * How many sessions run at once when a caller names no bound.
 *
 * Four, because the bound is a bound on *browsers*: twenty-four sessions must not take
 * twenty-four times one session, and four Chromium instances with their pages fit on a
 * laptop where twenty-four would swap. A replaying run can afford far more and says so.
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
}: SwarmPlanInput): readonly SwarmSession[] => {
  const planned: SwarmSession[] = [];
  for (const variant of variants) {
    for (const persona of personas) {
      for (const seed of seedGroups) {
        planned.push({ sessionId: sessionIdAt(planned.length + 1), persona, variant, seed });
      }
    }
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
  /** How many sessions may be in flight at once. Defaults to `DEFAULT_CONCURRENCY`. */
  readonly concurrency?: number;
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
}

export interface SwarmResult {
  /** Every session the run produced, in plan order — the excluded ones included. */
  readonly sessions: readonly Session[];
  /** The run as it now stands: finished, with its counts, its log and its totals. */
  readonly run: Run;
}

export const runSwarm = async (input: RunSwarmInput): Promise<SwarmResult> => {
  const planned = planSwarm(input);
  if (planned.length === 0) {
    throw new Error(
      `${input.runDir}: this swarm plans no sessions (${input.personas.length} ${input.personas.length === 1 ? 'person' : 'people'}, ${input.seedGroups.length} seed groups, ${input.variants.length} variants), so there is no run to make`,
    );
  }

  const clock = input.now ?? ((): Date => new Date());
  const concurrency = capOf(input.concurrency, DEFAULT_CONCURRENCY);
  const timeoutMs = capOf(input.sessionTimeoutMs, DEFAULT_SESSION_BUDGET.wallClockMs);

  const opened = await openRun(input.runDir, planned, input.providers.decision.mode);
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

    const walked = await walkOne(input, opened.runId, plan, { clock, timeoutMs });
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

  return { sessions, run: await closeRun(input.runDir, planned, startedAt, clock) };
};

/** What one session produced, and what of it belongs to the run. */
interface WalkedSession {
  readonly session: Session;
  readonly usage: RunUsage;
  readonly aois: readonly Aoi[];
  readonly screenshots: Run['screenshots'];
  readonly elapsedMs: number;
  /**
   * Set only for a session the race gave up on: it is still running, and `runSession` writes
   * its own file when it lands. `null` for a session that answered, which is every session
   * of a run that went well.
   */
  readonly landsLate: Promise<unknown> | null;
}

const walkOne = async (
  input: RunSwarmInput,
  runId: string,
  plan: SwarmSession,
  { clock, timeoutMs }: { clock: () => Date; timeoutMs: number },
): Promise<WalkedSession> => {
  const provider = input.providers.decision;
  const aois: Aoi[] = [];
  const captures: Capture[] = [];
  const usages: DecisionUsage[] = [];

  const startedAt = clock().toISOString();
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
    runDir: input.runDir,
    runId,
    sessionId: plan.sessionId,
    variant: plan.variant,
    persona: plan.persona,
    seed: plan.seed,
    task: input.task,
    source: input.source,
    providers: { decision: answersWithin(provider, remainingMs) },
    segmenter: input.segmenter,
    budget: new SessionBudget({ wallClockMs: timeoutMs }),
    maxScreens: input.maxScreens,
    weights: input.weights,
    startedAt,
    outcomePolicy: input.outcomePolicy,
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
    const ours = brokenSession(input, runId, plan, startedAt, {
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
      session: brokenSession(input, runId, plan, startedAt, ourBreakage(finished.error, captures)),
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
    beginSession: (identity) => {
      const session = provider.beginSession(identity);
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
 * A session that never produced one: our own breakage, written as the session it would have
 * been. It carries no screen, no fixation and no action, because none happened, and
 * `decideOutcome` reads it as an automation failure — excluded from every score, so a
 * weakness of the simulation is never reported as a weakness of the product.
 */
const brokenSession = (
  input: RunSwarmInput,
  runId: string,
  plan: SwarmSession,
  startedAt: string,
  failure: AutomationFailure,
): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: plan.sessionId,
  runId,
  variant: plan.variant.id,
  taskId: input.task.id,
  kind: 'simulated',
  persona: { id: plan.persona.id, traits: plan.persona.traits, device: plan.persona.device },
  participant: null,
  seed: plan.seed,
  startedAt,
  durationMs: 0,
  screens: [],
  fixations: [],
  saccades: [],
  actions: [],
  outcome: decideOutcome(
    {
      screens: [],
      fixations: [],
      actions: [],
      durationMs: 0,
      taskCompleted: false,
      primaryActionAoiId: null,
      automationFailure: failure,
      wallClockBudgetMs: null,
    },
    plan.persona,
    input.outcomePolicy,
  ),
  integrity: { selectorFailures: 0, retries: 0 },
});

/** The step the session had reached when it broke, for a failure that names one. */
const stepNamed = (captures: readonly Capture[]): string =>
  captures.at(-1)?.step ?? FAILED_BEFORE_A_STEP;

/** What a session that broke before it reached a screen says it broke on. */
const FAILED_BEFORE_A_STEP = 'start';

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

/** The open run, read before anything is written, with the plan checked against it. */
interface OpenedRun {
  readonly runId: string;
  readonly startedAt: string | undefined;
}

const openRun = async (
  runDir: string,
  planned: readonly SwarmSession[],
  mode: ProviderMode,
): Promise<OpenedRun> => {
  const { run } = await readRun(runDir);
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
  return { runId: run.runId, startedAt: run.startedAt };
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

/** The cap won: the work is still running, and nobody is waiting for it any more. */
const EXPIRED = Symbol('the session passed its cap');

const withinTimeout = async <T>(
  work: Promise<T>,
  withinMs: number,
): Promise<T | typeof EXPIRED> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof EXPIRED>([
      work,
      new Promise<typeof EXPIRED>((settle) => {
        timer = setTimeout(() => settle(EXPIRED), withinMs);
      }),
    ]);
  } finally {
    // Left behind, the timer keeps the process alive for the length of the cap — twenty-four
    // sessions of a replaying run would hold a minute of timers for a run that took a second.
    clearTimeout(timer);
  }
};
