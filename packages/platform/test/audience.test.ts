import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDirName, writeRun } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import {
  AudienceValidationError,
  OUTDOOR_GEAR_SHOPPERS,
  parseAudience,
} from '@personavision/personas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ageGroup, validArtifact } from '../../contract/tests/fixtures.js';
import {
  ALMATY_PARENTS,
  EXPECTED_DRAWN_FIELDS,
} from '../../personas/tests/drawn-fields-expectation.js';
import { AudienceNotOfferedError, audienceForNewTest } from '../src/audience/freeze.js';
import { withPeople } from '../src/audience/people.js';
import { createPlatform } from '../src/platform.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { DEFAULT_PARTICIPANTS } from '../src/server/routes/audiences.js';
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

/** How many people each value of a drawn field went to. */
const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

/**
 * How many of `size` people a share is worth — 46% of a hundred is 46 of them.
 *
 * Only ever called with shares that divide the size whole, so it is the arithmetic a user
 * does when they read *72% on phones* and not a second copy of the generator's
 * largest-remainder rule, which is asserted where that rule lives.
 */
const peopleIn = (fraction: number, size: number): number => Math.round(fraction * size);

/**
 * `id|gender|age group|age|language` for each of the hundred people `ALMATY_PARENTS` draws,
 * as `@personavision/personas` committed them (#278), read as fields.
 *
 * The age group is in here and not on the person: a bracket moves somebody's patience and
 * reading rather than being a field they carry, so these rows are where a test can count
 * the brackets at all.
 */
const drawnRows = (): { id: string; gender: string; group: string; language: string }[] =>
  EXPECTED_DRAWN_FIELDS.map((row) => {
    const fields = row.split('|');
    return {
      id: fields[0] ?? '',
      gender: fields[1] ?? '',
      group: fields[2] ?? '',
      language: fields[4] ?? '',
    };
  });

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

  describe('an audience with a gender split, age groups and languages', () => {
    /**
     * `docs/FLOW.md` section 12's own worked example, and the one place it is written down:
     * a hundred busy parents in Almaty, 72% on phones, 28 to 44, Russian and Kazakh. A
     * clone of it, because it is a committed object and a test that edited one would reach
     * the next test.
     */
    const almatyParents = (): Audience => structuredClone(ALMATY_PARENTS);

    /** What `@personavision/personas` says is wrong with an audience: the schema's own words. */
    const contractIssues = (audience: unknown): { path: string; message: string }[] => {
      try {
        parseAudience(audience);
      } catch (error) {
        if (error instanceof AudienceValidationError) return [...error.issues];
        throw error;
      }
      throw new Error('this audience was expected to be refused');
    };

    it('is created, listed and read back with the new fields intact', async () => {
      const created = await send('/audiences', 'POST', almatyParents());
      expect(created.status).toBe(201);
      const { id } = await bodyOf(created);

      const read = await send(`/audiences/${id}`, 'GET');
      expect(read.status).toBe(200);
      expect((await bodyOf(read)).audience).toStrictEqual(almatyParents());
      expect((await listed()).find((entry) => entry.id === id)?.audience).toStrictEqual(
        almatyParents(),
      );
    });

    it('reads back identically from the same data directory after a restart', async () => {
      const { id } = await bodyOf(await send('/audiences', 'POST', almatyParents()));

      // A second platform over the directory the first wrote. That is what a restart is:
      // the settings file is already there, so nothing is seeded and every record read
      // here came off disk rather than out of the first process's memory.
      const restarted = await createPlatform({
        dataDir: served.directories.dataDir,
        runsRoot: served.directories.runsRoot,
      });
      expect(restarted.seeded).toBeNull();

      const record = await restarted.store.audiences.byId(workspaceId, id);
      expect(record).not.toBeNull();
      expect(record?.audience).toStrictEqual(almatyParents());
      expect(withPeople(record as NonNullable<typeof record>).people).toHaveLength(
        almatyParents().size,
      );
    });

    it('previews the hundred people that audience and that seed draw', async () => {
      const created = await bodyOf(await send('/audiences', 'POST', almatyParents()));

      expect(created.issues).toStrictEqual([]);
      expect(created.people).toHaveLength(almatyParents().size);
      // Against #278's committed expectation rather than a second run of the generator:
      // what the preview promises beside the people is *same audience and seed, same
      // people*, and two calls agreeing with each other would not say that.
      expect(
        created.people.map(
          (person) => `${person.id}|${String(person.gender)}|${String(person.language)}`,
        ),
      ).toStrictEqual(drawnRows().map((row) => `${row.id}|${row.gender}|${row.language}`));
    });

    it('draws each share of the gender split as that share of the people', async () => {
      const created = await bodyOf(await send('/audiences', 'POST', almatyParents()));
      const { genderSplit, size } = almatyParents();
      expect(genderSplit).toBeDefined();

      expect(tally(created.people.map((person) => String(person.gender)))).toStrictEqual(
        Object.fromEntries(
          Object.entries(genderSplit as NonNullable<typeof genderSplit>).map(([word, fraction]) => [
            word,
            peopleIn(fraction, size),
          ]),
        ),
      );
    });

    it('draws each age group as that share of the people, bracket by bracket', async () => {
      // A person does not carry the bracket they were dealt — it moves their own patience
      // and reading instead — so the brackets are read off the committed rows. The line
      // that makes this a statement about *this* list is the one below it: the people this
      // route answered with are those rows, person for person.
      const created = await bodyOf(await send('/audiences', 'POST', almatyParents()));
      const rows = drawnRows();
      expect(created.people.map((person) => person.id)).toStrictEqual(rows.map((row) => row.id));

      const { ageGroups, size } = almatyParents();
      expect(ageGroups).toBeDefined();
      expect(tally(rows.map((row) => row.group))).toStrictEqual(
        Object.fromEntries(
          (ageGroups as NonNullable<typeof ageGroups>).map((entry) => [
            entry.group,
            peopleIn(entry.share, size),
          ]),
        ),
      );
    });

    it('gives every person one of the audience’s languages, an even share each', async () => {
      const created = await bodyOf(await send('/audiences', 'POST', almatyParents()));
      const { languages, size } = almatyParents();
      expect(languages).toBeDefined();
      const spoken = languages as NonNullable<typeof languages>;

      for (const person of created.people) expect(spoken).toContain(person.language);
      expect(tally(created.people.map((person) => String(person.language)))).toStrictEqual(
        Object.fromEntries(spoken.map((language) => [language, peopleIn(1 / spoken.length, size)])),
      );
    });

    it('is refused at the path of the share that does not sum to one, and never half-stored', async () => {
      const wrong: [string, unknown][] = [
        ['genderSplit', { ...almatyParents(), genderSplit: { male: 0.7, female: 0.7 } }],
        [
          'ageGroups',
          { ...almatyParents(), ageGroups: [ageGroup('25–34', 0.3), ageGroup('35–44', 0.3)] },
        ],
      ];

      for (const [path, audience] of wrong) {
        const response = await send('/audiences', 'POST', audience);
        expect(response.status, path).toBe(400);
        const body = await bodyOf(response);
        expect(
          body.issues.map((issue) => issue.path),
          path,
        ).toStrictEqual([path]);
        // The message is the contract's, not a second one written in the platform: the
        // audience is declared once, so what is wrong with one is stated once.
        expect(body.issues, path).toStrictEqual(contractIssues(audience));
      }

      expect((await listed()).map((entry) => entry.id)).toStrictEqual([seededAudienceId]);
    });

    it('is frozen by value, down to the lists and the split the new fields carry', async () => {
      const { id } = await bodyOf(await send('/audiences', 'POST', almatyParents()));
      const frozen = await audienceForNewTest(served.platform.store.audiences, workspaceId, id);
      const stored = await served.platform.store.audiences.byId(workspaceId, id);

      expect(frozen).toStrictEqual(stored?.audience);
      expect(frozen).not.toBe(stored?.audience);
      expect(frozen.languages).not.toBe(stored?.audience.languages);
      expect(frozen.genderSplit).not.toBe(stored?.audience.genderSplit);
      expect(frozen.ageGroups).not.toBe(stored?.audience.ageGroups);
      expect(frozen.ageGroups?.[0]).not.toBe(stored?.audience.ageGroups?.[0]);
    });

    it('leaves an audience that declares none of them previewing as it did', async () => {
      await send('/audiences', 'POST', almatyParents());

      const read = await bodyOf(await send(`/audiences/${seededAudienceId}`, 'GET'));
      expect(read.audience).toStrictEqual(fixtureAudience());
      expect(read.people).toHaveLength(fixtureAudience().size);
      for (const person of read.people) {
        // Absent and not empty: a person drawn from an audience that named nothing to draw
        // from was drawn as nothing in particular, which is what the missing field says.
        expect(person.gender).toBeUndefined();
        expect(person.language).toBeUndefined();
      }
    });
  });

  describe('an audience created with no number of participants', () => {
    /** The audience as the form sends it with that field left empty. */
    const withoutParticipants = (): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(structuredClone(ALMATY_PARENTS)).filter(([field]) => field !== 'size'),
      );

    it('is stored with a hundred, from this package’s one named default', async () => {
      expect(DEFAULT_PARTICIPANTS).toBe(100);

      const created = await send('/audiences', 'POST', withoutParticipants());
      expect(created.status).toBe(201);
      const body = await bodyOf(created);
      expect(body.audience.size).toBe(DEFAULT_PARTICIPANTS);
      expect(body.people).toHaveLength(DEFAULT_PARTICIPANTS);

      const read = await bodyOf(await send(`/audiences/${body.id}`, 'GET'));
      expect(read.audience.size).toBe(DEFAULT_PARTICIPANTS);
      expect(read.people).toHaveLength(DEFAULT_PARTICIPANTS);
    });

    it('is left at the number an audience that names one names', async () => {
      const created = await bodyOf(
        await send('/audiences', 'POST', { ...withoutParticipants(), size: 24 }),
      );

      expect(created.audience.size).toBe(24);
      expect(created.people).toHaveLength(24);
    });

    it('is not read into a number that is there and wrong', async () => {
      // The default fills a field the submission leaves out. A field it names and gets
      // wrong is still the contract's to refuse, at its own path.
      const response = await send('/audiences', 'POST', { ...withoutParticipants(), size: 0 });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).issues.map((issue) => issue.path)).toStrictEqual(['size']);
    });

    it('is not applied by a PATCH, which leaves a stored audience the size it is', async () => {
      // The demo audience generates four people. A PATCH naming something else must not
      // quietly resize it to a hundred: the default is for an audience being created.
      const patched = await send(`/audiences/${seededAudienceId}`, 'PATCH', {
        name: 'Outdoor-gear shoppers, still',
      });

      expect(patched.status).toBe(200);
      expect((await bodyOf(patched)).audience.size).toBe(fixtureAudience().size);
    });
  });

  describe('an audience written by a generator version this build does not implement', () => {
    it('reports its reason on its own card and takes no other audience down with it', async () => {
      const mine = await bodyOf(await send('/audiences', 'POST', structuredClone(ALMATY_PARENTS)));
      // Written through the store rather than the route, because the route refuses an
      // audience nobody can be generated from. This is the one such record that reaches
      // storage: it was written, and generated from, by a build that is not this one.
      const audience = structuredClone(ALMATY_PARENTS);
      const later = await served.platform.store.audiences.create(workspaceId, {
        ...audience,
        id: 'audience-from-a-later-build',
        generatedFrom: { ...audience.generatedFrom, generatorVersion: 'persona-gen-9999' },
      });

      const entries = await listed();
      const card = entries.find((entry) => entry.id === later.id);
      expect(card?.people).toStrictEqual([]);
      expect(card?.issues.map((issue) => issue.path)).toStrictEqual([
        'generatedFrom.generatorVersion',
      ]);
      // The list is still a list: the other two cards carry their people as before.
      expect(entries.find((entry) => entry.id === mine.id)?.people).toHaveLength(
        ALMATY_PARENTS.size,
      );
      expect(entries.find((entry) => entry.id === seededAudienceId)?.people).toHaveLength(
        fixtureAudience().size,
      );
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

  /**
   * Where one of those words is a field of **another type** that happens to be named after
   * the audience's, and not the audience being restated. One entry so far.
   *
   * `AudienceAskInput.generatorVersion` (`@personavision/provider`) is the generator a
   * written audience is to be labelled with, and it is required: the provider generates
   * nobody, so it cannot know it and the caller stamps it on. `POST
   * /audiences/from-sentence` is that caller (#396), and filling a required field of a
   * documented input type in is not a second declaration of the audience — the audience it
   * gets back is still held to `audienceSchema` by `parseAudience`, like every other
   * audience this package stores, and the version itself is read off
   * `@personavision/personas`, which owns it.
   *
   * It is an allowance named file by file and field by field rather than a word dropped
   * from the list above, so that the next file to use that name is still caught. Spelling
   * the key some other way to keep this scan quiet would have hidden exactly what the scan
   * is for.
   */
  const NOT_THE_AUDIENCE: ReadonlyMap<string, readonly string[]> = new Map([
    ['server/routes/audiences.ts', ['generatorVersion']],
  ]);

  it('is imported from the contract and restated nowhere in packages/platform', async () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = (await readdir(src, { recursive: true })).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const restated: string[] = [];
    for (const file of files) {
      const body = await readFile(join(src, file), 'utf8');
      const allowed = NOT_THE_AUDIENCE.get(file) ?? [];
      restated.push(
        ...FIELDS.filter((field) => body.includes(field) && !allowed.includes(field)).map(
          (f) => `${file}: ${f}`,
        ),
      );
    }

    expect(restated).toStrictEqual([]);
  });
});
