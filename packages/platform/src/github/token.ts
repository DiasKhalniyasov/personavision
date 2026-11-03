import { GITHUB_APP_JWT_ALGORITHM, GithubAppError, readGithubAppSigner } from './credentials.js';
import type { GithubAppCredentialOptions, GithubAppSigner } from './credentials.js';

/**
 * The installation token, minted from the App's credentials.
 *
 * The App's JWT is signed with the key `./credentials.ts` closed over, exchanged for an
 * **installation token** on the one endpoint that mints one, and handed to
 * `@personavision/improve`'s client as an argument — which is exactly the shape #297
 * specified, and the reason that package reads no environment variable and needs no
 * credential to be built, tested or type-checked.
 *
 * Four things are load-bearing here:
 *
 * 1. **The transport is injected**, and the default is built only when no other is given, so
 *    every test mints over a recorded transport with no network and asserts on the request
 *    that was made: the endpoint, the headers and the JWT's claims.
 * 2. **The key is never in scope.** This module holds a {@link GithubAppSigner}, not a key.
 *    Nothing it returns, throws or records carries the PEM, and the minted token is never
 *    written to a file, a log line or an error either — a reply this module cannot read is
 *    reported as "the reply carried no installation token", never by quoting the reply.
 * 3. **A token is cached no longer than it lives.** An installation token is good for an
 *    hour. {@link createGithubInstallationTokens} holds one per installation **in memory
 *    only**, under GitHub's own `expires_at` less a margin and never past an hour from when
 *    it was minted, and mints a fresh one the instant that passes.
 * 4. **The two failures that are GitHub's answers are named**: a **401** because the key does
 *    not match the App, and a **404** because the App is not installed on that repository.
 *    Both come back as the {@link GithubAppError} `./credentials.ts` declares, carrying what
 *    was asked and what was answered.
 *
 * `docs/github-app.md`; `docs/FLOW.md` section 15; #319.
 */

/**
 * GitHub's API, as this one call reaches it.
 *
 * `@personavision/improve` states the same base URL for the product's own calls. It is
 * written twice because the two packages are deliberately not dependents of one another —
 * the platform mints a token and hands it over; it does not reach GitHub for anything else —
 * and both read it from an option a test overrides, so neither is a second place a path is
 * composed.
 */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** GitHub asks every client to name itself. */
export const GITHUB_USER_AGENT = 'personavision';

/**
 * How long the one POST may take before it is our own timeout rather than a wait.
 *
 * It bounds the **default** transport. An injected one owns its own deadline, and it needs
 * one: a mint that never answers holds every caller waiting on that installation's token,
 * because they all wait on the one call rather than starting a second.
 */
export const TOKEN_MINT_TIMEOUT_MS = 30_000;

/**
 * The App JWT is backdated a minute, which is GitHub's own advice for clock drift, and spans
 * the ten minutes GitHub allows at most — so it expires nine minutes after this clock reads
 * it, and a token exchange that takes longer than that was never going to succeed.
 */
export const APP_JWT_BACKDATE_SECONDS = 60;
export const APP_JWT_MAX_SPAN_SECONDS = 600;

/** An installation token's whole life, as GitHub issues it: one hour. */
export const INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * How long before a cached token's own expiry it stops being used. A minute: long enough for
 * a call already in flight to finish on it, short enough that an hour-long token is used for
 * an hour.
 */
export const INSTALLATION_TOKEN_MARGIN_MS = 60 * 1000;

/**
 * The one request this module makes, as it hands it to whatever sends it.
 *
 * A test passes a function, keeps what it was given and asserts against it; the platform
 * passes nothing and gets `fetch`. `headers` carries the App JWT — the sender needs it and
 * nothing else does, so a recorded request is never put anywhere a credential may not go.
 */
export interface GithubTokenRequest {
  readonly method: 'POST';
  /** The API path, e.g. `/app/installations/45678901/access_tokens`. */
  readonly path: string;
  /** The absolute URL the path resolved to against the base URL. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GithubTokenAnswer {
  readonly status: number;
  /** Header names lower-cased, as `fetch` gives them. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed body, or the raw text when it was not JSON. */
  readonly body: unknown;
}

export type GithubTokenTransport = (request: GithubTokenRequest) => Promise<GithubTokenAnswer>;

/** The token GitHub minted, and when GitHub says it stops working. */
export interface MintedInstallationToken {
  readonly token: string;
  /** ISO-8601, GitHub's own. */
  readonly expiresAt: string;
}

/** The claims an App JWT carries, and all of them: GitHub reads these three and no more. */
export interface AppJwtClaims {
  /** Issued at, backdated {@link APP_JWT_BACKDATE_SECONDS} for clock drift. */
  readonly iat: number;
  readonly exp: number;
  /** The issuer: the App's id. */
  readonly iss: string;
}

export interface GithubTokenOptions extends GithubAppCredentialOptions {
  /** How the one POST is sent. Defaults to `fetch`, built only when this is absent. */
  readonly transport?: GithubTokenTransport;
  readonly baseUrl?: string;
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly userAgent?: string;
  /** What bounds the default transport. Defaults to {@link TOKEN_MINT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * How the App's credentials are read. Defaults to {@link readGithubAppSigner}, which is the
   * one read of the environment — this seam exists so a test can hand in a signer built from
   * a generated key without going through the environment at all.
   */
  readonly readSigner?: (options: GithubAppCredentialOptions) => Promise<GithubAppSigner>;
}

const base64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

/**
 * The App's JWT: `{alg, typ}.{iat, exp, iss}.signature`, signed by the signer's closure.
 *
 * It is minted per exchange and never cached: it costs one signature, it is good for ten
 * minutes at most, and a JWT held anywhere is a credential held somewhere.
 */
export const mintAppJwt = (signer: GithubAppSigner, atMs: number): string => {
  const issuedAt = Math.floor(atMs / 1000) - APP_JWT_BACKDATE_SECONDS;
  const claims: AppJwtClaims = {
    iat: issuedAt,
    exp: issuedAt + APP_JWT_MAX_SPAN_SECONDS,
    iss: signer.appId,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: GITHUB_APP_JWT_ALGORITHM, typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  return `${signingInput}.${signer.sign(signingInput)}`;
};

/** The claims of a JWT this module minted, read back — for a test, and for nothing else. */
export const claimsOfAppJwt = (jwt: string): AppJwtClaims => {
  const [, claims = ''] = jwt.split('.');
  return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as AppJwtClaims;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (source: Record<string, unknown> | undefined, name: string): string | undefined =>
  typeof source?.[name] === 'string' ? (source[name] as string) : undefined;

/**
 * GitHub's own words for a refusal: its `message`, or the text it sent where it sent text.
 *
 * A reply that is neither is described rather than quoted. The body of a **successful**
 * exchange holds the installation token, so no path here stringifies a body it did not read a
 * field out of: a credential cannot be smuggled into a message by a reply we did not expect.
 */
const wordsOf = (body: unknown): string => {
  if (typeof body === 'string') return body.trim() === '' ? 'no body' : body;
  const message = text(asRecord(body), 'message');
  return message ?? 'a reply this client could not read';
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const createFetchTransport =
  (timeoutMs: number): GithubTokenTransport =>
  async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      // Not JSON: the text itself is what came back, and the failure it becomes quotes it.
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: parsed };
  };

/**
 * Mint one installation token: sign the App JWT, exchange it, and answer the token GitHub
 * minted with the moment GitHub says it stops working.
 *
 * No caching here — {@link createGithubInstallationTokens} is where a token is held — so this
 * is also the function a caller reaches for when it wants a token minted for certain.
 */
export const mintInstallationToken = async (
  installationId: string,
  options: GithubTokenOptions = {},
): Promise<MintedInstallationToken> => {
  const now = options.now ?? Date.now;
  const transport =
    options.transport ?? createFetchTransport(options.timeoutMs ?? TOKEN_MINT_TIMEOUT_MS);
  const baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/$/, '');
  const signer = await (options.readSigner ?? readGithubAppSigner)({
    env: options.env,
    readKeyFile: options.readKeyFile,
  });

  const path = `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  const asked = `POST ${path}`;
  const request: GithubTokenRequest = {
    method: 'POST',
    path,
    url: `${baseUrl}${path}`,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${mintAppJwt(signer, now())}`,
      'user-agent': options.userAgent ?? GITHUB_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
  };

  let answer: GithubTokenAnswer;
  try {
    answer = await transport(request);
  } catch (error) {
    throw new GithubAppError({ kind: 'transport', asked, answered: messageOf(error) });
  }

  if (answer.status === 401) {
    throw new GithubAppError({
      kind: 'unauthorized',
      asked,
      status: 401,
      answered: `GitHub answered 401 to the App JWT for App ${signer.appId}, which is what it answers when the private key does not match the App: ${wordsOf(answer.body)}`,
    });
  }
  if (answer.status === 404) {
    throw new GithubAppError({
      kind: 'not_installed',
      asked,
      status: 404,
      answered: `GitHub answered 404: App ${signer.appId} has no installation ${installationId}, which is what it answers when the App is not installed on that repository: ${wordsOf(answer.body)}`,
    });
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new GithubAppError({
      kind: 'http_status',
      asked,
      status: answer.status,
      answered: `GitHub answered ${String(answer.status)}: ${wordsOf(answer.body)}`,
    });
  }

  const reply = asRecord(answer.body);
  const token = text(reply, 'token');
  const expiresAt = text(reply, 'expires_at');
  if (token === undefined || token === '' || expiresAt === undefined || expiresAt === '') {
    throw new GithubAppError({
      kind: 'unparseable',
      asked,
      status: answer.status,
      answered: `GitHub answered ${String(answer.status)}, and the reply carried no installation token and expiry this module could read`,
    });
  }
  return { token, expiresAt };
};

/**
 * Tokens for the installations this process talks to: minted when there is none to use, held
 * while the one it minted still lives, and held **in memory only**.
 *
 * One instance per process is enough and nothing here is module state: the cache lives in
 * this closure, so a test gets its own and two platforms in one process do not share tokens.
 */
export interface GithubInstallationTokens {
  /** A token for this installation, from the cache or freshly minted. */
  readonly tokenFor: (installationId: string) => Promise<string>;
  /**
   * The same, as the `GitHubTokenSource` #297's client takes: a function the client calls at
   * the moment of each call, so a run that outlives one token mints the next by itself.
   */
  readonly tokenSourceFor: (installationId: string) => () => Promise<string>;
}

interface HeldToken {
  readonly token: string;
  /** When this process stops using it: GitHub's expiry, less the margin. */
  readonly stopUsingAtMs: number;
}

export const createGithubInstallationTokens = (
  options: GithubTokenOptions & { readonly marginMs?: number } = {},
): GithubInstallationTokens => {
  const now = options.now ?? Date.now;
  const marginMs = options.marginMs ?? INSTALLATION_TOKEN_MARGIN_MS;
  const held = new Map<string, HeldToken>();
  /** One mint per installation at a time: a hundred sessions starting at once ask once. */
  const minting = new Map<string, Promise<string>>();

  const mint = async (installationId: string): Promise<string> => {
    const mintedAtMs = now();
    const minted = await mintInstallationToken(installationId, options);
    const statedMs = Date.parse(minted.expiresAt);
    // GitHub's own expiry when it parses, never more than an hour from the mint either way,
    // and nothing cached at all when it does not parse: a token whose life is unknown is
    // used for the one call it was minted for.
    const expiresAtMs = Number.isNaN(statedMs)
      ? Number.NaN
      : Math.min(statedMs, mintedAtMs + INSTALLATION_TOKEN_LIFETIME_MS);
    const stopUsingAtMs = expiresAtMs - marginMs;
    if (!Number.isNaN(stopUsingAtMs) && stopUsingAtMs > mintedAtMs) {
      held.set(installationId, { token: minted.token, stopUsingAtMs });
    }
    return minted.token;
  };

  const tokenFor = async (installationId: string): Promise<string> => {
    const have = held.get(installationId);
    if (have !== undefined) {
      if (have.stopUsingAtMs > now()) return have.token;
      held.delete(installationId);
    }
    const already = minting.get(installationId);
    if (already !== undefined) return already;
    const inFlight = (async () => {
      try {
        return await mint(installationId);
      } finally {
        minting.delete(installationId);
      }
    })();
    minting.set(installationId, inFlight);
    return inFlight;
  };

  return {
    tokenFor,
    tokenSourceFor: (installationId) => () => tokenFor(installationId),
  };
};
