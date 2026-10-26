import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeNextPath } from '../../auth/guard.js';
import { signIn } from '../../auth/signin.js';
import type {
  AccountRecord,
  PlatformStore,
  SessionRecord,
  WorkspaceRecord,
} from '../../store/types.js';
import { clearedSessionCookieHeader, isSecureRequest } from '../session.js';
import { sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * Sign-in, sign-out and the session the signed-in chrome reads.
 *
 * `POST /auth/signin` — email and password in, a session cookie out, or one deliberately
 * vague failure. `POST /auth/signout` — the record is deleted and the cookie emptied.
 * `GET /auth/session` — who is signed in and which workspace they are looking at, or that
 * nobody is, which is what the public landing page's chrome reads.
 *
 * A cookie that is expired, unknown or badly signed is signed out everywhere here. It is
 * never an error the user has to understand, and never a 500.
 */

/**
 * The one failure a sign-in can report. A wrong password and an email nobody has produce
 * this same sentence and the same status, so the answer cannot be used to find out which
 * addresses have accounts. `signIn` does the same work either way, so neither can the
 * time it took.
 */
const SIGNIN_FAILED = 'That email and password do not match an account.';

/** A body larger than this is not a sign-in form, and is refused before it is read. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AuthRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /** The `set-cookie` value for a new session, signed with this data directory's key. */
  sessionCookie: (sessionId: string, options: { secure: boolean }) => string;
  /** How long a new session lasts, absolutely. */
  lifetimeSeconds: number;
}

/**
 * The submitted fields, from JSON or from a form post. Both are accepted because the
 * sign-in screen is a form: built with `fetch` it sends JSON, submitted by the browser
 * itself it sends `application/x-www-form-urlencoded`, and neither should be a 400 that
 * says nothing about which of the two the server wanted.
 */
const readFields = async (request: IncomingMessage): Promise<Record<string, string> | null> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (body === '') return {};
  const type = request.headers['content-type'] ?? '';
  if (type.includes('x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Only the strings are kept: a field sent as a number or an object is not a credential.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return null;
  }
};

/** What `/auth/session` and a completed sign-in say about who is signed in. */
const signedInBody = (
  account: AccountRecord,
  workspace: WorkspaceRecord,
  session: SessionRecord,
): Record<string, unknown> => ({
  signedIn: true,
  account: { id: account.id, email: account.email, displayName: account.displayName },
  workspace: { id: workspace.id, name: workspace.name },
  expiresAt: session.expiresAt,
});

const signinHandler =
  ({ store, sessionCookie, lifetimeSeconds }: AuthRouteOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const fields = await readFields(request);
    if (fields === null) {
      sendJson(response, 400, { error: 'That sign-in could not be read.' });
      return;
    }
    const email = fields.email ?? '';
    const password = fields.password ?? '';
    if (email === '' || password === '') {
      sendJson(response, 400, { error: 'Enter your email and your password.' });
      return;
    }

    const signedIn = await signIn({ email, password }, { store, lifetimeSeconds });
    if (signedIn === null) {
      // 401 and one sentence. Nothing here — not the status, not the body, not a header —
      // differs between a wrong password and an address nobody has.
      sendJson(response, 401, { error: SIGNIN_FAILED, signedIn: false });
      return;
    }

    response.setHeader(
      'set-cookie',
      sessionCookie(signedIn.session.id, { secure: isSecureRequest(request) }),
    );
    sendJson(response, 200, {
      ...signedInBody(signedIn.account, signedIn.workspace, signedIn.session),
      // Where the guard was sending them before they were asked to sign in, so a shared
      // link survives it. Sanitised the same way the redirect was: only a path of this
      // site, never a URL somewhere else.
      next: safeNextPath(fields.next) ?? '/',
    });
  };

const signoutHandler =
  ({ store, readSession }: AuthRouteOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    // Deleting the record is what signing out means: the cookie is cleared as well, but a
    // copy of it kept elsewhere is signed out too, because the record it named is gone.
    if (session !== null) await store.sessions.delete(session.id);
    response.setHeader(
      'set-cookie',
      clearedSessionCookieHeader({ secure: isSecureRequest(request) }),
    );
    sendJson(response, 200, { signedIn: false });
  };

const sessionHandler =
  ({ store, readSession }: AuthRouteOptions) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      // Not 401: the landing page and `/demo` are public, and their chrome reads this to
      // find out there is nobody signed in. That is an answer, not a failure.
      sendJson(response, 200, { signedIn: false });
      return;
    }
    const [account, workspace] = await Promise.all([
      store.accounts.byId(session.accountId),
      store.workspaces.byId(session.workspaceId),
    ]);
    if (account === null || workspace === null) {
      // The record outlived what it pointed at. The session is of no further use, so it
      // is deleted and the request is signed out rather than being handed a half-answer.
      await store.sessions.delete(session.id);
      response.setHeader(
        'set-cookie',
        clearedSessionCookieHeader({ secure: isSecureRequest(request) }),
      );
      sendJson(response, 200, { signedIn: false });
      return;
    }
    sendJson(response, 200, signedInBody(account, workspace, session));
  };

export const authRoutes = (options: AuthRouteOptions): Route[] => [
  { method: 'POST', path: /^\/auth\/signin$/, handle: signinHandler(options) },
  { method: 'POST', path: /^\/auth\/signout$/, handle: signoutHandler(options) },
  { method: 'GET', path: /^\/auth\/session$/, handle: sessionHandler(options) },
];
