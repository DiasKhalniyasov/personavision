import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { hashPassword } from '../src/store/password.js';
import { startTestServer } from './http.js';
import type { TestServer } from './http.js';
import { writeRunAt } from './workspace.js';

/**
 * Two workspaces, each with a test of its own: each session reads its own and is refused
 * the other, asserted over HTTP rather than through the store — scoping that is only true
 * inside the process is not scoping.
 *
 * A run of another workspace is **404 and not 403**: that somebody else holds it is not
 * disclosed. The run data the public landing page and `/demo` read is the one exception,
 * and it is one run, read-only, of the seeded demo workspace (`docs/FLOW.md` section 3).
 */

describe('two workspaces, each with a run', () => {
  let served: TestServer;
  let demoRun: string;
  let theirRun: string;
  let myCookie: string;
  let theirCookie: string;

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await served.request('/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  const listed = async (cookie?: string): Promise<string[]> => {
    const response = await served.request(
      '/runs/index.json',
      cookie === undefined ? {} : { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as string[];
  };

  const read = (runId: string, cookie?: string): Promise<Response> =>
    served.request(`/runs/${runId}/run.json`, cookie === undefined ? {} : { headers: { cookie } });

  beforeEach(async () => {
    // The seeded workspace's own run, written before the platform started: one run on a
    // fresh runs root is the committed example, so this is the run the public pages read.
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
    });
    demoRun = served.runIds[0] ?? '';
    myCookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');

    // A second shop, with an account of its own and a test the first one never ran.
    theirRun = await writeRunAt(served.platform.runsRoot, {
      stamp: '2026-10-25T09:00:00.000Z',
      name: 'another shop',
    });
    const them = await served.platform.store.accounts.create({
      email: 'owner@another.example',
      displayName: 'Another shop owner',
      password: await hashPassword('another-shops-password'),
    });
    await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [them.id],
      runIds: [theirRun],
    });
    theirCookie = await signIn('owner@another.example', 'another-shops-password');
  });

  afterEach(() => served.close());

  it('reads its own test', async () => {
    expect((await read(demoRun, myCookie)).status).toBe(200);
    expect((await read(theirRun, theirCookie)).status).toBe(200);
  });

  it('is refused the other workspace’s test, and is not told it exists', async () => {
    const mine = await read(theirRun, myCookie);
    expect(mine.status).toBe(404);
    expect(await mine.text()).not.toContain('Another shop');

    expect((await read(demoRun, theirCookie)).status).toBe(404);
  });

  it('lists its own tests and nobody else’s', async () => {
    expect(await listed(myCookie)).toEqual([demoRun]);
    expect(await listed(theirCookie)).toEqual([theirRun]);
  });

  it('reads nothing of either workspace once it has signed out', async () => {
    await served.request('/auth/signout', { method: 'POST', headers: { cookie: theirCookie } });
    expect((await read(theirRun, theirCookie)).status).toBe(404);
    expect(await listed(theirCookie)).toEqual([demoRun]);
  });

  describe('a signed-out request', () => {
    it('reads the seeded demo run, which the landing page and /demo show', async () => {
      expect((await read(demoRun)).status).toBe(200);
      expect(await listed()).toEqual([demoRun]);
    });

    it('is refused another workspace’s run as missing, not as unauthorised', async () => {
      const response = await read(theirRun);
      expect(response.status).toBe(404);
      // Not 302 and not 401: a run it may not read is a run that is not there, and the
      // answer never confirms that some other workspace holds it.
      expect(response.headers.get('location')).toBeNull();
    });
  });
});
