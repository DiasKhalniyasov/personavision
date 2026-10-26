/**
 * The fixture site, served from disk.
 *
 * `serveFixtureSite()` is the local server the browser module's tests drive Chromium
 * against: `packages/browser/test/fixtures/site/` over `node:http` and `node:fs`, on a
 * free port, with no dependency of its own. Six tickets of the browser-driving step share
 * it, so what it does is stated in `fixtures/site/LANDMARKS.md` and asserted in
 * `fixture-site.test.ts` rather than discovered by reading this file.
 *
 * It is deliberately separate from `demo/northwind/serve.ts`. That shop is the product
 * under test — it is what the committed example run was recorded against, and it is meant
 * to look like a customer's checkout. This site is test substrate: its pages are
 * adversarial on purpose (a control that crosses the fold between two viewports, two
 * controls with the same words, a step page missing its own required element, frames that
 * never arrive).
 *
 * The two servers' mechanics are therefore the same shape — the traversal guard, the
 * listen handshake, the destroy-on-close — and that repetition is accepted rather than
 * shared. Sharing it would mean either a dependency on `demo/*`, which this package does
 * not have and cannot gain here (the ticket adds none, and the repo guards which way
 * imports between packages point), or a new shared package. The routes differ where it
 * matters: the shop stalls one named frame document, this site has whole routes for
 * stalling and for failing, and it serves no markdown so that its own record cannot be
 * fetched as a page.
 *
 * Three behaviours here exist only so that failures can be provoked:
 *
 * 1. `/slow` accepts the connection and never answers, so a wait times out for real.
 * 2. `/boom` answers 500, so a navigation can land on a server error.
 * 3. Only web assets are served: `LANDMARKS.md` sits inside the site directory and is a
 *    404, so the record of the site can never be mistaken for a page of it.
 *
 * A hard navigation failure needs no route at all — point the driver at this site's own
 * origin after `close()`, or at a port nothing listens on.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fixture site's directory: the six pages, the stylesheet, `assets/`, LANDMARKS.md. */
export const FIXTURE_SITE_DIR = resolve(
  fileURLToPath(new URL('../fixtures/site', import.meta.url)),
);

/** Where `/` sends a browser: the first step of the task these pages describe. */
const ENTRY_PATH = '/cart.html';

/** The route that is accepted and never answered. */
const STALL_ROUTE = '/slow';

/** The route that answers with a server error. */
const ERROR_ROUTE = '/boom';

/**
 * What this site serves, by extension. An extension that is absent is a 404 rather than a
 * download: the site holds its own documentation, and a driver that follows a link into it
 * should get nothing, not markdown.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

export interface ServeFixtureSiteOptions {
  /** Port to listen on. `0`, the default, takes a free one from the operating system. */
  readonly port?: number;
  /** Interface to bind. Defaults to loopback: a test server never leaves the machine. */
  readonly host?: string;
  /** Directory to serve. Defaults to the fixture site. */
  readonly root?: string;
}

export interface FixtureSite {
  /** Origin the site answers on, with no trailing slash — e.g. `http://127.0.0.1:53412`. */
  readonly url: string;
  /** The port that origin resolves to, chosen by the operating system unless one was given. */
  readonly port: number;
  /**
   * Stops listening and frees the port. Open connections are destroyed, so a request held
   * by `/slow` cannot keep this from resolving.
   */
  close(): Promise<void>;
}

const contentTypeFor = (filePath: string): string | undefined =>
  CONTENT_TYPES[extname(filePath).toLowerCase()];

/**
 * A request path with its percent-encoding removed, or `null` when it cannot be decoded or
 * smuggles a NUL. Decoding is separate from resolving because `%2f` survives WHATWG URL
 * normalisation, so an encoded slash has to be caught here rather than inherited.
 */
const decodePathname = (pathname: string): string | null => {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
};

/**
 * The file a decoded request path names, or `null` when it names nothing inside the root.
 * A path that escapes the root is a 403, not a stack trace.
 */
const fileForRequest = (root: string, pathname: string): string | null => {
  const full = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  const within = relative(root, full);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return null;
  return full;
};

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
      'content-type': TEXT_CONTENT_TYPE,
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    },
    text,
  );

/**
 * Answers one request, or deliberately does not: returning without touching `res` leaves
 * the request hanging, which is what `/slow` is for.
 */
const handle = async (root: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(
      res,
      405,
      { allow: 'GET, HEAD', 'content-type': TEXT_CONTENT_TYPE },
      'Method not allowed\n',
    );
    return;
  }

  // The base is never used: `req.url` on a server is always origin-form.
  const requested = new URL(req.url ?? '/', 'http://fixture.invalid');

  if (requested.pathname === '/') {
    send(res, 302, { location: ENTRY_PATH, 'content-length': 0, 'cache-control': 'no-store' });
    return;
  }

  // Accepted and never answered. The connection stays open and nothing is written, so a
  // driver waiting on this page — or on the frame of `broken-frame.html` that points at
  // it — waits until its own timeout fires.
  if (requested.pathname === STALL_ROUTE) return;

  if (requested.pathname === ERROR_ROUTE) {
    sendText(res, 500, 'Internal server error\n');
    return;
  }

  const pathname = decodePathname(requested.pathname);
  if (pathname === null) {
    sendText(res, 403, 'Forbidden\n');
    return;
  }

  // A URL path here is a file path, so there is no directory to land on. Without this,
  // `resolve` would drop the trailing slash and answer `/cart.html/` with the cart page,
  // whose stylesheet and relative links would then resolve one level too deep: a driver
  // would get a page that looks loaded and cannot advance.
  if (pathname.endsWith('/')) {
    sendText(res, 404, 'Not found\n');
    return;
  }

  const filePath = fileForRequest(root, pathname);
  if (filePath === null) {
    sendText(res, 403, 'Forbidden\n');
    return;
  }

  const contentType = contentTypeFor(filePath);
  if (contentType === undefined) {
    sendText(res, 404, 'Not found\n');
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
    'content-type': contentType,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  };
  // A HEAD still reports the length it would have sent.
  send(res, 200, headers, method === 'HEAD' ? undefined : body);
};

export const serveFixtureSite = async (
  options: ServeFixtureSiteOptions = {},
): Promise<FixtureSite> => {
  const root = resolve(options.root ?? FIXTURE_SITE_DIR);
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
      // From here an `error` is an accept failure such as EMFILE, not a failure to bind.
      // With no listener it would be an uncaught exception and would take down the whole
      // test worker rather than one request, so it is reported and the site stays up.
      server.on('error', (error: Error) => {
        process.stderr.write(`fixture site: ${error.message}\n`);
      });
      started();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the fixture site is listening, but not on a TCP port');
  }
  const boundPort = address.port;

  // An IPv6 literal has to be bracketed or the origin does not parse: `http://::1:5173`
  // is not a URL, `http://[::1]:5173` is.
  const hostInUrl = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${hostInUrl}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((closed, failed) => {
        if (!server.listening) {
          closed();
          return;
        }
        server.close((error) => (error ? failed(error) : closed()));
        // `close()` alone waits for every open connection, and a request held by `/slow`
        // has one that will never finish. Destroying them is what frees the port.
        server.closeAllConnections();
      }),
  };
};
