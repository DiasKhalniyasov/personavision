import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { routeMount } from './router.js';
import type { Middleware, Route } from './routes/types.js';

/**
 * The platform server: the handful of platform routes, the workspace-scoped run-data
 * mount, and the built viewer behind them.
 *
 * The mount and the static viewer are passed in rather than built here: the run-data
 * mount is implemented once in `@personavision/cli` and reused, not forked
 * (`docs/adr/0001-run-data-over-http-as-static-files.md`), which also keeps this package
 * dependent on `@personavision/contract` and nothing else in the repository.
 */

/** Out of the way of Vite (5173), the demo shop's preview (4173) and `open` (5175). */
export const DEFAULT_PORT = 5176;

/** Loopback: the self-hosted default serves the machine it runs on. */
export const DEFAULT_HOST = '127.0.0.1';

export interface PlatformServerOptions {
  routes: readonly Route[];
  /** `runDataMount` from `@personavision/cli`, scoped by the platform's `visibleRuns`. */
  runData: Middleware;
  /** The built viewer, as a static file handler. */
  viewer: Middleware;
  /** `0` asks the operating system for a free port, which is what tests pass. */
  port?: number;
  host?: string;
}

export interface PlatformServer {
  /** The address to open, with the port actually listened on. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export const startPlatformServer = async ({
  routes,
  runData,
  viewer,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
}: PlatformServerOptions): Promise<PlatformServer> => {
  const platformRoutes = routeMount(routes);
  const server: Server = createServer((request, response) => {
    platformRoutes(request, response, () => {
      runData(request, response, () => {
        viewer(request, response, () => {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Not found.\n');
        });
      });
    });
  });

  await new Promise<void>((listening, failed) => {
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      listening();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${String(address.port)}/`,
    port: address.port,
    close: () =>
      new Promise<void>((closed, failed) => {
        server.close((error) => (error === undefined ? closed() : failed(error)));
        // A browser keeps its connection open, and `close` waits for the sockets.
        server.closeAllConnections();
      }),
  };
};
