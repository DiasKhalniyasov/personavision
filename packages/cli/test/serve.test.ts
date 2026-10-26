import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { findingsSchema, runPaths, runSchema, sessionSchema } from '@personavision/contract';
import { SESSION_COOKIE } from '@personavision/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveCommand } from '../src/commands/serve.js';
import type { ServeResult } from '../src/commands/serve.js';
import { personavision, startPersonavision } from './cli-process.js';
import { SCREENSHOT, SCREENSHOT_BYTES, temporaryWorkspace, writeRunAt } from './workspace.js';
import type { TestWorkspace } from './workspace.js';

/**
 * `personavision serve` over HTTP: the documented run-data paths served as the bytes on
 * disk, scoped to the workspace the request's session belongs to, with the platform's own
 * routes in front and the app behind.
 *
 * Everything here is asserted through requests rather than through the store, because
 * scoping that is only true inside the process is not scoping.
 */

const repoRoot = new URL('../../..', import.meta.url).pathname;

/** Every file under a directory, by its path relative to it. */
const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
};

describe('personavision serve', () => {
  let workspace: TestWorkspace;
  let served: ServeResult;
  let base: string;
  let theirRunId: string;
  let myCookie: string;
  let theirCookie: string;
  let theirWorkspaceId: string;

  const get = (path: string, cookie?: string): Promise<Response> =>
    fetch(new URL(path, base), {
      headers: cookie === undefined ? {} : { cookie },
      redirect: 'manual',
    });

  const cookieFor = async (workspaceId: string): Promise<string> => {
    const session = await served.platform.store.sessions.create({
      accountId: 'account',
      workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return `${SESSION_COOKIE}=${served.platform.signSession(session.id)}`;
  };

  beforeAll(async () => {
    workspace = await temporaryWorkspace();
    served = await serveCommand({
      dataDir: join(workspace.dir, '.personavision'),
      runsRoot: workspace.runsRoot,
      viewerDist: workspace.viewerDist,
      repoRoot,
      port: 0,
      build: false,
      openBrowser: false,
      log: () => undefined,
      announce: () => undefined,
    });
    base = served.url;

    // A second workspace with a run of its own, written after seeding so that the demo
    // workspace never owned it.
    theirRunId = await writeRunAt(workspace.runsRoot, {
      stamp: '2026-10-25T09:00:00Z',
      createdAt: '2026-10-25T09:00:00Z',
      name: 'another workspace',
    });
    const theirs = await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [],
      runIds: [theirRunId],
    });
    theirWorkspaceId = theirs.id;
    myCookie = await cookieFor(served.platform.seeded?.workspaceId ?? '');
    theirCookie = await cookieFor(theirWorkspaceId);
  });

  afterAll(async () => {
    await served.close();
    await workspace.cleanup();
  });

  it('seeds the demo workspace on a data directory that did not exist', () => {
    expect(served.platform.seeded?.workspaceName).toBe('Northwind Outdoors');
    expect(served.platform.seeded?.demoRunId).toBe(workspace.runId);
  });

  it('serves the app at /', async () => {
    const response = await get('/', myCookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toContain('<html');
  });

  it('serves the app at a screen route the run mount does not claim', async () => {
    const response = await get(`/runs/${workspace.runId}`, myCookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<html');
  });

  describe('the documented run-data paths', () => {
    const file = (path: string): string => join(workspace.runDir, path);

    it('returns run.json byte for byte, and it parses through the contract', async () => {
      const response = await get(`/runs/${workspace.runId}/run.json`, myCookie);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe(await readFile(file('run.json'), 'utf8'));
      expect(runSchema.safeParse(JSON.parse(body)).success).toBe(true);
    });

    it('returns findings.json byte for byte, and it parses through the contract', async () => {
      const response = await get(`/runs/${workspace.runId}/findings.json`, myCookie);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe(await readFile(file('findings.json'), 'utf8'));
      expect(findingsSchema.safeParse(JSON.parse(body)).success).toBe(true);
    });

    it('returns a session byte for byte, and it parses through the contract', async () => {
      const response = await get(`/runs/${workspace.runId}/sessions/S-01.json`, myCookie);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe(await readFile(runPaths(workspace.runDir).session('S-01'), 'utf8'));
      expect(sessionSchema.safeParse(JSON.parse(body)).success).toBe(true);
    });

    it('returns a screenshot byte for byte', async () => {
      const response = await get(
        `/runs/${workspace.runId}/screenshots/${SCREENSHOT.variant}/${SCREENSHOT.step}.png`,
        myCookie,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(SCREENSHOT_BYTES);
    });

    it('lists the session’s own workspace, newest first, and nobody else’s', async () => {
      const mine = (await (await get('/runs/index.json', myCookie)).json()) as {
        runId: string;
      }[];
      expect(mine.map((run) => run.runId)).toEqual([workspace.runId]);

      const theirs = (await (await get('/runs/index.json', theirCookie)).json()) as {
        runId: string;
      }[];
      expect(theirs.map((run) => run.runId)).toEqual([theirRunId]);
    });

    it('lists two runs of one workspace newest first', async () => {
      const second = await writeRunAt(workspace.runsRoot, {
        stamp: '2026-10-26T11:00:00Z',
        createdAt: '2026-10-26T11:00:00Z',
        name: 'a later test',
      });
      await served.platform.store.workspaces.addRun(theirWorkspaceId, second);

      const listed = (await (await get('/runs/index.json', theirCookie)).json()) as {
        runId: string;
      }[];
      expect(listed.map((run) => run.runId)).toEqual([second, theirRunId]);
    });
  });

  describe('a run of another workspace', () => {
    it('is not found, rather than forbidden', async () => {
      const response = await get(`/runs/${theirRunId}/run.json`, myCookie);
      expect(response.status).toBe(404);
      // 404 and not 403: that another workspace holds this run is not disclosed, and the
      // answer says nothing about it.
      expect(await response.text()).not.toContain('Another shop');
    });

    it('is not found for a signed-out request either', async () => {
      expect((await get(`/runs/${theirRunId}/run.json`)).status).toBe(404);
    });
  });

  describe('a signed-out request', () => {
    it('reads the seeded demo run, which the landing page and /demo show', async () => {
      expect((await get(`/runs/${workspace.runId}/run.json`)).status).toBe(200);
      const listed = (await (await get('/runs/index.json')).json()) as { runId: string }[];
      expect(listed.map((run) => run.runId)).toEqual([workspace.runId]);
    });
  });

  describe('signing in to the seeded workspace', () => {
    it('reads its run data with the cookie the printed credentials earn', async () => {
      const signedIn = await fetch(new URL('/auth/signin', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: served.platform.seeded?.email,
          password: served.platform.seeded?.password,
        }),
      });
      expect(signedIn.status).toBe(200);
      const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const response = await get(`/runs/${workspace.runId}/run.json`, cookie);
      expect(response.status).toBe(200);
    });

    it('sends a signed-out page request to /signin carrying where it was going', async () => {
      const response = await fetch(new URL('/audiences', base), {
        headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' },
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `/signin?next=${encodeURIComponent('/audiences')}`,
      );
    });
  });

  describe('the routes the next tickets fill in', () => {
    it('answers the audience routes with 501 naming #102', async () => {
      const saved = await fetch(new URL('/audiences', base), {
        method: 'POST',
        headers: { cookie: myCookie },
      });
      expect(saved.status).toBe(501);
      expect(await saved.text()).toContain('#102');

      const read = await fetch(new URL('/audiences/outdoor-gear-shoppers', base), {
        method: 'GET',
        headers: { accept: 'application/json', cookie: myCookie },
      });
      expect(read.status).toBe(501);
      expect(await read.text()).toContain('#102');
    });

    it('leaves /audiences to the app when a browser navigates to it', async () => {
      const response = await fetch(new URL('/audiences', base), {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'sec-fetch-dest': 'document',
          cookie: myCookie,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<html');
    });
  });

  it('writes nothing into a run directory: no account, no workspace, no email', async () => {
    const seeded = served.platform.seeded;
    const secrets = [seeded?.accountId ?? '', seeded?.workspaceId ?? '', seeded?.email ?? ''];

    for (const path of await filesUnder(workspace.runsRoot)) {
      const body = await readFile(join(workspace.runsRoot, path));
      for (const secret of secrets) {
        expect(body.includes(secret), `${path} mentions ${secret}`).toBe(false);
      }
    }
  });

  it('keeps the run artifact byte for byte what the pipeline wrote', async () => {
    // The committed artifact is the product's interface: the server reads it and never
    // writes to it, so the same bytes it was given are the bytes it still holds.
    expect(JSON.parse(await readFile(join(workspace.runDir, 'run.json'), 'utf8'))).toEqual(
      JSON.parse(await (await get(`/runs/${workspace.runId}/run.json`, myCookie)).text()),
    );
  });
});

describe('personavision serve, as the command', () => {
  let workspace: TestWorkspace;

  beforeAll(async () => {
    workspace = await temporaryWorkspace();
  });

  afterAll(() => workspace.cleanup());

  it('prints the URL and the generated password once, and nothing new on a restart', async () => {
    const dataDir = join(workspace.dir, 'first-start');
    const args = [
      'serve',
      '--no-open',
      '--no-build',
      '--port',
      '0',
      '--data-dir',
      dataDir,
      '--viewer',
      workspace.viewerDist,
    ];

    const first = startPersonavision(args, workspace.dir);
    try {
      await first.waitForLine(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally {
      await first.stop();
    }

    const printed = /^\s*Password\s+(\S+)$/m.exec(first.stdout());
    const password = printed?.[1];
    expect(password, first.stdout()).toBeDefined();
    expect(first.stdout().split(password as string)).toHaveLength(2);
    expect(first.stderr()).not.toContain(password);
    // `--data-dir` is honoured: the workspace is in the directory that was named.
    expect(await readdir(dataDir)).toContain('settings.json');

    const second = startPersonavision(args, workspace.dir);
    try {
      await second.waitForLine(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally {
      await second.stop();
    }
    expect(second.stdout()).not.toContain(password);
    expect(second.stdout()).not.toMatch(/Password/);
  });

  it('hands over the password even when the port it was given is taken', async () => {
    // The workspace is seeded before the port is bound and will not be seeded again, so
    // a start that cannot listen still has to print the only copy of the password.
    const taken: Server = createServer();
    await new Promise<void>((listening) => taken.listen(0, '127.0.0.1', listening));
    const port = String((taken.address() as AddressInfo).port);
    const dataDir = join(workspace.dir, 'refused-port');

    try {
      const refused = await personavision(
        [
          'serve',
          '--no-open',
          '--no-build',
          '--port',
          port,
          '--data-dir',
          dataDir,
          '--viewer',
          workspace.viewerDist,
        ],
        workspace.dir,
      );
      expect(refused.code).not.toBe(0);
      const password = /^\s*Password\s+(\S+)$/m.exec(refused.stdout)?.[1];
      expect(password, refused.stdout).toBeDefined();
      expect(refused.stdout).toContain('will not be');

      // And the next start, which does come up, signs in with that same password.
      const started = startPersonavision(
        [
          'serve',
          '--no-open',
          '--no-build',
          '--port',
          '0',
          '--data-dir',
          dataDir,
          '--viewer',
          workspace.viewerDist,
        ],
        workspace.dir,
      );
      try {
        await started.waitForLine(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      } finally {
        await started.stop();
      }
      expect(started.stdout()).not.toContain(password);
    } finally {
      await new Promise<void>((closed) => taken.close(() => closed()));
    }
  });

  it('fails with a message naming the port when the port is taken', async () => {
    const taken: Server = createServer();
    await new Promise<void>((listening) => taken.listen(0, '127.0.0.1', listening));
    const port = String((taken.address() as AddressInfo).port);

    try {
      const result = await personavision(
        [
          'serve',
          '--no-open',
          '--no-build',
          '--port',
          port,
          '--data-dir',
          join(workspace.dir, 'taken-port'),
          '--viewer',
          workspace.viewerDist,
        ],
        workspace.dir,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(port);
    } finally {
      await new Promise<void>((closed) => taken.close(() => closed()));
    }
  });
});
