/**
 * The platform's three auth routes, served over the stubbed `fetch` the run data already
 * uses, so a sign-in test exercises the screen against the answers
 * `packages/platform/src/server/routes/auth.ts` gives and not against a mocked module.
 *
 * It holds one account and one cookie. Everything the screen can do to a real server it
 * can do to this one: sign in with the right credentials, be refused by the wrong ones,
 * sign out, come back after a reload, and find the server not there at all.
 */
import { vi } from 'vitest';
import { serveRunData } from '../app';

/** The seeded demo workspace of `docs/FLOW.md` section 2, as the platform seeds it. */
export const DEMO_ACCOUNT = {
  email: 'owner@northwind.example',
  password: 'the-password-serve-printed',
  displayName: 'Workspace owner',
  workspace: { id: 'northwind-demo', name: 'Northwind Outdoors' },
};

/**
 * The one sentence a refused sign-in reports, as `SIGNIN_FAILED` in
 * `packages/platform/src/server/routes/auth.ts` words it: a wrong password and an address
 * nobody has produce this same sentence, so the form cannot be used to find out which
 * addresses have accounts.
 */
export const SIGNIN_FAILED = 'That email and password do not match an account.';

export interface ServedPlatform {
  /** Every auth path asked for, in order. */
  readonly requests: string[];
  /** What `POST /auth/signin` received: the email, and whether a password came with it. */
  readonly attempts: { email: string; sentPassword: boolean }[];
  /** Whether a session cookie is held — what a reload would send. */
  signedIn: () => boolean;
  /** The run directories the listing holds, newest first. */
  readonly runIds: string[];
  /** Answers the held `GET /auth/session`, for a test about the unresolved state. */
  release: () => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function servePlatform(
  options: {
    signedIn?: boolean;
    unreachable?: boolean;
    account?: typeof DEMO_ACCOUNT;
    /** Hold `GET /auth/session` unanswered until `release` is called. */
    holdSession?: boolean;
  } = {},
): Promise<ServedPlatform> {
  const account = options.account ?? DEMO_ACCOUNT;
  const served = await serveRunData();
  // `serveRunData` has just stubbed `fetch` with the run-data mount; the auth routes sit in
  // front of it and everything else falls through, exactly as the server composes them.
  const runData = globalThis.fetch;

  let cookie = options.signedIn === true;
  const requests: string[] = [];
  const attempts: { email: string; sentPassword: boolean }[] = [];

  let release = (): void => {};
  const held =
    options.holdSession === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  const signedInBody = () => ({
    signedIn: true,
    account: { id: 'acc-demo', email: account.email, displayName: account.displayName },
    workspace: account.workspace,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (!pathname.startsWith('/auth/')) return runData(input as RequestInfo, init);

    requests.push(pathname);
    if (options.unreachable === true) throw new TypeError('Failed to fetch');

    if (pathname === '/auth/session') {
      if (held !== null) await held;
      return cookie ? json(200, signedInBody()) : json(200, { signedIn: false });
    }
    if (pathname === '/auth/signout') {
      cookie = false;
      return json(200, { signedIn: false });
    }
    if (pathname === '/auth/signin') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      attempts.push({
        email: String(body.email ?? ''),
        sentPassword: typeof body.password === 'string' && body.password !== '',
      });
      if (body.email !== account.email || body.password !== account.password) {
        return json(401, { signedIn: false, error: SIGNIN_FAILED });
      }
      cookie = true;
      return json(200, { ...signedInBody(), next: '/' });
    }
    return json(404, { signedIn: false });
  });

  return {
    requests,
    attempts,
    signedIn: () => cookie,
    runIds: served.runIds,
    release: () => {
      release();
    },
  };
}
