import { readFile, readdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import type { AuthBody } from '../src/server/routes/auth.js';
import { isSecureRequest, SESSION_COOKIE } from '../src/server/session.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * Sign-in, the session that survives a reload, and signing out — asserted over HTTP,
 * because a session that is only true inside the process is not a session.
 *
 * What is proved here is what a request gets back: the cookie's own flags, the one vague
 * failure that is the same for a wrong password and for an email nobody has, a cookie
 * this server did not write being signed out rather than an error, and the redirect that
 * carries a shared link through a sign-in and back.
 */

/** The answer the routes declare, so the shape is read from the compiler, not restated. */
const body = async (response: Response): Promise<AuthBody> => (await response.json()) as AuthBody;

describe('signing in', () => {
  let served: TestServer;
  let password: string;
  let runId: string;

  const signIn = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    served.signIn(fields, headers);

  const signInAsDemo = () => signIn({ email: DEMO_ACCOUNT_EMAIL, password });

  beforeEach(async () => {
    // A run of the seeded workspace, so a protected screen route has somewhere to point.
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
    });
    runId = served.runIds[0] ?? '';
    password = served.platform.seeded?.password ?? '';
  });

  afterEach(() => served.close());

  it('signs in with the seeded credentials and names the account and the workspace', async () => {
    const response = await signInAsDemo();
    expect(response.status).toBe(200);
    expect(cookieOf(response)).toContain(`${SESSION_COOKIE}=`);

    const session = await served.request('/auth/session', {
      headers: { cookie: cookieOf(response) },
    });
    const read = await body(session);
    expect(session.status).toBe(200);
    expect(read.signedIn).toBe(true);
    expect(read.account?.email).toBe(DEMO_ACCOUNT_EMAIL);
    expect(read.workspace?.name).toBe(served.platform.seeded?.workspaceName);
  });

  it('keeps the session across a reload, and forgets it on signing out', async () => {
    const cookie = cookieOf(await signInAsDemo());
    const reload = await served.request('/auth/session', { headers: { cookie } });
    expect((await body(reload)).signedIn).toBe(true);

    const out = await served.request('/auth/signout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    // The record is gone, so the same cookie is signed out rather than still being a key.
    const after = await served.request('/auth/session', { headers: { cookie } });
    expect((await body(after)).signedIn).toBe(false);
    expect((await served.navigate(`/runs/${runId}`, cookie)).status).toBe(302);
  });

  it('answers a wrong password and an email nobody has with the same failure', async () => {
    const wrong = await signIn({ email: DEMO_ACCOUNT_EMAIL, password: `${password}x` });
    const unknown = await signIn({ email: 'nobody@northwind.example', password });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(wrong.headers.get('set-cookie')).toBeNull();
    // Nothing in the sentence says which of the two it was, or that the address exists.
    expect((await body(await signIn({ email: DEMO_ACCOUNT_EMAIL, password: 'no' }))).error).toBe(
      'That email and password do not match an account.',
    );
  });

  it('asks for both fields rather than reporting a failure it did not test', async () => {
    expect((await signIn({ email: DEMO_ACCOUNT_EMAIL })).status).toBe(400);
    expect((await signIn({})).status).toBe(400);

    // A body that is not the JSON the sign-in screen sends is a 400 as well: nothing was
    // tested, so reporting a failed sign-in would be reporting something that never ran.
    const unreadable = await served.request('/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'email=owner@northwind.example&password=hunter2',
    });
    expect(unreadable.status).toBe(400);
  });

  describe('a cookie this server did not write', () => {
    const casesOf = async (): Promise<string[]> => {
      const good = cookieOf(await signInAsDemo());
      const expired = await served.platform.store.sessions.create({
        accountId: served.platform.seeded?.accountId ?? '',
        workspaceId: served.platform.seeded?.workspaceId ?? '',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      return [
        // Tampered: the last character of the signature flipped.
        `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`,
        `${SESSION_COOKIE}=${served.platform.signSession(expired.id)}`,
        `${SESSION_COOKIE}=${served.platform.signSession('no-such-session')}`,
        `${SESSION_COOKIE}=not-a-signed-value`,
        `${SESSION_COOKIE}=%E0%A4%A`,
      ];
    };

    it('is signed out everywhere, and is never a 500', async () => {
      for (const cookie of await casesOf()) {
        const session = await served.request('/auth/session', { headers: { cookie } });
        expect(session.status).toBe(200);
        expect((await body(session)).signedIn).toBe(false);

        const page = await served.navigate(`/runs/${runId}`, cookie);
        expect(page.status).toBe(302);
        expect(page.headers.get('location')).toContain('/signin');
      }
    });
  });

  describe('a request while signed out', () => {
    it('redirects a page to /signin carrying where it was going', async () => {
      const page = await served.navigate(`/runs/${runId}?aoi=fee`);
      expect(page.status).toBe(302);
      expect(page.headers.get('location')).toBe(
        `/signin?next=${encodeURIComponent(`/runs/${runId}?aoi=fee`)}`,
      );
    });

    it('answers a data request with 401 rather than a redirect', async () => {
      const data = await served.request('/audiences', {
        headers: { accept: 'application/json' },
      });
      expect(data.status).toBe(401);
      expect(data.headers.get('location')).toBeNull();
      expect((await body(data)).signedIn).toBe(false);
    });

    it('lands back on the page it was sent from once it has signed in', async () => {
      const page = await served.navigate(`/runs/${runId}`);
      const next = new URL(page.headers.get('location') ?? '', 'http://localhost').searchParams.get(
        'next',
      );
      const signedIn = await signIn({ email: DEMO_ACCOUNT_EMAIL, password, next: next ?? '' });
      expect((await body(signedIn)).next).toBe(`/runs/${runId}`);
    });

    it('refuses to be sent anywhere but this site after signing in', async () => {
      for (const next of ['//evil.example/take-over', 'https://evil.example', '/\\evil.example']) {
        const signedIn = await signIn({ email: DEMO_ACCOUNT_EMAIL, password, next });
        expect((await body(signedIn)).next).toBe('/');
      }
    });

    it('serves the public pages of the product without a session', async () => {
      for (const path of ['/', '/demo', '/demo/', '/signin']) {
        expect((await served.navigate(path)).status).toBe(200);
      }
      expect((await served.request('/auth/session')).status).toBe(200);
    });
  });

  describe('the session cookie', () => {
    it('is HTTP-only and SameSite=Lax, and not Secure over plain HTTP', async () => {
      const plain = (await signInAsDemo()).headers.get('set-cookie') ?? '';
      expect(plain).toContain('HttpOnly');
      expect(plain).toContain('SameSite=Lax');
      // A loopback server is reached over HTTP, and a cookie marked `Secure` there would
      // never come back.
      expect(plain).not.toContain('Secure');
    });

    it('is Secure when the connection carrying the request is encrypted', () => {
      const overTls = { headers: {}, socket: { encrypted: true } } as unknown as IncomingMessage;
      const overTcp = { headers: {}, socket: {} } as unknown as IncomingMessage;
      // The connection decides it, not a header: `x-forwarded-proto` is written by
      // whoever is on the other end, and a cookie attribute a client can set is not one.
      expect(isSecureRequest(overTls)).toBe(true);
      expect(isSecureRequest(overTcp)).toBe(false);
      expect(
        isSecureRequest({
          headers: { 'x-forwarded-proto': 'https' },
          socket: {},
        } as unknown as IncomingMessage),
      ).toBe(false);
    });

    it('carries nothing but a session id and its signature', async () => {
      const cookie = cookieOf(await signInAsDemo());
      expect(cookie).not.toContain(password);
      expect(cookie).not.toContain(DEMO_ACCOUNT_EMAIL);
      expect(cookie).not.toContain(served.platform.seeded?.workspaceId ?? '');
    });
  });

  describe('the password', () => {
    it('is stored only as a verifier, with the parameters it was made with', async () => {
      const account = await served.platform.store.accounts.byEmail(DEMO_ACCOUNT_EMAIL);
      expect(account?.password).toMatchObject({
        algorithm: 'scrypt',
        cost: 16_384,
        blockSize: 8,
        parallelization: 1,
        keyLength: 64,
      });
      expect(account?.password.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(account)).not.toContain(password);
    });

    it('appears in no file of the store and in no line the server logged', async () => {
      const lines: string[] = [];
      const streams = [process.stdout, process.stderr] as const;
      const originals = streams.map((stream) => stream.write.bind(stream));
      for (const stream of streams) {
        stream.write = ((chunk: string | Uint8Array): boolean => {
          lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        }) as typeof stream.write;
      }
      try {
        await signInAsDemo();
        await signIn({ email: DEMO_ACCOUNT_EMAIL, password: `${password}x` });
        await signIn({ email: 'nobody@northwind.example', password });
      } finally {
        streams.forEach((stream, index) => {
          stream.write = originals[index] as typeof stream.write;
        });
      }
      expect(lines.join('').includes(password)).toBe(false);

      const dataDir = served.platform.dataDir;
      const entries = await readdir(dataDir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dataDir, join(entry.parentPath, entry.name)));
      expect(files).toContain('accounts.json');
      for (const file of files) {
        expect(await readFile(join(dataDir, file), 'utf8')).not.toContain(password);
      }
    });
  });
});
