import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDirName, writeRun } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import { OUTDOOR_GEAR_SHOPPERS } from '@personavision/personas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validArtifact } from '../../contract/tests/fixtures.js';
import { AudienceNotOfferedError, audienceForNewTest } from '../src/audience/freeze.js';
import { withPeople } from '../src/audience/people.js';
import { createPlatform } from '../src/platform.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { hashPassword } from '../src/store/password.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';
import { temporaryDirectories } from './workspace.js';

/**
 * Audience storage: the store, its routes, and the copy a test freezes (#102).
 *
 * Everything that can be is asserted **over HTTP**, because scoping that is only true
 * inside the process is not scoping, and because these are the routes the Audience screens
 * (#109) read and write. The audience itself is never spelled out here: it is the committed
 * preset or the one the contract's own fixture carries, so a change to the schema reaches
 * this file as a compile error rather than as a test that passes about the wrong shape.
 */

/** The audience the seeded workspace takes from the run written before the platform starts. */
const fixtureAudience = (): Audience => validArtifact().run.audience;

/**
 * A second audience for the seeded workspace. It is the committed preset under an id of its
 * own, because an audience's `id` names one audience of a workspace: the preset's own id is
 * the one the seeded audience already carries, having come from the committed example run.
 */
const secondAudience = (): Audience => ({
  ...OUTDOOR_GEAR_SHOPPERS,
  id: 'winter-gear-shoppers',
  name: 'Winter-gear shoppers',
});

/** What a route answers with. Only what these tests read: the rest is the compiler's. */
interface AudienceBody {
  id: string;
  audience: Audience;
  people: Persona[];
  deletedAt: string | null;
  issues: { path: string; message: string }[];
  error?: string;
}

describe('the audience routes', () => {
  let served: TestServer;
  let cookie: string;
  let workspaceId: string;
  let seededAudienceId: string;

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await served.signIn({ email, password });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };

  const send = (
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    as: string = cookie,
  ): Promise<Response> =>
    served.request(path, {
      method,
      headers: {
        cookie: as,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const bodyOf = async (response: Response): Promise<AudienceBody> =>
    (await response.json()) as AudienceBody;

  const listed = async (as: string = cookie): Promise<AudienceBody[]> => {
    const response = await send('/audiences', 'GET', undefined, as);
    expect(response.status).toBe(200);
    return ((await response.json()) as { audiences: AudienceBody[] }).audiences;
  };

  beforeEach(async () => {
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
    });
    cookie = await signIn(DEMO_ACCOUNT_EMAIL, served.platform.seeded?.password ?? '');
    workspaceId = served.platform.seeded?.workspaceId ?? '';
    seededAudienceId = served.platform.seeded?.audienceId ?? '';
    expect(seededAudienceId).not.toBe('');
  });

  afterEach(() => served.close());

  describe('an audience saved through the store', () => {
    it('comes back from GET /audiences/:id with every field intact', async () => {
      const created = await send('/audiences', 'POST', secondAudience());
      expect(created.status).toBe(201);
      const { id } = await bodyOf(created);

      const read = await send(`/audiences/${id}`, 'GET');
      expect(read.status).toBe(200);
      expect((await bodyOf(read)).audience).toStrictEqual(secondAudience());
    });

    it('is listed by GET /audiences for its own workspace', async () => {
      const { id } = await bodyOf(await send('/audiences', 'POST', secondAudience()));

      expect((await listed()).map((entry) => entry.id)).toStrictEqual([seededAudienceId, id]);
    });

    it('keeps the fields a PATCH does not name, down to the one inside the field it does', async () => {
      const patched = await send(`/audiences/${seededAudienceId}`, 'PATCH', {
        ageRange: { max: 55 },
      });

      expect(patched.status).toBe(200);
      expect((await bodyOf(patched)).audience).toStrictEqual({
        ...fixtureAudience(),
        ageRange: { min: fixtureAudience().ageRange.min, max: 55 },
      });
    });

    it('is edited in place by PATCH, which answers with the audience as it now stands', async () => {
      const patched = await send(`/audiences/${seededAudienceId}`, 'PATCH', {
        name: 'Outdoor-gear shoppers, winter',
      });

      expect(patched.status).toBe(200);
      expect((await bodyOf(patched)).audience).toStrictEqual({
        ...fixtureAudience(),
        name: 'Outdoor-gear shoppers, winter',
      });
    });
  });

  describe('a second workspace', () => {
    let theirCookie: string;

    beforeEach(async () => {
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

    it('cannot read the first workspace’s audience, and is not told it exists', async () => {
      const response = await send(`/audiences/${seededAudienceId}`, 'GET', undefined, theirCookie);

      // 404 and not 403: that another workspace holds it is not disclosed.
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Outdoor-gear');
    });

    it('cannot list it', async () => {
      expect(await listed(theirCookie)).toStrictEqual([]);
    });

    it('cannot update it', async () => {
      const response = await send(
        `/audiences/${seededAudienceId}`,
        'PATCH',
        { name: 'Theirs' },
        theirCookie,
      );
      expect(response.status).toBe(404);

      const mine = await send(`/audiences/${seededAudienceId}`, 'GET');
      expect((await bodyOf(mine)).audience).toStrictEqual(fixtureAudience());
    });
  });

  describe('a request with no session', () => {
    it('is refused each route, and reads no audience', async () => {
      const paths: [string, 'GET' | 'POST' | 'PATCH'][] = [
        ['/audiences', 'GET'],
        ['/audiences', 'POST'],
        [`/audiences/${seededAudienceId}`, 'GET'],
        [`/audiences/${seededAudienceId}`, 'PATCH'],
      ];

      for (const [path, method] of paths) {
        const response = await served.request(path, { method });
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(await response.text()).not.toContain('Outdoor-gear');
      }
    });
  });

  describe('a browser navigating to /audiences', () => {
    it('gets the app’s screen rather than the route, on the list and on one audience', async () => {
      for (const path of ['/audiences', `/audiences/${seededAudienceId}`]) {
        const response = await served.navigate(path, cookie);
        expect(response.headers.get('content-type'), path).toContain('text/html');
      }
    });
  });

  describe('an audience the contract’s schema refuses', () => {
    const refusedAt = async (audience: unknown): Promise<string[]> => {
      const response = await send('/audiences', 'POST', audience);
      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      return body.issues.map((issue) => issue.path);
    };

    it('is rejected at the path of the device mix that does not sum to one', async () => {
      const audience = fixtureAudience();
      const [first] = audience.devices;
      expect(first).toBeDefined();
      expect(
        await refusedAt({
          ...audience,
          devices: [{ ...(first as Audience['devices'][number]), share: 0.1 }],
        }),
      ).toStrictEqual(['devices']);
    });

    it('is rejected at the path of an age range that runs backwards', async () => {
      expect(
        await refusedAt({ ...fixtureAudience(), ageRange: { min: 60, max: 20 } }),
      ).toStrictEqual(['ageRange']);
    });

    it('is rejected at the path of a field the audience does not declare', async () => {
      expect(await refusedAt({ ...fixtureAudience(), conversionRate: 0.2 })).toStrictEqual([
        'conversionRate',
      ]);
    });

    it('is not stored', async () => {
      await refusedAt({ ...fixtureAudience(), ageRange: { min: 60, max: 20 } });

      expect((await listed()).map((entry) => entry.id)).toStrictEqual([seededAudienceId]);
    });

    it('leaves a stored audience as it was when a PATCH is refused', async () => {
      const response = await send(`/audiences/${seededAudienceId}`, 'PATCH', { size: 0 });
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).issues.map((issue) => issue.path)).toStrictEqual(['size']);

      const read = await send(`/audiences/${seededAudienceId}`, 'GET');
      expect((await bodyOf(read)).audience).toStrictEqual(fixtureAudience());
    });

    it('is rejected, and not stored, when nobody can be generated from it', async () => {
      // `size` is a positive integer and nothing narrower, so an audience can ask for more
      // people than an array can hold. It is refused rather than stored: every answer
      // carries the people, so a stored record nothing can be generated from would answer
      // for itself and for every list it appears in, and no route deletes one.
      const response = await send('/audiences', 'POST', {
        ...secondAudience(),
        size: 5_000_000_000,
      });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).issues).not.toStrictEqual([]);
      expect((await listed()).map((entry) => entry.id)).toStrictEqual([seededAudienceId]);
    });

    it('is rejected at the id another audience of this workspace already carries', async () => {
      // The seeded audience came from the committed example run, so it already carries the
      // preset's id. A second record under it would leave a finished test unable to say
      // which stored audience it was run for.
      expect(await refusedAt(OUTDOOR_GEAR_SHOPPERS)).toStrictEqual(['id']);

      const created = await send('/audiences', 'POST', secondAudience());
      expect(created.status).toBe(201);
      const patched = await send(`/audiences/${(await bodyOf(created)).id}`, 'PATCH', {
        id: OUTDOOR_GEAR_SHOPPERS.id,
      });
      expect(patched.status).toBe(400);
      expect((await bodyOf(patched)).issues.map((issue) => issue.path)).toStrictEqual(['id']);
    });

    it('is rejected when the body is a list rather than an audience', async () => {
      for (const [path, method] of [
        ['/audiences', 'POST'],
        [`/audiences/${seededAudienceId}`, 'PATCH'],
      ] as [string, 'POST' | 'PATCH'][]) {
        const response = await send(path, method, []);
        expect(response.status, `${method} ${path}`).toBe(400);
      }

      const read = await send(`/audiences/${seededAudienceId}`, 'GET');
      expect((await bodyOf(read)).audience).toStrictEqual(fixtureAudience());
    });

    it('says what could not be read when the body is not JSON at all', async () => {
      const response = await served.request('/audiences', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: 'who my customers are',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBeTruthy();
    });
  });

  describe('the people an audience would generate', () => {
    it('are carried by every answer, as many as the audience generates', async () => {
      const created = await bodyOf(await send('/audiences', 'POST', secondAudience()));
      expect(created.people).toHaveLength(secondAudience().size);
      expect(created.issues).toStrictEqual([]);

      const read = await bodyOf(await send(`/audiences/${created.id}`, 'GET'));
      expect(read.people).toStrictEqual(created.people);
      expect((await listed()).map((entry) => entry.people.length)).toStrictEqual([
        fixtureAudience().size,
        secondAudience().size,
      ]);
    });

    it('are the same people for the same audience and seed, every time', async () => {
      const first = await bodyOf(await send(`/audiences/${seededAudienceId}`, 'GET'));
      const second = await bodyOf(await send(`/audiences/${seededAudienceId}`, 'GET'));

      expect(second.people).toStrictEqual(first.people);
      expect(first.people.map((person) => person.audienceId)).toStrictEqual(
        first.people.map(() => first.audience.id),
      );
    });

    it('change when the audience changes', async () => {
      const before = await bodyOf(await send(`/audiences/${seededAudienceId}`, 'GET'));
      const after = await bodyOf(
        await send(`/audiences/${seededAudienceId}`, 'PATCH', {
          generatedFrom: { ...fixtureAudience().generatedFrom, seed: 1234 },
        }),
      );

      expect(after.people).not.toStrictEqual(before.people);
    });
  });

  describe('a test that has started', () => {
    /**
     * Starting a test, as far as this ticket is concerned: the audience is resolved by id
     * and copied **by value** into `run.json`, which is what `RunRequest.audienceId` and
     * `runSchema.audience` say between them. The pipeline that does the rest is #54's.
     */
    const startTest = async (audienceId: string, name: string): Promise<string> => {
      const frozen = await audienceForNewTest(
        served.platform.store.audiences,
        workspaceId,
        audienceId,
      );
      const stamp = '2026-10-26T09:30:00.000Z';
      const runId = runDirName(new Date(stamp), name);
      const artifact = validArtifact();
      artifact.run = { ...artifact.run, runId, createdAt: stamp, audience: frozen };
      artifact.findings = { ...artifact.findings, runId };
      await writeRun(join(served.platform.runsRoot, runId), artifact);
      await served.platform.store.workspaces.addRun(workspaceId, runId);
      return runId;
    };

    const reportedAudience = async (runId: string): Promise<Audience> => {
      const response = await served.request(`/runs/${runId}/run.json`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return ((await response.json()) as { audience: Audience }).audience;
    };

    it('reports the audience it ran for, unchanged by a later edit of that audience', async () => {
      const runId = await startTest(seededAudienceId, 'frozen audience');
      expect(await reportedAudience(runId)).toStrictEqual(fixtureAudience());

      const patched = await send(`/audiences/${seededAudienceId}`, 'PATCH', {
        name: 'Somebody else entirely',
        techSavviness: 0.1,
        size: 2,
      });
      expect(patched.status).toBe(200);
      expect((await bodyOf(patched)).audience.name).toBe('Somebody else entirely');

      // The whole point of the copy: the finished test says what it was run for.
      expect(await reportedAudience(runId)).toStrictEqual(fixtureAudience());
    });

    it('keeps its audience readable after that audience is soft-deleted', async () => {
      const runId = await startTest(seededAudienceId, 'retired audience');
      await served.platform.store.audiences.softDelete(workspaceId, seededAudienceId);

      const read = await send(`/audiences/${seededAudienceId}`, 'GET');
      expect(read.status).toBe(200);
      expect((await bodyOf(read)).deletedAt).not.toBeNull();
      expect(await reportedAudience(runId)).toStrictEqual(fixtureAudience());
    });

    it('is not offered a soft-deleted audience for a new test', async () => {
      await served.platform.store.audiences.softDelete(workspaceId, seededAudienceId);

      expect(await listed()).toStrictEqual([]);
      await expect(startTest(seededAudienceId, 'too late')).rejects.toBeInstanceOf(
        AudienceNotOfferedError,
      );
    });

    it('refuses an edit to the audience it froze once that audience is retired', async () => {
      const runId = await startTest(seededAudienceId, 'retired audience');
      await served.platform.store.audiences.softDelete(workspaceId, seededAudienceId);

      const patched = await send(`/audiences/${seededAudienceId}`, 'PATCH', { name: 'Revived' });
      expect(patched.status).toBe(404);
      expect(await reportedAudience(runId)).toStrictEqual(fixtureAudience());
      expect(
        (await bodyOf(await send(`/audiences/${seededAudienceId}`, 'GET'))).audience,
      ).toStrictEqual(fixtureAudience());
    });

    it('is not offered another workspace’s audience either', async () => {
      const theirs = await served.platform.store.workspaces.create({
        name: 'Another shop',
        memberAccountIds: [],
      });
      const theirAudience = await served.platform.store.audiences.create(
        theirs.id,
        fixtureAudience(),
      );

      await expect(startTest(theirAudience.id, 'not mine')).rejects.toBeInstanceOf(
        AudienceNotOfferedError,
      );
    });

    it('holds a copy, not the stored object', async () => {
      const frozen = await audienceForNewTest(
        served.platform.store.audiences,
        workspaceId,
        seededAudienceId,
      );
      const stored = await served.platform.store.audiences.byId(workspaceId, seededAudienceId);

      expect(frozen).toStrictEqual(stored?.audience);
      expect(frozen).not.toBe(stored?.audience);
      expect(frozen.devices[0]).not.toBe(stored?.audience.devices[0]);
    });
  });
});

describe('the seeded demo workspace', () => {
  /** The repository's own runs root, read the way the preset's tests reach it. */
  const RUNS_ROOT = fileURLToPath(new URL('../../../runs', import.meta.url));

  it('has the Outdoor-gear shoppers audience, and it generates the four demo people', async () => {
    const directories = await temporaryDirectories();
    try {
      const platform = await createPlatform({
        dataDir: directories.dataDir,
        runsRoot: RUNS_ROOT,
      });
      const audiences = await platform.store.audiences.list(platform.seeded?.workspaceId ?? '');
      const [only] = audiences;
      expect(only).toBeDefined();

      const answered = withPeople(only as NonNullable<typeof only>);
      expect(answered.audience).toStrictEqual(OUTDOOR_GEAR_SHOPPERS);
      expect(answered.people.map((person) => person.name)).toStrictEqual([
        'Rushed buyer',
        'Careful comparer',
        'First-time visitor',
        'Price-sensitive scanner',
      ]);
    } finally {
      await directories.cleanup();
    }
  });
});

describe('the audience shape', () => {
  /**
   * The audience is declared by `@personavision/contract` and nowhere else (`CONTEXT.md`),
   * so no file of this package names one of its fields — in code or in a comment. A comment
   * that has to talk about a field is talking about the contract's, and says so by naming
   * the type instead; that is what keeps this scan honest rather than a word filter.
   */
  const FIELDS = [
    'techSavviness',
    'priceSensitivity',
    'ageRange',
    'generatedFrom',
    'generatorVersion',
    'deviceScaleFactor',
    'devices',
    'regions',
    'goals',
    'viewport',
  ];

  it('is imported from the contract and restated nowhere in packages/platform', async () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = (await readdir(src, { recursive: true })).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const restated: string[] = [];
    for (const file of files) {
      const body = await readFile(join(src, file), 'utf8');
      restated.push(...FIELDS.filter((field) => body.includes(field)).map((f) => `${file}: ${f}`));
    }

    expect(restated).toStrictEqual([]);
  });
});
