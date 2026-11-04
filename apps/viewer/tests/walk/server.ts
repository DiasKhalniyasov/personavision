import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveCommand } from '@personavision/cli';
import { createOfflineWonderProvider } from '../../../../packages/provider/src/index.js';
import type { CaptureSource } from '../../../../packages/browser/src/index.js';
import type { ServeResult } from '@personavision/cli';

/**
 * The product, started the way `personavision serve` starts it, for one walk.
 *
 * `serveCommand` and not a composition of its parts: it is the one caller of
 * `createPlatform` in the product, and it is what brings the swarm behind `POST /runs`
 * (#398), the real run-data mount, the session guard and the app behind them. A suite that
 * assembled those itself would be asserting against its own wiring rather than against the
 * product's.
 *
 * Three things are the walk's and not the machine's, each through a seam the command
 * already declares:
 *
 * - **the port**: `0`, so two of these in parallel cannot lock each other out — the
 *   acceptance suite's fixed 4173 is deliberately not reused;
 * - **the data directory and the runs root**: temporary and this walk's own, so nothing
 *   touches `runs/` in the repository;
 * - **the pages and the model**: a committed capture set replaces Chromium, an environment
 *   holding no key is what selects the offline engine, and the one-shot Wonder
 *   implementation is replaced at the provider seam — so the walk reaches no network and
 *   no model, and what it is about is the wiring rather than what a model would say.
 */

/** The viewer's own document shell: `serve` wants a built app, and serving one is not this walk's subject. */
const VIEWER_HTML = fileURLToPath(new URL('../../index.html', import.meta.url));

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export interface WalkServer {
  readonly served: ServeResult;
  /** Every line the command wrote. The credentials block never comes through here. */
  readonly logged: readonly string[];
  readonly runsRoot: string;
  readonly cleanup: () => Promise<void>;
}

export const startWalkServer = async (source: CaptureSource): Promise<WalkServer> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-walk-'));
  const runsRoot = join(dir, 'runs');
  const viewerDist = join(dir, 'viewer-dist');
  await mkdir(runsRoot, { recursive: true });
  await mkdir(viewerDist, { recursive: true });
  await copyFile(VIEWER_HTML, join(viewerDist, 'index.html'));

  const logged: string[] = [];
  const served = await serveCommand({
    dataDir: join(dir, '.personavision'),
    runsRoot,
    viewerDist,
    repoRoot,
    port: 0,
    build: false,
    openBrowser: false,
    log: (line) => void logged.push(line),
    announce: () => undefined,
    captureSource: source,
    // No key, which is what makes `serve` usable without one and what keeps this walk off
    // a model: the engine is selected, recorded and reported as offline.
    runEnv: {},
    // The shipped selection refuses without a key, in words — which is the right answer for
    // a deployment and the wrong one for a walk about wiring. The offline implementation is
    // the product's own, so the two asks answer without anything being invented here.
    wonder: () => createOfflineWonderProvider(),
  });

  return {
    served,
    logged,
    runsRoot,
    cleanup: async () => {
      await served.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
};
