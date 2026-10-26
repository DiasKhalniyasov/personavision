/**
 * A stub publisher, served from the test process over loopback.
 *
 * Nothing in this package's suite reaches the public internet, and nothing downloads the
 * real 12.9 GB archive. The download is exercised against this server instead: it serves
 * bytes the test made up, answers range requests the way Zenodo does, and can be told to
 * cut a transfer off in the middle so that resumption is asserted rather than assumed.
 *
 * It listens on port zero and reports the port it was given, so no test hard-codes one and
 * two suites can run side by side.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/** What one request asked for, so a test can assert what was and was not fetched. */
export interface StubRequest {
  readonly method: string;
  /** The path alone — the query string is kept separately, to assert it is never logged. */
  readonly path: string;
  readonly query: string;
  readonly range: string | null;
  /** Any credential the command sent. It must always be empty: the dataset is open access. */
  readonly authorization: string | null;
}

export interface StubOriginOptions {
  /** The files served, by path without a leading slash. */
  readonly files: Readonly<Record<string, Buffer>>;
  /**
   * How much of the body each successive request may send before the connection is
   * destroyed, oldest request first. `null`, or running off the end of the list, means the
   * whole body.
   */
  readonly cutAfter?: readonly (number | null)[];
  /** Answer every request with the whole file and status 200, as an origin without ranges. */
  readonly ignoreRanges?: boolean;
  /** Answer every request with this status and no body. */
  readonly refuseWith?: number;
  /** Answer a request for one path with a redirect to this location. */
  readonly redirects?: Readonly<Record<string, string>>;
}

export interface StubOrigin {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The URL of one served path, with any query string the caller wants on it. */
  url(path: string, query?: string): string;
  readonly requests: readonly StubRequest[];
  close(): Promise<void>;
}

const parseRange = (
  header: string | undefined,
  size: number,
): { start: number; end: number } | null => {
  if (header === undefined) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
};

export const startStubOrigin = async (options: StubOriginOptions): Promise<StubOrigin> => {
  const requests: StubRequest[] = [];

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/^\//, '');
    const index = requests.length;
    requests.push({
      method: request.method ?? 'GET',
      path,
      query: url.search,
      range: request.headers.range ?? null,
      authorization: request.headers.authorization ?? null,
    });

    if (options.refuseWith !== undefined) {
      response.writeHead(options.refuseWith);
      response.end();
      return;
    }

    const redirect = options.redirects?.[path];
    if (redirect !== undefined) {
      response.writeHead(302, { location: redirect });
      response.end();
      return;
    }

    const body = options.files[path];
    if (body === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }

    const range =
      options.ignoreRanges === true ? null : parseRange(request.headers.range, body.length);
    const slice = range === null ? body : body.subarray(range.start, range.end + 1);
    if (range === null) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
      });
    } else {
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(slice.length),
        'content-range': `bytes ${range.start}-${range.end}/${body.length}`,
        'accept-ranges': 'bytes',
      });
    }

    const cut = options.cutAfter?.[index] ?? null;
    if (cut === null || cut >= slice.length) {
      response.end(slice);
      return;
    }
    // Half a transfer, then the connection goes away under it — which is what the download
    // has to survive by picking up from the bytes already written.
    response.write(slice.subarray(0, cut), () => {
      response.socket?.destroy();
    });
  };

  const server: Server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path, query = '') => `${origin}/${path}${query}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};
