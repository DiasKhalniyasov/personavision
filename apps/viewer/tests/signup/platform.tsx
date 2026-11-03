/**
 * The platform's auth routes, served over the stubbed `fetch` the run data already uses, so
 * a sign-up test exercises the screen against the answers
 * `packages/platform/src/server/routes/auth.ts` gives and not against a mocked module.
 *
 * It holds the accounts and workspaces that exist, and one cookie. Everything the screen can
 * do to a real server it can do to this one: create a workspace and be signed in by the
 * cookie that comes back, be refused against one field, be told an email already has a
 * workspace, and find the server not there at all.
 */
import { vi } from 'vitest';
import { serveRunData } from '../app';

/** What the three fields of `#screen-signup` are filled in with here. */
export const NEW_WORKSPACE = {
  email: 'owner@clipforge.example',
  password: 'a-long-enough-password',
  workspaceName: 'ClipForge',
};

/**
 * The sentences a refused sign-up reports, as `SIGNUP_REFUSALS` in
 * `packages/platform/src/server/routes/auth.ts` words them. Each is against one field,
 * which is deliberately not the sign-in route's one vague sentence (decision 17).
 */
export const SIGNUP_REFUSALS = {
  emailMissing: 'Enter your work email.',
  emailMalformed: 'That does not look like an email address.',
  emailTaken: 'That email already has a workspace. Sign in instead.',
  passwordMissing: 'Enter a password.',
  passwordTooShort: 'Use at least twelve characters.',
  workspaceMissing: 'Name your workspace.',
  workspaceTooLong: 'Use 60 characters or fewer.',
  unreadable: 'That sign-up could not be read.',
};

/** The least a password may be, as `MIN_PASSWORD_LENGTH` in `packages/platform` fixes it. */
const MIN_PASSWORD_LENGTH = 12;

/** The most a workspace name may be, as `MAX_WORKSPACE_NAME_LENGTH` fixes it. */
const MAX_WORKSPACE_NAME_LENGTH = 60;

/** The rule `signUp` applies: a local part, an `@`, and a domain with a dot in it. */
const LOOKS_LIKE_AN_EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export interface ServedPlatform {
  /** Every auth path asked for, in order. */
  readonly requests: string[];
  /** What `POST /auth/signup` received: the fields, and whether a password came with them. */
  readonly attempts: { email: string; workspaceName: string; sentPassword: boolean }[];
  /** Whether a session cookie is held — what a reload would send. */
  signedIn: () => boolean;
  /** The workspaces that exist, by name, in the order they were created. */
  workspaces: () => string[];
  /** The run directories the listing holds. Empty: a workspace signed up for owns no test. */
  readonly runIds: string[];
  /** Answers the held `GET /auth/session`, for a test about the unresolved state. */
  release: () => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A refusal, in the shape the route answers with: a sentence and the field it is about. */
const refuse = (status: number, error: string, field: string): Response =>
  json(status, { signedIn: false, error, field });

export async function servePlatform(
  options: {
    /** Somebody is already signed in when the screen mounts. */
    signedIn?: boolean;
    /** An email that already has a workspace, as the seeded demo account's does. */
    taken?: string;
    /** The server is not there at all. */
    unreachable?: boolean;
    /** Hold `GET /auth/session` unanswered until `release` is called. */
    holdSession?: boolean;
    /** Hold `POST /auth/signup` unanswered until `release` is called, so the screen's
     *  in-flight state is observable rather than raced past. */
    holdSignup?: boolean;
    /** What `POST /auth/signup` answers with instead of creating anything. */
    signupAnswers?: { status: number; body?: unknown };
  } = {},
): Promise<ServedPlatform> {
  // A workspace that was just signed up for owns no test and has described no audience, so
  // the screen it lands on reads an empty listing rather than another workspace's run.
  const served = await serveRunData({ runIds: [], audiences: [] });
  // `serveRunData` has just stubbed `fetch` with the run-data mount; the auth routes sit in
  // front of it and everything else falls through, exactly as the server composes them.
  const runData = globalThis.fetch;

  const accounts = new Map<string, { workspaceName: string }>();
  if (options.taken !== undefined) {
    accounts.set(options.taken.toLowerCase(), { workspaceName: 'Northwind Outdoors' });
  }
  const created: string[] = [];
  let signedInAs: string | null = options.signedIn === true ? 'Northwind Outdoors' : null;
  const requests: string[] = [];
  const attempts: { email: string; workspaceName: string; sentPassword: boolean }[] = [];

  let release = (): void => {};
  const held =
    options.holdSession === true || options.holdSignup === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;
  const heldSession = options.holdSession === true ? held : null;
  const heldSignup = options.holdSignup === true ? held : null;

  const signedInBody = (workspaceName: string, email: string) => ({
    signedIn: true,
    account: { id: 'acc-new', email, displayName: `${workspaceName} owner` },
    workspace: { id: workspaceName.toLowerCase().replaceAll(' ', '-'), name: workspaceName },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  /** The owner of the session the cookie names, once there is one. */
  let session: { workspaceName: string; email: string } | null =
    options.signedIn === true
      ? { workspaceName: 'Northwind Outdoors', email: 'owner@northwind.example' }
      : null;

  const signUp = (body: Record<string, unknown>): Response => {
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const workspaceName = String(body.workspaceName ?? '').trim();
    attempts.push({ email, workspaceName, sentPassword: password !== '' });

    const answer = options.signupAnswers;
    if (answer !== undefined) return json(answer.status, answer.body ?? {});

    if (email === '') return refuse(400, SIGNUP_REFUSALS.emailMissing, 'email');
    if (!LOOKS_LIKE_AN_EMAIL.test(email)) {
      return refuse(400, SIGNUP_REFUSALS.emailMalformed, 'email');
    }
    if (password === '') return refuse(400, SIGNUP_REFUSALS.passwordMissing, 'password');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return refuse(400, SIGNUP_REFUSALS.passwordTooShort, 'password');
    }
    if (workspaceName === '') return refuse(400, SIGNUP_REFUSALS.workspaceMissing, 'workspaceName');
    if (workspaceName.length > MAX_WORKSPACE_NAME_LENGTH) {
      return refuse(400, SIGNUP_REFUSALS.workspaceTooLong, 'workspaceName');
    }
    // 409: the one refusal this route makes deliberately specific.
    if (accounts.has(email.toLowerCase())) {
      return refuse(409, SIGNUP_REFUSALS.emailTaken, 'email');
    }

    accounts.set(email.toLowerCase(), { workspaceName });
    created.push(workspaceName);
    session = { workspaceName, email };
    signedInAs = workspaceName;
    return json(200, { ...signedInBody(workspaceName, email), next: '/sites' });
  };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (!pathname.startsWith('/auth/')) return runData(input as RequestInfo, init);

    requests.push(pathname);
    if (options.unreachable === true) throw new TypeError('Failed to fetch');

    if (pathname === '/auth/session') {
      const answer =
        session === null
          ? json(200, { signedIn: false })
          : json(200, signedInBody(session.workspaceName, session.email));
      if (heldSession !== null) await heldSession;
      return answer;
    }
    if (pathname === '/auth/signup') {
      if (heldSignup !== null) await heldSignup;
      return signUp(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    }
    if (pathname === '/auth/signout') {
      session = null;
      signedInAs = null;
      return json(200, { signedIn: false });
    }
    return json(404, { signedIn: false });
  });

  return {
    requests,
    attempts,
    signedIn: () => signedInAs !== null,
    workspaces: () => [...created],
    runIds: served.runIds,
    release: () => {
      release();
    },
  };
}
