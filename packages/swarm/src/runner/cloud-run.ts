/**
 * One session, as one Cloud Run job execution.
 *
 * It is the second implementation of the runner seam and it makes the same promise the first
 * one does: **a session is a session wherever it runs.** The same persona, the same seed, the
 * same task and the same written session file, so a run driven here reads back through
 * `@personavision/contract` identically to a local run of the same seeds. What differs is
 * where the work happened and what can go wrong on the way to it.
 *
 * - **The Jobs API is reached only through the injected transport** (`jobs.ts`). Nothing here
 *   fetches, and nothing here knows how the transport is authorised.
 * - **A failed execution is a typed automation failure, not a lost run.** A task that died, a
 *   quota refusal, an image that will not start and an execution that left no session behind
 *   are each read by `failures.ts`, recorded as that one session's outcome with what was
 *   asked and what was answered, counted in the run's automation-failure total, and the other
 *   ninety-nine sessions carry on.
 * - **Nothing runs for ever.** The session's own wall-clock cap is passed to the task *and*
 *   held here, over both halves of a remote session: the execution, and the collection of what
 *   it wrote. Either one still going at the cap is given up on — the execution **cancelled**,
 *   by name — and reported, never waited on, and `landsLate` is always `null` because there is
 *   nothing left to land. The coordinator's clock starts when the execution is **created** and
 *   the task's own timeout starts when it begins **running**, so the wait held here is the
 *   session's cap plus what an execution is allowed for being scheduled and pulling the image
 *   plus a write-up grace — otherwise the coordinator would always be the first clock to fire,
 *   and a cold run of a hundred sessions would cancel every one of them before it started.
 * - **The output comes back through the object store** (#316), which is why a remote run
 *   without a bucket is refused before any execution is created (`choose.ts`): a Cloud Run
 *   task cannot write to the owner's disk, so a run with nowhere to put a session is a run
 *   that would launch a hundred executions and collect none of them.
 */

import { readFile } from 'node:fs/promises';
import { runPaths, sessionSchema, ZERO_USAGE } from '@personavision/contract';
import { readBreakage, remoteFailure } from './failures.js';
import { brokenSession, FAILED_BEFORE_A_STEP } from './session.js';
import { readContributions, sessionTaskEnvironment, taskArgs } from './session-task.js';
import { JobsRefused } from './jobs.js';
import { EXPIRED, withinTimeout } from './within.js';
import type { Session } from '@personavision/contract';
import type { ProviderMode } from '@personavision/provider';
import type { AutomationFailure } from '../outcome.js';
import type { Answered, Asked } from './failures.js';
import type { JobExecution, JobRunRequest, JobsTransport } from './jobs.js';
import type { SessionContributions } from './session-task.js';
import type { SessionRunner, WalkedSession } from './types.js';

/** What a remote run is pointed at. Every field comes from the environment (`choose.ts`). */
export interface CloudRunRunnerConfig {
  readonly project: string;
  readonly region: string;
  /** The job's short name; the resource name is built from it with the project and region. */
  readonly job: string;
  /**
   * The image the job runs, **tag included**, as `docs/deployment.md`'s build command tagged
   * it. It is recorded on the run so a remote run can be told which code drove it, and it is
   * named in every failure sentence, because "which image" is the first question an execution
   * that would not start raises.
   */
  readonly image: string;
  /** The bucket a task's output comes back through (#316). Never written into an artifact. */
  readonly videoBucket: string;
  /** The engine mode the run records, passed on so the task selects the same provider. */
  readonly engineMode: ProviderMode;
  /**
   * How long an execution may take to be scheduled, pull the image and start before the wait
   * begins to count against the session (`choose.ts`, `PV_RUNNER_START_ALLOWANCE_MS`).
   *
   * The two clocks start at different moments: the task's own timeout starts when the task
   * begins running, and this coordinator's starts when the execution is created. Without an
   * allowance the coordinator's deadline is always the earlier of the two, by the whole of the
   * provisioning time, so a cold run would cancel every session before its task started.
   */
  readonly startAllowanceMs: number;
}

export interface CloudRunRunnerDeps {
  readonly transport: JobsTransport;
  /**
   * How a finished task's own file is read back. The default reads it out of the run
   * directory, which is where the object store of #316 lands what the task uploaded.
   */
  readonly collect?: (
    runDir: string,
    sessionId: string,
  ) => Promise<{ session: Session; contributions: SessionContributions }>;
}

/** `projects/<project>/locations/<region>/jobs/<job>`, which is what the API is addressed by. */
export const jobResourceName = ({ project, region, job }: CloudRunRunnerConfig): string =>
  `projects/${project}/locations/${region}/jobs/${job}`;

/** The whole of one session's request, so that a test can assert on what was asked for. */
export const jobRunRequestFor = (
  config: CloudRunRunnerConfig,
  request: Parameters<SessionRunner>[0],
): JobRunRequest => ({
  job: jobResourceName(config),
  args: taskArgs(request.runId, request.sessionId),
  env: sessionTaskEnvironment(request, {
    videoBucket: config.videoBucket,
    engineMode: config.engineMode,
  }),
  taskTimeoutMs: request.timeoutMs,
});

const collectFromRunDirectory = async (
  runDir: string,
  sessionId: string,
): Promise<{ session: Session; contributions: SessionContributions }> => ({
  session: sessionSchema.parse(
    JSON.parse(await readFile(runPaths(runDir).session(sessionId), 'utf8')),
  ),
  contributions: await readContributions(runDir, sessionId),
});

const asAnswered = (error: unknown): Answered =>
  error instanceof JobsRefused
    ? { status: error.status, said: error.said }
    : { status: '', said: error instanceof Error ? error.message : String(error) };

/**
 * The grace a session gets to write itself up after its own cap has fired, which is the local
 * runner's own figure and is here for the same reason: a cap that fires while a session is
 * writing costs a record that exists.
 */
const WRITE_UP_GRACE_MS = 1_000;

/** A session that produced nothing produced nothing: no cost, no areas, no screens. */
const nothing = (
  request: Parameters<SessionRunner>[0],
  failure: AutomationFailure,
  elapsedMs = 0,
): WalkedSession => ({
  session: brokenSession(request, failure),
  usage: { ...ZERO_USAGE },
  aois: [],
  screenshots: [],
  elapsedMs,
  landsLate: null,
});

export const createCloudRunRunner = (
  config: CloudRunRunnerConfig,
  { transport, collect = collectFromRunDirectory }: CloudRunRunnerDeps,
): SessionRunner => {
  const asked = (sessionId: string): Asked => ({
    job: jobResourceName(config),
    image: config.image,
    sessionId,
  });

  return async (request) => {
    const mine = asked(request.sessionId);
    /** Our own breakage, read from what the API answered, as the one session it cost. */
    const broke = (answered: Answered, elapsedMs = 0): WalkedSession =>
      nothing(
        request,
        remoteFailure(readBreakage(answered), mine, answered, FAILED_BEFORE_A_STEP),
        elapsedMs,
      );

    let execution: JobExecution;
    try {
      execution = await transport.start(jobRunRequestFor(config, request));
    } catch (error) {
      // Nothing was created, so there is nothing to cancel and nothing to collect.
      return broke(asAnswered(error));
    }

    const startedMs = Date.now();
    const since = (): number => Math.max(0, Date.now() - startedMs);
    /**
     * The session's own cap, plus what the execution is allowed for getting itself started and
     * a grace for writing itself up — so this is never the clock that fires first on a session
     * that is still working. The same reasoning the local runner's race uses, with one term
     * more, because a container has to exist before it can be slow.
     */
    const waitMs = request.timeoutMs + config.startAllowanceMs + WRITE_UP_GRACE_MS;
    const stop = new AbortController();
    const cap = setTimeout(() => stop.abort(), waitMs);
    // Unreferenced, so a hundred sessions' caps do not hold the process open by themselves.
    cap.unref?.();
    try {
      const result = await transport.settle(execution, { signal: stop.signal });
      if (result.kind === 'failed') return broke(result, since());
    } catch (error) {
      // The cap won, or the API stopped answering. Either way nobody is waiting any more, so
      // the execution is cancelled rather than left running against the site.
      await transport.cancel(execution).catch(() => undefined);
      if (!stop.signal.aborted) return broke(asAnswered(error), since());
      return nothing(
        request,
        remoteFailure(
          'past_the_cap',
          mine,
          {
            status: 'CANCELLED',
            said: `${execution.name} was still running after the ${String(waitMs / 1000)} s this session had, and was cancelled`,
          },
          FAILED_BEFORE_A_STEP,
        ),
        since(),
      );
    } finally {
      clearTimeout(cap);
    }

    // The execution succeeded, so the task wrote a session and its contributions. A reply
    // this cannot read is our breakage and costs this one session: the alternative is a
    // malformed area of interest reaching `run.json`'s own write, which stops the swarm.
    //
    // Capped too, and with what is left of the session's own cap rather than a fresh one: the
    // default collector is a file read and cannot hang, but the store this seam exists for is
    // a download, and "nothing runs for ever" is about the session and not about the execution.
    try {
      const collected = await withinTimeout(
        collect(request.runDir, request.sessionId),
        Math.max(1, waitMs - since()),
      );
      if (collected === EXPIRED) {
        return nothing(
          request,
          remoteFailure(
            'nothing_landed',
            mine,
            {
              status: 'CANCELLED',
              said: `${execution.name} finished and its session had still not come back after the ${String(waitMs / 1000)} s this session had`,
            },
            FAILED_BEFORE_A_STEP,
          ),
          since(),
        );
      }
      const { session, contributions } = collected;
      return {
        session,
        usage: contributions.usage,
        aois: contributions.aois,
        screenshots: contributions.screenshots,
        elapsedMs: contributions.elapsedMs,
        landsLate: null,
      };
    } catch (error) {
      return nothing(
        request,
        remoteFailure('nothing_landed', mine, asAnswered(error), FAILED_BEFORE_A_STEP),
        since(),
      );
    }
  };
};
