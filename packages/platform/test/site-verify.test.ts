import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { checkDnsTxt } from '../src/site/check-dns.js';
import { siteVerificationPair } from '../src/site/token.js';
import { AVAILABLE_SITE_VERIFICATION_METHODS } from '../src/site/verify.js';
import type { SiteCheckResult, TxtResolver } from '../src/site/checks.js';
import { hashPassword } from '../src/store/password.js';
import type { SiteStore, SiteVerification } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The one path to verified (#236): `POST /sites/:siteId/verify`, and the store invariant
 * underneath it.
 *
 * Asserted **over HTTP**, because an invariant that only holds inside the process is not the
 * one the product has: these are the routes `#screen-site`'s four buttons call. The resolver
 * is injected into the server, so nothing here reaches DNS.
 *
 * The invariant this suite exists for is structural rather than a convention: `SiteStore`
 * publishes **one** writer of the verification block, it refuses a result that did not pass,
 * and nothing else on the interface — nor any route, body or method — can reach the state.
 */

/** The state a site reads until a check has passed on it. */
const UNVERIFIED: SiteVerification = { state: 'unverified', method: null, verifiedAt: null };

/** `#screen-site`'s "at 09:04", so a stored `verifiedAt` is assertable to the millisecond. */
const CHECKED_AT = '2026-11-03T09:04:00.000Z';

const A_URL = 'https://beta.clipforge.example/create';
const HOST = 'beta.clipforge.example';
const DOMAIN = 'clipforge.example';

/** What one name answers: its TXT records, or the code the resolver rejects with. */
type Answer = string[][] | { rejects: string };

const dnsError = (code: string): Error => Object.assign(new Error(`queryTxt ${code}`), { code });

/** What a route answers. Only the fields these tests read. */
interface SiteBody {
  id: string;
  url: string;
  token: string;
  verification: SiteVerification;
  lastCheck: SiteCheckResult | null;
  updatedAt: string;
  deletedAt: string | null;
  /** On the verify route only: what this check found. */
  check?: SiteCheckResult;
  error?: string;
  available?: string[];
}

describe('POST /sites/:siteId/verify', () => {
  let served: TestServer;
  let cookie: string;
  let theirCookie: string;
  let workspaceId: string;
  let sites: SiteStore;
  /** The zone the injected resolver answers from, set per test. */
  let zone: Record<string, Answer>;
  /** Every name the server's checks asked for, so "no network" is an assertion. */
  let asked: string[];

  const resolveTxt: TxtResolver = async (hostname) => {
    asked.push(hostname);
    const answer = zone[hostname] ?? { rejects: 'ENODATA' };
    if (Array.isArray(answer)) return answer;
    throw dnsError(answer.rejects);
  };

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

  const add = async (url = A_URL, as: string = cookie): Promise<SiteBody> => {
    const response = await send('/sites', 'POST', { url }, as);
    expect(response.status).toBe(201);
    return bodyOf(response);
  };

  /** The site as `GET /sites/:siteId` answers it — the stored record, over the API. */
  const read = async (siteId: string, as: string = cookie): Promise<SiteBody> =>
    bodyOf(await send(`/sites/${siteId}`, 'GET', undefined, as));

  const verify = (
    siteId: string,
    method: unknown = 'dns-txt',
    as: string = cookie,
  ): Promise<Response> => send(`/sites/${siteId}/verify`, 'POST', { method }, as);

  /** Publishes this site's own line on a name, as its owner would. */
  const publish = (name: string, site: SiteBody): void => {
    zone[name] = [[siteVerificationPair(site.token)]];
  };

  /**
   * A real check result for this site, run against a zone of this test's choosing — so the
   * results handed to the store below are ones a check actually produced.
   */
  const checkOf = (site: SiteBody, against: Record<string, Answer>): Promise<SiteCheckResult> =>
    // A stored record satisfies `CheckedSite`; what the route answers carries no workspace
    // id, so the one in scope is named here (#238 put the site's identity on the type).
    checkDnsTxt(
      { ...site, workspaceId },
      {
        resolveTxt: async (hostname) => {
          const answer = against[hostname] ?? { rejects: 'ENODATA' };
          if (Array.isArray(answer)) return answer;
          throw dnsError(answer.rejects);
        },
        now: () => new Date(CHECKED_AT),
      },
    );

  const passingCheckFor = (site: SiteBody): Promise<SiteCheckResult> =>
    checkOf(site, { [HOST]: [[siteVerificationPair(site.token)]] });

  const failedCheckFor = (site: SiteBody): Promise<SiteCheckResult> => checkOf(site, {});

  beforeEach(async () => {
    zone = {};
    asked = [];
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
      siteChecks: { resolveTxt, now: () => new Date(CHECKED_AT) },
    });
    sites = served.platform.store.sites;
    cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');
    workspaceId = served.platform.seeded?.workspaceId ?? '';
    expect(workspaceId).not.toBe('');

    const them = await served.platform.store.accounts.create({
      email: 'owner@another.example',
      displayName: 'Another shop owner',
      password: await hashPassword('another-shops-password'),
    });
    await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [them.id],
    });
    theirCookie = await signIn('owner@another.example', 'another-shops-password');
  });

  afterEach(() => served.close());

  describe('a check that passed', () => {
    it('answers the site as verified, by the method and at the moment it was proved', async () => {
      const site = await add();
      publish(HOST, site);

      const response = await verify(site.id);
      expect(response.status).toBe(200);
      const verified = await bodyOf(response);

      expect(verified.verification).toEqual({
        state: 'verified',
        method: 'dns-txt',
        verifiedAt: CHECKED_AT,
      });
      expect(verified.check?.passed).toBe(true);
      expect(verified.check?.sentence).toBe(
        `the TXT record on ${HOST} carries ${siteVerificationPair(site.token)}`,
      );
    });

    it('is the stored record that is verified, and GET /sites then lists it so', async () => {
      const site = await add();
      publish(DOMAIN, site);
      expect((await verify(site.id)).status).toBe(200);

      expect((await read(site.id)).verification.state).toBe('verified');
      const listed = ((await (await send('/sites', 'GET')).json()) as { sites: SiteBody[] }).sites;
      expect(listed.map((entry) => entry.verification)).toEqual([
        { state: 'verified', method: 'dns-txt', verifiedAt: CHECKED_AT },
      ]);
    });

    it('stores the result it passed on, so the screen can print what was found where', async () => {
      const site = await add();
      publish(DOMAIN, site);
      await verify(site.id);

      const stored = (await read(site.id)).lastCheck;
      expect(stored?.passed).toBe(true);
      expect(stored?.found.at).toEqual([DOMAIN]);
      expect(stored?.checkedAt).toBe(CHECKED_AT);
    });
  });

  describe('a check that did not pass', () => {
    it('answers 200, because the user asked us to look and we looked', async () => {
      const site = await add();

      const response = await verify(site.id);

      expect(response.status).toBe(200);
      expect((await bodyOf(response)).check?.passed).toBe(false);
    });

    it('leaves the site unverified', async () => {
      const site = await add();
      await verify(site.id);

      expect((await bodyOf(await verify(site.id))).verification).toEqual(UNVERIFIED);
      expect((await read(site.id)).verification).toEqual(UNVERIFIED);
    });

    it('stores a lastCheck whose words name the check, the domain and what it found', async () => {
      const site = await add();

      await verify(site.id);
      const stored = (await read(site.id)).lastCheck;

      expect(stored?.method).toBe('dns-txt');
      expect(stored?.lookedFor).toBe(siteVerificationPair(site.token));
      expect(stored?.lookedIn).toEqual([
        { kind: 'domain', value: HOST },
        { kind: 'domain', value: DOMAIN },
      ]);
      // The sentence `#screen-site` prints after "Last check: ".
      expect(stored?.sentence).toBe(`no TXT record found on ${HOST} or ${DOMAIN}`);
      expect(stored?.sentence.toLowerCase()).not.toContain('something went wrong');
      expect(stored?.checkedAt).toBe(CHECKED_AT);
    });

    it('says what is published there instead, when something is', async () => {
      const site = await add();
      zone[HOST] = [['v=spf1 include:mail.example -all']];

      const { check } = await bodyOf(await verify(site.id));

      expect(check?.found.outcome).toBe('other-values');
      expect(check?.found.values).toEqual(['v=spf1 include:mail.example -all']);
    });

    it('has its own sentence for a host that did not answer', async () => {
      const site = await add();
      zone[HOST] = { rejects: 'ETIMEOUT' };
      zone[DOMAIN] = { rejects: 'ETIMEOUT' };

      const { check } = await bodyOf(await verify(site.id));

      expect(check?.found.outcome).toBe('no-answer');
      expect(check?.sentence).toBe(`${HOST} and ${DOMAIN} did not answer: the lookup timed out`);
    });

    it('leaves a site that was already verified verified, and says what the last look found', async () => {
      // Verification is recorded rather than enforced (#221): a transient outage or a record
      // somebody removed does not drop a site out of the state a passing check put it in.
      // The card keeps "Verified by DNS" and gains a "Last check:" line that disagrees.
      const site = await add();
      publish(HOST, site);
      await verify(site.id);
      zone = {};

      const after = await bodyOf(await verify(site.id));

      expect(after.verification.state).toBe('verified');
      expect(after.check?.passed).toBe(false);
      expect(after.lastCheck?.passed).toBe(false);
    });
  });

  describe('a site nobody has checked', () => {
    it('reads lastCheck of null, which is the method’s unchecked state', async () => {
      expect((await add()).lastCheck).toBeNull();
      expect((await read((await add()).id)).lastCheck).toBeNull();
    });
  });

  describe('the store’s one writer of the verification block', () => {
    it('refuses a result that did not pass, rather than writing it', async () => {
      const site = await add();
      const failed = await failedCheckFor(site);

      await expect(sites.verify(workspaceId, site.id, failed)).rejects.toThrow(/did not/);
      // Nothing was written: not the state, and not even the result it was handed.
      const stored = await sites.byId(workspaceId, site.id);
      expect(stored?.verification).toEqual(UNVERIFIED);
      expect(stored?.lastCheck).toBeNull();
    });

    it('is the only method on the interface that can write it', async () => {
      const site = await add();
      const passing = await passingCheckFor(site);

      // Every other writer the store publishes, handed a result that passed.
      await sites.recordCheck(workspaceId, site.id, passing);
      await sites.create(workspaceId, { url: A_URL, token: site.token });
      await sites.softDelete(workspaceId, site.id);
      expect((await sites.byId(workspaceId, site.id))?.verification).toEqual(UNVERIFIED);
      // `recordCheck` stored the result and could not move the state with it.
      expect((await sites.byId(workspaceId, site.id))?.lastCheck?.passed).toBe(true);

      // And `verify` is the one that moves it.
      await sites.verify(workspaceId, site.id, passing);
      expect((await sites.byId(workspaceId, site.id))?.verification.state).toBe('verified');
    });

    it('publishes no second path: these six methods and no others', () => {
      // A writer added later without reading `docs/FLOW.md` section 13 fails here, which is
      // the point — the invariant is the interface's shape, not a convention to remember.
      expect(Object.keys(sites).sort()).toEqual([
        'byId',
        'create',
        'list',
        'recordCheck',
        'softDelete',
        'verify',
      ]);
    });
  });

  describe('nothing over the API can verify a site but a passing check', () => {
    it('cannot be done by POST /sites, a DELETE, a re-add or a PATCH-shaped body', async () => {
      const verified = {
        state: 'verified',
        method: 'dns-txt',
        verifiedAt: '2026-11-01T00:00:00.000Z',
      };
      const passing = { passed: true, method: 'dns-txt', checkedAt: CHECKED_AT };

      // Submitted on the way in.
      const site = await bodyOf(
        await send('/sites', 'POST', {
          url: A_URL,
          verification: verified,
          lastCheck: passing,
          check: passing,
        }),
      );
      expect(site.verification).toEqual(UNVERIFIED);
      expect(site.lastCheck).toBeNull();

      // Removed and added again, in case either step took a body's word for it.
      await send(`/sites/${site.id}`, 'DELETE', { verification: verified });
      const again = await add();
      expect(again.verification).toEqual(UNVERIFIED);

      // And on a PATCH-shaped body at the site's own path, which claims no route.
      for (const method of ['POST', 'PATCH', 'PUT'] as const) {
        const response = await served.request(`/sites/${again.id}`, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ verification: verified, lastCheck: passing }),
        });
        expect(response.headers.get('content-type')).not.toContain('application/json');
      }
      expect((await read(again.id)).verification).toEqual(UNVERIFIED);
    });

    it('cannot be done by a verify body that claims the check already passed', async () => {
      const site = await add();

      const response = await served.request(`/sites/${site.id}/verify`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'dns-txt',
          passed: true,
          verification: { state: 'verified', method: 'dns-txt', verifiedAt: CHECKED_AT },
          lastCheck: { passed: true },
        }),
      });

      expect(response.status).toBe(200);
      const answered = await bodyOf(response);
      expect(answered.check?.passed).toBe(false);
      expect(answered.verification).toEqual(UNVERIFIED);
    });
  });

  describe('a method this platform cannot check yet', () => {
    it('answers 400 naming the methods that are available', async () => {
      const site = await add();

      // `connected-repository` left this list when #238 wired its check in: it is a check
      // that runs and answers "nothing is connected", which is a result and not a refusal.
      for (const method of ['meta-tag', 'well-known-file']) {
        const response = await verify(site.id, method);

        expect(response.status).toBe(400);
        const refused = await bodyOf(response);
        expect(refused.error).toContain(method);
        expect(refused.error).toContain('dns-txt');
        expect(refused.available).toEqual(['dns-txt', 'connected-repository']);
      }
      expect(AVAILABLE_SITE_VERIFICATION_METHODS).toEqual(['dns-txt', 'connected-repository']);
    });

    it('answers 400 naming them for a method that is no method at all', async () => {
      const site = await add();

      for (const method of [
        'dns',
        'DNS-TXT',
        '',
        42,
        null,
        { method: 'dns-txt' },
        // Keys every object answers to, which a plain property read would hand back as a
        // check: `CHECKS['constructor']` is `Object`, and calling it returns the site.
        'constructor',
        'toString',
        '__proto__',
        'hasOwnProperty',
      ]) {
        const response = await verify(site.id, method);

        expect(response.status).toBe(400);
        expect((await bodyOf(response)).error).toContain('dns-txt');
      }
    });

    it('asks for one when the body names no method, and names what is available', async () => {
      const site = await add();

      for (const body of ['{}', '{"method":null}', '']) {
        const response = await served.request(`/sites/${site.id}/verify`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body,
        });

        expect(response.status).toBe(400);
        const refused = await bodyOf(response);
        expect(refused.error).toContain('Name the check to run');
        expect(refused.error).toContain('dns-txt');
      }
    });

    it('ran no check and stored nothing', async () => {
      const site = await add();
      publish(HOST, site);

      await verify(site.id, 'meta-tag');

      expect(asked).toEqual([]);
      const stored = await read(site.id);
      expect(stored.verification).toEqual(UNVERIFIED);
      expect(stored.lastCheck).toBeNull();
    });

    it('answers a body it could not read without pretending a check ran', async () => {
      const site = await add();

      const response = await served.request(`/sites/${site.id}/verify`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{not json',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBe('That check could not be read.');
    });
  });

  describe('a site that has been removed', () => {
    it('answers 404 and runs no check, as editing a removed audience does', async () => {
      // A removed site is readable and is not checkable: the user said they were done with
      // this address, and proving control of one they have taken away verifies nothing.
      const site = await add();
      publish(HOST, site);
      expect((await send(`/sites/${site.id}`, 'DELETE')).status).toBe(200);

      const response = await verify(site.id);

      expect(response.status).toBe(404);
      expect((await bodyOf(response)).error).toBe('There is no such site.');
      expect(asked).toEqual([]);
      expect((await read(site.id)).verification).toEqual(UNVERIFIED);
    });
  });

  describe('a site of another workspace', () => {
    it('answers 404, as reading one does, and runs no check', async () => {
      const mine = await add();
      publish(HOST, mine);

      const response = await verify(mine.id, 'dns-txt', theirCookie);

      expect(response.status).toBe(404);
      expect((await bodyOf(response)).error).toBe('There is no such site.');
      expect(asked).toEqual([]);
      expect((await read(mine.id)).verification).toEqual(UNVERIFIED);
    });

    it('answers 404 before it answers 400, so a bad method does not disclose the site', async () => {
      const mine = await add();

      const theirs = await verify(mine.id, 'meta-tag', theirCookie);
      const nobodys = await verify('a-site-nobody-has', 'meta-tag', theirCookie);

      expect([theirs.status, nobodys.status]).toEqual([404, 404]);
      expect(await bodyOf(theirs)).toEqual(await bodyOf(nobodys));
    });

    it('does not verify this site with the other workspace’s published token', async () => {
      // The same URL in two workspaces is two sites with two tokens: one workspace's record
      // on the domain is not the other's proof.
      const mine = await add();
      const theirs = await add(A_URL, theirCookie);
      publish(HOST, theirs);

      expect((await bodyOf(await verify(mine.id))).check?.passed).toBe(false);
      expect((await bodyOf(await verify(theirs.id, 'dns-txt', theirCookie))).check?.passed).toBe(
        true,
      );
    });
  });

  describe('signed out', () => {
    it('is 401, and runs no check', async () => {
      const site = await add();
      publish(HOST, site);

      const response = await served.request(`/sites/${site.id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'dns-txt' }),
      });

      expect(response.status).toBe(401);
      expect(asked).toEqual([]);
    });
  });

  describe('the check the server ran', () => {
    it('asked the injected resolver and nothing else, so no test reaches the network', async () => {
      const site = await add();

      await verify(site.id);

      expect(asked).toEqual([HOST, DOMAIN]);
    });
  });
});
