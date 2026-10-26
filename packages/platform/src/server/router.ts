import type { IncomingMessage } from 'node:http';
import { sendJson } from './routes/types.js';
import type { Middleware, Route } from './routes/types.js';

/**
 * The platform routes in front of everything else. A path no route claims falls through —
 * to the run-data mount, and then to the app, so a screen's route resolves on a refresh.
 */

const pathnameOf = (request: IncomingMessage): string =>
  new URL(request.url ?? '/', 'http://localhost').pathname;

/**
 * `true` when the browser is navigating to this path rather than fetching it. Both
 * signals are sent by every browser this product runs in; a programmatic `fetch` sends
 * neither, which is exactly the request a `jsonOnly` route is for.
 */
const isNavigation = (request: IncomingMessage): boolean =>
  request.headers['sec-fetch-dest'] === 'document' ||
  (request.headers.accept ?? '').includes('text/html');

export const routeMount = (routes: readonly Route[]): Middleware => {
  const answer = async (request: IncomingMessage, response: Parameters<Middleware>[1]) => {
    const pathname = pathnameOf(request);
    const route = routes.find(
      (candidate) =>
        candidate.method === request.method &&
        candidate.path.test(pathname) &&
        !(candidate.jsonOnly === true && isNavigation(request)),
    );
    if (route === undefined) return false;
    await route.handle(request, response);
    return true;
  };

  return (request, response, next) => {
    answer(request, response)
      .then((answered) => {
        if (!answered) next();
      })
      .catch((error: unknown) => {
        // Why it failed goes to whoever runs the server, never to whoever asked.
        process.stderr.write(`personavision: ${pathnameOf(request)} failed: ${String(error)}\n`);
        if (!response.headersSent) sendJson(response, 500, { error: 'The request failed.' });
        else response.destroy();
      });
  };
};
