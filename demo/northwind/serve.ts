/**
 * The northwind demo shop, served from disk.
 *
 * A static file server over this directory, on Node built-ins only. It exists so that the
 * demo needs nothing but a browser: no backend, no build step, no dependency.
 *
 * Two things here are load-bearing for later tickets rather than incidental:
 *
 * 1. Every instance takes a free port, so a run can hold several shops open at once.
 * 2. The **stall switch**: a request for `shared/card-frame.html` carrying `?stall=1` is
 *    accepted and never answered. The committed example run's two automation failures are
 *    a selector timeout on that frame, and a shop that cannot stall would force somebody
 *    to hand-edit the artifact instead. See `demo/README.md`.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This directory: `a/`, `shared/`, and whatever a later variant ticket adds beside them. */
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** Where `/` sends a browser. Variant A is the current checkout, so it is the front door. */
const ENTRY_PATH = '/a/cart.html';

/** The one document the stall switch applies to, as a root-relative POSIX path. */
const STALL_TARGET = 'shared/card-frame.html';

/** The query parameter that arms the stall switch, and the value that arms it. */
const STALL_PARAM = 'stall';
const STALL_VALUE = '1';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

export interface ServeDemoShopOptions {
  /** Port to listen on. `0`, the default, takes a free one from the operating system. */
  readonly port?: number;
  /** Interface to bind. Defaults to loopback, so a demo run never leaves the machine. */
  readonly host?: string;
  /** Directory to serve. Defaults to this package's own directory. */
  readonly root?: string;
}

export interface DemoShop {
  /** Origin the shop answers on, with no trailing slash — e.g. `http://127.0.0.1:53412`. */
  readonly url: string;
  /** The port that origin resolves to, chosen by the operating system unless one was given. */
  readonly port: number;
  /**
   * Stops listening and frees the port. Connections still open are destroyed, so a request
   * held by the stall switch cannot keep this from resolving.
   */
  close(): Promise<void>;
}

const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[extname(filePath).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;

/**
 * The file a request path names, or `null` when it names nothing inside the root. Returns
 * `null` rather than throwing for a path that escapes the root, so traversal is a 403 and
 * not a stack trace.
 */
const fileForRequest = (root: string, pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const full = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const within = relative(root, full);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return null;
  return full;
};

/** The root-relative POSIX path of a resolved file, for comparing against `STALL_TARGET`. */
const rootRelativePath = (root: string, filePath: string): string =>
  relative(root, filePath).split(sep).join('/');

const send = (
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body?: Buffer | string,
): void => {
  res.writeHead(status, headers);
  res.end(body);
};

const sendText = (res: ServerResponse, status: number, text: string): void =>
  send(
    res,
    status,
    {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    },
    text,
  );

/**
 * Answers one request, or deliberately does not. Returning without touching `res` leaves
 * the request hanging, which is exactly what the stall switch is for.
 */
const handle = async (root: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed\n');
    return;
  }

  // The base is never used: `req.url` on a server is always origin-form.
  const requested = new URL(req.url ?? '/', 'http://northwind.invalid');

  if (requested.pathname === '/') {
    send(res, 302, { location: ENTRY_PATH, 'content-length': 0, 'cache-control': 'no-store' });
    return;
  }

  const filePath = fileForRequest(root, requested.pathname);
  if (filePath === null) {
    sendText(res, 403, 'Forbidden\n');
    return;
  }

  // The stall switch. The request is accepted — the connection stays open and no response
  // is written — so a driver waiting on a selector inside the frame times out for real.
  if (
    rootRelativePath(root, filePath) === STALL_TARGET &&
    requested.searchParams.get(STALL_PARAM) === STALL_VALUE
  ) {
    return;
  }

  let body: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendText(res, 404, 'Not found\n');
      return;
    }
    body = await readFile(filePath);
  } catch {
    sendText(res, 404, 'Not found\n');
    return;
  }

  const headers = {
    'content-type': contentTypeFor(filePath),
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  };
  // A HEAD still reports the length it would have sent.
  send(res, 200, headers, method === 'HEAD' ? undefined : body);
};

export const serveDemoShop = async (options: ServeDemoShopOptions = {}): Promise<DemoShop> => {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const server = createServer((req, res) => {
    handle(root, req, res).catch(() => {
      if (!res.headersSent) {
        sendText(res, 500, 'Internal server error\n');
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((started, failed) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      failed(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      started();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the demo shop is listening, but not on a TCP port');
  }
  const boundPort = address.port;

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((closed, failed) => {
        if (!server.listening) {
          closed();
          return;
        }
        server.close((error) => (error ? failed(error) : closed()));
        // `close()` on its own waits for every open connection, and a stalled request has
        // one that will never finish. Destroying them is what makes the port come back.
        server.closeAllConnections();
      }),
  };
};
