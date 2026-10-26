import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The platform's own routes — sign-in, sign-out, the session the chrome reads, and
 * audience storage. There is no other API: run data stays static files on the documented
 * read-only paths (`docs/adr/0001-run-data-over-http-as-static-files.md`).
 */

/** Connect-style, so `node:http` and Vite's dev server take the same handler. */
export type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Matched against the pathname. A capture group is a path parameter. */
  path: RegExp;
  /**
   * `true` for a route whose path is also one of the app's screens (`/audiences`): a
   * browser navigating there wants the screen, and only a request asking for JSON wants
   * the route. Without this a hard refresh on a screen would answer with the API.
   */
  jsonOnly?: boolean;
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const encoded = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.byteLength,
    'cache-control': 'no-store',
  });
  response.end(encoded);
};

/** A body larger than this is not a form submission, and is refused before it is read. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The request's body as JSON, or `null` for a body that is not JSON or is too large.
 *
 * `null` is "nothing was read", which a route answers 400 to: a body it could not parse is
 * not a submission that failed validation, because nothing was validated. An empty body is
 * `undefined` inside the box, so the two are told apart without a second return type.
 */
export const readJsonBody = async (
  request: IncomingMessage,
): Promise<{ value: unknown } | null> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (body === '') return { value: undefined };
  try {
    return { value: JSON.parse(body) };
  } catch {
    return null;
  }
};

/**
 * A route whose ticket has not landed yet. It answers 501 naming the ticket, so that a
 * screen built against it fails loudly and the issue to read is in the message.
 */
export const notImplemented =
  (ticket: number, what: string) =>
  (_request: IncomingMessage, response: ServerResponse): void => {
    sendJson(response, 501, {
      error: `${what} is not built yet — see #${String(ticket)}.`,
      ticket,
    });
  };
