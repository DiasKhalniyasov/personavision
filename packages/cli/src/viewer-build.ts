import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './cli-error.js';

/**
 * The built viewer the two serving commands put in front of the run data.
 *
 * Both the demo's first beat and a fresh clone's first `personavision serve` are a single
 * command, so a missing `apps/viewer/dist` is built rather than reported — saying so
 * rather than hanging silently. `--no-build` turns that into a failure instead.
 */

const VIEWER_PACKAGE = '@personavision/viewer';

export interface EnsureViewerBuiltOptions {
  /** The built viewer to serve — `apps/viewer/dist`. */
  viewerDist: string;
  /** Where `pnpm` is run from when the viewer has to be built. */
  repoRoot: string;
  /** `--no-build`: fail instead of building a missing viewer. */
  build: boolean;
  log: (line: string) => void;
  /** A seam: the tests drive the build without running one. */
  buildViewer?: () => Promise<void>;
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

/** Returns once `viewerDist` holds an `index.html`, building it if that is allowed. */
export const ensureViewerBuilt = async ({
  viewerDist,
  repoRoot,
  build,
  log,
  buildViewer = () => pnpmBuild(repoRoot),
}: EnsureViewerBuiltOptions): Promise<void> => {
  const viewerHtml = join(viewerDist, 'index.html');
  if (await exists(viewerHtml)) return;
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
};
