import type { IncomingMessage, ServerResponse } from 'node:http';
import { AudienceValidationError, parseAudience } from '@personavision/personas';
import type { Audience } from '@personavision/contract';
import type { AudienceIssue } from '@personavision/personas';
import { peopleOf, withPeople } from '../../audience/people.js';
import type { AudienceWithPeople, GeneratedPeople } from '../../audience/people.js';
import type { AudienceStore, PlatformStore, SessionRecord } from '../../store/types.js';
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
 * An audience that cannot be saved, reported **at the path it is wrong at** so that the form
 * can render each message against the field it concerns (#109). The messages are the
 * schema's own: the audience is declared once, so what is wrong with one is stated once.
 */
const refuse = (response: ServerResponse, issues: readonly AudienceIssue[]): void =>
  sendJson(response, 400, { error: 'That audience could not be saved.', issues });

/** A plain object: something a `PATCH` merges into rather than replaces. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The stored audience with the submitted fields over it, as deep as the submission goes: a
 * `PATCH` naming one end of the age range leaves the other end as it was.
 *
 * A list the submission names replaces the stored list rather than being merged into it
 * position by position — the second device of a mix is not an edit to the first — and a
 * body that is not an object at all replaces the audience, which the schema then refuses.
 */
const merge = (stored: unknown, submitted: unknown): unknown => {
  if (!isPlainObject(stored) || !isPlainObject(submitted)) return submitted;
  return Object.fromEntries([
    ...Object.entries(stored),
    ...Object.entries(submitted).map(([key, value]) => [key, merge(stored[key], value)]),
  ]);
};

/** The submitted audience, validated, or the 400 that says where it is wrong. */
const validated = async (
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
  // The merged result is validated whole, so a changed field cannot break an invariant
  // that spans two of them: the device shares and the age range are checked against the
  // audience as it would stand, not against the fields the submission happened to name.
  try {
    return parseAudience(stored === null ? body.value : merge(stored, body.value));
  } catch (error) {
    if (error instanceof AudienceValidationError) {
      refuse(response, error.issues);
      return null;
    }
    throw error;
  }
};

/**
 * The people the audience generates, or the 400 that says why it generates none.
 *
 * Generated **before** the audience is stored, so that a record nothing can be generated
 * from is never written: every answer carries the people, so one such record would answer
 * for the audience it is in and for every list it appears in — and with no route to delete
 * it, the workspace's audiences would stay unreadable until somebody edited the file.
 */
const generatedOrRefused = (
  response: ServerResponse,
  audience: Audience,
): GeneratedPeople | null => {
  const generated = peopleOf(audience);
  if (generated.issues.length === 0) return generated;
  refuse(response, generated.issues);
  return null;
};

/**
 * `null`, or the 400 saying this workspace already has an audience under the `id` the
 * submission carries.
 *
 * An audience's own `id` is what a run artifact carries by value and what every generated
 * person's `audienceId` names, so it has to name one audience per workspace: a second
 * record under the same id leaves a finished test unable to say which stored audience it
 * was run for, and the people of two audiences indistinguishable by the field that exists
 * to tell them apart. A soft-deleted record keeps its id for the same reason — the tests
 * that used it still name it.
 */
const idTaken = async (
  audiences: AudienceStore,
  workspaceId: string,
  audience: Audience,
  /** The record being edited, whose own id is not a clash with itself. */
  exceptRecordId: string | null,
): Promise<boolean> => {
  const records = await audiences.list(workspaceId, { includeDeleted: true });
  return records.some(
    (record) => record.id !== exceptRecordId && record.audience.id === audience.id,
  );
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
        sendJson(response, 200, { audiences: records.map((record) => withPeople(record)) });
      }),
    },
    {
      method: 'POST',
      path: /^\/audiences$/,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const audience = await validated(request, response, null);
        if (audience === null) return;
        if (await idTaken(audiences, workspaceId, audience, null)) {
          refuse(response, [
            {
              path: 'id',
              message: `this workspace already has an audience with the id "${audience.id}": a test records the audience it ran for by this id, so it names one audience`,
            },
          ]);
          return;
        }
        const generated = generatedOrRefused(response, audience);
        if (generated === null) return;
        answer(response, 201, withPeople(await audiences.create(workspaceId, audience), generated));
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
        // A soft-deleted audience is readable and is not editable: the user said they were
        // done describing these customers, and the tests that used it report what it was
        // then. It is the same answer `audienceForNewTest` gives for the same reason.
        if (record === null || record.deletedAt !== null) {
          sendJson(response, 404, { error: NO_SUCH_AUDIENCE });
          return;
        }
        const audience = await validated(request, response, record.audience);
        if (audience === null) return;
        if (await idTaken(audiences, workspaceId, audience, record.id)) {
          refuse(response, [
            {
              path: 'id',
              message: `this workspace already has another audience with the id "${audience.id}"`,
            },
          ]);
          return;
        }
        const generated = generatedOrRefused(response, audience);
        if (generated === null) return;
        answer(
          response,
          200,
          withPeople(await audiences.update(workspaceId, audienceId, audience), generated),
        );
      }),
    },
  ];
};
