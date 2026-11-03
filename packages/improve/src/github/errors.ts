/**
 * What a GitHub call answers when it does not answer what was asked.
 *
 * Every failure here is named, and every failure carries **what was asked** — the method and
 * the path — and **what was answered** — the status and GitHub's own words. Nothing is
 * smoothed into a success and nothing comes back as `undefined`: the three replies this
 * product will actually meet in the field are a **403** on a repository the App is not
 * installed on, a **422** on a pull request that already exists, and a **rate limit**, and a
 * caller that cannot tell them apart cannot tell a user what to do about it.
 *
 * No message built here contains the installation token. The client redacts the token out of
 * every string it takes from a transport or from a reply before composing one, because a 401
 * page, a proxy that echoes the request or a gateway that logs what it received are not ours
 * to trust.
 */

export const GITHUB_FAILURE_KINDS = [
  /** The call never reached GitHub: DNS, TLS, a dropped connection. */
  'transport',
  /** Our own clock ran out, which is a different failure from a connection that dropped. */
  'timeout',
  /** 401: the token is not good for this call. */
  'unauthorized',
  /** 403 that is not a rate limit: the App is not installed, or lacks the permission. */
  'forbidden',
  /** 404: no such repository, pull request or comment — or the App cannot see it. */
  'not_found',
  /** 422: GitHub understood and refused, e.g. a pull request that already exists. */
  'unprocessable',
  /** 429, or a 403 whose remaining quota is zero: asked too often. */
  'rate_limit',
  /** Any other non-2xx status. */
  'http_status',
  /** A 2xx reply this client could not read the fields it needs out of. */
  'unparseable',
  /** The client refused to make the call: see {@link GitHubCallError}'s `answered`. */
  'refused',
] as const;

export type GitHubFailureKind = (typeof GITHUB_FAILURE_KINDS)[number];

/**
 * A GitHub call that did not produce what was asked for.
 *
 * `method` and `path` are what was asked; `status` and `answered` are what came back. The
 * message states all four in one sentence, so a failure that reaches a log line or a screen
 * is already in words.
 */
export class GitHubCallError extends Error {
  readonly kind: GitHubFailureKind;
  readonly method: string;
  readonly path: string;
  /** The HTTP status, when the call got far enough to have one. */
  readonly status?: number;
  /** What GitHub said, or what went wrong before it could say anything. */
  readonly answered: string;

  constructor(options: {
    readonly kind: GitHubFailureKind;
    readonly method: string;
    readonly path: string;
    readonly status?: number;
    readonly answered: string;
  }) {
    const asked = `${options.method} ${options.path}`;
    const answered =
      options.status === undefined
        ? `No answer from GitHub to ${asked}`
        : `GitHub answered ${String(options.status)} to ${asked}`;
    super(`${answered} — ${options.kind}: ${options.answered}`);
    this.name = 'GitHubCallError';
    this.kind = options.kind;
    this.method = options.method;
    this.path = options.path;
    if (options.status !== undefined) this.status = options.status;
    this.answered = options.answered;
  }
}

/** Which named failure a status is, read with the headers because a rate limit hides in a 403. */
export const failureKindForStatus = (
  status: number,
  headers: Readonly<Record<string, string>>,
  answered: string,
): GitHubFailureKind => {
  const outOfQuota =
    headers['x-ratelimit-remaining'] === '0' ||
    headers['retry-after'] !== undefined ||
    /rate limit|too many requests/i.test(answered);
  if (status === 429) return 'rate_limit';
  if (status === 403) return outOfQuota ? 'rate_limit' : 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 422) return 'unprocessable';
  return 'http_status';
};

/**
 * GitHub's own words for a failure: `message`, plus the per-field `errors` it adds to a 422,
 * which is where "A pull request already exists" actually lives. A reply that is not the
 * shape GitHub documents is quoted as it came.
 */
export const answerOf = (body: unknown): string => {
  if (typeof body === 'string') return body === '' ? 'no body' : body;
  if (typeof body !== 'object' || body === null) return 'no body';
  const record = body as Record<string, unknown>;
  const head = typeof record['message'] === 'string' ? record['message'] : '';
  const errors = Array.isArray(record['errors'])
    ? record['errors']
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (typeof entry !== 'object' || entry === null) return '';
          const detail = entry as Record<string, unknown>;
          return typeof detail['message'] === 'string' ? detail['message'] : '';
        })
        .filter((text) => text !== '')
    : [];
  const sentence = [head, ...errors].filter((text) => text !== '').join('; ');
  return sentence === '' ? JSON.stringify(body) : sentence;
};
