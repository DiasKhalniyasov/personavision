import { resolve } from 'node:path';
import {
  createPlatform,
  githubAppRegistration,
  startPlatformServer,
} from '@personavision/platform';
import type {
  Platform,
  PlatformServer,
  SeededWorkspace,
  StartedTest,
  TestPipeline,
} from '@personavision/platform';
import { modelCredentialPresent, ModelModeUnavailableError } from '@personavision/provider';
import launch from 'open';
import sirv from 'sirv';
import { CliError } from '../cli-error.js';
import { runDataMount } from '../run-data.js';
import { RunNotStartedError, startRun } from '../run/start.js';
import { ensureViewerBuilt } from '../viewer-build.js';
import type { CaptureSource } from '@personavision/browser';
import type { RunRequest } from '@personavision/contract';

/**
 * `personavision serve` — the product's entry point: the platform server on localhost,
 * the built viewer, and the run data on the documented read-only paths with the
 * requesting session's workspace scoping them.
 *
 * On a data directory that does not exist yet it seeds the demo workspace and prints the
 * generated password **once**. That one block is the only thing this command ever prints
 * that is a secret: nothing else it writes — no log line, no error, no file outside the
 * password's own scrypt verifier — carries it, and a restart prints nothing new.
 */

export interface ServeCommandOptions {
  /** Where accounts, workspaces, audiences and sessions live. `--data-dir`. */
  dataDir: string;
  /** The directory the run directories sit in — `./runs` relative to where it was run. */
  runsRoot: string;
  /** The built viewer to serve. */
  viewerDist: string;
  /** Where `pnpm` is run from when the viewer has to be built. */
  repoRoot: string;
  port: number;
  /** `--no-build`: fail instead of building a missing viewer. */
  build: boolean;
  /** `--no-open`: start the server and print the URL without launching a browser. */
  openBrowser: boolean;
  /** Everything the command says while it runs. It never carries a credential. */
  log?: (line: string) => void;
  /** The one-time credentials block, written only by the start that seeds. */
  announce?: (block: string) => void;
  /** Seams: the tests drive the build and the browser without running either. */
  buildViewer?: () => Promise<void>;
  launchBrowser?: (url: string) => Promise<void>;
  /**
   * What a run opens its pages with. Absent is Chromium over the site's own URL, which is
   * what the product does; a suite passes a committed capture set instead, so a test of this
   * command starts a real run without launching a browser.
   */
  captureSource?: CaptureSource;
  /**
   * What a run's engine selection reads — whether this deployment has a `MODEL_API_KEY`, and
   * so whether a test runs on the model or offline (#143). Absent is this process's own
   * environment, which is what makes `serve` usable with no key: the run is recorded as
   * offline and says so. A suite passes its own, so no test reaches a model.
   */
  runEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ServeResult extends PlatformServer {
  platform: Platform;
}

/**
 * What a first start prints. The password is on its own line so it can be copied, and the
 * block says plainly that it will not be shown again — it is stored only as a verifier.
 */
const credentials = (seeded: SeededWorkspace, dataDir: string): string =>
  [
    '',
    `A new workspace was created in ${dataDir}:`,
    '',
    `  Workspace   ${seeded.workspaceName}`,
    `  Sign in as  ${seeded.email}`,
    `  Password    ${seeded.password}`,
    '',
    '  This password is shown once and nowhere else: only a scrypt verifier of it is',
    '  stored, so it cannot be read back. Write it down before closing this window.',
    '',
  ].join('\n');

/**
 * The same block when the server then failed to come up. The directory is seeded either
 * way, so a later start prints nothing — without this, a start that is refused its port
 * would create a workspace whose password nobody ever sees.
 */
const credentialsDespiteFailure = (seeded: SeededWorkspace, dataDir: string): string =>
  [
    credentials(seeded, dataDir),
    '  The server did not start, but the workspace above was created and will not be',
    '  created again. Keep this password: the next start signs in with it.',
    '',
  ].join('\n');

/**
 * The request as **this deployment** can serve it: the same request, except that a
 * contributor run on a machine with no `MODEL_API_KEY` asks for the offline engine.
 *
 * It is not a downgrade of a customer's test, and the condition is written to be exactly the
 * one `startTest`'s own `servedAsAsked` accepts: a `standard` request is never touched and is
 * refused rather than served by anything else (#143, and the owner's decision of
 * 2026-10-28), while for a contributor workspace *"no key means offline, said plainly on the
 * screen, which is what keeps the demo and a cold start working"* (#144). The platform cannot
 * apply that rule itself and neither can a screen: whether a key is present is a fact only
 * the process serving the request holds (decision 44), and this pipeline is that process.
 *
 * It is asked for **before** the run rather than patched afterwards, so the artifact records
 * the engine that ran and the Running screen says offline from its first read.
 */
const asThisDeploymentCanServeIt = (
  request: RunRequest,
  env?: Readonly<Record<string, string | undefined>>,
): RunRequest =>
  request.engineMode === 'model' && request.modelMode !== 'standard' && !modelCredentialPresent(env)
    ? { ...request, engineMode: 'offline' }
    : request;

/**
 * The model this deployment cannot serve, as the platform reads it.
 *
 * `startRun` records such a run as refused in its own artifact and hands back a
 * `RunNotStartedError` carrying the selection's refusal as its cause; `startTest` reads that
 * cause's type to turn a `standard` workspace's refusal into the 503 the New test screen
 * renders (#144). So the cause is what the pipeline reports, and the artifact beside it is
 * the record of the run that was refused.
 */
const asThePlatformReadsIt = (error: unknown): unknown =>
  error instanceof RunNotStartedError && error.cause instanceof ModelModeUnavailableError
    ? error.cause
    : error;

/**
 * The swarm behind `POST /runs`: `startRun` — the very function `personavision run` is — in
 * the shape the platform declares a `TestPipeline` in.
 *
 * It is built **here** rather than in `@personavision/platform`, and that is the seam rather
 * than an accident: the platform is the package the screens talk to, and it does not depend
 * on `@personavision/swarm` or on `@personavision/browser`, so nothing a screen imports
 * drags Playwright behind it. `packages/cli` depends on both already, because it is the thing
 * that runs tests.
 *
 * **It answers when the run exists, not when it ends.** `startRun` resolves once every
 * session has landed — a hundred of them is twenty minutes — and `startTest` awaits this
 * pipeline before its `201`, so a pipeline that awaited the run would hold the response open
 * for the whole test. So the run is started and deliberately not awaited: the promise this
 * returns is resolved by `onOpen`, the moment the run directory and its first `run.json` are
 * written, and the run goes on in the background under the same process.
 *
 * Nothing here decides a number. The request, the audience by value, the site and the
 * concurrency all arrive as `TestPipeline` declares them — the concurrency is the caps
 * module's, computed by `startTest` before this is called — and the run directory is written
 * under the `runsRoot` this command serves, so the Running screen and the results screens
 * read the run the launch wrote with no second path to it.
 */
const swarmPipeline =
  ({
    runsRoot,
    log,
    captureSource,
    runEnv,
  }: {
    runsRoot: string;
    log: (line: string) => void;
    captureSource?: CaptureSource;
    runEnv?: Readonly<Record<string, string | undefined>>;
  }): TestPipeline =>
  async (request, audience, site, concurrency) => {
    /** The run once it is open, or `null` while the response is still being waited for. */
    let openedRunId: string | null = null;
    let answer: (opened: StartedTest) => void = () => undefined;
    let refuse: (reason: unknown) => void = () => undefined;
    const opened = new Promise<StartedTest>((resolveWith, rejectWith) => {
      answer = resolveWith;
      refuse = rejectWith;
    });

    // Started and **not awaited**: see above. The handlers below are the whole of what
    // happens when it finishes, which is why this is not a floating promise.
    void startRun({
      runsRoot,
      request: asThisDeploymentCanServeIt(request, runEnv),
      audience,
      // The artifact's shape rather than the platform's: `SiteAtLaunch` carries the stored
      // record's id too, and a run directory names no row of the platform's store
      // (`docs/FLOW.md` section 8), so the id is dropped here.
      //
      // `verifiedAtLaunch` is written as `false` because `@personavision/contract` still
      // declares it required inside the block and an artifact without it would not parse.
      // Site verification was deleted from the platform (#392), so there is nothing left to
      // fill it with: the field itself goes with #393.
      ...(site === undefined ? {} : { site: { url: site.url, verifiedAtLaunch: false } }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(captureSource === undefined ? {} : { source: captureSource }),
      ...(runEnv === undefined ? {} : { env: runEnv }),
      onOpen: (open) => {
        openedRunId = open.runId;
        answer(open);
      },
    }).then(
      () => undefined,
      (error: unknown) => {
        // **Before the run existed**, this is the request's own refusal: it is handed back so
        // that `startTest` can tell a model that could not be served from a run that broke,
        // and so that the route answers it rather than a run id for a run nobody wrote.
        //
        // **After it**, the response was given long ago and the sessions were running: the
        // artifact `startRun` wrote is the record — the Running screen reads the failure out
        // of `run.json` the way it reads a finished run — so this logs one line and leaves it
        // there. It is a handler rather than nothing so that a background run that throws is
        // recorded rather than raised as an unhandled rejection that takes the server down.
        if (openedRunId === null) refuse(asThePlatformReadsIt(error));
        else log(`The test in ${openedRunId} did not finish: ${(error as Error).message}`);
      },
    );

    return await opened;
  };

export const serveCommand = async ({
  dataDir,
  runsRoot,
  viewerDist,
  repoRoot,
  port,
  build,
  openBrowser,
  log = (line) => process.stdout.write(`${line}\n`),
  announce = (block) => process.stdout.write(`${block}\n`),
  buildViewer,
  launchBrowser = async (url) => void (await launch(url)),
  captureSource,
  runEnv,
}: ServeCommandOptions): Promise<ServeResult> => {
  await ensureViewerBuilt({ viewerDist, repoRoot, build, log, buildViewer });

  // Whether a GitHub App is registered is answered from this process's environment, by
  // the one module that reads it (#319): `GITHUB_APP_ID` set means `/settings/github` can
  // offer the connect flow, and absent means path 2 renders locked with the reason. This
  // is the only place the seam is filled — `createPlatform`'s default stays "not
  // registered", so no test depends on what the machine running it happens to export.
  const platform = await createPlatform({
    dataDir,
    runsRoot,
    // What `POST /runs` runs a test with (#54, #398). Handed over here, which is why the
    // route's "not built yet" branch is unreachable from this command: `serve` is the one
    // caller of `createPlatform` in the product, and it always brings the swarm.
    //
    // The same `runsRoot` the platform resolves and this command serves, resolved the same
    // way, so the run a launch writes is a run the app already reads.
    pipeline: swarmPipeline({
      runsRoot: resolve(runsRoot),
      log,
      ...(captureSource === undefined ? {} : { captureSource }),
      ...(runEnv === undefined ? {} : { runEnv }),
    }),
    githubApp: githubAppRegistration(),
  });

  if (platform.seeded !== null) {
    if (platform.seeded.runIds.length === 0) {
      log(
        `No test under ${platform.runsRoot} yet, so the new workspace has none. Generate the committed example with \`pnpm seed:example-run\` and restart.`,
      );
    }
  } else {
    log(`Signing in to the workspace in ${platform.dataDir}.`);
  }

  // The mount is `packages/cli`'s, used rather than forked: `serve` adds only the scoping
  // above it, by naming the runs this request's session may read.
  const runData = runDataMount({ runsRoot: platform.runsRoot, visibleRuns: platform.visibleRuns });
  // `dev` because a run directory changes while the server is up; `single` so an unknown
  // path is the app's own route rather than a 404 from the file server.
  const viewer = sirv(viewerDist, { dev: true, single: true });

  let server: PlatformServer;
  try {
    server = await startPlatformServer({
      // The guard is the platform's, in front of the routes, the run data and the app:
      // signed out means `/signin` for a page and 401 for a data request (#101).
      guard: platform.guard,
      routes: platform.routes,
      runData,
      viewer,
      port,
    });
  } catch (error) {
    // The workspace was seeded before the port was bound, and it will not be seeded
    // again — so a start that cannot listen still has to hand over the password.
    if (platform.seeded !== null) {
      announce(credentialsDespiteFailure(platform.seeded, platform.dataDir));
    }
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new CliError(
        `Port ${String(port)} is already in use. Pass --port <port> to use another one, or stop what is on it.`,
      );
    }
    throw error;
  }

  if (platform.seeded !== null) announce(credentials(platform.seeded, platform.dataDir));
  log(server.url);
  if (openBrowser) {
    try {
      await launchBrowser(server.url);
    } catch (error) {
      // A machine with no browser is not a failure: the URL is already printed.
      log(`Could not launch a browser (${(error as Error).message}). Open the URL above.`);
    }
  }
  return { ...server, platform };
};
