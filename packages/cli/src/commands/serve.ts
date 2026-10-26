import { createPlatform, startPlatformServer } from '@personavision/platform';
import type { Platform, PlatformServer, SeededWorkspace } from '@personavision/platform';
import launch from 'open';
import sirv from 'sirv';
import { CliError } from '../cli-error.js';
import { runDataMount } from '../run-data.js';
import { ensureViewerBuilt } from '../viewer-build.js';

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
}: ServeCommandOptions): Promise<ServeResult> => {
  await ensureViewerBuilt({ viewerDist, repoRoot, build, log, buildViewer });

  const platform = await createPlatform({ dataDir, runsRoot });

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
    server = await startPlatformServer({ routes: platform.routes, runData, viewer, port });
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
