import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import {
  mintSiteToken,
  parseSiteUrl,
  SITE_TOKEN_PREFIX,
  SITE_VERIFICATION_NAME,
  siteVerificationPair,
  SiteUrlNotAcceptedError,
} from '../src/site/index.js';
import { hashPassword } from '../src/store/password.js';
import type { SiteVerification } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * Sites: the record, the token and the `/sites` routes (#235).
 *
 * Everything that can be is asserted **over HTTP**, because scoping that is only true inside
 * the process is not scoping, and because these are the routes the Sites and Add-a-site
 * screens read and write (#225). Two workspaces run through every assertion that concerns
 * ownership: a site of another workspace is **404 and not 403**, which is the rule
 * `visibleRuns` already follows for runs.
 *
 * Nothing in this ticket can verify a site. Every assertion about the verification block is
 * that it reads `unverified` — including for a body that asks for anything else — because the
 * one writer is the passing check of a later ticket of #221.
 */

/** The state every site this ticket can create reads. */
const UNVERIFIED: SiteVerification = { state: 'unverified', method: null, verifiedAt: null };

/** What a route answers with. Only what these tests read: the rest is the compiler's. */
interface SiteBody {
  id: string;
  url: string;
  token: string;
  verification: SiteVerification;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  error?: string;
  issues?: { path: string; message: string }[];
  /** Never present. Read so that its absence is an assertion rather than a hope. */
  workspaceId?: string;
}

const A_URL = 'https://app.clipforge.example/create';
const ANOTHER_URL = 'https://beta.clipforge.example/create';

describe('the site routes', () => {
  let served: TestServer;
  let cookie: string;
  let theirCookie: string;
  let workspaceId: string;
  let theirWorkspaceId: string;

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await served.signIn({ email, password });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };

  const send = (
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    bodyOrUndefined?: unknown,
    as: string = cookie,
  ): Promise<Response> =>
    served.request(path, {
      method,
      headers: {
        cookie: as,
        ...(bodyOrUndefined === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(bodyOrUndefined === undefined ? {} : { body: JSON.stringify(bodyOrUndefined) }),
    });

  const bodyOf = async (response: Response): Promise<SiteBody> =>
    (await response.json()) as SiteBody;

  const listed = async (as: string = cookie): Promise<SiteBody[]> => {
    const response = await send('/sites', 'GET', undefined, as);
    expect(response.status).toBe(200);
    return ((await response.json()) as { sites: SiteBody[] }).sites;
  };

  /** A site added through the route, as the Add-a-site form adds one. */
  const add = async (url = A_URL, as: string = cookie): Promise<SiteBody> => {
    const response = await send('/sites', 'POST', { url }, as);
    expect(response.status).toBe(201);
    return bodyOf(response);
  };

  beforeEach(async () => {
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
    });
    cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');
    workspaceId = served.platform.seeded?.workspaceId ?? '';
    expect(workspaceId).not.toBe('');

    // A second shop, with an account and a workspace of its own.
    const them = await served.platform.store.accounts.create({
      email: 'owner@another.example',
      displayName: 'Another shop owner',
      password: await hashPassword('another-shops-password'),
    });
    const theirs = await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [them.id],
    });
    theirWorkspaceId = theirs.id;
    theirCookie = await signIn('owner@another.example', 'another-shops-password');
  });

  afterEach(() => served.close());

  describe('a site added through POST /sites', () => {
    it('is created in the session’s workspace, unverified, with a token of its own', async () => {
      const site = await add();

      expect(site.url).toBe(A_URL);
      expect(site.verification).toEqual(UNVERIFIED);
      expect(site.token).toMatch(/^pv_[0-9a-f]{12}$/);
      expect((await served.platform.store.sites.byId(workspaceId, site.id))?.workspaceId).toBe(
        workspaceId,
      );
    });

    it('is then listed by GET /sites', async () => {
      const site = await add();

      expect((await listed()).map((entry) => entry.id)).toEqual([site.id]);
      expect((await listed())[0]?.token).toBe(site.token);
    });

    it('comes back from GET /sites/:siteId with every field intact', async () => {
      const site = await add();

      const read = await send(`/sites/${site.id}`, 'GET');
      expect(read.status).toBe(200);
      expect(await bodyOf(read)).toEqual(site);
    });

    it('names no workspace in the answer', async () => {
      const site = await add();

      expect(site.workspaceId).toBeUndefined();
      expect(JSON.stringify(await listed())).not.toContain(workspaceId);
    });

    it('keeps the URL the user typed, port, credentials, capitals and all', async () => {
      const typed = 'https://me:pw@Staging.ClipForge.Example:8443/create?a=1';

      expect((await add(typed)).url).toBe(typed);
    });

    it('accepts a non-default port on a host that is not localhost', async () => {
      expect((await add('http://staging.clipforge.example:8080/create')).url).toBe(
        'http://staging.clipforge.example:8080/create',
      );
    });

    it('accepts http://localhost, so the product can be tried on a dev server', async () => {
      expect((await add('http://localhost:5173/create')).url).toBe('http://localhost:5173/create');
    });
  });

  describe('a workspace with no sites', () => {
    it('answers an empty list rather than 404, so the Sites screen can draw its one card', async () => {
      const response = await send('/sites', 'GET');

      expect(response.status).toBe(200);
      expect(await listed()).toEqual([]);
    });
  });

  describe('nothing a body says can verify a site', () => {
    it('ignores a submitted verification block, token and id', async () => {
      const response = await send('/sites', 'POST', {
        url: A_URL,
        id: 'an-id-of-my-choosing',
        token: 'pv_deadbeefcafe',
        verification: { state: 'verified', method: 'dns-txt', verifiedAt: '2026-11-01T00:00:00Z' },
      });
      expect(response.status).toBe(201);
      const site = await bodyOf(response);

      expect(site.id).not.toBe('an-id-of-my-choosing');
      expect(site.token).not.toBe('pv_deadbeefcafe');
      expect(site.token).toMatch(/^pv_[0-9a-f]{12}$/);
      expect(site.verification).toEqual(UNVERIFIED);
      // And it is the stored record that is unverified, not only the answer.
      expect((await bodyOf(await send(`/sites/${site.id}`, 'GET'))).verification).toEqual(
        UNVERIFIED,
      );
    });

    it('offers no route that could move one', async () => {
      const site = await add();
      for (const method of ['POST', 'PATCH', 'PUT'] as const) {
        const response = await served.request(`/sites/${site.id}`, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ verification: { state: 'verified' } }),
        });
        // No route claims the path for these methods, so the request falls through to the
        // app and is answered with the screen. Whatever it answers, it is not a record.
        expect(response.headers.get('content-type')).not.toContain('application/json');
      }
      expect((await bodyOf(await send(`/sites/${site.id}`, 'GET'))).verification).toEqual(
        UNVERIFIED,
      );
    });
  });

  describe('a URL the platform will not point a swarm at', () => {
    const refused = async (url: unknown): Promise<SiteBody> => {
      const response = await send('/sites', 'POST', { url });
      expect(response.status).toBe(400);
      return bodyOf(response);
    };

    it('reports the message at the url path, so the form renders it against its field', async () => {
      const body = await refused('app.clipforge.example');

      expect(body.issues?.map((issue) => issue.path)).toEqual(['url']);
      expect(body.issues?.[0]?.message).toContain('absolute URL');
    });

    it('refuses a scheme that is not http or https, and names it', async () => {
      const body = await refused('ftp://files.clipforge.example/create');

      expect(body.issues?.[0]?.path).toBe('url');
      expect(body.issues?.[0]?.message).toContain('ftp:');
    });

    it('refuses a path with no host at all', async () => {
      expect((await refused('/create')).issues?.[0]?.path).toBe('url');
    });

    it('asks for one when the body names none', async () => {
      for (const url of [undefined, '', '   ', 42, null]) {
        expect((await refused(url)).issues?.[0]?.message).toContain('a site needs a URL');
      }
    });

    it('stores nothing it refused', async () => {
      await refused('app.clipforge.example');

      expect(await listed()).toEqual([]);
    });

    it('answers a body it could not read without pretending it was validated', async () => {
      const response = await served.request('/sites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{not json',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBe('That site could not be read.');
    });
  });

  describe('DELETE /sites/:siteId', () => {
    it('takes the site out of the list and keeps the record', async () => {
      const site = await add();

      const response = await send(`/sites/${site.id}`, 'DELETE');
      expect(response.status).toBe(200);
      expect((await bodyOf(response)).deletedAt).not.toBeNull();

      expect(await listed()).toEqual([]);
      const kept = await served.platform.store.sites.list(workspaceId, { includeDeleted: true });
      expect(kept.map((record) => record.id)).toEqual([site.id]);
      expect(kept[0]?.url).toBe(A_URL);
    });

    it('leaves the removed site readable, because a finished test ran against it', async () => {
      const site = await add();
      await send(`/sites/${site.id}`, 'DELETE');

      const read = await send(`/sites/${site.id}`, 'GET');
      expect(read.status).toBe(200);
      expect((await bodyOf(read)).deletedAt).not.toBeNull();
    });

    it('is 404 for a site id that names nothing', async () => {
      const response = await send('/sites/not-a-site', 'DELETE');

      expect(response.status).toBe(404);
      expect((await bodyOf(response)).error).toBe('There is no such site.');
    });
  });

  describe('two workspaces', () => {
    it('does not show one workspace’s site to the other, through any route', async () => {
      const mine = await add();

      expect(await listed(theirCookie)).toEqual([]);
      const read = await send(`/sites/${mine.id}`, 'GET', undefined, theirCookie);
      expect(read.status).toBe(404);
      expect((await bodyOf(read)).error).toBe('There is no such site.');
    });

    it('answers 404 and not 403, so that the site is not disclosed by the refusal', async () => {
      const mine = await add();

      for (const path of [`/sites/${mine.id}`, '/sites/a-site-nobody-has']) {
        const read = await send(path, 'GET', undefined, theirCookie);
        const removed = await send(path, 'DELETE', undefined, theirCookie);
        expect([read.status, removed.status]).toEqual([404, 404]);
        expect(await bodyOf(read)).toEqual(await bodyOf(removed));
      }
    });

    it('does not let the other workspace remove it', async () => {
      const mine = await add();

      expect((await send(`/sites/${mine.id}`, 'DELETE', undefined, theirCookie)).status).toBe(404);
      expect((await listed()).map((entry) => entry.id)).toEqual([mine.id]);
      expect((await bodyOf(await send(`/sites/${mine.id}`, 'GET'))).deletedAt).toBeNull();
    });

    it('gives both of them the same URL as two sites with two different tokens', async () => {
      const mine = await add(A_URL);
      const theirs = await add(A_URL, theirCookie);

      expect(mine.id).not.toBe(theirs.id);
      expect(mine.token).not.toBe(theirs.token);
      expect((await listed()).map((entry) => entry.id)).toEqual([mine.id]);
      expect((await listed(theirCookie)).map((entry) => entry.id)).toEqual([theirs.id]);
      // A token proves control of the site it is published on, for the workspace it was
      // minted for: one workspace's published token is not the other's proof.
      expect((await served.platform.store.sites.byId(theirWorkspaceId, theirs.id))?.token).not.toBe(
        mine.token,
      );
    });

    it('lists each workspace’s own sites and no more', async () => {
      await add(A_URL);
      await add(ANOTHER_URL);
      await add(A_URL, theirCookie);

      expect((await listed()).map((entry) => entry.url)).toEqual([A_URL, ANOTHER_URL]);
      expect((await listed(theirCookie)).map((entry) => entry.url)).toEqual([A_URL]);
    });
  });

  describe('signed out', () => {
    it('is 401 for a fetch at every one of the four routes', async () => {
      for (const [path, method] of [
        ['/sites', 'GET'],
        ['/sites', 'POST'],
        ['/sites/a-site', 'GET'],
        ['/sites/a-site', 'DELETE'],
      ] as const) {
        const response = await served.request(path, {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: A_URL }),
              }
            : {}),
        });
        expect(response.status).toBe(401);
      }
    });

    it('sends a browser to sign in and back, rather than answering with the API', async () => {
      const response = await served.navigate('/sites');

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/signin?next=%2Fsites');
    });
  });

  describe('the screens behind the paths', () => {
    it('answers the app, not JSON, when a browser navigates to /sites', async () => {
      const response = await served.navigate('/sites', cookie);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });

    it('answers the app for the Add-a-site screens too', async () => {
      const site = await add();

      for (const path of ['/sites/new', `/sites/${site.id}`]) {
        const response = await served.navigate(path, cookie);
        expect(response.headers.get('content-type')).toContain('text/html');
      }
    });

    it('answers JSON to the fetch the screen makes', async () => {
      const response = await send('/sites', 'GET');

      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });
});

describe('the verification token', () => {
  it('is pv_ and twelve hex characters, as the Add-a-site screen prints it', () => {
    expect(mintSiteToken()).toMatch(new RegExp(`^${SITE_TOKEN_PREFIX}[0-9a-f]{12}$`));
  });

  it('is not the same token twice', () => {
    const minted = new Set(Array.from({ length: 64 }, () => mintSiteToken()));

    expect(minted.size).toBe(64);
  });

  it('builds the line a user publishes, from the one place that name is written', () => {
    expect(siteVerificationPair('pv_7f3c91a2d84e')).toBe(
      'personavision-site-verification=pv_7f3c91a2d84e',
    );
    expect(SITE_VERIFICATION_NAME).toBe('personavision-site-verification');
  });
});

describe('the URL a site may be', () => {
  it('keeps what was typed rather than what a round trip through URL would make of it', () => {
    // No trailing slash added, no host lower-cased, no path re-escaped: the address a person
    // proves they control is the address they wrote down.
    expect(parseSiteUrl('https://App.Example.com')).toBe('https://App.Example.com');
    expect(parseSiteUrl('  https://app.example.com/a b  ')).toBe('https://app.example.com/a b');
  });

  it('refuses everything that is not an absolute http or https URL', () => {
    for (const value of [
      'app.example.com',
      '/create',
      '//app.example.com/create',
      'ftp://files.example.com',
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/hosts',
      '',
      '   ',
      undefined,
      null,
      42,
      { url: 'https://app.example.com' },
    ]) {
      expect(() => parseSiteUrl(value)).toThrow(SiteUrlNotAcceptedError);
    }
  });

  it('says what is wrong at the url path, and never says something went wrong', () => {
    try {
      parseSiteUrl('app.example.com');
      expect.unreachable('a URL with no scheme is not accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(SiteUrlNotAcceptedError);
      const { issues } = error as SiteUrlNotAcceptedError;
      expect(issues.map((issue) => issue.path)).toEqual(['url']);
      expect(issues[0]?.message).toContain('https://app.example.com/create');
      expect(issues[0]?.message).not.toContain('something went wrong');
    }
  });

  it('quotes back only as much of a long submission as is a sentence', () => {
    const long = `not-a-url-${'x'.repeat(500)}`;

    try {
      parseSiteUrl(long);
      expect.unreachable('that is not a URL');
    } catch (error) {
      const { issues } = error as SiteUrlNotAcceptedError;
      expect(issues[0]?.message.length).toBeLessThan(200);
      expect(issues[0]?.message).toContain('…');
    }
  });
});
