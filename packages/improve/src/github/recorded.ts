import type { GitHubHttpResponse, GitHubMethod, GitHubTransport } from './transport.js';

/**
 * The recorded transport: the one way this package and the tickets built on it exercise a
 * GitHub call.
 *
 * A test states the exchanges it expects — method, path and the reply GitHub would have
 * given — and reads back the requests that were actually made. Two properties make it worth
 * publishing rather than rewriting per ticket:
 *
 * 1. **An unrecorded call fails loudly.** A call the test did not state throws, naming the
 *    method and path, rather than resolving to `undefined` and leaving the module under test
 *    to invent something from nothing.
 * 2. **The transcript carries no headers.** The `Authorization` line the client builds is
 *    needed by a sender and by nobody else, so it is not kept here. A transcript printed by
 *    a failing assertion therefore cannot carry an installation token.
 */

/** What a test asserts a call on: what was asked, never what it was authorised with. */
export interface RecordedRequest {
  readonly method: GitHubMethod;
  readonly path: string;
  readonly url: string;
  /** The JSON body, absent on a read. */
  readonly body?: unknown;
}

/** What GitHub would have answered. A missing status is `200`. */
export interface RecordedReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** One expected call and its reply. */
export interface RecordedExchange {
  readonly method: GitHubMethod;
  readonly path: string;
  readonly reply: RecordedReply;
}

export interface RecordedTransport {
  readonly transport: GitHubTransport;
  /** Every request made, in order, as a live view. */
  readonly requests: readonly RecordedRequest[];
}

/** Thrown when a module under test makes a call the test did not record. */
export class UnrecordedGitHubCallError extends Error {
  readonly method: GitHubMethod;
  readonly path: string;

  constructor(method: GitHubMethod, path: string) {
    super(`no recorded reply for ${method} ${path}`);
    this.name = 'UnrecordedGitHubCallError';
    this.method = method;
    this.path = path;
  }
}

export const createRecordedTransport = (
  exchanges: readonly RecordedExchange[],
): RecordedTransport => {
  const requests: RecordedRequest[] = [];
  /**
   * Each exchange answers one call, in the order it was stated. Two exchanges with the same
   * method and path are therefore two turns of the same call — which is how a re-run that
   * edits a comment it posted earlier is recorded (#301).
   */
  const unused = exchanges.map((exchange) => ({ exchange, used: false }));

  const transport: GitHubTransport = async (request) => {
    requests.push({
      method: request.method,
      path: request.path,
      url: request.url,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const match = unused.find(
      (entry) =>
        !entry.used &&
        entry.exchange.method === request.method &&
        entry.exchange.path === request.path,
    );
    if (match === undefined) throw new UnrecordedGitHubCallError(request.method, request.path);
    match.used = true;
    const reply = match.exchange.reply;
    const response: GitHubHttpResponse = {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      body: reply.body,
    };
    return response;
  };

  return { transport, requests };
};
