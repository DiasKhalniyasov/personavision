import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sirv from 'sirv';
import { runDataMount } from './run-data.js';

/**
 * The server both `personavision open` and the demo's first beat run: the built viewer,
 * with the read-only run-data mount in front of it.
 *
 * Everything that is not run data falls through to the viewer, and an unknown path falls
 * through to its `index.html`, so a screen's client-side route resolves on a hard refresh.
 */

/** Out of the way of Vite's dev server (5173) and the demo shop's preview (4173). */
export const DEFAULT_PORT = 5175;

/** Loopback only: these are internal tools, and nothing here belongs on a network. */
const HOST = '127.0.0.1';

export interface RunServerOptions {
  /** The directory the run directories sit in. */
  runsRoot: string;
  /** The built viewer — `apps/viewer/dist`. */
  viewerDist: string;
  /** `0` asks the operating system for a free port, which is what tests pass. */
  port?: number;
}

export interface RunServer {
  /** The address to open, with the port actually listened on. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export const startRunServer = async ({
  runsRoot,
  viewerDist,
  port = DEFAULT_PORT,
}: RunServerOptions): Promise<RunServer> => {
  const runData = runDataMount({ runsRoot });
  // `dev` because the viewer may be rebuilt while the server is up; `single` so an unknown
  // path is the app's own route rather than a 404 from the file server.
  const viewer = sirv(viewerDist, { dev: true, single: true });
  const server: Server = createServer((request, response) => {
    runData(request, response, () => {
      viewer(request, response, () => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found.\n');
      });
    });
  });

  await new Promise<void>((listening, failed) => {
    server.once('error', failed);
    server.listen(port, HOST, () => {
      server.off('error', failed);
      listening();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${HOST}:${address.port}/`,
    port: address.port,
    close: () =>
      new Promise<void>((closed, failed) => {
        server.close((error) => (error === undefined ? closed() : failed(error)));
        // A browser keeps its connection open, and `close` waits for the sockets.
        server.closeAllConnections();
      }),
  };
};
