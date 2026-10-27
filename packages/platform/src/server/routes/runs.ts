import type { IncomingMessage, ServerResponse } from 'node:http';
import { AudienceNotOfferedError } from '../../audience/freeze.js';
import { DraftNotAcceptedError, startTest, TestRefusedError } from '../../run/start.js';
import type { TestDraft, TestPipeline } from '../../run/start.js';
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

            try {
              const run = await startTest({
                workspaces: store.workspaces,
                audiences: store.audiences,
                workspaceId: session.workspaceId,
                // The body is whatever was submitted; `startTest` parses it against the
                // contract with the workspace's mode over it, and a mode the body named is
                // dropped on the way.
                draft: body.value as TestDraft,
                pipeline,
              });
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
