import type { IncomingMessage, ServerResponse } from 'node:http';
import { AudienceNotOfferedError } from '../../audience/freeze.js';
import { CapRefusedError } from '../../caps.js';
import {
  DraftNotAcceptedError,
  NoSuchSiteError,
  startSiteTest,
  startTest,
  TestRefusedError,
} from '../../run/start.js';
import type { SiteTestDraft, TestDraft, TestPipeline } from '../../run/start.js';
import type { PlatformStore, SessionRecord } from '../../store/types.js';
import { notImplemented, readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * `POST /runs` — starting a test.
 *
 * The New test screen's one request (#110, merged): the `RunRequest` the contract declares,
 * answered with the id of the run directory the platform opened, or refused with a sentence
 * the form renders above itself with everything typed still in it. No route is invented
 * here — `/runs` is the run family `docs/FLOW.md` section 3 lists, and the screen that calls
 * this shipped already.
 *
 * Everything this decides is `startTest`'s: the mode comes off the workspace and nothing in
 * the body can name it, the audience is resolved against the workspace that asked, and a
 * standard workspace whose test cannot run on the standard model is refused rather than
 * answered by another (#144). This route is the HTTP skin on that, and the status codes.
 *
 * **Two forms, one route and one run.** A submission naming its `variants` is the
 * two-variant comparison, unchanged down to its refusals; anything else is read as the
 * one-URL test the New test wizard collects (#273, #276, #279) — the site, the feature in
 * the user's words, the goal as they approved it and the audience. Both answer with
 * the id of one run directory: a path-1 test is a run with one variant and a path-2 test is
 * a run with two, and nothing here branches on a "path" (the auto-decision of 2026-11-03 on
 * #222).
 *
 * The swarm itself is #54. Until it lands, `personavision serve` passes no pipeline and this
 * answers 501 naming that ticket, so a screen built against it fails loudly.
 */

export interface RunRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /** The swarm (#54). Absent means this deployment cannot run a test at all. */
  pipeline?: TestPipeline;
}

/** The one sentence a request with no session gets, as the audience routes answer it. */
const SIGNED_OUT = 'Sign in to start a test.';

/** The ticket that runs a test, named in the 501 so the developer is not left guessing. */
const ENGINE_TICKET = 54;

const started = (response: ServerResponse, runId: string): void =>
  sendJson(response, 201, { runId });

/**
 * A test that was not started, as `{ error }` — the shape the New test screen reads, whose
 * `error` is the sentence it puts above the form.
 *
 * Every sentence here is written in this package. Nothing from an error thrown underneath
 * it is interpolated, so no key value can travel out through this body (#144).
 */
const refuse = (response: ServerResponse, status: number, error: string, extra = {}): void =>
  sendJson(response, status, { error, ...extra });

/**
 * Which of the two forms was submitted: a comparison **names its `variants`** and a test of
 * one site does not.
 *
 * Read off `variants` rather than off `site`, because the site is the field most likely to
 * be missing from a one-URL submission — a launch step serialising a draft whose site was
 * never chosen leaves the key out altogether — and such a draft has to be refused at `site`
 * rather than answered with a page of refusals about `task` and `variants`, which are the
 * fields the New test wizard cannot render. A submission naming both is two forms at once,
 * and the one-URL path refuses it with the `variants` it found named rather than guessing
 * which half was meant. `variants` is required of a comparison by the contract, so a body
 * that names none was never one.
 */
const namesTwoVersions = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'variants' in body && !('site' in body);

export const runRoutes = ({ store, readSession, pipeline }: RunRouteOptions): Route[] => [
  {
    method: 'POST',
    path: /^\/runs$/,
    handle:
      pipeline === undefined
        ? notImplemented(ENGINE_TICKET, 'Starting a test')
        : async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
            const session = await readSession(request);
            if (session === null) {
              refuse(response, 401, SIGNED_OUT, { signedIn: false });
              return;
            }
            const body = await readJsonBody(request);
            if (body === null) {
              refuse(response, 400, 'That test could not be read.');
              return;
            }

            // The body is whatever was submitted; both functions below parse it against
            // the contract with the workspace's mode over it, and a mode the body named is
            // dropped on the way.
            const test = {
              workspaces: store.workspaces,
              audiences: store.audiences,
              // The workspace's sites: the one the body names is resolved against these
              // alone, and the per-site caps are counted against it.
              sites: store.sites,
              workspaceId: session.workspaceId,
              pipeline,
            };
            try {
              const run = namesTwoVersions(body.value)
                ? await startTest({ ...test, draft: body.value as TestDraft })
                : await startSiteTest({ ...test, draft: body.value as SiteTestDraft });
              started(response, run.runId);
            } catch (error) {
              if (error instanceof DraftNotAcceptedError) {
                refuse(response, 400, 'That test could not be started.', {
                  issues: error.issues,
                });
                return;
              }
              if (error instanceof AudienceNotOfferedError) {
                refuse(response, 400, 'That audience is not one this workspace can test for.');
                return;
              }
              if (error instanceof NoSuchSiteError) {
                // The same sentence `GET /sites/:siteId` gives, and for the same reason: a
                // site of another workspace is missing rather than forbidden. 400 rather
                // than 404, because `POST /runs` is a route that exists — a 404 here would
                // read as the platform not having the route at all.
                refuse(response, 400, error.message);
                return;
              }
              if (error instanceof CapRefusedError) {
                // **429**, with the figures beside the sentence: the cap that refused it, its
                // limit, what was observed and when it next passes. The screen renders the
                // sentence as it is given and draws its countdown from `retryAt`, so the
                // screen, this body and the CLI print one sentence rather than three.
                refuse(response, 429, error.message, {
                  cap: error.cap,
                  limit: error.limit,
                  observed: error.observed,
                  retryAt: error.retryAt,
                });
                return;
              }
              if (error instanceof TestRefusedError) {
                // The model this workspace pays for could not be used. 503, because it is
                // this deployment that cannot serve it rather than the submission that was
                // wrong, and the message is the one the Test failed screen states (#18).
                refuse(response, 503, error.message, { modelMode: error.modelMode });
                return;
              }
              throw error;
            }
          },
  },
];
