import { createContext, use, useEffect, useSyncExternalStore } from 'react';
import { clearRunCache } from './useRun';

/**
 * Who is signed in. The **only** place the viewer asks.
 *
 * It asks `GET /auth/session`, which `packages/platform` answers with the account and the
 * workspace a session cookie names, or with nobody — that is an answer and not a failure,
 * because `/`, `/signin` and `/demo` are public and their chrome reads it too.
 *
 * One read per app, held in the module below, so the chrome and the screen inside it share
 * the answer and the session is resolved **before the first screen paints**: every consumer
 * sees `loading` until it is, which is what keeps a redirect from flashing the other screen.
 * Signing in and signing out write the answer straight into that store, so no screen
 * re-reads it and nothing reloads the page.
 *
 * A test — and #124's public demo page — supplies its own answer with `SessionContext`.
 */

export interface AccountSession {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly account: { readonly name: string; readonly email: string };
}

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: AccountSession };

/**
 * The seeded demo workspace of `docs/FLOW.md` section 2: a fresh install has one, and its
 * latest test is the committed example run. The words are the prototype's own.
 *
 * It is no longer what the app answers with — the server is — and it stays as the session a
 * test mounts the app with when the test is not about signing in.
 */
export const DEMO_SESSION: SessionState = {
  status: 'signed-in',
  session: {
    workspace: { id: 'northwind-demo', name: 'Northwind Outdoors' },
    account: { name: 'Workspace owner', email: 'owner@northwind.example' },
  },
};

/** The platform's own routes, as `packages/platform/src/server/routes/auth.ts` mounts them. */
const SESSION_URL = '/auth/session';
const SIGNIN_URL = '/auth/signin';
const SIGNOUT_URL = '/auth/signout';

/** The platform is served from the site root; `fetch` wants an absolute URL in a test. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/**
 * What the three auth routes answer with, read defensively.
 *
 * The shape is `AuthBody` in `packages/platform`, which the viewer does not depend on: this
 * app is the browser half of the same contract and names the fields it reads. A body
 * missing one of them is nobody signed in rather than a half-rendered chrome.
 */
interface AuthBody {
  signedIn?: unknown;
  account?: { email?: unknown; displayName?: unknown };
  workspace?: { id?: unknown; name?: unknown };
  error?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The session an answer carries, or `null` for a body that names nobody. */
const sessionOf = (body: AuthBody): AccountSession | null => {
  if (body.signedIn !== true) return null;
  const id = text(body.workspace?.id);
  const name = text(body.workspace?.name);
  const email = text(body.account?.email);
  if (id === null || name === null || email === null) return null;
  // The display name is the one field a signed-in answer may reasonably not carry; the
  // email always identifies the account, and the account menu shows that.
  return {
    workspace: { id, name },
    account: { name: text(body.account?.displayName) ?? email, email },
  };
};

/* ---- The one answer, shared ---------------------------------------------- */

let state: SessionState = { status: 'loading' };
const listeners = new Set<() => void>();
let reading: Promise<void> | null = null;

const publish = (next: SessionState): void => {
  state = next;
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = (): SessionState => state;

/**
 * Read a body as JSON, whatever the status. A refused sign-in is a 401 with a sentence in
 * it, so the status alone is never the whole answer.
 */
const readBody = async (response: Response): Promise<AuthBody> => {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as AuthBody) : {};
  } catch {
    return {};
  }
};

const signedOut = (): SessionState => ({ status: 'signed-out' });

/**
 * Ask the server who is signed in. Once per app: the answer is kept in the store above.
 *
 * A read that did not get an answer is not remembered — `reading` is dropped, the way
 * `useRun` drops a listing it could not read — so the next screen to mount asks again
 * rather than treating one unreachable moment as the session for the rest of the visit.
 */
const readSession = (): Promise<void> => {
  reading ??= (async () => {
    try {
      const response = await fetch(absolute(SESSION_URL), { credentials: 'same-origin' });
      if (!response.ok) {
        reading = null;
        publish(signedOut());
        return;
      }
      const session = sessionOf(await readBody(response));
      publish(session === null ? signedOut() : { status: 'signed-in', session });
    } catch {
      // A server that cannot be reached is not a session: the visitor is signed out, which
      // sends a protected route to `/signin`, where the failure can be acted on.
      reading = null;
      publish(signedOut());
    }
  })();
  return reading;
};

/** What a sign-in attempt came back with. `error` is the one sentence the screen renders. */
export type SignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly unreachable: boolean };

/** The sentence a server that cannot be reached reports. */
const UNREACHABLE = 'The server could not be reached. Check that it is running, then try again.';
/** The sentence a refusal with no sentence of its own reports. */
const REFUSED = 'That email and password do not match an account.';

/**
 * Sign in. The password is sent as JSON in the body of a POST and is held nowhere else:
 * not in this module, not in a URL, and never written to the console.
 *
 * On success the store carries the new session, so the chrome names the workspace on the
 * next render with nothing reloaded, and every run read under the old session is forgotten.
 */
export const signIn = async (credentials: {
  email: string;
  password: string;
}): Promise<SignInResult> => {
  let response: Response;
  try {
    response = await fetch(absolute(SIGNIN_URL), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } catch {
    return { ok: false, error: UNREACHABLE, unreachable: true };
  }

  const body = await readBody(response);
  const session = response.ok ? sessionOf(body) : null;
  if (session === null) {
    return { ok: false, error: text(body.error) ?? REFUSED, unreachable: false };
  }

  clearRunCache();
  // The session is the server's answer, not the request's: a reload reads the same thing.
  reading = Promise.resolve();
  publish({ status: 'signed-in', session });
  return { ok: true };
};

/**
 * Sign out: the server deletes the record and empties the cookie, and this app forgets both
 * the session and every run it read under it — so a reload does not get back in, and the
 * next sign-in reads its own workspace's tests rather than the last one's.
 *
 * The visitor is signed out here whatever the server answered. A request that never arrived
 * leaves the cookie in place and the next protected route finds that out; what must not
 * happen is a chrome still naming a workspace the user has asked to leave.
 */
export const signOut = async (): Promise<void> => {
  try {
    await fetch(absolute(SIGNOUT_URL), { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Nothing to tell the user here: they are leaving either way.
  }
  clearRunCache();
  reading = Promise.resolve();
  publish(signedOut());
};

/** Ask the server again on the next render. For tests, and for a screen that has to retry. */
export const forgetSession = (): void => {
  reading = null;
  publish({ status: 'loading' });
};

/** Overrides the server's answer: #124's public demo page provides one, and a test its own. */
export const SessionContext = createContext<SessionState | null>(null);

/**
 * Who is signed in: the override above it, or the one answer this app reads.
 *
 * The read is fired from an effect rather than during a render, so no component suspends on
 * it and the first paint is the quiet loading state the shell and this screen draw.
 */
export function useSession(): SessionState {
  const override = use(SessionContext);
  const live = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (override === null) void readSession();
  }, [override]);

  return override ?? live;
}

/** The initials the account menu shows, from the workspace this session is in. */
export const workspaceInitials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
