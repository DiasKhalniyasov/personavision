/**
 * The runner seam, and the second implementation of it: a session as a Cloud Run job
 * execution.
 *
 * Every test here runs against a **fake Jobs transport**. Nothing opens a socket, nothing
 * reads a credential and no cloud client is constructed — the default transport is built only
 * when none is given, and the tests below always give one. The fake does the one thing a real
 * job execution does: it runs `runSessionTask`, the function the container's entry point
 * calls, in this process, against the committed capture set. So what is exercised is the
 * whole of this side of the container boundary, the per-session environment included — the
 * fake reads the session it is to run out of the environment the coordinator sent it, exactly
 * as the image does.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import { createFixtureSource } from '@personavision/browser';
import { readRun, runPaths, runSchema, validate } from '@personavision/contract';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseRunner,
  contributionsPath,
  createCloudRunJobsTransport,
  createCloudRunRunner,
  JobsRefused,
  readSessionTaskEnvironment,
  RunnerNotConfiguredError,
  runSessionTask,
  runSwarm,
  TASK_ENV,
} from '../src/index.js';
import {
  MOBILE,
  oneDeviceCaptureSet,
  peopleOnMobile,
  runVariant,
  sweep,
  TASK,
  temporaryRunDir,
  withNothingRunning,
  writeOpenRun,
} from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run, Session } from '@personavision/contract';
import type {
  JobExecutionResult,
  JobRunRequest,
  JobsTransport,
  RunSwarmInput,
} from '../src/index.js';

const VARIANTS: ReadonlyArray<Run['variants'][number]> = [runVariant('A'), runVariant('B')];
const SEEDS = [11];
const NOON = '2026-10-27T12:00:00.000Z';

/** The image a remote run is driven by, tag included, as the build command tags it. */
const IMAGE = 'europe-west1-docker.pkg.dev/pv-test/personavision/session-runner:abc1234';

/** The environment that asks for one Cloud Run job execution per session. */
const CLOUD_RUN: Readonly<Record<string, string>> = {
  PV_RUNNER: 'cloud-run',
  PV_GCP_PROJECT: 'pv-test',
  PV_GCP_REGION: 'europe-west1',
  PV_RUNNER_IMAGE: IMAGE,
  PV_VIDEO_BUCKET: 'pv-test-session-videos',
};

const JOB = 'projects/pv-test/locations/europe-west1/jobs/personavision-session-runner';

/** The same environment with no bucket in it, which is the one a remote run is refused for. */
const withNoBucket = (): Record<string, string> =>
  Object.fromEntries(Object.entries(CLOUD_RUN).filter(([named]) => named !== 'PV_VIDEO_BUCKET'));

/**
 * How long the hundred-session test is given before it is called hung. Sixty seconds, for the
 * reason `run-swarm.test.ts` gives for its own cap and one step further: this test runs the
 * hundred twice, once through the seam and once locally, so that the two can be compared.
 */
const TWO_HUNDRED_SESSIONS_TIMEOUT_MS = 60_000;

let runDir: string;
let localDir: string;
let captures: string;
let source: CaptureSource;

beforeEach(async () => {
  runDir = await temporaryRunDir();
  localDir = await temporaryRunDir();
  captures = await oneDeviceCaptureSet();
  source = createFixtureSource(captures);
});

afterEach(async () => {
  await sweep(runDir);
  await sweep(localDir);
  await sweep(captures);
});

/** What a fake execution does instead of succeeding. */
type Behaviour =
  | { readonly kind: 'runs' }
  | { readonly kind: 'refused'; readonly status: string; readonly said: string }
  | { readonly kind: 'ended'; readonly result: Extract<JobExecutionResult, { kind: 'failed' }> }
  | { readonly kind: 'never_ends' };

const RUNS: Behaviour = { kind: 'runs' };

interface FakeJobs {
  readonly transport: JobsTransport;
  /** Every request the coordinator made, in the order it made them. */
  readonly started: JobRunRequest[];
  /** Every execution it cancelled, by name. */
  readonly cancelled: string[];
}

/**
 * The Jobs API as a fake: it records what it was asked for, and for an execution that is to
 * succeed it **runs the real task function** on the environment it was handed.
 *
 * The session is started in `start` and awaited in `settle`, which is the order a real
 * execution happens in — so the swarm's pool is what bounds how many sessions are in flight,
 * exactly as it is for a local run.
 */
const fakeJobs = (
  decide: (request: JobRunRequest) => Behaviour = () => RUNS,
  { collectInto = (): string => runDir }: { collectInto?: () => string } = {},
): FakeJobs => {
  const started: JobRunRequest[] = [];
  const cancelled: string[] = [];
  const running = new Map<string, Promise<void>>();
  /** Which session each execution is, so that `settle` answers about the right one. */
  const asked = new Map<string, JobRunRequest>();
  let next = 0;

  return {
    started,
    cancelled,
    transport: {
      start: async (request) => {
        started.push(request);
        const behaviour = decide(request);
        if (behaviour.kind === 'refused') {
          throw new JobsRefused(behaviour.status, behaviour.said);
        }
        next += 1;
        const name = `${request.job}/executions/exec-${String(next).padStart(3, '0')}`;
        asked.set(name, request);
        if (behaviour.kind === 'runs') {
          // The container's own work, in this process: the environment in, a session file and
          // its run contributions out. The capture source and the provider are what a task
          // builds for itself at the far end.
          running.set(
            name,
            runSessionTask(
              readSessionTaskEnvironment(request.env, {
                runDir: collectInto(),
                source,
                providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
              }),
            ),
          );
        }
        if (behaviour.kind === 'ended') running.set(name, Promise.resolve());
        return Promise.resolve({ name });
      },
      settle: async (execution, { signal }) => {
        const behaviour = decide(asked.get(execution.name) as JobRunRequest);
        if (behaviour.kind === 'never_ends') {
          await new Promise<void>((settle) => {
            signal.addEventListener('abort', () => settle());
          });
          throw new JobsRefused('ABORTED', 'nobody is waiting for this execution any more');
        }
        await running.get(execution.name);
        if (behaviour.kind === 'ended') return behaviour.result;
        return { kind: 'succeeded' };
      },
      cancel: (execution) => {
        cancelled.push(execution.name);
        return Promise.resolve();
      },
    },
  };
};

const swarmOver = (over: Partial<RunSwarmInput>, people: readonly Persona[]): RunSwarmInput => ({
  runDir,
  variants: VARIANTS,
  personas: people,
  seedGroups: SEEDS,
  task: TASK,
  source,
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  concurrency: 10,
  now: () => new Date(NOON),
  ...over,
});

/**
 * A session as a reader of the committed artifact sees it, with the one field a wall clock
 * writes taken out.
 *
 * `durationMs` is how long the walk really took and is the only field that cannot be the same
 * in two runs of the same seeds — everything else, the screens, the fixations, the saccades,
 * the actions and the outcome, is arithmetic over the capture set and the seed. So it is
 * zeroed and the rest is compared field for field: that is what "reads back identically"
 * means for a run driven somewhere else.
 */
const comparable = (session: Session): Session => ({ ...session, durationMs: 0 });

const landed = async (dir: string): Promise<string[]> =>
  (await readdir(runPaths(dir).sessionsDir)).sort();

describe('the runner seam, chosen by one variable', () => {
  it('is the swarm’s own pool when PV_RUNNER is unset, and reaches for no cloud client', () => {
    expect(chooseRunner({ env: {}, engineMode: 'offline' })).toEqual({
      where: 'local',
      runner: null,
      image: null,
    });
    expect(chooseRunner({ env: { PV_RUNNER: '' }, engineMode: 'offline' }).where).toBe('local');
    expect(chooseRunner({ env: { PV_RUNNER: 'local' }, engineMode: 'offline' }).where).toBe(
      'local',
    );
  });

  it('refuses a name it does not implement rather than falling back to local', () => {
    expect(() => chooseRunner({ env: { PV_RUNNER: 'kubernetes' }, engineMode: 'offline' })).toThrow(
      RunnerNotConfiguredError,
    );
  });

  it('refuses a remote run with no video bucket, naming that reason', () => {
    const withoutBucket = withNoBucket();
    let thrown: unknown;
    try {
      chooseRunner({ env: withoutBucket, engineMode: 'offline' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunnerNotConfiguredError);
    expect((thrown as Error).message).toContain('PV_VIDEO_BUCKET');
    expect((thrown as Error).message).toContain('object store');
  });

  it('names every variable a remote run needs before it creates anything', () => {
    for (const missing of ['PV_GCP_PROJECT', 'PV_GCP_REGION', 'PV_RUNNER_IMAGE']) {
      const env = { ...CLOUD_RUN, [missing]: '' };
      expect(() => chooseRunner({ env, engineMode: 'offline' })).toThrow(missing);
    }
  });

  it('creates no execution at all for a run it refuses', async () => {
    await writeOpenRun(runDir, {
      personas: peopleOnMobile(2),
      variants: VARIANTS,
      seedGroups: SEEDS,
    });
    const jobs = fakeJobs();
    const withoutBucket = withNoBucket();

    await expect(
      runSwarm(swarmOver({ env: withoutBucket, jobsTransport: jobs.transport }, peopleOnMobile(2))),
    ).rejects.toThrow(RunnerNotConfiguredError);

    expect(jobs.started).toEqual([]);
    // And the run it refused is still the open run its caller wrote.
    const run = runSchema.parse(JSON.parse(await readFile(runPaths(runDir).run, 'utf8')));
    expect(run.status).toBe('open');
    expect(run.sessionIds).toEqual([]);
  });
});

describe('a session as a Cloud Run job execution', () => {
  it('asks for the job, the arguments and the environment one session needs', async () => {
    const people = peopleOnMobile(2);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    const jobs = fakeJobs();

    const { sessions } = await withNothingRunning(() =>
      runSwarm(swarmOver({ env: CLOUD_RUN, jobsTransport: jobs.transport }, people)),
    );

    expect(sessions).toHaveLength(4);
    expect(jobs.started).toHaveLength(4);

    // The job, by the resource name the API is addressed by — built from the project and the
    // region, with the default job name, because the environment named none.
    expect(new Set(jobs.started.map((request) => request.job))).toEqual(new Set([JOB]));

    const first = jobs.started[0] as JobRunRequest;
    // The arguments: what to do, and which session of which run to do it for.
    expect(first.args).toEqual([
      'run-session',
      '--run',
      '2026-10-27-1200-fixture',
      '--session',
      'S-01',
    ]);
    // The session's own cap travels as the execution's own timeout, so a task is not waited
    // on by one clock and killed by another.
    expect(first.taskTimeoutMs).toBeGreaterThan(0);

    // The environment: this session, this person, this seed, this variant — and the bucket its
    // output comes back through.
    expect(first.env[TASK_ENV.sessionId]).toBe('S-01');
    expect(first.env[TASK_ENV.runId]).toBe('2026-10-27-1200-fixture');
    expect(first.env[TASK_ENV.seed]).toBe('11');
    expect(JSON.parse(first.env[TASK_ENV.variant] as string)).toMatchObject({ id: 'A' });
    expect(JSON.parse(first.env[TASK_ENV.persona] as string)).toMatchObject({
      id: (people[0] as Persona).id,
    });
    expect(JSON.parse(first.env[TASK_ENV.task] as string)).toMatchObject({ id: TASK.id });
    expect(first.env[TASK_ENV.videoBucket]).toBe(CLOUD_RUN.PV_VIDEO_BUCKET);
    expect(first.env[TASK_ENV.startedAt]).toBe(NOON);
    // A task never chooses a runner again: one that read `cloud-run` would start a job
    // execution for the session it was itself started to run.
    expect(first.env[TASK_ENV.runner]).toBe('local');

    // Every session asked for is a session of the plan, each exactly once, with its own person.
    expect(jobs.started.map((request) => request.env[TASK_ENV.sessionId])).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
    ]);
    // And no request carries anything key-, token-, secret- or credential-shaped.
    const everything = JSON.stringify(jobs.started);
    expect(everything).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
  });

  it('records where the sessions ran, the image that drove them and our own ceiling', async () => {
    const people = peopleOnMobile(2);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    const jobs = fakeJobs();

    const { run } = await withNothingRunning(() =>
      runSwarm(
        swarmOver({ env: CLOUD_RUN, jobsTransport: jobs.transport, concurrency: 7 }, people),
      ),
    );

    expect(run.runner).toEqual({ where: 'cloud-run', image: IMAGE, concurrency: 7 });
    // On the record before the first session landed, not only at the end: a reader of an open
    // run can already tell which code is driving it.
    expect(await validate(runDir)).toEqual([]);
  });

  it('records a local run as local, with no image', async () => {
    const people = peopleOnMobile(2);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });

    const { run } = await withNothingRunning(() =>
      runSwarm(swarmOver({ env: {}, concurrency: 3 }, people)),
    );

    expect(run.runner).toEqual({ where: 'local', image: null, concurrency: 3 });
  });

  it(
    'walks a hundred sessions as executions, written as they land, and reads back identically to a local run of the same seeds',
    async () => {
      const people = peopleOnMobile(50);
      await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
      const jobs = fakeJobs();
      const landedWhileOpen: number[] = [];

      const remote = await withNothingRunning(() =>
        runSwarm(
          swarmOver(
            {
              env: CLOUD_RUN,
              jobsTransport: jobs.transport,
              onProgress: async (event) => {
                if (event.kind !== 'session-finished') return;
                // Read from inside the run's own turn at `run.json`, which is the one moment
                // a reader is promised the file as this session left it.
                const open = runSchema.parse(
                  JSON.parse(await readFile(runPaths(runDir).run, 'utf8')),
                );
                expect(open.status).toBe('open');
                expect(open.progress?.finishedSessions).toBe(event.finishedSessions);
                expect(open.sessionIds).toContain(event.sessionId);
                landedWhileOpen.push(event.finishedSessions);
              },
            },
            people,
          ),
        ),
      );

      // A hundred executions, one per session, and a hundred session files.
      expect(jobs.started).toHaveLength(100);
      expect(remote.sessions).toHaveLength(100);
      expect(remote.run.status).toBe('finished');
      expect(await landed(runDir)).toHaveLength(100);
      expect(landedWhileOpen).toEqual(Array.from({ length: 100 }, (_unused, at) => at + 1));
      // The directory a reader is handed still validates, dot-directory of contributions and
      // all: the contributions are not in `sessions/`, where every `.json` is read as one.
      expect(await validate(runDir)).toEqual([]);
      expect(await readFile(contributionsPath(runDir, 'S-01'), 'utf8')).toContain('"aois"');

      // The same hundred, locally, with nothing about the cloud in the environment.
      const localPeople = people;
      await writeOpenRun(localDir, {
        personas: localPeople,
        variants: VARIANTS,
        seedGroups: SEEDS,
      });
      await withNothingRunning(() =>
        runSwarm(swarmOver({ runDir: localDir, env: {} }, localPeople)),
      );

      // Read back through the contract rather than off the returned values: what is promised
      // is that the *artifact* is the same.
      const [readRemote, readLocal] = await Promise.all([readRun(runDir), readRun(localDir)]);
      expect(readRemote.sessions.map(comparable)).toEqual(readLocal.sessions.map(comparable));
      expect(readRemote.run.sessionIds).toEqual(readLocal.run.sessionIds);
      expect(readRemote.run.progress?.perVariant).toEqual(readLocal.run.progress?.perVariant);
      expect(readRemote.run.usage).toEqual(readLocal.run.usage);
      expect(readRemote.run.aois).toEqual(readLocal.run.aois);
      expect(readRemote.run.screenshots).toEqual(readLocal.run.screenshots);
      // The one field that is deliberately different, and the only one.
      expect(readRemote.run.runner).toEqual({ where: 'cloud-run', image: IMAGE, concurrency: 10 });
      expect(readLocal.run.runner).toEqual({ where: 'local', image: null, concurrency: 10 });
    },
    TWO_HUNDRED_SESSIONS_TIMEOUT_MS,
  );
});

describe('an execution that goes wrong costs one session', () => {
  /** The three things that go wrong with an execution, and how the API says each of them. */
  const BREAKAGES = [
    {
      what: 'a task that died',
      behaviour: {
        kind: 'ended' as const,
        result: {
          kind: 'failed' as const,
          status: 'TaskFailed',
          said: 'the container exited with code 137',
        },
      },
      says: ['the task did not finish', 'exited with code 137'],
    },
    {
      what: 'a quota refusal',
      behaviour: {
        kind: 'refused' as const,
        status: 'RESOURCE_EXHAUSTED',
        said: 'Quota exceeded for quota metric "Job executions" ',
      },
      says: ['refused on quota', 'RESOURCE_EXHAUSTED'],
    },
    {
      what: 'an image that will not start',
      behaviour: {
        kind: 'ended' as const,
        result: {
          kind: 'failed' as const,
          status: 'ContainerStartFailed',
          said: `Image '${IMAGE}' not found`,
        },
      },
      says: ['the image would not start', IMAGE],
    },
  ];

  for (const { what, behaviour, says } of BREAKAGES) {
    it(`records ${what} as that session’s typed automation failure and runs the rest`, async () => {
      const people = peopleOnMobile(2);
      await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
      // Exactly one session breaks; the other three run.
      const jobs = fakeJobs((request) =>
        request.env[TASK_ENV.sessionId] === 'S-02' ? behaviour : RUNS,
      );

      const { run, sessions } = await withNothingRunning(() =>
        runSwarm(swarmOver({ env: CLOUD_RUN, jobsTransport: jobs.transport }, people)),
      );

      expect(sessions).toHaveLength(4);
      const broke = sessions.find((session) => session.sessionId === 'S-02') as Session;
      // Typed, from the existing vocabulary — no sixth word in `docs/FLOW.md` section 8's list.
      expect(broke.outcome.status).toBe('automation_failure');
      expect(broke.outcome.attribution).toBe('automation');
      expect(broke.outcome.excludedFromScores).toBe(true);
      // Carrying what was asked and what was answered.
      expect(broke.outcome.reason).toContain(JOB);
      expect(broke.outcome.reason).toContain('S-02');
      for (const said of says) expect(broke.outcome.reason).toContain(said);

      // Counted in the run's integrity counters, and the other three sessions are untouched.
      const ours = (run.progress?.sessions ?? []).filter(
        (entry) => entry.status === 'automation_failure',
      );
      expect(ours.map((entry) => entry.sessionId)).toEqual(['S-02']);
      expect(run.status).toBe('finished');
      expect(run.sessionIds).toHaveLength(4);
      expect(await landed(runDir)).toHaveLength(4);
      expect(await validate(runDir)).toEqual([]);
    });
  }

  it('cancels an execution past the wall-clock cap and waits on nothing', async () => {
    const people = peopleOnMobile(2);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    const jobs = fakeJobs((request) =>
      request.env[TASK_ENV.sessionId] === 'S-02' ? { kind: 'never_ends' } : RUNS,
    );

    const started = Date.now();
    const { run, sessions } = await withNothingRunning(() =>
      runSwarm(
        swarmOver({ env: CLOUD_RUN, jobsTransport: jobs.transport, sessionTimeoutMs: 300 }, people),
      ),
    );

    // Nothing was waited on: the run finished in about the cap, not for ever.
    expect(Date.now() - started).toBeLessThan(TWO_HUNDRED_SESSIONS_TIMEOUT_MS / 2);
    const broke = sessions.find((session) => session.sessionId === 'S-02') as Session;
    expect(broke.outcome.status).toBe('automation_failure');
    expect(broke.outcome.reason).toContain('was cancelled');
    expect(broke.outcome.reason).toContain('still running after the 0.3 s');
    // And it really was cancelled, by name, rather than abandoned.
    expect(jobs.cancelled).toHaveLength(1);
    expect(jobs.cancelled[0]).toContain('/executions/');
    expect(run.sessionIds).toHaveLength(4);
    expect(await validate(runDir)).toEqual([]);
  });

  it('records an execution that reported success and left no session behind', async () => {
    const people = peopleOnMobile(1);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    // Every execution "succeeds" and nothing is ever written: what a bucket that silently
    // dropped an upload would look like from here.
    const jobs = fakeJobs(() => ({
      kind: 'ended',
      result: { kind: 'failed', status: '', said: '' },
    }));
    const quiet = {
      ...jobs.transport,
      settle: (): Promise<JobExecutionResult> => Promise.resolve({ kind: 'succeeded' }),
    } satisfies JobsTransport;

    const { sessions, run } = await withNothingRunning(() =>
      runSwarm(swarmOver({ env: CLOUD_RUN, jobsTransport: quiet }, people)),
    );

    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.outcome.status).toBe('automation_failure');
      expect(session.outcome.reason).toContain('left no session behind');
    }
    expect(run.status).toBe('finished');
    expect(await validate(runDir)).toEqual([]);
  });
});

describe('a local run reaches for nothing', () => {
  it('constructs no cloud client and makes no request with PV_RUNNER unset', async () => {
    const people = peopleOnMobile(2);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    const refuse = (): never => {
      throw new Error('a local run reached for the Jobs API');
    };
    const unusable: JobsTransport = { start: refuse, settle: refuse, cancel: refuse };

    const { sessions, run } = await withNothingRunning(() =>
      runSwarm(swarmOver({ env: {}, jobsTransport: unusable }, people)),
    );

    expect(sessions).toHaveLength(4);
    expect(run.status).toBe('finished');
    expect(await validate(runDir)).toEqual([]);
  });

  it('leaves no run contributions behind: a local session is observed as it happens', async () => {
    const people = peopleOnMobile(1);
    await writeOpenRun(runDir, { personas: people, variants: VARIANTS, seedGroups: SEEDS });
    await withNothingRunning(() => runSwarm(swarmOver({ env: {} }, people)));
    await expect(readFile(contributionsPath(runDir, 'S-01'), 'utf8')).rejects.toThrow();
    await rm(runPaths(runDir).run, { force: true }).catch(() => undefined);
  });
});

describe('the default Jobs transport, without a socket', () => {
  /**
   * The one function in this package that would open a socket, exercised with its `fetch` and
   * its token handed in: no network, no metadata server and no credential. What is asserted is
   * the shape of the three requests, because a transport that asks the wrong thing of the
   * right API is the failure a fake coordinator can never catch.
   */
  interface Call {
    readonly url: string;
    readonly method: string;
    readonly body: unknown;
  }

  const transportOver = (
    answer: (call: Call) => { status: number; body: unknown },
  ): { transport: JobsTransport; calls: Call[] } => {
    const calls: Call[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const { status, body } = answer(call);
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    }) as unknown as typeof fetch;
    return {
      calls,
      transport: createCloudRunJobsTransport({
        region: 'europe-west1',
        fetchImpl,
        token: () => Promise.resolve('not-a-real-token'),
      }),
    };
  };

  it('runs the job at its regional endpoint, with the session as overrides', async () => {
    const { transport, calls } = transportOver(() => ({
      status: 200,
      body: { response: { name: `${JOB}/executions/exec-1` } },
    }));

    const execution = await transport.start({
      job: JOB,
      args: ['run-session', '--run', 'r', '--session', 'S-01'],
      env: { PV_SESSION_ID: 'S-01' },
      taskTimeoutMs: 600_000,
    });

    expect(execution.name).toBe(`${JOB}/executions/exec-1`);
    const call = calls[0] as Call;
    expect(call.url).toBe(`https://europe-west1-run.googleapis.com/v2/${JOB}:run`);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({
      overrides: {
        taskCount: 1,
        timeout: '600s',
        containerOverrides: [
          {
            args: ['run-session', '--run', 'r', '--session', 'S-01'],
            env: [{ name: 'PV_SESSION_ID', value: 'S-01' }],
          },
        ],
      },
    });
  });

  it('turns an API refusal into a JobsRefused carrying its status and its words', async () => {
    const { transport } = transportOver(() => ({
      status: 429,
      body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
    }));

    await expect(
      transport.start({ job: JOB, args: [], env: {}, taskTimeoutMs: 1_000 }),
    ).rejects.toMatchObject({ status: 'RESOURCE_EXHAUSTED', said: 'Quota exceeded' });
  });

  it('reads a succeeded execution, and a failed one with the reason its condition names', async () => {
    const succeeded = transportOver(() => ({ status: 200, body: { succeededCount: 1 } }));
    await expect(
      succeeded.transport.settle(
        { name: `${JOB}/executions/exec-1` },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: 'succeeded' });

    const failed = transportOver(() => ({
      status: 200,
      body: {
        failedCount: 1,
        conditions: [
          {
            type: 'Completed',
            state: 'CONDITION_FAILED',
            reason: 'ContainerStartFailed',
            message: `Image '${IMAGE}' not found`,
          },
        ],
      },
    }));
    await expect(
      failed.transport.settle(
        { name: `${JOB}/executions/exec-1` },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      kind: 'failed',
      status: 'ContainerStartFailed',
      said: `Image '${IMAGE}' not found`,
    });
  });

  it('cancels by the execution’s own name, and never throws for a cancel that failed', async () => {
    const { transport, calls } = transportOver((call) =>
      call.url.endsWith(':cancel') ? { status: 500, body: {} } : { status: 200, body: {} },
    );
    await expect(transport.cancel({ name: `${JOB}/executions/exec-1` })).resolves.toBeUndefined();
    expect((calls[0] as Call).url).toBe(
      `https://europe-west1-run.googleapis.com/v2/${JOB}/executions/exec-1:cancel`,
    );
  });
});

describe('collecting what a task wrote', () => {
  /**
   * The second half of a remote session is a download, and the session's cap is about the
   * session rather than about the execution — so a store that never answers costs this one
   * session and the run carries on, rather than holding a worker of the pool for ever.
   */
  it('gives up on a collection that outstays what the session had left', async () => {
    const jobs = fakeJobs(() => ({
      kind: 'ended',
      result: { kind: 'failed', status: '', said: '' },
    }));
    const runner = createCloudRunRunner(
      {
        project: 'pv-test',
        region: 'europe-west1',
        job: 'personavision-session-runner',
        image: IMAGE,
        videoBucket: 'pv-test-session-videos',
        engineMode: 'offline',
      },
      {
        transport: {
          ...jobs.transport,
          settle: () => Promise.resolve({ kind: 'succeeded' }),
        },
        collect: () => new Promise(() => undefined),
      },
    );

    const walked = await runner({
      runDir,
      runId: '2026-10-27-1200-fixture',
      sessionId: 'S-01',
      persona: peopleOnMobile(1)[0] as Persona,
      variant: runVariant('A'),
      seed: 11,
      task: TASK,
      startedAt: NOON,
      timeoutMs: 200,
      source,
      providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
    });

    expect(walked.session.outcome.status).toBe('automation_failure');
    expect(walked.session.outcome.reason).toContain('had still not come back');
    expect(walked.session.persona?.device).toEqual({ ...MOBILE, name: 'mobile-person-1' });
    expect(walked.landsLate).toBeNull();
    expect(walked.aois).toEqual([]);
  });
});
