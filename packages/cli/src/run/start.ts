import { join } from 'node:path';
import { createLiveSource } from '@personavision/browser';
import { runDirName } from '@personavision/contract';
import { generatePersonas } from '@personavision/personas';
import { ModelModeUnavailableError } from '@personavision/provider';
import { planSwarm, runSwarm } from '@personavision/swarm';
import {
  closeStoppedRun,
  failedRunRecord,
  openRunRecord,
  readRunRecord,
  writeRunRecord,
} from './artifact.js';
import { requestedEngine, selectEngine } from './engine.js';
import { closingLines, finishedPhrase, openingLines, reportLine } from './progress.js';
import { taskFor } from './task.js';
import type { CaptureSource, TaskStep, Variant } from '@personavision/browser';
import type { Audience, Run, RunFailure, RunRequest } from '@personavision/contract';
import type { CreateModelProvider, SelectedEngine } from './engine.js';
import type { ModelMode } from '@personavision/provider';
import type { SwarmProgress } from '@personavision/swarm';

/**
 * A run, start to finish: the swarm behind one call.
 *
 * It is the whole of what `personavision run` does once its arguments have been read, and
 * it is shaped as the platform's `TestPipeline` — a request and the audience by value, in;
 * what actually ran, out — so that the command line and the New test form can drive one
 * pipeline and produce identical run directories rather than two that drift.
 *
 * What it owns:
 *
 * - **The run directory.** It opens the run with status `open`, lets the swarm append each
 *   session and close it as `finished`, and records a run that could **not** start as
 *   `failed` with its reason and the captured detail — with no session at all, which is what
 *   lets the Test failed screen state outright that nobody was simulated.
 * - **The audience, by value.** The people are generated from it with the base seed (#31)
 *   and the audience is copied into `run.json`, so a later edit to a stored audience cannot
 *   restate a finished test.
 * - **The mode, as it actually ran.** `engine.mode` and `engine.modelMode` are the
 *   selection's answer and never the request's wish: no key means offline, a mode is never
 *   upgraded implicitly, and `standard` is refused rather than quietly downgraded (#143).
 * - **Progress a person can read**, one line per finished session, rendered from the
 *   artifact's own structured progress fields.
 * - **Stopping.** Ctrl-C ends the run on the sessions already written, and the directory it
 *   leaves still validates.
 *
 * What it decides nothing about: a session (that is `runSession`'s), how a session ended
 * (`decideOutcome`'s), and the run's counts, log and totals (`runSwarm`'s).
 */

/** What a run that never started records, and what the Test failed screen leads with. */
export class RunNotStartedError extends Error {
  readonly runId: string;
  readonly runDir: string;
  /** The artifact as it was written: status `failed`, its reason, and no session. */
  readonly run: Run;

  constructor(run: Run, runDir: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunNotStartedError';
    this.runId = run.runId;
    this.runDir = runDir;
    this.run = run;
  }
}

/**
 * A run that started, landed some sessions and then broke somewhere that is not a session:
 * a `run.json` that could not be written is a run nobody can read, so the swarm stops.
 *
 * It is told apart from the above because the sessions on disk are real: the run is closed
 * on what it kept and the directory still reads, and saying "nothing was simulated" about it
 * would be a lie with a run sitting next to it.
 */
export class RunStoppedError extends Error {
  readonly runId: string;
  readonly runDir: string;
  readonly run: Run;

  constructor(run: Run, runDir: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunStoppedError';
    this.runId = run.runId;
    this.runDir = runDir;
    this.run = run;
  }
}

/** Ctrl-C, carried out of the swarm by the one handler it awaits. Never seen by a caller. */
class RunInterrupted extends Error {
  constructor() {
    super('the run was stopped');
    this.name = 'RunInterrupted';
  }
}

export interface StartRunOptions {
  /** The directory run directories sit in — `./runs`, read from where the command was run. */
  readonly runsRoot: string;
  readonly request: RunRequest;
  /** Resolved and frozen by the caller: the platform from its store, the command from a preset or a file. */
  readonly audience: Audience;
  /** The task's declared steps, or `null` for the page as one step (see `./task.ts`). */
  readonly steps?: readonly TaskStep[] | null;
  readonly concurrency?: number;
  readonly sessionTimeoutMs?: number;
  /** Chromium over a URL by default; a test replays a committed capture set instead. */
  readonly source?: CaptureSource;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the Meta Model API provider; a test passes one of its own. */
  readonly createModelProvider?: CreateModelProvider;
  readonly now?: () => Date;
  /** Every line the run reports. It never carries a credential. */
  readonly report?: (line: string) => void;
  /** Whether to stop: read as each session starts and lands, so Ctrl-C keeps what is done. */
  readonly stopping?: () => boolean;
}

export interface StartedRun {
  readonly runId: string;
  readonly runDir: string;
  /** What ran, not what was asked for: the artifact records this. */
  readonly engineMode: RunRequest['engineMode'];
  /** The tier that ran, and absent where no model was called. */
  readonly modelMode?: ModelMode;
  /** The run as it now stands. */
  readonly run: Run;
  /** Whether it was stopped part way rather than running to the end. */
  readonly stopped: boolean;
}

/** The versions as the swarm walks them: the id a session records, and the URL it opens. */
const walkable = (variants: RunRequest['variants']): Variant[] =>
  variants.map((variant) => ({ id: variant.id, url: variant.url }));

/**
 * The seeds a run compares: the base seed, and one more per repeat.
 *
 * `repeats` is how many times each person walks each version, and a repeat is a *seed
 * group* — the same people on the same seeds against both versions, so the comparison is
 * never confounded by who was tested. Four people, three seeds and two versions are the
 * demo's twenty-four sessions.
 */
const seedGroupsOf = (request: RunRequest): number[] =>
  Array.from({ length: request.repeats }, (_unused, index) => request.seed + index);

export const startRun = async (options: StartRunOptions): Promise<StartedRun> => {
  const { request, audience } = options;
  const clock = options.now ?? ((): Date => new Date());
  const report = options.report ?? ((): void => undefined);
  const stopping = options.stopping ?? ((): boolean => false);

  // Nothing is written until the plan holds: the people, the seeds, the task and the
  // sessions they cross to. A plan nobody is in is not a run, and it is refused here rather
  // than discovered by the swarm with a run directory already on disk.
  const personas = generatePersonas(audience, { seed: request.seed });
  const seedGroups = seedGroupsOf(request);
  const task = taskFor(request, options.steps ?? null);
  const variants = walkable(request.variants);
  const plan = planSwarm({ variants, personas, seedGroups });
  if (plan.length === 0) {
    throw new Error(
      `this test plans no sessions (${personas.length} ${personas.length === 1 ? 'person' : 'people'}, ${seedGroups.length} seed groups, ${variants.length} versions), so there is no run to make`,
    );
  }

  const createdAt = clock();
  const runId = runDirName(createdAt, task.id);
  const runDir = join(options.runsRoot, runId);
  const record = {
    runId,
    createdAt,
    task,
    variants: [...request.variants],
    audience,
    personas,
    seedGroups,
  };
  const planned = {
    totalSessions: plan.length,
    perVariant: variants.map((variant) => ({
      variant: variant.id,
      totalSessions: plan.filter((session) => session.variant.id === variant.id).length,
    })),
  };

  /**
   * A run that could not start, recorded and handed back to the caller to report.
   *
   * The engine block is passed in rather than derived here, because what a failed run
   * records has to be the engine it was going to run on: the one that was *asked* for where
   * the selection itself refused, and the one that was *selected* where the run broke after
   * that. Deriving it from the request either way would record a model run that had already
   * resolved to offline.
   */
  const refuse = async (
    engine: Run['engine'],
    failure: RunFailure,
    cause: unknown,
  ): Promise<never> => {
    const run = failedRunRecord(openRunRecord({ ...record, engine }, planned), failure, clock());
    await writeRunRecord(runDir, run);
    throw new RunNotStartedError(run, runDir, failure.reason, { cause });
  };

  /**
   * The decision layer, or a run recorded as refused.
   *
   * The model this run was to run on could not be served, so nothing is simulated and no
   * other engine stands in for it (#144). The reason names the model; the detail is the
   * selection's own account of why, which never carries the key's value.
   */
  const selectOrRefuse = async (): Promise<SelectedEngine> => {
    try {
      return selectEngine({
        request,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.createModelProvider === undefined
          ? {}
          : { createModelProvider: options.createModelProvider }),
      });
    } catch (error) {
      if (!(error instanceof ModelModeUnavailableError)) throw error;
      return await refuse(
        requestedEngine(request),
        {
          reason:
            request.modelMode === undefined
              ? 'The model this test was to run on could not be used'
              : `The ${request.modelMode} model could not be used`,
          detail: error.message,
        },
        error,
      );
    }
  };
  const selected = await selectOrRefuse();

  const open = openRunRecord({ ...record, engine: selected.engine }, planned);
  await writeRunRecord(runDir, open);
  for (const line of openingLines(open)) report(line);
  report(`  ${selected.reason}`);

  const onProgress = async (event: SwarmProgress): Promise<void> => {
    if (event.kind === 'session-finished') {
      // Read back rather than composed from the event: the sentence a person reads is
      // rendered from the artifact's own progress entry, so the terminal and the Running
      // screen are two renderings of one record and not two accounts of one event.
      const run = await readRunRecord(runDir);
      const entry = run.progress?.sessions.find((landed) => landed.sessionId === event.sessionId);
      report(
        entry === undefined
          ? finishedPhrase(event.finishedSessions, event.totalSessions)
          : reportLine(run, entry),
      );
    }
    if (stopping()) throw new RunInterrupted();
  };

  const plannedOrder = plan.map((session) => session.sessionId);
  let run: Run;
  let stopped = false;
  try {
    const finished = await runSwarm({
      runDir,
      variants,
      personas,
      seedGroups,
      task,
      source: options.source ?? createLiveSource(),
      providers: { decision: selected.provider },
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.sessionTimeoutMs === undefined
        ? {}
        : { sessionTimeoutMs: options.sessionTimeoutMs }),
      now: clock,
      onProgress,
    });
    run = finished.run;
  } catch (error) {
    if (error instanceof RunInterrupted) {
      // Stopped on purpose: the sessions already written are kept and the run ends on them,
      // rather than staying open for ever with nothing driving it.
      run = await closeStoppedRun(runDir, plannedOrder, clock());
      stopped = true;
    } else {
      // Whether anything landed decides what this is, so a run that cannot even be read is
      // neither: it is handed on as the failure it is rather than overwritten with a record
      // that might sweep the sessions beside it.
      const landed = await readRunRecord(runDir).catch(() => null);
      if (landed === null) throw error;
      const finishedSessions = landed.progress?.finishedSessions ?? 0;
      if (finishedSessions === 0) {
        await refuse(
          selected.engine,
          { reason: 'The test could not be started', detail: (error as Error).message },
          error,
        );
      }
      run = await closeStoppedRun(runDir, plannedOrder, clock());
      throw new RunStoppedError(
        run,
        runDir,
        `the run stopped after ${String(finishedSessions)} of ${String(landed.progress?.totalSessions ?? 0)} sessions: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  for (const line of closingLines(run, clock().getTime())) report(line);
  return {
    runId,
    runDir,
    engineMode: run.engine.mode,
    ...(selected.modelMode === undefined ? {} : { modelMode: selected.modelMode }),
    run,
    stopped,
  };
};
