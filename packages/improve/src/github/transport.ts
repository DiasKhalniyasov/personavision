/**
 * How a GitHub call is sent, and the two ways this project sends one.
 *
 * The transport is a function, and the client is handed one. That is the whole reason this
 * module exists: every test in `@personavision/improve` and in the tickets built on it runs
 * over a recorded transport, so a fresh clone type-checks, lints, tests and builds with no
 * GitHub App, no installation token and no network. The default — `fetch` — is built only
 * when no other transport is given, so a test that passes one never constructs it.
 *
 * `docs/FLOW.md` section 15; tickets #227 and #297.
 */

/** The methods this product uses. There is no `DELETE`: nothing here removes anything. */
export type GitHubMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

/**
 * One HTTP call, as the client hands it to whatever sends it.
 *
 * `headers` carries the installation token's `Authorization` line, because the sender needs
 * it and nothing else does: it is deliberately not part of what the recorded transport keeps
 * (see {@link RecordedRequest}), so a transcript dumped into a failing test's output cannot
 * carry a credential.
 */
export interface GitHubHttpRequest {
  readonly method: GitHubMethod;
  /** The API path with its query, e.g. `/repos/clipforge/web/pulls`. */
  readonly path: string;
  /** The absolute URL the path resolved to against the client's base URL. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON body, absent on a read. */
  readonly body?: unknown;
  /** Aborted when the client's own timeout runs out. */
  readonly signal: AbortSignal;
}

export interface GitHubHttpResponse {
  readonly status: number;
  /** Header names lower-cased, because a rate limit is read off one of them. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed body, or the raw text when it was not JSON — whatever came back, verbatim. */
  readonly body: unknown;
}

/**
 * How a request is sent. A test passes a function and asserts against what it was given; the
 * platform passes nothing and gets `fetch`.
 */
export type GitHubTransport = (request: GitHubHttpRequest) => Promise<GitHubHttpResponse>;

/**
 * The default transport, built on demand rather than on import: `fetch`, and nothing a test
 * ever reaches.
 */
export const createFetchTransport = (): GitHubTransport => async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: request.signal,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the text itself is what came back, and the failure it becomes quotes it.
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body };
};
