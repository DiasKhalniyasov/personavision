import type { IncomingMessage, ServerResponse } from 'node:http';
import { AudienceValidationError, parseAudience } from '@personavision/personas';
import type { Audience } from '@personavision/contract';
import { withPeople } from '../../audience/people.js';
import type { AudienceWithPeople } from '../../audience/people.js';
import type { PlatformStore, SessionRecord } from '../../store/types.js';
import { readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * Audience storage: the workspace's audiences, and the people each would generate.
 *
 * Four routes, all of them the session's own workspace and no other, and every one of them
 * answering with the audience **and the people it generates** — the Audience screens (#109)
 * show who a test would run on before the test exists, and they read it here rather than
 * running the generator in a browser.
 *
 * The two `GET`s are `jsonOnly`, because `/audiences` and `/audiences/:audienceId` are also
 * the app's own screens (`docs/FLOW.md` section 3) and a browser navigating to one wants the
 * screen. There is no `DELETE`: section 3 lists the routes, section 8 says they are not
 * invented per ticket, and retiring an audience is `AudienceStore.softDelete`.
 */

/** Matched by the router, and read here for the id it captures. */
const AUDIENCE_PATH = /^\/audiences\/([^/]+)$/;

export interface AudienceRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
}

/**
 * The one sentence a request with no session gets. The guard in front of these routes
 * answers it first for a signed-out request; this is the same answer where the handler is
 * reached directly, so the seam does not depend on something above it having run.
 */
const SIGNED_OUT = 'Sign in to read this.';

/** An audience of another workspace is missing, not forbidden: that it exists is not news. */
const NO_SUCH_AUDIENCE = 'There is no such audience.';

const audienceIdOf = (request: IncomingMessage): string => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const captured = AUDIENCE_PATH.exec(pathname)?.[1] ?? '';
  try {
    return decodeURIComponent(captured);
  } catch {
    // A half-escaped path names no audience, and it is not worth a 500 to say so.
    return captured;
  }
};

/** What a route answers with: the audience, its people, and when it was last written. */
const answer = (response: ServerResponse, status: number, record: AudienceWithPeople): void =>
  sendJson(response, status, record);

/**
 * An audience the contract's schema refuses, reported **at the path it is wrong at** so that
 * the form can render each message against the field it concerns (#109). The messages are
 * the schema's own: the audience is declared once, so what is wrong with one is stated once.
 */
const refuse = (response: ServerResponse, error: AudienceValidationError): void =>
  sendJson(response, 400, {
    error: 'That audience could not be saved.',
    issues: error.issues,
  });

/** The submitted audience, validated, or the 400 that says where it is wrong. */
const submitted = async (
  request: IncomingMessage,
  response: ServerResponse,
  /** What a `PATCH` is merged over; `null` for a `POST`, which carries the whole audience. */
  stored: Audience | null,
): Promise<Audience | null> => {
  const body = await readJsonBody(request);
  if (body === null) {
    sendJson(response, 400, { error: 'That audience could not be read.' });
    return null;
  }
  // A `PATCH` names the fields it changes and the rest stay as they are; a body carrying
  // the whole audience replaces it, which is what the form submits. Either way the merged
  // result is validated whole, so a changed field cannot break an invariant across two.
  const merged =
    stored !== null && typeof body.value === 'object' && body.value !== null
      ? { ...stored, ...body.value }
      : body.value;
  try {
    return parseAudience(merged);
  } catch (error) {
    if (error instanceof AudienceValidationError) {
      refuse(response, error);
      return null;
    }
    throw error;
  }
};

/** A handler that needs a workspace: the session's, or 401. */
const inWorkspace =
  (
    { readSession }: AudienceRouteOptions,
    handle: (
      workspaceId: string,
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      sendJson(response, 401, { error: SIGNED_OUT, signedIn: false });
      return;
    }
    await handle(session.workspaceId, request, response);
  };

export const audienceRoutes = (options: AudienceRouteOptions): Route[] => {
  const { audiences } = options.store;

  return [
    {
      method: 'GET',
      path: /^\/audiences$/,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, _request, response) => {
        // Soft-deleted audiences are left out: this is the list a new test chooses from.
        const records = await audiences.list(workspaceId);
        sendJson(response, 200, { audiences: records.map(withPeople) });
      }),
    },
    {
      method: 'POST',
      path: /^\/audiences$/,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const audience = await submitted(request, response, null);
        if (audience === null) return;
        answer(response, 201, withPeople(await audiences.create(workspaceId, audience)));
      }),
    },
    {
      method: 'GET',
      path: AUDIENCE_PATH,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        // A soft-deleted audience is readable here: a finished test names it, and the
        // screen that reports that test has to be able to say which audience it was.
        const record = await audiences.byId(workspaceId, audienceIdOf(request));
        if (record === null) {
          sendJson(response, 404, { error: NO_SUCH_AUDIENCE });
          return;
        }
        answer(response, 200, withPeople(record));
      }),
    },
    {
      method: 'PATCH',
      path: AUDIENCE_PATH,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const audienceId = audienceIdOf(request);
        const record = await audiences.byId(workspaceId, audienceId);
        if (record === null) {
          sendJson(response, 404, { error: NO_SUCH_AUDIENCE });
          return;
        }
        const audience = await submitted(request, response, record.audience);
        if (audience === null) return;
        answer(
          response,
          200,
          withPeople(await audiences.update(workspaceId, audienceId, audience)),
        );
      }),
    },
  ];
};
