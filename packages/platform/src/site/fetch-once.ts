import type { SiteFetch } from './checks.js';

/**
 * The one fetch policy the two HTTP checks share: **one** public request, a short timeout, a
 * redirect followed only back onto the site's own origin, and a byte cap on what is read.
 *
 * It lives in its own module and is written once because **the policy is the security
 * boundary**, not a detail of either check (#237). A token proved through somebody else's
 * origin is not a proof of control, and a check that followed a redirect off-origin would
 * verify whoever that origin belongs to. Both checks call this and neither calls `fetch`.
 *
 * What it will not do, each for a reason rather than an omission:
 *
 * - **No credential, no cookie, no header about the user.** These are public GETs of a public
 *   URL (`#221`: nothing here reads a credential), so no `Authorization`, no `Cookie`, no
 *   workspace id and no account id leaves this process. `credentials: 'omit'` states it to
 *   `fetch` as well as to a reader.
 * - **No redirect followed by the client.** `redirect: 'manual'` so the hop is this module's
 *   decision; the one hop that is followed is onto the site's own origin.
 * - **No unbounded read.** The body is read in chunks against a cap, rather than with
 *   `response.text()`, so a multi-gigabyte answer is dropped after 512 KiB instead of being
 *   buffered first and measured second.
 *
 * A failure is a **sentence, not an exception**: every return is either the body or the clause
 * the checks hand to `noAnswer`, which `checks.ts` prints after _"… did not answer: "_. That
 * is what `#screen-site` promises — _"A failed check says what it looked for, where, and what
 * it found instead. Nothing here is 'something went wrong'"_ — so each way a request can end
 * has its own clause and none of them is a stack trace.
 */

/**
 * How long one check is given, start to finish.
 *
 * Section 13's screens show the check as a single bounded request with no job id and no
 * polling, so the user who pressed "Check the page" waits this long at most. The signal is
 * passed to `fetch`, which also aborts the body stream, so a server that sends headers and
 * then stalls is held to the same five seconds as one that never answers.
 */
export const FETCH_TIMEOUT_MS = 5_000;

/**
 * How much of an answer is read before it is dropped.
 *
 * Generous for a page carrying a `<meta>` tag in its `<head>` and for a file whose only
 * contents are a twelve-character token, and small enough that a hundred checks cannot be
 * made to hold half a gigabyte between them.
 */
export const BODY_LIMIT_BYTES = 512 * 1_024;

/** The request, and the one same-origin redirect it may follow. Nothing walks a chain. */
const MAX_REQUESTS = 2;

/** `fetch` itself — the only thing in this module that reaches the network. */
export const nodeFetch: SiteFetch = (url, init) => fetch(url, init);

/** The body that was read, or the clause saying why there is none. */
export type FetchedBody =
  | {
      readonly ok: true;
      /** Where it was finally read from — the URL asked, or the same-origin hop it named. */
      readonly from: string;
      /** The bytes as text, within the cap. Not trimmed and not parsed: that is the check's. */
      readonly body: string;
    }
  | {
      readonly ok: false;
      /**
       * Why there is no body, written to sit after _"<url> did not answer: "_ — _"it answered
       * 404"_, _"the request timed out after 5 seconds"_. One clause per way a request ends,
       * because a 404 and a refused connection do not share a sentence.
       */
      readonly because: string;
    };

/** The clause, as both a `FetchedBody` and an `Attempt`: nothing was read either way. */
const refuse = (because: string): Extract<FetchedBody, { ok: false }> => ({ ok: false, because });

/** `5 seconds`, `50ms` — the bound as the sentence names it. */
const lasting = (ms: number): string =>
  ms >= 1_000 ? `${Math.round(ms / 1_000)} seconds` : `${ms}ms`;

/** `512 KiB` — the cap as the sentence names it. */
const sized = (bytes: number): string => `${Math.round(bytes / 1_024)} KiB`;

/**
 * Whether a rejection is the timeout firing.
 *
 * `AbortSignal.timeout` aborts with a `TimeoutError`; a reader cancelled by that abort
 * rejects with an `AbortError`. Both mean the same thing to a user, and nothing else here
 * aborts a request.
 */
const isTimeout = (error: unknown): boolean => {
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
};

/**
 * The socket's error code inside whatever `fetch` rejected with.
 *
 * It is never at the top: Node rejects with `TypeError: fetch failed` carrying the real error
 * as `cause`, and for a host with several addresses that cause is an `AggregateError` whose
 * `errors` hold one code each. So the chain is walked — `code`, then `errors`, then `cause` —
 * with a depth bound, because an injected fetcher may reject with anything at all and a cause
 * chain could be circular.
 */
const codeOf = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  const holder = value as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof holder.code === 'string') return holder.code;
  if (Array.isArray(holder.errors)) {
    for (const nested of holder.errors) {
      const found = codeOf(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return codeOf(holder.cause, depth + 1);
};

/** Why a rejected request never reached a server, in the user's words. */
const whyUnreachable = (error: unknown): string => {
  const code = codeOf(error);
  switch (code) {
    case 'ENOTFOUND':
      return 'that domain does not exist';
    case 'EAI_AGAIN':
      return 'that domain could not be looked up';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'ECONNRESET':
      return 'the connection was reset';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'that host could not be reached';
    case 'CERT_HAS_EXPIRED':
      return 'its certificate has expired';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'its certificate could not be verified';
    case undefined:
      return 'the connection could not be made';
    default:
      // Named rather than swallowed: an unrecognised code is still something a user can
      // search for, and it is the one thing we know about why their server said no.
      return `the connection failed with ${code}`;
  }
};

/** One request, or the clause saying why it did not come back. */
type Attempt = { readonly response: Response } | Extract<FetchedBody, { ok: false }>;

const request = async (url: string, fetcher: SiteFetch, timeoutMs: number): Promise<Attempt> => {
  try {
    return {
      response: await fetcher(url, {
        method: 'GET',
        // The policy, stated to `fetch` and not only in prose: the hop is ours to decide,
        // nothing of the user's is sent, and the whole request is bounded.
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(timeoutMs),
      }),
    };
  } catch (error) {
    if (isTimeout(error)) return refuse(`the request timed out after ${lasting(timeoutMs)}`);
    return refuse(whyUnreachable(error));
  }
};

/** Lets go of a body we are not reading, so the socket is not held open until it is collected. */
const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed, already errored, or a stand-in Response of a test. Either way there is
    // nothing left to release, and a check does not fail over tidying up.
  }
};

/**
 * Where a redirect names next, resolved against the URL that answered — or `null` for an
 * answer that is not a redirect.
 *
 * A 3xx with no `Location`, or one naming something that is not a URL, is not a redirect
 * anybody could follow, so it is read as the answer it is (and then as a status).
 */
const redirectedTo = (response: Response, from: string): string | null => {
  if (response.status < 300 || response.status > 399) return null;
  const location = response.headers.get('location');
  if (location === null || location.trim() === '') return null;
  try {
    return new URL(location, from).href;
  } catch {
    return null;
  }
};

/**
 * Whether a hop stays with the site: its own origin, or the same host over https.
 *
 * The https upgrade is allowed deliberately. A site added as `http://clipforge.example` that
 * redirects to `https://clipforge.example` is the **same party** tightening its transport,
 * and refusing it would tell a user that their own site is not their own site — which is
 * exactly the unactionable sentence `#screen-site` rules out. Everything else is refused: a
 * different host, and a downgrade from https to http, are somebody else's answer or an
 * answer nobody can vouch for.
 */
const staysWithTheSite = (to: string, site: string): boolean => {
  let there: URL;
  let here: URL;
  try {
    there = new URL(to);
    here = new URL(site);
  } catch {
    return false;
  }
  if (there.origin === here.origin) return true;
  return (
    here.protocol === 'http:' && there.protocol === 'https:' && there.hostname === here.hostname
  );
};

/** The answer's body, within the cap — or the clause saying why it was not read. */
const readBody = async (
  from: string,
  response: Response,
  timeoutMs: number,
): Promise<FetchedBody> => {
  if (response.status < 200 || response.status > 299) {
    await discard(response);
    // The number, which is the actionable part: 404 sends a user to where they put the file,
    // 500 and 403 to their own server. "Something went wrong" sends them nowhere.
    return refuse(`it answered ${response.status}`);
  }
  // Checked before reading, so a declared oversize answer is dropped without being streamed.
  // A server may lie or omit it, which is why the cap below is the one that is enforced.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    await discard(response);
    return refuse(`its body is larger than ${sized(BODY_LIMIT_BYTES)}`);
  }
  const stream = response.body;
  // A 204, a HEAD-like answer or a stand-in with no stream: an empty body, which is a finding
  // for the check to name and not a failure of the request.
  if (stream === null || stream === undefined) return { ok: true, from, body: '' };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      read += value.byteLength;
      if (read > BODY_LIMIT_BYTES) {
        await reader.cancel();
        return refuse(`its body is larger than ${sized(BODY_LIMIT_BYTES)}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    // The stream broke part-way, or the timeout fired while it was being read. The bytes so
    // far are not an answer — the tag may be in the part that never arrived — so this is the
    // same silence as a request that never connected.
    if (isTimeout(error)) {
      return refuse(
        `the request timed out after ${lasting(timeoutMs)} while the answer was being read`,
      );
    }
    return refuse(whyUnreachable(error));
  }
  return { ok: true, from, body: Buffer.concat(chunks).toString('utf8') };
};

/**
 * Fetch a URL once under the shared policy, and answer with its body or with why there is
 * none.
 *
 * The fetcher is **injected** — as the DNS check's resolver is — so every test of either HTTP
 * check runs against a local fixture or a stub and nothing in the suite reaches the network.
 */
export const fetchOnce = async ({
  url,
  fetch: fetcher = nodeFetch,
  timeoutMs = FETCH_TIMEOUT_MS,
}: {
  url: string;
  fetch?: SiteFetch;
  /** The bound, overridden only by a test that would rather not wait five seconds. */
  timeoutMs?: number;
}): Promise<FetchedBody> => {
  let target = url;
  for (let attempt = 1; ; attempt += 1) {
    const got = await request(target, fetcher, timeoutMs);
    if (!('response' in got)) return got;
    const moved = redirectedTo(got.response, target);
    if (moved === null) return await readBody(target, got.response, timeoutMs);
    await discard(got.response);
    if (!staysWithTheSite(moved, url)) {
      // Named, because where it was being sent is the whole of what the user has to act on:
      // a stale proxy rule, a parked domain, somebody else's CDN.
      return refuse(`it redirected to ${moved}, which is not this site’s own address`);
    }
    if (attempt >= MAX_REQUESTS) {
      return refuse(`it redirected again, to ${moved}, and a check follows one redirect only`);
    }
    target = moved;
  }
};
