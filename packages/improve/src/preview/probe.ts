/**
 * Whether a preview URL answers, and what it answered.
 *
 * A deployment status can name a host that serves nothing: a preview that was torn down, a
 * domain that no longer resolves, a gateway answering 502. A hundred browsers pointed at
 * such a host is a hundred automation failures reported as a comparison, so the URL is
 * asked one question before it is handed on (#300).
 *
 * The probe is a function for the same reason the GitHub transport is one: every test in
 * this package passes its own and no test reaches the network. The default is built on
 * demand rather than on import.
 *
 * Nothing of ours travels with the request. The probe is handed the URL and nothing else —
 * no header, no installation token — because the host it asks is the customer's preview and
 * not GitHub.
 */

export interface PreviewProbeAnswer {
  readonly reachable: boolean;
  /** What the request answered: a status, or what went wrong before there was one. */
  readonly answered: string;
}

/** How a preview URL is asked whether it answers. Handed a URL, and nothing else. */
export type PreviewProbe = (url: string) => Promise<PreviewProbeAnswer>;

/** How long the question may take before silence is the answer. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * What counts as a host serving the change.
 *
 * Below 400 the host is serving something a browser can walk. At 400 and above it answered,
 * but with a page that is not the change: a 404 root, or the 401 a password-protected
 * preview gives. Either would turn every session into a walk of an error page, so it is
 * reported as not usable with the status quoted rather than compared against the baseline.
 */
const SERVES_BELOW = 400;

/** Methods a host may refuse outright, which is not the same as not answering. */
const REFUSES_HEAD = new Set([405, 501]);

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The default probe: one `HEAD`, falling back to `GET` where the host refuses the method.
 * The body is cancelled rather than read, because the question is whether anything answers
 * and a preview's home page is not ours to download.
 */
export const createFetchProbe =
  (options: { readonly timeoutMs?: number } = {}): PreviewProbe =>
  async (url) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    /** One deadline for the whole question, so a slow refusal and a slow retry cannot double it. */
    const signal = AbortSignal.timeout(timeoutMs);
    const ask = (method: 'HEAD' | 'GET'): Promise<Awaited<ReturnType<typeof fetch>>> =>
      fetch(url, { method, redirect: 'follow', signal });

    /**
     * The body is not ours to download, and a cancel that fails says nothing about the
     * host: a connection dropped after the headers is still a host that answered.
     */
    const drop = async (response: Awaited<ReturnType<typeof fetch>>): Promise<void> => {
      try {
        await response.body?.cancel();
      } catch {
        // The status is already in hand, which is the whole question.
      }
    };

    let status: number;
    try {
      const first = await ask('HEAD');
      status = first.status;
      if (REFUSES_HEAD.has(first.status)) {
        await drop(first);
        const second = await ask('GET');
        status = second.status;
        await drop(second);
      } else {
        await drop(first);
      }
    } catch (error) {
      return {
        reachable: false,
        answered: `the request to ${url} answered nothing — ${messageOf(error)}`,
      };
    }

    return {
      reachable: status < SERVES_BELOW,
      answered: `the request to ${url} answered ${String(status)}`,
    };
  };
