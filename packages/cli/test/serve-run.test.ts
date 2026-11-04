import { readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureSource } from '@personavision/browser';
import { runPaths, runSchema } from '@personavision/contract';
import { ONE_URL_VARIANT_ID, SESSION_COOKIE } from '@personavision/platform';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serveCommand } from '../src/commands/serve.js';
import { startRun } from '../src/run/start.js';
import { DERIVED_STEP_ID } from '../src/run/task.js';
import { audienceOf } from './run-swarm.js';
import { temporaryWorkspace } from './workspace.js';
import type { CaptureSource, Device } from '@personavision/browser';
import type { Run } from '@personavision/contract';
import type { ServeResult } from '../src/commands/serve.js';
import type { OpenedRun } from '../src/run/start.js';
import type { TestWorkspace } from './workspace.js';

/**
 * `personavision serve` starting a **real** run: the swarm `packages/cli` already depends on,
 * handed to the platform as its `TestPipeline`, driving the committed capture set rather than
 * Chromium (#398).
 *
 * Everything is asserted through `POST /runs` and the run directory, because that is the
 * promise: the id is answered while the sessions are still running, and the directory the
 * launch writes is the one under the `runsRoot` this command already serves — so the Running
 * screen and the results screens read it with no second path to it.
 *
 * Nothing here opens a browser or reaches a model. The capture source replays
 * `packages/browser`'s committed recording and the run's environment names no key, which is
 * also what a deployment with no `MODEL_API_KEY` is: the run is recorded as offline.
 */

const repoRoot = new URL('../../..', import.meta.url).pathname;

/** The capture set `pnpm -F @personavision/browser record:captures` wrote. */
const COMMITTED = fileURLToPath(new URL('../../browser/test/fixtures/captures', import.meta.url));

/** The address of the site these tests launch against — the fixture pages' own. */
const SITE_URL = 'https://fixture.test/cart.html';

/** The index of a capture set, as the recorder writes it. */
interface CaptureSetIndex {
  formatVersion: number;
  variants: { id: string; device: Device; steps: { step: string; path: string }[] }[];
}

/**
 * The committed capture set, rewritten as the **one page** a test launched through the product
 * walks: one variant named `site` and one step named `page`.
 *
 * It has to be rewritten rather than replayed as it is, because a run started through the
 * platform carries no step declaration — the request is a sentence and a URL, so `taskFor`
 * derives the page as one step — and a capture source answers with the step id it recorded.
 * The recorded geometry, elements and screenshot are the committed ones; only the two names
 * change.
 */
const onePageCaptureSet = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-serve-captures-'));
  const index = JSON.parse(
    await readFile(join(COMMITTED, 'capture-set.json'), 'utf8'),
  ) as CaptureSetIndex;
  const recorded = index.variants.find((variant) => variant.id === 'A');
  if (recorded === undefined) throw new Error(`${COMMITTED} records no variant "A"`);
  const first = recorded.steps[0];
  if (first === undefined) throw new Error(`${COMMITTED} records no step for variant "A"`);

  await writeFile(
    join(dir, 'capture-set.json'),
    JSON.stringify(
      {
        formatVersion: index.formatVersion,
        variants: [
          {
            id: ONE_URL_VARIANT_ID,
            device: recorded.device,
            steps: [{ step: DERIVED_STEP_ID, path: first.path }],
          },
        ],
      },
      null,
      2,
    ),
  );

  const capture = JSON.parse(
    await readFile(join(COMMITTED, 'captures', 'A', `${first.step}.json`), 'utf8'),
  ) as Record<string, unknown>;
  const screenshot = runPaths('').screenshot(ONE_URL_VARIANT_ID, DERIVED_STEP_ID);
  await mkdir(join(dir, 'captures', ONE_URL_VARIANT_ID), { recursive: true });
  await mkdir(dirname(join(dir, screenshot)), { recursive: true });
  await writeFile(
    join(dir, 'captures', ONE_URL_VARIANT_ID, `${DERIVED_STEP_ID}.json`),
    JSON.stringify(
      { ...capture, variant: ONE_URL_VARIANT_ID, step: DERIVED_STEP_ID, screenshot },
      null,
      2,
    ),
  );
  await copyFile(join(COMMITTED, runPaths('').screenshot('A', first.step)), join(dir, screenshot));
  return dir;
};

/**
 * The same source, holding every session at its first capture until the test lets go.
 *
 * It is what makes "the id is answered before the run finishes" an assertion rather than a
 * race: no session can land while the gate is shut, so a `run.json` that says `open` at the
 * moment of the `201` says so because the run is still running and not because the test was
 * quick enough.
 */
const heldAtTheFirstScreen = (
  inner: CaptureSource,
): { source: CaptureSource; release: () => void } => {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    release: () => {
      open();
    },
    source: {
      ...inner,
      capture: async (page, ctx) => {
        await gate;
        return await inner.capture(page, ctx);
      },
    },
  };
};

/** What the launch step of the New test wizard submits (`SiteTestDraft`). */
const submission = (audienceId: string, siteId: string): Record<string, unknown> => ({
  site: SITE_URL,
  siteId,
  feature: 'buying the canvas tote bag',
  goal: {
    task: 'Buy the canvas tote bag and place the order.',
    successCriterion: 'The confirmation screen shows the order.',
    lastWrittenBy: 'user',
  },
  audienceId,
});

describe('personavision serve starts a real run', () => {
  let workspace: TestWorkspace;
  let served: ServeResult;
  let gate: { source: CaptureSource; release: () => void };
  let captures: string;
  let logged: string[];
  let cookie: string;
  let audienceId: string;
  let siteId: string;
  let runId: string;

  /** `run.json` as it stands, read on its own: the whole directory is unreadable mid-run. */
  const runNow = async (id: string = runId): Promise<Run> =>
    runSchema.parse(JSON.parse(await readFile(runPaths(join(workspace.runsRoot, id)).run, 'utf8')));

  const post = (body: unknown, as: string | null = cookie): Promise<Response> =>
    fetch(new URL('/runs', served.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(as === null ? {} : { cookie: as }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    logged = [];
    captures = await onePageCaptureSet();
    gate = heldAtTheFirstScreen(createFixtureSource(captures));
    workspace = await temporaryWorkspace();
    served = await serveCommand({
      dataDir: join(workspace.dir, '.personavision'),
      runsRoot: workspace.runsRoot,
      viewerDist: workspace.viewerDist,
      repoRoot,
      port: 0,
      build: false,
      openBrowser: false,
      log: (line) => void logged.push(line),
      announce: () => undefined,
      captureSource: gate.source,
      // No key, which is what makes `serve` usable without one: the run is selected,
      // recorded and reported as offline rather than refused (#143).
      runEnv: {},
    });

    const workspaceId = served.platform.seeded?.workspaceId ?? '';
    // Two people on the one device the committed set was recorded under, so the run plans
    // two sessions: a hundred is the same code and twenty minutes of it.
    const audience = await served.platform.store.audiences.create(workspaceId, audienceOf(2));
    audienceId = audience.id;
    const site = await served.platform.store.sites.create(workspaceId, { url: SITE_URL });
    siteId = site.id;
    const session = await served.platform.store.sessions.create({
      accountId: served.platform.seeded?.accountId ?? '',
      workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    cookie = `${SESSION_COOKIE}=${served.platform.signSession(session.id)}`;
  });

  afterAll(async () => {
    gate.release();
    await served.close();
    await workspace.cleanup();
    await rm(captures, { recursive: true, force: true });
  });

  it('answers the run id while the run is still running', async () => {
    const response = await post(submission(audienceId, siteId));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { runId: string };
    runId = body.runId;
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-/);

    // The run exists and is readable at the moment the id was answered, and it has not
    // finished: every session is held at its first screen.
    const run = await runNow();
    expect(run.runId).toBe(runId);
    expect(run.status).toBe('open');
    expect(run.finishedAt).toBeUndefined();
    expect(run.progress?.finishedSessions ?? 0).toBe(0);
    expect(run.progress?.totalSessions).toBe(2);
  }, 90_000);

  it('writes the run under the runsRoot it serves, visible to the workspace that launched it', async () => {
    const listed = (await (
      await fetch(new URL('/runs/index.json', served.url), { headers: { cookie } })
    ).json()) as { runId: string }[];
    expect(listed.map((entry) => entry.runId)).toContain(runId);

    const served404 = await fetch(new URL(`/runs/${runId}/run.json`, served.url), {
      headers: { cookie },
    });
    expect(served404.status).toBe(200);
    expect(((await served404.json()) as Run).runId).toBe(runId);
  }, 90_000);

  it('records the site it was launched against and the engine that actually ran', async () => {
    const run = await runNow();
    expect(run.site).toEqual({ url: SITE_URL, verifiedAtLaunch: false });
    expect(run.engine.mode).toBe('offline');
    // The audience by value, not by reference: a later edit to the stored audience cannot
    // restate this run.
    expect(run.audience.size).toBe(2);
    expect(run.variants.map((variant) => variant.id)).toEqual([ONE_URL_VARIANT_ID]);
  }, 90_000);

  it('lands the sessions as they finish and reaches finished', async () => {
    gate.release();
    const finished = await vi.waitFor(
      async () => {
        const run = await runNow();
        expect(run.status).toBe('finished');
        return run;
      },
      { timeout: 60_000, interval: 50 },
    );

    expect(finished.progress?.finishedSessions).toBe(2);
    expect(finished.sessionIds).toHaveLength(2);
    const onDisk = await readdir(runPaths(join(workspace.runsRoot, runId)).sessionsDir);
    expect(onDisk.sort()).toEqual(finished.sessionIds.map((id) => `${id}.json`).sort());
  }, 90_000);

  it('refuses a signed-out launch rather than answering that starting a test is not built', async () => {
    const response = await post(submission(audienceId, siteId), null);
    // 401 and not 501: the route has a pipeline, so `notImplemented` is unreachable here.
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toMatchObject({ signedIn: false });
  }, 90_000);

  it('refuses a standard workspace whose model this deployment cannot serve', async () => {
    // The one case the pipeline does **not** run offline: a `standard` workspace is refused
    // rather than served by anything else (#143, #144). The refusal reaches the route as the
    // selection's own error, which is how it becomes the 503 the New test screen renders
    // instead of a bare failure.
    const paying = await served.platform.store.workspaces.create({
      name: 'Paying customer',
      memberAccountIds: [served.platform.seeded?.accountId ?? ''],
      runIds: [],
      modelMode: 'standard',
    });
    const audience = await served.platform.store.audiences.create(paying.id, audienceOf(1));
    const site = await served.platform.store.sites.create(paying.id, { url: SITE_URL });
    const session = await served.platform.store.sessions.create({
      accountId: served.platform.seeded?.accountId ?? '',
      workspaceId: paying.id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const response = await post(
      submission(audience.id, site.id),
      `${SESSION_COOKIE}=${served.platform.signSession(session.id)}`,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; modelMode: string };
    expect(body.modelMode).toBe('standard');
    expect(body.error).toContain('Nothing was simulated');

    // The run that was refused is on disk as the record of a refusal — `startRun` writes it —
    // and it belongs to no workspace, so nothing in the product offers it.
    const listed = (await (
      await fetch(new URL('/runs/index.json', served.url), {
        headers: { cookie: `${SESSION_COOKIE}=${served.platform.signSession(session.id)}` },
      })
    ).json()) as { runId: string }[];
    expect(listed).toEqual([]);
  }, 90_000);
});

describe('a run that breaks after its id was answered', () => {
  let workspace: TestWorkspace;
  let served: ServeResult;
  let gate: { source: CaptureSource; release: () => void };
  let captures: string;
  const logged: string[] = [];
  const unhandled: unknown[] = [];
  const noteRejection = (reason: unknown): void => void unhandled.push(reason);

  beforeAll(async () => {
    process.on('unhandledRejection', noteRejection);
    captures = await onePageCaptureSet();
    gate = heldAtTheFirstScreen(createFixtureSource(captures));
    workspace = await temporaryWorkspace();
    served = await serveCommand({
      dataDir: join(workspace.dir, '.personavision'),
      runsRoot: workspace.runsRoot,
      viewerDist: workspace.viewerDist,
      repoRoot,
      port: 0,
      build: false,
      openBrowser: false,
      log: (line) => void logged.push(line),
      announce: () => undefined,
      captureSource: gate.source,
      runEnv: {},
    });
  });

  afterAll(async () => {
    process.off('unhandledRejection', noteRejection);
    gate.release();
    await served.close();
    await workspace.cleanup();
    await rm(captures, { recursive: true, force: true });
  });

  it('logs one line, leaves the artifact readable, and raises no unhandled rejection', async () => {
    const workspaceId = served.platform.seeded?.workspaceId ?? '';
    const audience = await served.platform.store.audiences.create(workspaceId, audienceOf(1));
    const site = await served.platform.store.sites.create(workspaceId, { url: SITE_URL });
    const session = await served.platform.store.sessions.create({
      accountId: served.platform.seeded?.accountId ?? '',
      workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const cookie = `${SESSION_COOKIE}=${served.platform.signSession(session.id)}`;

    const response = await fetch(new URL('/runs', served.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(submission(audience.id, site.id)),
    });
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    const paths = runPaths(join(workspace.runsRoot, runId));

    // The run is broken where a run breaks at the level of the run rather than of a session:
    // `run.json` can no longer be written, which is a run nobody can read, so the swarm
    // stops. The sessions are still held at their first screen, so this lands before any of
    // them tries to append itself.
    await chmod(paths.run, 0o444);
    gate.release();

    await vi.waitFor(
      () => {
        expect(logged.filter((line) => line.includes(runId))).toHaveLength(1);
      },
      { timeout: 60_000, interval: 50 },
    );
    await chmod(paths.run, 0o644);

    // The artifact `startRun` wrote is the record: it still parses, and the Running screen
    // reads it the way it reads any other run.
    const run = runSchema.parse(JSON.parse(await readFile(paths.run, 'utf8')));
    expect(run.runId).toBe(runId);
    expect(unhandled).toEqual([]);
  }, 90_000);
});

/**
 * The seam the pipeline above is built on, asserted on its own: `startRun` tells its caller
 * the run exists **once**, and by then the artifact is on disk under that id.
 *
 * `personavision run` passes no `onOpen` and is unchanged by it — which is what the rest of
 * `packages/cli/test/run.test.ts` goes on proving.
 */
describe('startRun opens before it finishes', () => {
  it('fires onOpen exactly once, with the run already readable under that id', async () => {
    const captures = await onePageCaptureSet();
    const runsRoot = await mkdtemp(join(tmpdir(), 'personavision-onopen-'));
    const opens: OpenedRun[] = [];
    /** What `run.json` said at the moment the callback fired, read inside it. */
    const statusWhenOpened: (string | undefined)[] = [];

    try {
      const started = await startRun({
        runsRoot,
        request: {
          task: { prompt: 'Buy the canvas tote bag and place the order' },
          variants: [{ id: ONE_URL_VARIANT_ID, name: 'fixture.test', url: SITE_URL }],
          audienceId: 'fixture-shoppers',
          repeats: 1,
          seed: 11,
          engineMode: 'offline',
        },
        audience: audienceOf(1),
        source: createFixtureSource(captures),
        env: {},
        onOpen: (open) => {
          opens.push(open);
          const run = runSchema.parse(
            JSON.parse(readFileSync(runPaths(join(runsRoot, open.runId)).run, 'utf8')),
          );
          statusWhenOpened.push(run.status);
        },
      });

      expect(opens).toEqual([{ runId: started.runId, engineMode: 'offline' }]);
      expect(statusWhenOpened).toEqual(['open']);
      expect(started.run.status).toBe('finished');
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
      await rm(captures, { recursive: true, force: true });
    }
  }, 90_000);
});

/**
 * The reason the pipeline lives in `packages/cli` and not in `@personavision/platform`: the
 * package every screen talks to must not gain a dependency on the swarm, so that nothing a
 * screen imports drags Playwright behind it.
 */
describe('the package the screens talk to', () => {
  it('depends on neither the swarm nor the browser', async () => {
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../../platform/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain('@personavision/swarm');
    expect(declared).not.toContain('@personavision/browser');
    expect(declared).not.toContain('playwright');
  });
});

/**
 * A served workspace a launch can be posted to: the demo workspace seeded by the start, an
 * audience on the capture set's own device, a site at the fixture's address, and a session
 * cookie for the workspace that owns all three.
 *
 * It exists because the two cases below are about **when** a launch starts rather than about
 * what it writes, and both need the whole of that setup to ask the question.
 */
const launchable = async (
  gate: { source: CaptureSource },
  people = 2,
): Promise<{
  workspace: TestWorkspace;
  served: ServeResult;
  logged: string[];
  post: () => Promise<Response>;
  runNow: (runId: string) => Promise<Run>;
  runDirs: () => Promise<string[]>;
  cleanup: () => Promise<void>;
}> => {
  const logged: string[] = [];
  const workspace = await temporaryWorkspace();
  const served = await serveCommand({
    dataDir: join(workspace.dir, '.personavision'),
    runsRoot: workspace.runsRoot,
    viewerDist: workspace.viewerDist,
    repoRoot,
    port: 0,
    build: false,
    openBrowser: false,
    log: (line) => void logged.push(line),
    announce: () => undefined,
    captureSource: gate.source,
    runEnv: {},
  });
  const workspaceId = served.platform.seeded?.workspaceId ?? '';
  const audience = await served.platform.store.audiences.create(workspaceId, audienceOf(people));
  const site = await served.platform.store.sites.create(workspaceId, { url: SITE_URL });
  const session = await served.platform.store.sessions.create({
    accountId: served.platform.seeded?.accountId ?? '',
    workspaceId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const cookie = `${SESSION_COOKIE}=${served.platform.signSession(session.id)}`;

  return {
    workspace,
    served,
    logged,
    post: () =>
      fetch(new URL('/runs', served.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(submission(audience.id, site.id)),
      }),
    runNow: async (runId) =>
      runSchema.parse(
        JSON.parse(await readFile(runPaths(join(workspace.runsRoot, runId)).run, 'utf8')),
      ),
    // The run directories this server wrote: the committed fixture run the workspace was
    // seeded from is not one of them.
    runDirs: async () =>
      (await readdir(workspace.runsRoot)).filter((entry) => entry !== workspace.runId),
    cleanup: async () => {
      await served.close().catch(() => undefined);
      await workspace.cleanup();
    },
  };
};

/** The id a `201` answered. */
const launchedRunId = async (response: Response): Promise<string> => {
  expect(response.status).toBe(201);
  return ((await response.json()) as { runId: string }).runId;
};

/**
 * One run per site at a time, which is the gate `startTest` has always had and which a
 * pipeline answering at the open could quietly defeat: the site has to stay taken until the
 * run **ends**, or a second launch — and the hourly cap allows four — would put its own ten
 * browsers on a site the first is still driving.
 */
describe('two launches on one site', () => {
  let gate: { source: CaptureSource; release: () => void };
  let captures: string;
  let launch: Awaited<ReturnType<typeof launchable>>;

  beforeAll(async () => {
    captures = await onePageCaptureSet();
    gate = heldAtTheFirstScreen(createFixtureSource(captures));
    launch = await launchable(gate, 1);
  });

  afterAll(async () => {
    gate.release();
    await launch.cleanup();
    await rm(captures, { recursive: true, force: true });
  });

  it('holds the second until the first run has finished', async () => {
    const firstId = await launchedRunId(await launch.post());

    // Sent and deliberately not awaited: nothing of it may open while the first run is still
    // held at its first screen.
    const second = launch.post();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await launch.runDirs()).toEqual([firstId]);

    gate.release();
    const secondId = await launchedRunId(await second);
    expect(secondId).not.toBe(firstId);
    // The first was over before the second opened, which is the whole of what the queue
    // promises: what a second launch loses is time, not sessions.
    expect((await launch.runNow(firstId)).status).toBe('finished');
    expect((await launch.runDirs()).sort()).toEqual([firstId, secondId].sort());
  }, 120_000);
});

/**
 * A run started by `POST /runs` outlives the response that answered it, so the command that
 * started it has to own it: closing stops it and waits for it, rather than leaving a
 * `run.json` saying `open` for ever and a directory still being written.
 */
describe('a server that closes while a run is in flight', () => {
  let gate: { source: CaptureSource; release: () => void };
  let captures: string;
  let launch: Awaited<ReturnType<typeof launchable>>;

  beforeAll(async () => {
    captures = await onePageCaptureSet();
    gate = heldAtTheFirstScreen(createFixtureSource(captures));
    launch = await launchable(gate, 2);
  });

  afterAll(async () => {
    gate.release();
    await launch.cleanup();
    await rm(captures, { recursive: true, force: true });
  });

  it('waits for the run it started and leaves it closed', async () => {
    const runId = await launchedRunId(await launch.post());
    expect((await launch.runNow(runId)).status).toBe('open');

    gate.release();
    await launch.served.close();

    const run = await launch.runNow(runId);
    expect(run.status).not.toBe('open');
    expect(run.finishedAt).toBeDefined();
  }, 120_000);
});
