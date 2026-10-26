import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { listRunDirs } from '@personavision/contract';
import launch from 'open';
import { CliError } from '../cli-error.js';
import { readRunIndex } from '../run-data.js';
import { startRunServer } from '../server.js';
import type { RunServer } from '../server.js';

/**
 * `personavision open` — the internal way to look at a run directory: the built viewer and
 * the run data on one local server, with no sign-in and no workspace scoping. It is for a
 * developer debugging an artifact; `personavision serve` is the product's entry point.
 *
 * Because the demo's first beat is this single command, it builds the viewer itself when
 * `apps/viewer/dist` is missing, saying so rather than hanging silently.
 */

const VIEWER_PACKAGE = '@personavision/viewer';

export interface OpenCommandOptions {
  /** The directory the run directories sit in — `./runs` relative to where it was run. */
  runsRoot: string;
  /** The built viewer to serve. */
  viewerDist: string;
  /** Where `pnpm` is run from when the viewer has to be built. */
  repoRoot: string;
  port: number;
  /** `--no-build`: fail instead of building a missing viewer. */
  build: boolean;
  /** `--no-open`: start the server without launching a browser. */
  openBrowser: boolean;
  log?: (line: string) => void;
  /** Seams: the tests drive the build and the browser without running either. */
  buildViewer?: () => Promise<void>;
  launchBrowser?: (url: string) => Promise<void>;
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const pnpmBuild = (repoRoot: string): Promise<void> =>
  new Promise<void>((built, failed) => {
    const build = spawn('pnpm', ['--filter', VIEWER_PACKAGE, 'build'], {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    build.on('error', (error) =>
      failed(
        new CliError(
          `The viewer could not be built: ${error.message}. Run \`pnpm build\` yourself, then run this again with --no-build.`,
        ),
      ),
    );
    build.on('exit', (code) =>
      code === 0
        ? built()
        : failed(
            new CliError(
              `The viewer could not be built: \`pnpm --filter ${VIEWER_PACKAGE} build\` exited ${String(code)}. The output above says why.`,
            ),
          ),
    );
  });

export const openCommand = async ({
  runsRoot,
  viewerDist,
  repoRoot,
  port,
  build,
  openBrowser,
  log = (line) => process.stdout.write(`${line}\n`),
  buildViewer = () => pnpmBuild(repoRoot),
  launchBrowser = async (url) => void (await launch(url)),
}: OpenCommandOptions): Promise<RunServer> => {
  const viewerHtml = join(viewerDist, 'index.html');
  if (!(await exists(viewerHtml))) {
    if (!build) {
      throw new CliError(
        `The viewer is not built: there is no ${viewerHtml}. Run \`pnpm build\`, or run this again without --no-build to have it built now.`,
      );
    }
    log(`The viewer is not built yet. Building it: pnpm --filter ${VIEWER_PACKAGE} build`);
    await buildViewer();
    if (!(await exists(viewerHtml))) {
      throw new CliError(
        `The viewer build left no ${viewerHtml}. Run \`pnpm --filter ${VIEWER_PACKAGE} build\` and read its output.`,
      );
    }
  }

  // The newest run is read from the listing the viewer itself reads, which orders by each
  // run's own timestamp — not from the order of the directory names, which can disagree.
  const runIds = await listRunDirs(runsRoot);
  const runs = await readRunIndex(runsRoot, runIds);
  if (runIds.length === 0) {
    log(
      `No test under ${runsRoot} yet. Generate the committed example with \`pnpm seed:example-run\`, or start a test from the app — the server below serves whatever appears.`,
    );
  } else if (runs.length === 0) {
    log(
      `${runIds.length} run director${runIds.length === 1 ? 'y' : 'ies'} under ${runsRoot}, and none of them reads as this build's schema version — so the app will list none. Run \`personavision validate <runDir>\` on one to see why.`,
    );
  } else {
    log(`${runs.length} test${runs.length === 1 ? '' : 's'} under ${runsRoot}, newest first:`);
    const newest = runs[0] as (typeof runs)[number];
    log(`  ${newest.runId} — ${newest.name}`);
  }

  let server: RunServer;
  try {
    server = await startRunServer({ runsRoot, viewerDist, port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new CliError(
        `Port ${port} is already in use. Pass --port <port> to use another one, or stop what is on it.`,
      );
    }
    throw error;
  }

  log(server.url);
  if (openBrowser) {
    try {
      await launchBrowser(server.url);
    } catch (error) {
      // A machine with no browser is not a failure: the URL is already printed.
      log(`Could not launch a browser (${(error as Error).message}). Open the URL above.`);
    }
  }
  return server;
};
