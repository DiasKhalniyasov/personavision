import { vi } from 'vitest';

/**
 * The two things a browser gives the app's own modules, and the only two the walk has to
 * stand in for: **where the page is** and **a cookie jar**.
 *
 * Every module in this app that fetches resolves its path against `window.location.href`,
 * so a walk outside a browser has to say where the page is — and the port is chosen by the
 * operating system, which is why it cannot be a fixed jsdom URL. And `fetch` in Node sends
 * no cookie and keeps none, while every one of these modules asks `same-origin`: without a
 * jar, the session the sign-up sets would be thrown away and every step after it would be
 * signed out.
 *
 * Nothing else is stood in for. The requests, their methods, their headers, their bodies and
 * the parsing of what comes back are the app's own, which is the whole point of the walk.
 */

/**
 * Whether the server answered nothing because the connection it would have answered on was
 * already gone.
 *
 * `node:http` drops an idle keep-alive socket after five seconds, and a step of this walk —
 * the launch, which answers only once the run exists — can take longer than that under load:
 * the next request then picks the dead socket out of the pool and is terminated before the
 * server ever sees it. A browser opens a new connection and asks again.
 */
const closedBeforeAnswering = (error: unknown): boolean => {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === 'UND_ERR_SOCKET') return true;
  }
  return false;
};

/**
 * Whether asking again is safe. `UND_ERR_SOCKET` is raised both for a socket that was
 * already dead — nothing was sent — and for a connection dropped after the server had the
 * request, and nothing in the error tells the two apart. So only a **read** is ever repeated:
 * a replayed `POST /auth/signup` would answer 409 about an account that now exists, and a
 * replayed `POST /runs` would start a second run in the runs root the walk is reading.
 *
 * That is enough for this walk, and not by luck: the one gap long enough to lose a socket is
 * the launch, and every request after it is a read of the run.
 */
const worthAskingAgain = (init: RequestInit | undefined): boolean => {
  const method = (init?.method ?? 'GET').toUpperCase();
  return (method === 'GET' || method === 'HEAD') && init?.body === undefined;
};

export interface BrowserAt {
  /** The wrapped `fetch`, for a module that takes one rather than reading the global. */
  readonly fetch: typeof globalThis.fetch;
  /** The cookies this jar holds, as a request header, or `null` while it holds none. */
  readonly cookie: () => string | null;
  readonly restore: () => void;
}

export const browserAt = (base: string): BrowserAt => {
  const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  /** One entry per cookie, by name, so a response setting a second one loses neither. */
  const jar = new Map<string, string>();

  const held = (): string | null => (jar.size === 0 ? null : [...jar.values()].join('; '));

  /**
   * Every `set-cookie` of a response, kept by name — and dropped where the value is empty,
   * which is the platform signing this browser out.
   *
   * `getSetCookie` and not `get('set-cookie')`: the second folds several headers into one
   * comma-joined string, and a jar reading the first pair out of that would keep the wrong
   * cookie the day a response carries two.
   */
  const keep = (response: Response): void => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0]?.trim() ?? '';
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at);
      if (pair.slice(at + 1) === '') jar.delete(name);
      else jar.set(name, pair);
    }
  };

  const fetched: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const cookie = held();
    if (cookie !== null) headers.set('cookie', cookie);
    const sent = { ...init, headers };

    let response: Response;
    try {
      response = await realFetch(input, sent);
    } catch (error) {
      if (!closedBeforeAnswering(error) || !worthAskingAgain(init)) throw error;
      response = await realFetch(input, sent);
    }

    keep(response);
    return response;
  };

  vi.stubGlobal('window', { location: { href: base } });
  vi.stubGlobal('fetch', fetched);

  return { fetch: fetched, cookie: held, restore: () => vi.unstubAllGlobals() };
};
