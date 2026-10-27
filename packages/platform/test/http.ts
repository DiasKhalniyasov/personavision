import { runDataMount } from '../../cli/src/run-data.js';
import { createPlatform } from '../src/platform.js';
import type { TestPipeline } from '../src/run/start.js';
import type { Platform } from '../src/platform.js';
import { startPlatformServer } from '../src/server/server.js';
import type { PlatformServer } from '../src/server/server.js';
import type { Middleware } from '../src/server/routes/types.js';
import { temporaryDirectories, writeRunAt } from './workspace.js';
import type { TestDirectories } from './workspace.js';

/**
 * A platform server for a test, and the requests every test here makes of it.
 *
 * The run-data mount is the shipped one — `@personavision/cli`'s, imported by path rather
 * than as a dependency, because the mount is implemented once
 * (`docs/adr/0001-run-data-over-http-as-static-files.md`) and a stand-in here would be a
 * second declaration of the run-directory paths, which only `@personavision/contract`
 * makes (`CONTEXT.md`). The built viewer is stood in for: it is a bundle, not a contract.
 */

export interface TestServerOptions {
  /**
   * Runs written **before** the platform starts, so the seed finds them and publishes the
   * one run of a fresh clone as the demo run. A run added afterwards belongs to the
   * workspace that adds it and is public to nobody, which is the seed's own rule.
   */
  runs?: readonly { stamp: string; name: string }[];
  /**
   * What `POST /runs` drives a test with. Omitted — as every suite but the one about
   * starting a test omits it — leaves the route answering 501 for #54, which is what
   * `personavision serve` does today.
   */
  pipeline?: TestPipeline;
}

export interface TestServer {
  platform: Platform;
  server: PlatformServer;
  directories: TestDirectories;
  /** A `fetch` at this server, following no redirect, so the redirect itself is assertable. */
  request: (path: string, options?: RequestInit) => Promise<Response>;
  /** `POST /auth/signin` with these fields, as the sign-in screen sends them. */
  signIn: (fields: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
  /** The ids of the runs written before the platform started, in the order given. */
  runIds: string[];
  /** What a browser navigating to a page sends, and a `fetch` does not. */
  navigate: (path: string, cookie?: string) => Promise<Response>;
  close: () => Promise<void>;
}

/** Stands in for the built viewer: one page, so a screen route has something to answer with. */
const viewerStandIn: Middleware = (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<html lang="en"><body>PersonaVision</body></html>\n');
};

export const startTestServer = async ({
  runs = [],
  pipeline,
}: TestServerOptions = {}): Promise<TestServer> => {
  const directories = await temporaryDirectories();
  const runIds: string[] = [];
  for (const run of runs) runIds.push(await writeRunAt(directories.runsRoot, run));
  const platform = await createPlatform({ ...directories, pipeline });
  const server = await startPlatformServer({
    guard: platform.guard,
    routes: platform.routes,
    runData: runDataMount({ runsRoot: platform.runsRoot, visibleRuns: platform.visibleRuns }),
    viewer: viewerStandIn,
    port: 0,
  });

  const request = (path: string, options: RequestInit = {}): Promise<Response> =>
    fetch(new URL(path, server.url), { redirect: 'manual', ...options });

  const signIn = (
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    request('/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(fields),
    });

  return {
    platform,
    server,
    directories,
    runIds,
    request,
    signIn,
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

/** The `pv_session=…` pair out of a response's `set-cookie`, ready to send back. */
export const cookieOf = (response: Response): string =>
  (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
