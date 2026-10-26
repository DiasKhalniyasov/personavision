import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatform } from '../src/platform.js';
import type { Platform } from '../src/platform.js';
import { startPlatformServer } from '../src/server/server.js';
import type { PlatformServer } from '../src/server/server.js';
import type { Middleware } from '../src/server/routes/types.js';
import { temporaryDirectories, writeRunAt } from './workspace.js';
import type { TestDirectories } from './workspace.js';

/**
 * A platform server for a test, and the two requests every test here makes of it.
 *
 * The run-data mount and the built viewer are `@personavision/cli`'s — this package
 * depends on `@personavision/contract` and nothing else in the repository — so the two
 * stand-ins below take their place. Each is the smallest thing that answers on the paths
 * the guard and the scoping have to be asserted over; the shipped mount serving the
 * documented paths byte for byte is asserted in `packages/cli/test/serve.test.ts`.
 */

export interface TestServerOptions {
  /**
   * Runs written **before** the platform starts, so the seed finds them and publishes the
   * one run of a fresh clone as the demo run. A run added afterwards belongs to the
   * workspace that adds it and is public to nobody, which is the seed's own rule.
   */
  runs?: readonly { stamp: string; name: string }[];
}

export interface TestServer {
  platform: Platform;
  server: PlatformServer;
  directories: TestDirectories;
  /** A `fetch` at this server, following no redirect, so the redirect itself is assertable. */
  request: (path: string, options?: RequestInit) => Promise<Response>;
  /** The ids of the runs written before the platform started, in the order given. */
  runIds: string[];
  /** What a browser navigating to a page sends, and a `fetch` does not. */
  navigate: (path: string, cookie?: string) => Promise<Response>;
  close: () => Promise<void>;
}

/**
 * Stands in for `runDataMount`: a run's files, served only when the run is one this
 * request may read. It asks the platform the same question the shipped mount is handed —
 * `visibleRuns` — and answers 404 for anything else, because that another workspace holds
 * a run is not disclosed.
 */
const runDataStandIn = (platform: Platform): Middleware => {
  const answer = async (
    pathname: string,
    response: Parameters<Middleware>[1],
    visible: readonly string[],
  ): Promise<void> => {
    if (pathname === '/runs/index.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(visible)}\n`);
      return;
    }
    const [runId, ...rest] = pathname.slice('/runs/'.length).split('/');
    if (runId === undefined || !visible.includes(runId)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`There is no run "${runId ?? ''}" here.\n`);
      return;
    }
    const body = await readFile(join(platform.runsRoot, runId, ...rest), 'utf8');
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(body);
  };

  return (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/runs/') || !pathname.endsWith('.json')) {
      next();
      return;
    }
    void platform
      .visibleRuns(request)
      .then((visible) => answer(pathname, response, visible))
      .catch(() => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('There is no such file in this run.\n');
      });
  };
};

/** Stands in for the built viewer: one page, so a screen route has something to answer with. */
const viewerStandIn: Middleware = (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<html lang="en"><body>PersonaVision</body></html>\n');
};

export const startTestServer = async ({
  runs = [],
}: TestServerOptions = {}): Promise<TestServer> => {
  const directories = await temporaryDirectories();
  const runIds: string[] = [];
  for (const run of runs) runIds.push(await writeRunAt(directories.runsRoot, run));
  const platform = await createPlatform(directories);
  const server = await startPlatformServer({
    guard: platform.guard,
    routes: platform.routes,
    runData: runDataStandIn(platform),
    viewer: viewerStandIn,
    port: 0,
  });

  const request = (path: string, options: RequestInit = {}): Promise<Response> =>
    fetch(new URL(path, server.url), { redirect: 'manual', ...options });

  return {
    platform,
    server,
    directories,
    runIds,
    request,
    navigate: (path, cookie) =>
      request(path, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'sec-fetch-dest': 'document',
          ...(cookie === undefined ? {} : { cookie }),
        },
      }),
    close: async () => {
      await server.close();
      await directories.cleanup();
    },
  };
};
