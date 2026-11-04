import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { GITHUB_APP_NOT_REGISTERED, GITHUB_APP_TICKET } from '../src/server/routes/github.js';
import { storedSiteConnections } from '../src/site/index.js';
import { hashPassword } from '../src/store/password.js';
import type { GithubInstallationRecord } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The installation record, and the connected repository it says deploys a site (#299).
 *
 * Three things are asserted here and nothing else is: the **record** — one per workspace,
 * replaced rather than accumulated, readable by its own workspace and by no other, and
 * carrying no credential; the **lookup** #238 declared, now answering from that record, which
 * is how `@personavision/improve` finds the repository for a site; and the two **routes** a
 * screen reads, one of which can only say that there is no App to connect to yet (#231).
 *
 * The installation is the one proof of control this product asks for, and it proves it by
 * existing: a site is a URL and nothing more, so connecting a repository writes this record
 * and nothing on a site.
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
  registered: boolean;
  connection: { repository: string; siteId: string; connectedAt: string } | null;
  sentence: string;
  error?: string;
}

/** A site as the site routes answer with one. Only what these tests read. */
interface SiteBody {
  id: string;
  url: string;
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

    it('is refused for a site of another workspace, at the one writer', async () => {
      const mine = await addSite();

      // The record says which repository deploys the site it names, so a site that is not
      // this workspace's cannot be named by it — a connection filed this way would otherwise
      // put a foreign site id into this workspace's own answer.
      await expect(connect(mine.id, { workspace: theirWorkspaceId })).rejects.toThrow(/no site/);
      expect(
        await served.platform.store.githubInstallations.forWorkspace(theirWorkspaceId),
      ).toBeNull();
    });

    it('is refused for a site nobody has', async () => {
      await expect(connect('a-site-nobody-has')).rejects.toThrow(/no site/);
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

  describe('the lookup that names the repository for a site', () => {
    it('answers this workspace’s connection, and nothing of another workspace’s', async () => {
      const mine = await addSite();
      await connect(mine.id);
      const lookup = storedSiteConnections(served.platform.store.githubInstallations);

      expect(await lookup.forWorkspace(workspaceId)).toEqual([
        { siteId: mine.id, repository: REPOSITORY, connectedAt: expect.any(String) },
      ]);
      expect(await lookup.forWorkspace(theirWorkspaceId)).toEqual([]);
    });

    it('does not carry the installation id into what a reader reads', async () => {
      const mine = await addSite();
      await connect(mine.id);

      const connections = await storedSiteConnections(
        served.platform.store.githubInstallations,
      ).forWorkspace(workspaceId);

      expect(JSON.stringify(connections)).not.toContain(AN_INSTALLATION);
    });
  });

  describe('what a connection changes about a site', () => {
    it('writes the record and nothing on the site it names', async () => {
      const site = await addSite();
      const before = await served.platform.store.sites.byId(workspaceId, site.id);

      await connect(site.id);

      // A site is a URL and nothing more, so a connection has nothing on one to move: the
      // record it names reads exactly as it did, down to its `updatedAt`.
      expect(await served.platform.store.sites.byId(workspaceId, site.id)).toEqual(before);
    });

    it('offers no route that asks the platform to check a site', async () => {
      const site = await addSite();

      // The installation is the proof, and it proves it by existing: there is no route that
      // takes a method and goes looking, so a connection is never also a check.
      expect(
        served.platform.routes.filter((route) => route.path.test(`/sites/${site.id}/verify`)),
      ).toEqual([]);

      const response = await send(`/sites/${site.id}/verify`, 'POST', {
        method: 'connected-repository',
      });

      expect(response.headers.get('content-type')).not.toContain('application/json');
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
      // No App either, today, and that is the sentence with something in it to act on.
      expect(state.sentence).toBe(GITHUB_APP_NOT_REGISTERED);
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

    it('says the application is not registered yet, in the sentence', async () => {
      const state = await connectionState();

      expect(state.registered).toBe(false);
      expect(state.sentence).toBe(GITHUB_APP_NOT_REGISTERED);
    });

    it('says it is registered once an application exists', async () => {
      await served.close();
      served = await startTestServer({
        githubApp: { installationUrl: async () => 'https://github.test/apps/pv/installations/new' },
      });
      cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');

      const state = await connectionState();

      expect(state.registered).toBe(true);
      expect(state.sentence).toBe('No GitHub repository is connected to this workspace.');
    });

    it('answers the shape the viewer reads: registered, and the repository under connection', async () => {
      // `apps/viewer/src/screens/settings/connection.ts` parses exactly these two fields and
      // renders path 2 **locked** for anything it cannot parse (#271, merged first). This
      // asserts the contract from the platform's side, where the viewer's own tests stub the
      // request and so cannot see it.
      const site = await addSite();
      await connect(site.id);

      const state = (await connectionState()) as unknown as Record<string, unknown>;

      expect(typeof state['registered']).toBe('boolean');
      expect((state['connection'] as { repository?: unknown }).repository).toBe(REPOSITORY);
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
      served = await startTestServer({
        githubApp: { installationUrl: async () => installationUrl },
      });
      cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');

      const response = await send('/github/connect', 'POST');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ installationUrl, registered: true });
    });

    it('writes no connection: starting one is not filing one', async () => {
      await send('/github/connect', 'POST');

      expect(await served.platform.store.githubInstallations.forWorkspace(workspaceId)).toBeNull();
    });
  });
});
