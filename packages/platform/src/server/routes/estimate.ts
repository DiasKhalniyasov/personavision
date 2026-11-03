import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionsInFlight } from '../../caps.js';
import {
  acceptedEstimateRequest,
  EstimateNotAcceptedError,
  estimateRun,
  measuredHistoryOfRuns,
} from '../../run/estimate.js';
import type { PlatformStore, SessionRecord } from '../../store/types.js';
import { readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * `POST /runs/estimate` — what a test would take, before anything launches.
 *
 * The launch step's one read (#279): the figures the estimate is made of, answered for a
 * **draft**. Nothing is created, nothing is stored and no run is registered — the one
 * request that may start a test is `POST /runs`, and this is not it. `POST` rather than
 * `GET` because the question is a body of four fields, not a URL; the answer is
 * `cache-control: no-store` like every other platform route.
 *
 * It sits inside the `/runs` family `docs/FLOW.md` section 3 lists, in front of the
 * read-only run-data mount. A run directory is named for the minute it was created, so
 * `/runs/estimate` is a path no run can ever answer to.
 *
 * Scoped to the session's own workspace, like every other platform route: the history the
 * estimate is quoted from is that workspace's runs and no others, so a figure is never
 * computed from a test somebody else ran. A workspace with no finished test gets figures
 * that say so (decision 79), which is a sentence on the screen rather than a refusal — the
 * launch stays available when the estimate cannot be read.
 */

export interface EstimateRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /** The directory the run directories sit in: the measured history, read per request. */
  runsRoot: string;
}

/** The one sentence a request with no session gets, as the other routes answer it. */
const SIGNED_OUT = 'Sign in to estimate a test.';

export const estimateRoutes = ({ store, readSession, runsRoot }: EstimateRouteOptions): Route[] => [
  {
    method: 'POST',
    path: /^\/runs\/estimate$/,
    handle: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const session = await readSession(request);
      if (session === null) {
        sendJson(response, 401, { error: SIGNED_OUT, signedIn: false });
        return;
      }
      const body = await readJsonBody(request);
      if (body === null) {
        sendJson(response, 400, { error: 'That estimate could not be read.' });
        return;
      }
      const workspace = await store.workspaces.byId(session.workspaceId);
      if (workspace === null) {
        sendJson(response, 404, { error: 'There is no such workspace.' });
        return;
      }

      let quotedFor;
      try {
        // The model mode comes off the workspace and nothing in the body can name it — the
        // rule `startTest` already holds to (#144). An estimate at another mode's rates
        // would be a price for a test this workspace cannot run.
        quotedFor = acceptedEstimateRequest(body.value, workspace.modelMode);
      } catch (error) {
        if (error instanceof EstimateNotAcceptedError) {
          // The shape the launch step reads: one sentence above the step, and a message per
          // field for the step that is missing one.
          sendJson(response, 400, {
            error: 'That estimate could not be quoted from what was submitted.',
            issues: error.issues,
          });
          return;
        }
        throw error;
      }

      const history = await measuredHistoryOfRuns({
        runsRoot,
        runIds: workspace.runIds,
      })(quotedFor.siteUrl);
      // The concurrency the estimate divides by is the one the run will really have in
      // flight: the per-site cap, what was submitted, and our own ceiling
      // (`PV_RUNNER_CONCURRENCY`), whichever is smallest. A screen that quoted a speed we
      // will not run at would be a screen that is wrong rather than a ceiling that moved —
      // `startTest` computes the same number from the same function.
      sendJson(
        response,
        200,
        estimateRun(
          { ...quotedFor, concurrency: sessionsInFlight(quotedFor.concurrency) },
          history,
        ),
      );
    },
  },
];
