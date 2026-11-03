import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { GITHUB_APP_NOT_REGISTERED, GITHUB_APP_TICKET } from '../src/server/routes/github.js';
import { storedSiteConnections } from '../src/site/index.js';
import { hashPassword } from '../src/store/password.js';
import type { GithubInstallationRecord, SiteCheckResult } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The installation record, and the connected repository that verifies the site it deploys
 * (#299).
 *
 * Three things are asserted here and nothing else is: the **record** — one per workspace,
 * replaced rather than accumulated, readable by its own workspace and by no other, and
 * carrying no credential; the **lookup** #238 declared, now answering from that record, so
 * that `connected-repository` verification passes for the site a connection names and keeps
 * its own sentences for the two cases that fail; and the two **routes** a screen reads, one
 * of which can only say that there is no App to connect to yet (#231).
 *
 * Everything that can be is asserted over HTTP, for the reason `sites.test.ts` gives: scoping
 * that is only true inside the process is not scoping. Nothing here reaches the network and
 * nothing here reads a credential — there is no GitHub App, which is half of what the
 * routes answer.
 */

const REPOSITORY = 'clipforge/web';
const ANOTHER_REPOSITORY = 'clipforge/marketing';
const AN_INSTALLATION = '45678901';

const A_URL = 'https://app.clipforge.example/create';
const ANOTHER_URL = 'https://beta.clipforge.example/create';

/** What `GET /github/connection` answers. Only what these tests read. */
interface ConnectionBody {
  connection: { repository: string; siteId: string; connectedAt: string } | null;
  sentence: string;
  application: { registered: boolean; reason: string | null };
  error?: string;
}

/** A site as the site routes answer with one, plus the check the verify route adds. */
interface SiteBody {
  id: string;
  url: string;
  verification: { state: string; method: string | null; verifiedAt: string | null };
  check?: SiteCheckResult;
}

/**
 * The shapes a credential takes, so that "no token is stored" is a test rather than a hope.
 *
 * Each pattern is assembled from fragments and the comments name the shape, the way
 * `tests/workspace.test.ts` does, so that this file cannot match itself and pass while a real
 * credential sits beside it.
 */
const CREDENTIAL_SHAPES = [
  // a GitHub installation or personal token, by its prefix
  new RegExp(['gh', '[a-z]_[A-Za-z0-9]{8,}'].join('')),
  // a PEM block, which is the shape the App's private key arrives in
  new RegExp(['-----BE', 'GIN [A-Z ]*PRIVATE KEY'].join('')),
  // a field whose name says it holds one
  new RegExp(
    ['"[a-zA-Z]*(?:to', 'ken|sec', 'ret|key|password|credential)[a-zA-Z]*"\\s*:'].join(''),
    'i',
  ),
] as const;

const carriesNoCredential = (what: string): void => {
  for (const shape of CREDENTIAL_SHAPES) expect(what).not.toMatch(shape);
};

describe('the connected repository', () => {
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
    method: 'GET' | 'POST',
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

  /** A site of the signed-in workspace, added as the Add-a-site form adds one. */
  const addSite = async (url = A_URL, as: string = cookie): Promise<SiteBody> => {
    const response = await send('/sites', 'POST', { url }, as);
    expect(response.status).toBe(201);
    return (await response.json()) as SiteBody;
  };

  /** The connection as the installation files it: through the store, never through a body. */
  const connect = (
    siteId: string,
    options: { workspace?: string; repository?: string; installationId?: string } = {},
  ): Promise<GithubInstallationRecord> =>
    served.platform.store.githubInstallations.connect(options.workspace ?? workspaceId, {
      installationId: options.installationId ?? AN_INSTALLATION,
      repository: options.repository ?? REPOSITORY,
      siteId,
    });

  const connectionState = async (as: string = cookie): Promise<ConnectionBody> => {
    const response = await send('/github/connection', 'GET', undefined, as);
    expect(response.status).toBe(200);
    return (await response.json()) as ConnectionBody;
  };

  const verify = async (siteId: string, as: string = cookie): Promise<SiteBody> => {
    const response = await send(
      `/sites/${siteId}/verify`,
      'POST',
      { method: 'connected-repository' },
      as,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as SiteBody;
  };

  beforeEach(async () => {
    served = await startTestServer();
    cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');
    workspaceId = served.platform.seeded?.workspaceId ?? '';
    expect(workspaceId).not.toBe('');

    // A second shop, with an account and a workspace of its own, as `sites.test.ts` sets up.
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

  describe('the installation record', () => {
    it('is held to shapes that do catch a credential, so the assertions are not vacuous', () => {
      // Each of the three shapes, caught: without this a typo in a pattern would make every
      // "carries no credential" assertion below pass by matching nothing at all.
      for (const credential of [
        `gh${'s'}_16CharactersOfToken`,
        `-----BE${'GIN'} RSA PRIVATE KEY-----`,
        '{"webhookSecret": "whatever"}',
      ]) {
        expect(CREDENTIAL_SHAPES.some((shape) => shape.test(credential))).toBe(true);
      }
    });

    it('is created for the workspace that connected it, with the moment it was connected', async () => {
      const site = await addSite();

      const record = await connect(site.id);

      expect(record.workspaceId).toBe(workspaceId);
      expect(record.repository).toBe(REPOSITORY);
      expect(record.siteId).toBe(site.id);
      expect(record.installationId).toBe(AN_INSTALLATION);
      expect(Date.parse(record.connectedAt)).not.toBeNaN();
    });

    it('is read back by its own workspace', async () => {
      const site = await addSite();
      await connect(site.id);

      expect(
        (await served.platform.store.githubInstallations.forWorkspace(workspaceId))?.repository,
      ).toBe(REPOSITORY);
    });

    it('is not readable by another workspace', async () => {
      await connect((await addSite()).id);

      expect(
        await served.platform.store.githubInstallations.forWorkspace(theirWorkspaceId),
      ).toBeNull();
    });

    it('is not replaceable by another workspace: each writes its own and both stand', async () => {
      const mine = await addSite();
      const theirs = await addSite(ANOTHER_URL, theirCookie);
      await connect(mine.id);

      await connect(theirs.id, {
        workspace: theirWorkspaceId,
        repository: ANOTHER_REPOSITORY,
      });

      const { githubInstallations } = served.platform.store;
      expect((await githubInstallations.forWorkspace(workspaceId))?.repository).toBe(REPOSITORY);
      expect((await githubInstallations.forWorkspace(theirWorkspaceId))?.repository).toBe(
        ANOTHER_REPOSITORY,
      );
    });

    it('is replaced by a second connection rather than leaving two', async () => {
      const first = await addSite();
      const second = await addSite(ANOTHER_URL);
      await connect(first.id);

      await connect(second.id, { repository: ANOTHER_REPOSITORY, installationId: '99887766' });

      const record = await served.platform.store.githubInstallations.forWorkspace(workspaceId);
      expect(record?.repository).toBe(ANOTHER_REPOSITORY);
      expect(record?.siteId).toBe(second.id);
      expect(record?.installationId).toBe('99887766');
      // And on disk: one record for this workspace, not two.
      const stored = JSON.parse(
        await readFile(join(served.directories.dataDir, 'github-installations.json'), 'utf8'),
      ) as GithubInstallationRecord[];
      expect(stored.filter((entry) => entry.workspaceId === workspaceId)).toHaveLength(1);
    });

    it('carries no key, no token and no secret — in the record or on disk', async () => {
      const record = await connect((await addSite()).id);

      expect(Object.keys(record).sort()).toEqual([
        'connectedAt',
        'id',
        'installationId',
        'repository',
        'siteId',
        'workspaceId',
      ]);
      carriesNoCredential(JSON.stringify(record));
      carriesNoCredential(
        await readFile(join(served.directories.dataDir, 'github-installations.json'), 'utf8'),
      );
    });
  });

  describe('the lookup the connected-repository check asks', () => {
    it('answers this workspace’s connection, and nothing of another workspace’s', async () => {
      const mine = await addSite();
      await connect(mine.id);
      const lookup = storedSiteConnections(served.platform.store.githubInstallations);

      expect(await lookup.forWorkspace(workspaceId)).toEqual([
        { siteId: mine.id, repository: REPOSITORY, connectedAt: expect.any(String) },
      ]);
      expect(await lookup.forWorkspace(theirWorkspaceId)).toEqual([]);
    });

    it('does not carry the installation id into what a check reads', async () => {
      const mine = await addSite();
      await connect(mine.id);

      const connections = await storedSiteConnections(
        served.platform.store.githubInstallations,
      ).forWorkspace(workspaceId);

      expect(JSON.stringify(connections)).not.toContain(AN_INSTALLATION);
    });
  });

  describe('verification by the connected repository', () => {
    it('verifies the site the connection names, by that method and at the check’s moment', async () => {
      const site = await addSite();
      await connect(site.id);

      const answered = await verify(site.id);

      expect(answered.verification.state).toBe('verified');
      expect(answered.verification.method).toBe('connected-repository');
      expect(answered.verification.verifiedAt).toBe(answered.check?.checkedAt);
      expect(answered.check?.passed).toBe(true);
      expect(answered.check?.sentence).toBe(
        `the GitHub repository ${REPOSITORY} is connected to this site`,
      );
    });

    it('says a connection on another site of this workspace is on another site', async () => {
      const connected = await addSite();
      const other = await addSite(ANOTHER_URL);
      await connect(connected.id);

      const answered = await verify(other.id);

      expect(answered.verification.state).toBe('unverified');
      expect(answered.check?.passed).toBe(false);
      expect(answered.check?.sentence).toBe(
        `the GitHub repository ${REPOSITORY} is connected to another site of this workspace`,
      );
    });

    it('says no repository is connected to this site where the workspace has connected none', async () => {
      const site = await addSite();

      const answered = await verify(site.id);

      expect(answered.verification.state).toBe('unverified');
      expect(answered.check?.sentence).toBe('no GitHub repository is connected to this site');
    });

    it('does not verify a site with another workspace’s connection', async () => {
      const mine = await addSite();
      // Their workspace connects a repository that names *my* site, which is the one thing a
      // connection must not be able to do across workspaces.
      await connect(mine.id, { workspace: theirWorkspaceId });

      const answered = await verify(mine.id);

      expect(answered.verification.state).toBe('unverified');
      expect(answered.check?.sentence).toBe('no GitHub repository is connected to this site');
    });

    it('goes through the store’s one writer, which refuses the result that did not pass', async () => {
      const site = await addSite();
      const failed = (await verify(site.id)).check as SiteCheckResult;

      await expect(
        served.platform.store.sites.verify(workspaceId, site.id, failed),
      ).rejects.toThrow(/did not/);
      expect(
        (await served.platform.store.sites.byId(workspaceId, site.id))?.verification.state,
      ).toBe('unverified');
    });

    it('carries no credential in what the check stored or answered', async () => {
      const site = await addSite();
      await connect(site.id);

      const answered = await verify(site.id);

      carriesNoCredential(JSON.stringify(answered.check));
      expect(JSON.stringify(answered.check)).not.toContain(AN_INSTALLATION);
    });
  });

  describe('GET /github/connection', () => {
    it('refuses a request with no session', async () => {
      const response = await served.request('/github/connection');

      expect(response.status).toBe(401);
      expect(((await response.json()) as ConnectionBody).error).toBe('Sign in to read this.');
    });

    it('answers the absence as a sentence rather than a blank', async () => {
      const state = await connectionState();

      expect(state.connection).toBeNull();
      expect(state.sentence).toBe('No GitHub repository is connected to this workspace.');
    });

    it('answers the repository, the site it deploys and when it was connected', async () => {
      const site = await addSite();
      const record = await connect(site.id);

      const state = await connectionState();

      expect(state.connection).toEqual({
        repository: REPOSITORY,
        siteId: site.id,
        connectedAt: record.connectedAt,
      });
      expect(state.sentence).toBe(`${REPOSITORY} is connected to this workspace.`);
    });

    it('says the application is not registered yet, with the reason', async () => {
      expect((await connectionState()).application).toEqual({
        registered: false,
        reason: GITHUB_APP_NOT_REGISTERED,
      });
    });

    it('says it is registered, with no reason, once an application exists', async () => {
      await served.close();
      served = await startTestServer({
        githubApp: { installationUrl: async () => 'https://github.test/apps/pv/installations/new' },
      });
      cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');

      expect((await connectionState()).application).toEqual({ registered: true, reason: null });
    });

    it('answers each workspace its own connection and carries no credential', async () => {
      const site = await addSite();
      await connect(site.id);

      const mine = await connectionState();
      const theirs = await connectionState(theirCookie);

      expect(mine.connection?.repository).toBe(REPOSITORY);
      expect(theirs.connection).toBeNull();
      carriesNoCredential(JSON.stringify(mine));
      expect(JSON.stringify(mine)).not.toContain(AN_INSTALLATION);
    });
  });

  describe('POST /github/connect', () => {
    it('refuses a request with no session', async () => {
      const response = await served.request('/github/connect', { method: 'POST' });

      expect(response.status).toBe(401);
    });

    it('answers that the application is not registered yet, with the reason and the ticket', async () => {
      const response = await send('/github/connect', 'POST');

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: GITHUB_APP_NOT_REGISTERED,
        ticket: GITHUB_APP_TICKET,
        registered: false,
      });
    });

    it('returns no URL while there is no application to install', async () => {
      const body = await (await send('/github/connect', 'POST')).text();

      expect(body).not.toMatch(/https?:\/\//);
    });

    it('answers the installation URL once an application is registered', async () => {
      const installationUrl = 'https://github.test/apps/pv/installations/new';
      await served.close();
      served = await startTestServer({ githubApp: { installationUrl: async () => installationUrl } });
      cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');

      const response = await send('/github/connect', 'POST');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ installationUrl, registered: true });
    });

    it('writes no connection: starting one is not filing one', async () => {
      await send('/github/connect', 'POST');

      expect(
        await served.platform.store.githubInstallations.forWorkspace(workspaceId),
      ).toBeNull();
    });
  });
});
