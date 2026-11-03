import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { checkConnectedRepository } from '../src/site/check-repository.js';
import { noSiteConnections } from '../src/site/connections.js';
import { AVAILABLE_SITE_VERIFICATION_METHODS } from '../src/site/verify.js';
import type { SiteConnections, SiteRepositoryConnection } from '../src/site/connections.js';
import type { SiteCheckResult, SiteVerification } from '../src/store/types.js';
import { hashPassword } from '../src/store/password.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * Verification by connected repository (#238), through the connection seam.
 *
 * The fourth method of `docs/FLOW.md` section 13 is the one the platform does not go and
 * look for: it **asks the seam** whether a repository is connected to this site, and the
 * seam answers nothing until the GitHub App of step #227 fills it in. So every assertion
 * here passes its own lookup, nothing reaches GitHub, and the default lookup — the one
 * `personavision serve` runs today — is asserted to answer "no connection" for every site.
 *
 * As with the DNS check, the assertions are about **the result's words** and not only its
 * boolean: `#screen-site`'s fourth panel prints them, and the two failing cases are two
 * different sentences because they are two different things for a user to do.
 */

/** The prototype's repository and site, so the lines asserted here are the lines it prints. */
const REPOSITORY = 'clipforge/web';
const A_URL = 'https://beta.clipforge.example/create';

/** `#screen-site`'s "Last check: … at 09:04." is this instant. */
const CHECKED_AT = '2026-11-03T09:04:00.000Z';

/** When the repository was connected, as `#screen-sites` prints it beside the method. */
const CONNECTED_AT = '2026-11-02T11:20:00.000Z';

/** The state a site reads until a check has passed on it. */
const UNVERIFIED: SiteVerification = { state: 'unverified', method: null, verifiedAt: null };

const connection = (siteId: string, repository = REPOSITORY): SiteRepositoryConnection => ({
  siteId,
  repository,
  connectedAt: CONNECTED_AT,
});

/**
 * A lookup over connections filed per workspace, and the workspaces it was asked about.
 *
 * Per workspace rather than a flat list, because "a connection of another workspace cannot
 * verify this site" is only an assertion if the fake could have answered one.
 */
const lookupOf = (
  byWorkspace: Record<string, readonly SiteRepositoryConnection[]>,
): { connections: SiteConnections; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    connections: {
      forWorkspace: async (workspaceId) => {
        asked.push(workspaceId);
        return byWorkspace[workspaceId] ?? [];
      },
    },
  };
};

const WORKSPACE = 'workspace-of-the-site';
const SITE = { id: 'the-site', workspaceId: WORKSPACE, url: A_URL, token: 'pv_7f3c91a2d84e' };

const check = async (
  byWorkspace: Record<string, readonly SiteRepositoryConnection[]>,
  site = SITE,
): Promise<{ result: SiteCheckResult; asked: string[] }> => {
  const { connections, asked } = lookupOf(byWorkspace);
  const result = await checkConnectedRepository(site, {
    resolveTxt: async () => {
      throw new Error('this check resolves nothing');
    },
    now: () => new Date(CHECKED_AT),
    connections,
  });
  return { result, asked };
};

describe('the connected-repository check', () => {
  describe('a connection that names this site', () => {
    it('passes, and names the repository the screen prints beside the method', async () => {
      const { result } = await check({ [WORKSPACE]: [connection(SITE.id)] });

      expect(result.passed).toBe(true);
      expect(result.method).toBe('connected-repository');
      expect(result.found).toEqual({
        outcome: 'found',
        at: [REPOSITORY],
        values: [],
        because: null,
      });
      expect(result.sentence).toBe(`the GitHub repository ${REPOSITORY} is connected to this site`);
      expect(result.checkedAt).toBe(CHECKED_AT);
    });

    it('asks the seam about this site’s own workspace and nothing else', async () => {
      const { asked } = await check({ [WORKSPACE]: [connection(SITE.id)] });

      expect(asked).toEqual([WORKSPACE]);
    });

    it('is not confused by another site of the same workspace being connected too', async () => {
      const { result } = await check({
        [WORKSPACE]: [connection('another-site', 'clipforge/marketing'), connection(SITE.id)],
      });

      expect(result.passed).toBe(true);
      expect(result.found.at).toEqual([REPOSITORY]);
    });
  });

  describe('no connection anywhere', () => {
    it('does not pass, and says no repository is connected to this site', async () => {
      const { result } = await check({});

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('nothing-published');
      expect(result.sentence).toBe('no GitHub repository is connected to this site');
      expect(result.sentence.toLowerCase()).not.toContain('something went wrong');
      expect(result.lookedFor).toBe('a GitHub repository connected to this site');
    });
  });

  describe('a connection on a different site of the same workspace', () => {
    it('does not pass, and says that instead — which is the thing the user can act on', async () => {
      const { result } = await check({ [WORKSPACE]: [connection('another-site')] });

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('other-values');
      expect(result.found.at).toEqual([REPOSITORY]);
      // Which site it is on, as data, so the screen can name the site rather than its id.
      expect(result.found.values).toEqual(['another-site']);
      expect(result.sentence).toBe(
        `the GitHub repository ${REPOSITORY} is connected to another site of this workspace`,
      );
    });

    it('names every one of them when the workspace has several', async () => {
      const { result } = await check({
        [WORKSPACE]: [
          connection('another-site'),
          connection('a-third-site', 'clipforge/marketing'),
        ],
      });

      expect(result.found.at).toEqual([REPOSITORY, 'clipforge/marketing']);
      expect(result.sentence).toBe(
        `the GitHub repositories ${REPOSITORY} and clipforge/marketing are connected to other sites of this workspace`,
      );
    });
  });

  describe('a connection of another workspace', () => {
    it('is not this site’s proof, even where it names this site’s id', async () => {
      const { result } = await check({ 'another-workspace': [connection(SITE.id)] });

      expect(result.passed).toBe(false);
      expect(result.sentence).toBe('no GitHub repository is connected to this site');
    });
  });

  describe('a lookup that could not answer', () => {
    it('is a result saying so, not a throw — the seam’s rule for all four methods', async () => {
      const result = await checkConnectedRepository(SITE, {
        resolveTxt: async () => [],
        now: () => new Date(CHECKED_AT),
        connections: {
          forWorkspace: async () => {
            throw new Error('the GitHub API answered 502');
          },
        },
      });

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toBe(
        'GitHub did not answer, so whether a repository is connected to this site is not known',
      );
      // Not the thrown message: what broke is ours, and it is not a sentence for a screen.
      expect(result.sentence).not.toContain('502');
    });
  });

  describe('the default lookup, which is what runs until #227 lands', () => {
    it('answers no connection for every site of every workspace', async () => {
      expect(await noSiteConnections.forWorkspace(WORKSPACE)).toEqual([]);
      expect(await noSiteConnections.forWorkspace('any-workspace-at-all')).toEqual([]);
    });

    it('is what the check reads when no lookup is injected at all', async () => {
      const result = await checkConnectedRepository(SITE, {
        resolveTxt: async () => [],
        now: () => new Date(CHECKED_AT),
      });

      expect(result.passed).toBe(false);
      expect(result.sentence).toBe('no GitHub repository is connected to this site');
    });
  });
});

/** What a route answers. Only the fields these tests read. */
interface SiteBody {
  id: string;
  url: string;
  token: string;
  verification: SiteVerification;
  lastCheck: SiteCheckResult | null;
  check?: SiteCheckResult;
  error?: string;
  available?: string[];
}

describe('POST /sites/:siteId/verify with method connected-repository', () => {
  let served: TestServer;
  let cookie: string;
  let theirCookie: string;
  let workspaceId: string;
  let theirWorkspaceId: string;
  /** The connections the injected lookup answers from, set per test. */
  let byWorkspace: Record<string, readonly SiteRepositoryConnection[]>;
  /** Every TXT name the server's checks asked for, so "no network" is an assertion. */
  let asked: string[];

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

  const read = async (siteId: string, as: string = cookie): Promise<SiteBody> =>
    bodyOf(await send(`/sites/${siteId}`, 'GET', undefined, as));

  const verify = (siteId: string, as: string = cookie): Promise<Response> =>
    send(`/sites/${siteId}/verify`, 'POST', { method: 'connected-repository' }, as);

  /** Connects a repository to a site, as the GitHub App of #227 will. */
  const connect = (workspace: string, site: string, repository = REPOSITORY): void => {
    byWorkspace[workspace] = [...(byWorkspace[workspace] ?? []), connection(site, repository)];
  };

  beforeEach(async () => {
    byWorkspace = {};
    asked = [];
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
      siteChecks: {
        resolveTxt: async (hostname) => {
          asked.push(hostname);
          return [];
        },
        now: () => new Date(CHECKED_AT),
      },
      // Injected the way the pipeline is (#227 passes the real lookup here and nothing
      // else changes). A test's own lookup makes no request.
      siteConnections: { forWorkspace: async (id) => byWorkspace[id] ?? [] },
    });
    cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');
    workspaceId = served.platform.seeded?.workspaceId ?? '';
    expect(workspaceId).not.toBe('');

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

  it('verifies the site when the lookup answers a connection naming it', async () => {
    const site = await add();
    connect(workspaceId, site.id);

    const response = await verify(site.id);

    expect(response.status).toBe(200);
    const verified = await bodyOf(response);
    expect(verified.verification).toEqual({
      state: 'verified',
      method: 'connected-repository',
      verifiedAt: CHECKED_AT,
    });
    expect(verified.check?.passed).toBe(true);
  });

  it('reads method connected-repository afterwards, with the repository in the result', async () => {
    const site = await add();
    connect(workspaceId, site.id);
    await verify(site.id);

    const stored = await read(site.id);
    expect(stored.verification.method).toBe('connected-repository');
    expect(stored.lastCheck?.found.at).toEqual([REPOSITORY]);
    expect(stored.lastCheck?.sentence).toBe(
      `the GitHub repository ${REPOSITORY} is connected to this site`,
    );
  });

  it('leaves the site unverified with the default lookup, and says no repository is connected', async () => {
    // The state every site is in until #227 lands: the seam answers nothing.
    const site = await add();

    const response = await verify(site.id);

    expect(response.status).toBe(200);
    const answered = await bodyOf(response);
    expect(answered.verification).toEqual(UNVERIFIED);
    expect(answered.check?.sentence).toBe('no GitHub repository is connected to this site');
    expect((await read(site.id)).lastCheck?.passed).toBe(false);
  });

  it('does not verify on a connection that names a different site of the workspace', async () => {
    const mine = await add();
    const other = await add('https://shop.clipforge.example/checkout');
    connect(workspaceId, other.id);

    const answered = await bodyOf(await verify(mine.id));

    expect(answered.verification).toEqual(UNVERIFIED);
    expect(answered.check?.found.values).toEqual([other.id]);
    expect(answered.check?.sentence).toBe(
      `the GitHub repository ${REPOSITORY} is connected to another site of this workspace`,
    );
  });

  it('cannot be verified by a connection of another workspace', async () => {
    const mine = await add();
    // Filed under the other workspace, and naming this site's id: the only thing that
    // keeps it out is that the lookup is asked about the session's own workspace.
    connect(theirWorkspaceId, mine.id);

    const answered = await bodyOf(await verify(mine.id));

    expect(answered.verification).toEqual(UNVERIFIED);
    expect(answered.check?.sentence).toBe('no GitHub repository is connected to this site');
  });

  it('is a site of this workspace or 404, as every other read of one is', async () => {
    const mine = await add();
    connect(workspaceId, mine.id);

    const response = await verify(mine.id, theirCookie);

    expect(response.status).toBe(404);
    expect((await read(mine.id)).verification).toEqual(UNVERIFIED);
  });

  it('goes through the store’s one writer, which no body can reach around', async () => {
    const site = await add();
    const { sites } = served.platform.store;

    // The seam itself writes nothing: a connection is not a verification until a check
    // reads it, and the check's result is the only thing `verify` accepts.
    connect(workspaceId, site.id);
    expect((await sites.byId(workspaceId, site.id))?.verification).toEqual(UNVERIFIED);

    // And a body claiming the check passed is nothing the route can see.
    const response = await served.request(`/sites/${site.id}/verify`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'connected-repository',
        passed: true,
        verification: { state: 'verified', method: 'connected-repository', verifiedAt: CHECKED_AT },
      }),
    });
    const answered = await bodyOf(response);
    // It passed because the connection is there, by the method the check names — not by
    // anything the body said: `verifiedAt` is the check's clock and not the body's.
    expect(answered.verification.method).toBe('connected-repository');
    expect(answered.check?.passed).toBe(true);

    // A result that did not pass is refused by the one writer, as #236 established.
    const failing = { ...(answered.check as SiteCheckResult), passed: false };
    await expect(sites.verify(workspaceId, site.id, failing)).rejects.toThrow(/did not/);
  });

  it('is offered as an available method, and reaches no network', async () => {
    const site = await add();
    connect(workspaceId, site.id);
    await verify(site.id);

    expect(AVAILABLE_SITE_VERIFICATION_METHODS).toContain('connected-repository');
    // The DNS resolver is the only network seam the server holds, and this check is not it.
    expect(asked).toEqual([]);
  });
});
