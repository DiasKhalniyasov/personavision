/**
 * **The one place where a runner is chosen**, from one variable.
 *
 * `PV_RUNNER` unset, empty or `local` means the swarm's own pool: a session in this process,
 * ten at a time, which is the default everywhere — every existing test, the acceptance suite
 * and the demo run on it, and nothing in them reaches for a cloud client.
 * `PV_RUNNER=cloud-run` means one Cloud Run job execution per session.
 *
 * Nothing downstream of this function branches on the choice. The swarm takes a
 * `SessionRunner` and holds it; the screens, the artifact and the scores cannot tell which
 * one ran, because a session is a session wherever it runs. The one fact that is recorded is
 * the record itself — `run.json`'s `runner` block, which says where the sessions ran and
 * which image drove them.
 *
 * **A remote run with nowhere to put its output is refused here**, before any execution is
 * created. A Cloud Run task cannot write to the owner's disk, so a remote session's session
 * file, its contributions and its video come back through the object store of #316, selected
 * by `PV_VIDEO_BUCKET`. A run without one would launch a hundred executions and collect none
 * of them, so it is refused with that reason instead of attempted.
 */

import { createCloudRunJobsTransport } from './jobs.js';
import { createCloudRunRunner } from './cloud-run.js';
import type { ProviderMode } from '@personavision/provider';
import type { JobsTransport } from './jobs.js';
import type { SessionRunner } from './types.js';

/** The variables that choose and configure a runner. Not one of them is a credential. */
export const RUNNER_ENV = {
  /** `local` (the default) or `cloud-run`. */
  runner: 'PV_RUNNER',
  project: 'PV_GCP_PROJECT',
  region: 'PV_GCP_REGION',
  /**
   * **Our own ceiling on sessions in flight, and never a per-site cap.**
   *
   * It is **read by `@personavision/platform`** and not here: that package computes the
   * concurrency a run is started at, quotes the estimate from the same figure
   * (`sessionsInFlight`), and hands the number to the swarm, which holds whatever bound it is
   * given. It is listed here because it is one of the variables a remote deployment sets, and
   * because the name must be spelt the same in both places. A run driven from
   * `personavision run` takes its bound from `--concurrency` instead, which is that command's
   * own flag.
   *
   * The three caps — a hundred agents a run, ten browsers at a time per site, four runs an
   * hour per site — are about the site being driven and do not read it.
   */
  concurrency: 'PV_RUNNER_CONCURRENCY',
  /** The job's short name. The resource name is built from it with the project and region. */
  job: 'PV_RUNNER_JOB',
  /** The image the job runs, **tag included**, which is recorded on the run. */
  image: 'PV_RUNNER_IMAGE',
  /** Where a remote session's output comes back through (#316). */
  videoBucket: 'PV_VIDEO_BUCKET',
  /**
   * How long an execution may take to be **scheduled, pull the image and start** before the
   * wait begins to count against the session, in milliseconds.
   *
   * It exists because the two clocks start at different moments: Cloud Run's own task timeout
   * starts when the task begins running, and the coordinator's starts when the execution is
   * created. Without an allowance the coordinator's deadline is always the earlier of the two
   * by the whole of the provisioning time — and a first pull of an image carrying Chromium
   * takes longer than a session's whole budget, so every session of a cold remote run would be
   * cancelled before its task started and recorded as having passed its cap without running.
   *
   * Optional; `DEFAULT_START_ALLOWANCE_MS` when unset.
   */
  startAllowance: 'PV_RUNNER_START_ALLOWANCE_MS',
} as const;

/** The job's name when the deployment did not rename it. `docs/deployment.md` creates it. */
export const DEFAULT_JOB = 'personavision-session-runner';

/**
 * Five minutes for an execution to be scheduled and to pull the image, before the wait counts
 * against the session. Generous on purpose: the cost of too much is that a genuinely hung
 * execution is cancelled later than it could have been, and the cost of too little is a cold
 * run of a hundred sessions none of which ran. `PV_RUNNER_START_ALLOWANCE_MS` moves it.
 */
export const DEFAULT_START_ALLOWANCE_MS = 5 * 60_000;

/** Where this run's sessions run, as `run.json`'s `runner` block records it. */
export type RunnerWhere = 'local' | 'cloud-run';

export interface ChosenRunner {
  readonly where: RunnerWhere;
  /**
   * The runner to hand the swarm, or `null` for local — which is the swarm's own pool and is
   * not this module's to build.
   */
  readonly runner: SessionRunner | null;
  /** The image a remote run is driven by, tag included; `null` for a local run. */
  readonly image: string | null;
  /**
   * What an execution is allowed for being scheduled and pulling the image before the wait
   * counts against the session, in milliseconds; `null` for a local run, which starts nothing.
   */
  readonly startAllowanceMs: number | null;
}

/** Thrown for an environment that asks for a remote run it could not possibly finish. */
export class RunnerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerNotConfiguredError';
  }
}

const read = (env: Readonly<Record<string, string | undefined>>, key: string): string =>
  env[key]?.trim() ?? '';

export const chooseRunner = (
  {
    env = process.env,
    engineMode,
  }: { env?: Readonly<Record<string, string | undefined>>; engineMode: ProviderMode },
  /** A transport of its own, for a test and for a coordinator that is authorised its own way. */
  transport?: JobsTransport,
): ChosenRunner => {
  const chosen = read(env, RUNNER_ENV.runner);
  if (chosen === '' || chosen === 'local') {
    return { where: 'local', runner: null, image: null, startAllowanceMs: null };
  }
  if (chosen !== 'cloud-run') {
    throw new RunnerNotConfiguredError(
      `${RUNNER_ENV.runner} is "${chosen}"; it names where sessions run and the two it may name are "local" and "cloud-run"`,
    );
  }

  const missing = (
    [
      [RUNNER_ENV.project, 'the Google Cloud project the job lives in'],
      [RUNNER_ENV.region, 'the region the job lives in'],
      [
        RUNNER_ENV.image,
        'the image the job runs, tag included, so the run can record which code drove it',
      ],
    ] as const
  ).filter(([key]) => read(env, key) === '');
  if (missing.length > 0) {
    throw new RunnerNotConfiguredError(
      `${RUNNER_ENV.runner} asks for a Cloud Run job execution per session, and ${missing
        .map(([key, why]) => `${key} (${why})`)
        .join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
    );
  }

  // The refusal this ticket exists to make before anything is created: a task cannot write to
  // the owner's disk, so a remote run whose output has nowhere to come back through is a run
  // of a hundred executions nobody can collect.
  const videoBucket = read(env, RUNNER_ENV.videoBucket);
  if (videoBucket === '') {
    throw new RunnerNotConfiguredError(
      `${RUNNER_ENV.runner} asks for a Cloud Run job execution per session, and ${RUNNER_ENV.videoBucket} is not set: a task cannot write to this machine's disk, so a remote session's output comes back through the object store — a run with none would launch every execution and collect no session, so it is refused rather than attempted`,
    );
  }

  const region = read(env, RUNNER_ENV.region);
  const named = read(env, RUNNER_ENV.job);
  const allowance = Number(read(env, RUNNER_ENV.startAllowance));
  const config = {
    project: read(env, RUNNER_ENV.project),
    region,
    job: named === '' ? DEFAULT_JOB : named,
    image: read(env, RUNNER_ENV.image),
    videoBucket,
    engineMode,
    startAllowanceMs:
      read(env, RUNNER_ENV.startAllowance) !== '' && Number.isFinite(allowance) && allowance >= 0
        ? allowance
        : DEFAULT_START_ALLOWANCE_MS,
  };
  return {
    where: 'cloud-run',
    image: config.image,
    startAllowanceMs: config.startAllowanceMs,
    runner: createCloudRunRunner(config, {
      // Built only when no transport was given, so a test that passes its own never reaches
      // the one function in this package that opens a socket.
      transport: transport ?? createCloudRunJobsTransport({ region }),
    }),
  };
};
