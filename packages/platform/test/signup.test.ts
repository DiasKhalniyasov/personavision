import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import type { AuthBody } from '../src/server/routes/auth.js';
import { SESSION_COOKIE } from '../src/server/session.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * `POST /auth/signup` — the way in, asserted over HTTP.
 *
 * What is proved here is what a request gets back: one account and one workspace for a
 * valid sign-up, the same `AuthBody` a completed sign-in answers with and a session cookie
 * that really is a session; a refusal against the field it is about, with nothing created;
 * and the one refusal this route makes deliberately specific — an email that already has a
 * workspace is told so, because a sign-up that pretends to succeed leaves a person stuck
 * forever. `POST /auth/signin` keeps its one vague sentence, and `auth.test.ts` holds it.
 */

/** The answer the routes declare, so the shape is read from the compiler, not restated. */
const body = async (response: Response): Promise<AuthBody> => (await response.json()) as AuthBody;

/** What the sign-up screen sends, as `#screen-signup` of the prototype asks for it. */
const FIELDS = {
  email: 'owner@clipforge.example',
  password: 'a-long-enough-password',
  workspaceName: 'ClipForge',
} as const;

describe('signing up', () => {
  let served: TestServer;

  const signUp = (fields: Record<string, string>): Promise<Response> =>
    served.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });

  /** The account an email has, or `null` — what "nothing was created" is asserted against. */
  const accountFor = (email: string) => served.platform.store.accounts.byEmail(email);

  beforeEach(async () => {
    served = await startTestServer();
  });

  afterEach(() => served.close());

  it('creates one account and one workspace, and answers as a completed sign-in does', async () => {
    const response = await signUp({ ...FIELDS });
    const read = await body(response);

    expect(response.status).toBe(200);
    expect(read.signedIn).toBe(true);
    expect(read.account?.email).toBe(FIELDS.email);
    expect(read.workspace?.name).toBe(FIELDS.workspaceName);
    expect(read.expiresAt).toBeTruthy();
    // Where a completed sign-up lands: adding a site and proving it is yours.
    expect(read.next).toBe('/sites');
    expect(cookieOf(response)).toContain(`${SESSION_COOKIE}=`);

    const account = await accountFor(FIELDS.email);
    expect(account?.displayName).toBeTruthy();
    const workspaces = await served.platform.store.workspaces.forAccount(account?.id ?? '');
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.memberAccountIds).toEqual([account?.id]);
  });

  it('opens a session the browser is already signed in with', async () => {
    const cookie = cookieOf(await signUp({ ...FIELDS }));

    // The cookie alone, with nothing else: who the chrome then names.
    const session = await served.request('/auth/session', { headers: { cookie } });
    const read = await body(session);
    expect(read.signedIn).toBe(true);
    expect(read.workspace?.name).toBe(FIELDS.workspaceName);

    // And a protected page is served rather than redirected to `/signin`.
    expect((await served.navigate('/sites', cookie)).status).toBe(200);
  });

  it('creates a workspace that owns no audience, no site and no run yet', async () => {
    const workspaceId = (await body(await signUp({ ...FIELDS }))).workspace?.id ?? '';
    const { store } = served.platform;

    expect((await store.workspaces.byId(workspaceId))?.runIds).toEqual([]);
    expect(await store.audiences.list(workspaceId)).toEqual([]);
    expect(await store.sites.list(workspaceId)).toEqual([]);
    // Nothing of this workspace is readable without a session: `demoRunId` is the seeded
    // demo run's alone, and a workspace somebody signed up for publishes nothing.
    expect((await store.workspaces.byId(workspaceId))?.demoRunId).toBeNull();
  });

  it('stores the password only as a verifier the new credentials then sign in with', async () => {
    await signUp({ ...FIELDS });

    const account = await accountFor(FIELDS.email);
    expect(account?.password.algorithm).toBe('scrypt');
    expect(JSON.stringify(account)).not.toContain(FIELDS.password);

    const signedIn = await served.signIn({ email: FIELDS.email, password: FIELDS.password });
    expect(signedIn.status).toBe(200);
    expect((await body(signedIn)).workspace?.name).toBe(FIELDS.workspaceName);
  });

  it('reads the email the way sign-in looks it up: trimmed, and case does not matter', async () => {
    await signUp({ ...FIELDS, email: `  ${FIELDS.email.toUpperCase()}  ` });

    const signedIn = await served.signIn({ email: FIELDS.email, password: FIELDS.password });
    expect(signedIn.status).toBe(200);
  });

  describe('a refusal', () => {
    /** Nothing was created: the email this sign-up was attempted with still has no account. */
    const createdNothing = async (email: string = FIELDS.email): Promise<void> => {
      expect(await accountFor(email)).toBeNull();
    };

    it('refuses a password under twelve characters against the password field', async () => {
      const response = await signUp({ ...FIELDS, password: 'eleven-char' });
      const read = await body(response);

      expect(response.status).toBe(400);
      expect(read.field).toBe('password');
      expect(read.error).toBe('Use at least twelve characters.');
      expect(response.headers.get('set-cookie')).toBeNull();
      await createdNothing();
    });

    it('accepts a password of exactly twelve characters', async () => {
      expect((await signUp({ ...FIELDS, password: 'twelve-chars' })).status).toBe(200);
    });

    it('names the field a missing one is, rather than asking for all three again', async () => {
      const cases: [Record<string, string>, AuthBody['field'], string][] = [
        [{}, 'email', 'Enter your work email.'],
        [{ email: FIELDS.email }, 'password', 'Enter a password.'],
        [
          { email: FIELDS.email, password: FIELDS.password },
          'workspaceName',
          'Name your workspace.',
        ],
        // Only whitespace is a missing name: it is what the chrome would then show.
        [{ ...FIELDS, workspaceName: '   ' }, 'workspaceName', 'Name your workspace.'],
        [
          { ...FIELDS, email: 'not-an-email' },
          'email',
          'That does not look like an email address.',
        ],
        [{ ...FIELDS, email: 'who@nowhere' }, 'email', 'That does not look like an email address.'],
      ];

      for (const [fields, field, error] of cases) {
        const response = await signUp(fields);
        const read = await body(response);
        expect(response.status, JSON.stringify(fields)).toBe(400);
        expect(read.field, JSON.stringify(fields)).toBe(field);
        expect(read.error, JSON.stringify(fields)).toBe(error);
      }
      await createdNothing();
    });

    it('tells an email that already has a workspace so, and creates nothing', async () => {
      await signUp({ ...FIELDS });
      const account = await accountFor(FIELDS.email);

      const again = await signUp({ ...FIELDS, workspaceName: 'ClipForge again' });
      const read = await body(again);

      // 409, not the sign-in route's one vague sentence: a sign-up that pretended to
      // succeed, or blamed the password, would leave this person stuck forever.
      expect(again.status).toBe(409);
      expect(read.field).toBe('email');
      expect(read.error).toBe('That email already has a workspace. Sign in instead.');
      expect(again.headers.get('set-cookie')).toBeNull();

      // Still one account and one workspace, and the second name was not created.
      const workspaces = await served.platform.store.workspaces.forAccount(account?.id ?? '');
      expect(workspaces.map((workspace) => workspace.name)).toEqual([FIELDS.workspaceName]);
    });

    it('says the same of the seeded demo account, whose email a visitor could guess', async () => {
      const response = await signUp({ ...FIELDS, email: DEMO_ACCOUNT_EMAIL });
      expect(response.status).toBe(409);
      expect((await body(response)).error).toBe(
        'That email already has a workspace. Sign in instead.',
      );
    });

    it('refuses a body it could not read, and one over the cap, before creating anything', async () => {
      const unreadable = await served.request('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'email=owner@clipforge.example&password=hunter2hunter2',
      });
      const read = await body(unreadable);
      expect(unreadable.status).toBe(400);
      expect(read.error).toBe('That sign-up could not be read.');
      // No field was reached, so none is named: it is not a refused sign-up.
      expect(read.field).toBeUndefined();

      // Over 64 KiB is not a sign-up form, and is refused before it is read.
      const oversized = await signUp({ ...FIELDS, workspaceName: 'C'.repeat(70_000) });
      expect(oversized.status).toBe(400);
      await createdNothing();
    });
  });

  describe('the screen and the route behind it are reachable signed out', () => {
    it('serves /signup with no session, as it serves /signin', async () => {
      expect((await served.navigate('/signup')).status).toBe(200);
      // And the route is not behind the guard either: a 401 here would be a door with no key.
      expect((await signUp({})).status).toBe(400);
    });
  });

  describe('secret hygiene', () => {
    it('writes no password, verifier or session id to a log line or an answer', async () => {
      const lines: string[] = [];
      const streams = [process.stdout, process.stderr] as const;
      const originals = streams.map((stream) => stream.write.bind(stream));
      for (const stream of streams) {
        stream.write = ((chunk: string | Uint8Array): boolean => {
          lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        }) as typeof stream.write;
      }
      let answer: string;
      let cookie: string;
      try {
        const response = await signUp({ ...FIELDS });
        answer = await response.text();
        cookie = cookieOf(response);
        await signUp({ ...FIELDS });
        await signUp({ ...FIELDS, email: 'other@clipforge.example', password: 'short' });
      } finally {
        streams.forEach((stream, index) => {
          stream.write = originals[index] as typeof stream.write;
        });
      }

      const account = await accountFor(FIELDS.email);
      const verifier = account?.password.verifier ?? '';
      const logged = lines.join('');
      expect(logged).not.toContain(FIELDS.password);
      expect(logged).not.toContain(verifier);
      expect(logged).not.toContain(cookie);

      // The answer names the account and the workspace. The session id travels in the
      // cookie and in nothing a script on the page could read.
      expect(answer).not.toContain(FIELDS.password);
      expect(answer).not.toContain(verifier);
      expect(answer).not.toContain(cookie.split('=')[1] ?? '');
    });

    it('writes the password into no file of the data directory', async () => {
      await signUp({ ...FIELDS });

      const { dataDir } = served.platform;
      const entries = await readdir(dataDir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dataDir, join(entry.parentPath, entry.name)));
      expect(files).toContain('accounts.json');
      for (const file of files) {
        expect(await readFile(join(dataDir, file), 'utf8'), file).not.toContain(FIELDS.password);
      }
    });
  });
});
