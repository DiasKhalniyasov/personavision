import { extname } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { isNavigation } from '../server/router.js';
import { sendJson } from '../server/routes/types.js';
import type { Middleware } from '../server/routes/types.js';
import type { SessionRecord } from '../store/types.js';

/**
 * Signed out means `/signin` — in front of every route, the run data and the app.
 *
 * Two answers, because two kinds of request are asking. A **page** request is redirected
 * to `/signin` carrying where it was going, so a link somebody shared survives a sign-in
 * and lands on what it pointed at. A **data** request gets 401 and no redirect, because a
 * `fetch` that followed one would parse the sign-in page as its payload and the viewer
 * could not tell "sign in" from "this is the answer".
 *
 * What is public is fixed by `docs/FLOW.md` section 3: the landing page at `/`, the
 * read-only `/demo`, `/signin` itself, and the two auth routes those pages use. Nothing
 * else is, including every app screen and every route the next tickets fill in.
 */

/** Where a signed-out page request is sent. The screen is `apps/viewer`'s (#12). */
export const SIGNIN_PATH = '/signin';

/**
 * The paths that answer without a session. `/` is the landing page and `/demo` the
 * committed example run's Verdict, read-only — both public by the owner's direction on
 * #1, which replaced the straight redirect from `/` to `/signin`.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/',
  SIGNIN_PATH,
  '/demo',
  '/auth/signin',
  // Reading the session is how the chrome on a public page knows there is nobody signed
  // in; it answers that rather than 401, so the landing page renders without an error.
  '/auth/session',
  // Signing out is idempotent: an expired cookie is already signed out, and saying 401 to
  // somebody pressing "sign out" would be a dead end rather than an answer.
  '/auth/signout',
]);

export interface GuardOptions {
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
}

/**
 * A path that **names a file** rather than a screen: the viewer's own bundles and fonts,
 * and the run data on the documented read-only paths.
 *
 * Neither is let through unscoped. Run data is scoped where it is served — the mount is
 * handed the runs this request's session may read, so a signed-out request reaches the
 * seeded demo run and answers 404 for anything else, which is also how another
 * workspace's run stays undisclosed rather than becoming a 401 that confirms it exists.
 * The viewer's bundles are the same bytes for everybody and have to load for `/signin`
 * itself to render.
 */
const namesAFile = (pathname: string): boolean => extname(pathname) !== '';

/**
 * Where to send the user back to after signing in, or `null` for a path not worth
 * carrying. Only a path of this site: a value starting `//` or `/\` is a URL somewhere
 * else to a browser, and a redirect that honoured it would hand sign-in to whoever wrote
 * the link.
 */
export const safeNextPath = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value === '/' || value.startsWith(`${SIGNIN_PATH}?`) || value === SIGNIN_PATH) return null;
  return value;
};

export const sessionGuard = ({ readSession }: GuardOptions): Middleware => {
  const answer = async (
    request: IncomingMessage,
    response: Parameters<Middleware>[1],
  ): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (PUBLIC_PATHS.has(url.pathname) || namesAFile(url.pathname)) return false;
    if ((await readSession(request)) !== null) return false;

    if (!isNavigation(request)) {
      sendJson(response, 401, { error: 'Sign in to read this.', signedIn: false });
      return true;
    }
    const next = safeNextPath(`${url.pathname}${url.search}`);
    response.writeHead(302, {
      location: next === null ? SIGNIN_PATH : `${SIGNIN_PATH}?next=${encodeURIComponent(next)}`,
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end('Sign in first.\n');
    return true;
  };

  return (request, response, next) => {
    answer(request, response)
      .then((answered) => {
        if (!answered) next();
      })
      .catch((error: unknown) => {
        // A cookie this server did not write is signed out, not an error, so reaching here
        // is the store failing. Why goes to whoever runs the server, never to the browser.
        process.stderr.write(`personavision: could not read the session: ${String(error)}\n`);
        if (!response.headersSent) sendJson(response, 500, { error: 'The request failed.' });
        else response.destroy();
      });
  };
};
