import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Audience, RunRequest } from '@personavision/contract';
import { runRequestSchema } from '@personavision/contract';
import { validRun } from '../../contract/tests/fixtures.js';
import { hashPassword } from '../src/store/password.js';
import { CAPS, CapRefusedError, refuseTooManyAgents } from '../src/caps.js';
import { foundTheLine, siteCheckResult, siteVerificationPair } from '../src/site/index.js';
import type { SiteAtLaunch } from '../src/run/start.js';
import type { SiteCheckResult, SiteRecord } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The caps: agents per run and runs per site per hour, enforced where a test starts (#239).
 *
 * Nearly every case here goes **over the API** rather than into `startTest`, because that is
 * the criterion: a cap a screen could get round is not a cap, so what is asserted is the
 * status code and the fields of the body a screen reads. The two that do not are the ones
 * about the module itself — that it is one module, and that it is handed no site state.
 *
 * The site every launch below runs against is **unverified** unless a case verifies it on
 * purpose. That is not laziness: the owner's answer of 2026-11-03 settled decision 71 as _no
 * gate on testing_, so an unverified site is the ordinary case and a cap that moved with the
 * verification state would fail here.
 */

const RUN_ID = '2026-11-03-0914-clipforge-create';

/** The site of the wizard's worked example, as `#screen-newtest-feature` names it. */
const SITE_URL = 'https://app.clipforge.example/create';

/** What the stand-in swarm was handed, each time. */
interface Call {
  request: RunRequest;
  audience: Audience;
  site?: SiteAtLaunch;
}

/** A refusal as `POST /runs` answers it: the sentence, and the figures beside it. */
interface Refusal {
  error: string;
  cap?: string;
  limit?: number;
  observed?: number;
  retryAt?: string | null;
}

describe('the caps are three numbers in one module', () => {
  it('states agents per run, concurrent sessions per site and runs per site per hour', () => {
    // The table of `docs/FLOW.md` section 13, as the owner's answer of 2026-11-03 leaves it.
    expect(CAPS).toStrictEqual({
      agentsPerRun: 100,
      concurrentSessionsPerSite: 10,
      runsPerSitePerHour: 4,
    });
  });

  it('is frozen, and is data rather than a function of a site', () => {
    expect(Object.isFrozen(CAPS)).toBe(true);
    // The structural half of "verification gates none of them": every value is a number
    // already decided, so there is no argument a verification state, a workspace or a site
    // could be passed in as. A cap cannot read what it is never handed.
    for (const value of Object.values(CAPS)) expect(typeof value).toBe('number');
    expect(Object.keys(CAPS)).toHaveLength(3);
    // And the one function that reads a cap takes a number of people and nothing else.
    expect(refuseTooManyAgents.length).toBe(1);
  });

  it('is the only place in the repository that defines them', async () => {
    // The acceptance criterion, as a test: a second literal anywhere is a second place a
    // number could be missed, and a screen that prints a different one is a screen that is
    // wrong rather than a cap that moved.
    const root = join(import.meta.dirname, '..', '..', '..');
    const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
      }
    };
    await walk(join(root, 'packages'));
    await walk(join(root, 'apps'));

    /**
     * Every spelling a second definition would plausibly take: the three names this module
     * publishes, and the shapes an alias would be written in. A name followed by `:` or `=`
     * and a digit is a definition; `caps: CAPS` and `CAPS.agentsPerRun` are reads and do not
     * match.
     */
    const DEFINITIONS =
      /\b(agentsPerRun|concurrentSessionsPerSite|runsPerSitePerHour|MAX_AGENTS|AGENTS_PER_RUN|RUNS_PER_HOUR|RUNS_PER_SITE_PER_HOUR|CONCURRENT_SESSIONS(_PER_SITE)?)\b\s*[:=]\s*\d/;

    const allowed = [
      // The one module that defines them.
      join('packages', 'platform', 'src', 'caps.ts'),
      // And this file, which pins the values — one test, in one place, deliberately.
      join('packages', 'platform', 'test', 'caps.test.ts'),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      const where = relative(root, path);
      if (allowed.includes(where)) continue;
      if (DEFINITIONS.test(await readFile(path, 'utf8'))) offenders.push(where);
    }

    expect(offenders).toStrictEqual([]);
    // And the numbers really are written in that module, so this test cannot pass by
    // finding nothing anywhere.
    expect(await readFile(join(root, allowed[0] ?? ''), 'utf8')).toMatch(DEFINITIONS);
  });
});

describe('the caps, enforced where a test starts', () => {
  let served: TestServer;
  let calls: Call[];
  let cookie: string;
  let workspaceId: string;
  let siteId: string;
  /**
   * What the stand-in swarm does before it answers. The default returns at once; a case
   * about launches in flight holds each one open until it releases it.
   */
  let held: ((release: () => void) => void) | null;
  /** Whether the stand-in swarm throws instead of answering, as a crashing one would. */
  let throws: boolean;

  /** The site record as it stands now, for reading the ledger between launches. */
  const siteNow = (): Promise<SiteRecord | null> =>
    served.platform.store.sites.byId(workspaceId, siteId);

  /** An audience of `size` people in the session's workspace, by id. */
  const audienceOf = async (size: number): Promise<string> =>
    (await served.platform.store.audiences.create(workspaceId, { ...validRun().audience, size }))
      .id;

  const post = (body: unknown, as: string = cookie): Promise<Response> =>
    served.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie: as },
      body: JSON.stringify(body),
    });

  /** What the launch step submits, for an audience of `size` people against `siteId`. */
  const launch = async (size: number, extra: Record<string, unknown> = {}): Promise<Response> =>
    post({
      site: SITE_URL,
      siteId,
      feature: 'Generating a video from a text prompt.',
      goal: {
        task: 'Generate a video from a text prompt, and wait until it is ready to watch.',
        successCriterion: 'The finished video is playable on the page.',
        lastWrittenBy: 'model',
      },
      audienceId: await audienceOf(size),
      ...extra,
    });

  /** `n` launches against the site, each `minutesAgo` old, written straight to the ledger. */
  const ledgerOf = async (entries: readonly number[]): Promise<void> => {
    for (const [index, minutesAgo] of entries.entries()) {
      await served.platform.store.sites.recordLaunch(workspaceId, siteId, {
        id: `launch-${String(index)}`,
        runId: `${RUN_ID}-${String(index)}`,
        at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      });
    }
  };

  /** A check that passed, so a site can be moved to verified the one way that is allowed. */
  const passingCheck = (token: string): SiteCheckResult =>
    siteCheckResult({
      method: 'dns-txt',
      subject: { one: 'TXT record', many: 'TXT records' },
      lookedFor: siteVerificationPair(token),
      lookedIn: [{ kind: 'domain', value: 'app.clipforge.example' }],
      found: foundTheLine(['app.clipforge.example']),
      at: new Date('2026-11-03T09:00:00.000Z'),
    });

  /** A site in a workspace that is not the session's, by id. */
  const anotherWorkspacesSite = async (): Promise<string> => {
    const them = await served.platform.store.accounts.create({
      email: 'owner@another.example',
      displayName: 'Another owner',
      password: await hashPassword('another-shops-password'),
    });
    const theirWorkspace = await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [them.id],
    });
    return (
      await served.platform.store.sites.create(theirWorkspace.id, {
        url: 'https://shop.another.example/checkout',
        token: 'pv_another',
      })
    ).id;
  };

  beforeEach(async () => {
    calls = [];
    held = null;
    throws = false;
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind-demo' }],
      // It reports back **what it was asked for**, so that nothing here is refused for
      // having run on the wrong model: this suite is about the caps, and `startTest`'s own
      // substitution rule (#144) has its own suite.
      pipeline: async (request, audience, site) => {
        calls.push({ request, audience, site });
        if (throws) throw new Error('the swarm fell over');
        if (held !== null) {
          await new Promise<void>((resolve) => {
            held?.(resolve);
          });
        }
        return {
          runId: RUN_ID,
          engineMode: request.engineMode,
          ...(request.engineMode === 'model' ? { modelMode: request.modelMode } : {}),
        };
      },
    });
    const seeded = served.platform.seeded;
    expect(seeded).not.toBeNull();
    const signedIn = await served.signIn({
      email: seeded?.email ?? '',
      password: seeded?.password ?? '',
    });
    expect(signedIn.status).toBe(200);
    cookie = cookieOf(signedIn);
    workspaceId = seeded?.workspaceId ?? '';
    const site = await served.platform.store.sites.create(workspaceId, {
      url: SITE_URL,
      token: 'pv_capsexample',
    });
    siteId = site.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await served.close();
  });

  describe('agents per run', () => {
    it('refuses an audience above a hundred with 429, naming the cap and the figures', async () => {
      const response = await launch(140);
      const body = (await response.json()) as Refusal;

      expect(response.status).toBe(429);
      expect(body.cap).toBe('agentsPerRun');
      expect(body.limit).toBe(100);
      expect(body.observed).toBe(140);
      // Nothing above the limit is promised, so there is no later at which this passes:
      // a hundred and forty people are a hundred and forty people in an hour too.
      expect(body.retryAt).toBeNull();
      // The sentence, verbatim and in one place — so the screen, this body and the CLI say
      // the same thing rather than three things.
      expect(body.error).toBe(
        'A test may run 100 agents; this audience asks for 140. Lower the participant count, or split it across two tests.',
      );
      // And the limit is stated as the ceiling it is, in the words as well as the field.
      expect(body.error).toContain('A test may run 100 agents');
      // Refused before anything ran: not one browser reached the site.
      expect(calls).toStrictEqual([]);
    });

    it('allows a launch of exactly a hundred', async () => {
      const response = await launch(100);

      expect(response.status).toBe(201);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.audience.size).toBe(100);
    });

    it('allows a launch of a hundred agents on an UNVERIFIED site', async () => {
      // The criterion stated on its own, because it is the one the owner settled: testing is
      // not gated on ownership (decision 71, 2026-11-03). What verification unlocks is
      // **Improve my site** (#227), not a bigger number here.
      const site = await served.platform.store.sites.byId(workspaceId, siteId);
      expect(site?.verification.state).toBe('unverified');

      const response = await launch(100);

      expect(response.status).toBe(201);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.site?.verifiedAtLaunch).toBe(false);
    });

    it('refuses an audience of a hundred and one, verified or not', async () => {
      await served.platform.store.sites.verify(workspaceId, siteId, passingCheck('pv_capsexample'));

      const response = await launch(101);
      const body = (await response.json()) as Refusal;

      expect(response.status).toBe(429);
      expect(body.limit).toBe(100);
      expect(body.observed).toBe(101);
      expect(calls).toStrictEqual([]);
    });
  });

  describe('runs per site per hour', () => {
    it('refuses the fifth run within the hour and says when the next is allowed', async () => {
      // Four launches in the last hour, the oldest fifty minutes ago.
      await ledgerOf([50, 30, 20, 5]);

      const response = await launch(10);
      const body = (await response.json()) as Refusal;

      expect(response.status).toBe(429);
      expect(body.cap).toBe('runsPerSitePerHour');
      expect(body.limit).toBe(4);
      expect(body.observed).toBe(4);
      // The oldest of the four falls out of the window ten minutes from now, which is the
      // first moment a fifth is under the limit — an instant, so the screen draws a
      // countdown beside the Launch button rather than the words "try again later".
      const retryAt = Date.parse(body.retryAt ?? '');
      expect(retryAt).toBeGreaterThan(Date.now());
      expect(retryAt).toBeLessThanOrEqual(Date.now() + 11 * 60 * 1000);
      expect(body.error).toMatch(
        /^This site has had its 4 runs this hour; the next may start at \d\d:\d\d\.$/,
      );
      expect(calls).toStrictEqual([]);
    });

    it('allows a run started sixty-one minutes after the first', async () => {
      // The same four launches, all now older than the hour the cap measures.
      await ledgerOf([64, 63, 62, 61]);

      const response = await launch(10);

      expect(response.status).toBe(201);
      expect(calls).toHaveLength(1);
    });

    it('records each launch against the site, so the fifth is the one refused', async () => {
      for (const attempt of [1, 2, 3, 4]) {
        expect((await launch(10)).status).toBe(201);
        const site = await served.platform.store.sites.byId(workspaceId, siteId);
        expect(site?.launches).toHaveLength(attempt);
      }

      expect((await launch(10)).status).toBe(429);
      // The refused one is not recorded: it drove nothing.
      const site = await served.platform.store.sites.byId(workspaceId, siteId);
      expect(site?.launches).toHaveLength(4);
      // One entry per launch, each annotated with the run it opened — the reservation and
      // the annotation are two writes of one entry, not two launches.
      expect(site?.launches?.map((entry) => entry.runId)).toStrictEqual([
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
      ]);
      expect(new Set(site?.launches?.map((entry) => entry.id)).size).toBe(4);
    });

    it('counts runs that are still in flight, not only the ones that finished', async () => {
      // The case the cap exists for: a person pressing Launch four times, or a client
      // retrying. None of the four pipelines has resolved, so a ledger written after the
      // pipeline would be empty and all five would start.
      const inFlight: (() => void)[] = [];
      held = (release) => inFlight.push(release);

      const started = [launch(10), launch(10), launch(10), launch(10)];
      // Four reservations are on the record before any of them has run a session.
      await vi.waitUntil(async () => (await siteNow())?.launches?.length === 4, {
        timeout: 2000,
      });
      expect((await siteNow())?.launches?.every((entry) => entry.runId === null)).toBe(true);

      // The fifth is refused while the other four are still open.
      const fifth = await launch(10);
      expect(fifth.status).toBe(429);
      expect(((await fifth.json()) as Refusal).cap).toBe('runsPerSitePerHour');

      // Released as each one arrives rather than all at once, because the site takes **one
      // run at a time** (#241): the four reservations above are on the ledger together, but
      // they reach the swarm one after another, so a release for a pipeline that has not
      // been called yet would be a release nobody takes.
      const releasing = setInterval(() => {
        for (const release of inFlight.splice(0)) release();
      }, 5);
      for (const response of started) expect((await response).status).toBe(201);
      clearInterval(releasing);
      // And the four entries are annotated rather than doubled.
      expect((await siteNow())?.launches).toHaveLength(4);
    });

    it('counts a launch whose pipeline threw, so a crash cannot be retried past the cap', async () => {
      // A ledger written only on success is a cap a retry loop walks straight through.
      throws = true;
      for (const attempt of [1, 2, 3, 4]) {
        expect((await launch(10)).status, `attempt ${String(attempt)}`).toBe(500);
      }

      expect((await siteNow())?.launches).toHaveLength(4);
      throws = false;
      const response = await launch(10);

      expect(response.status).toBe(429);
      expect(((await response.json()) as Refusal).cap).toBe('runsPerSitePerHour');
    });

    it('names a retry instant that is itself allowed, with more than four in the window', async () => {
      // Five in the hour: the oldest falling out still leaves four, so the instant to name
      // is when the *second* oldest does. Naming the oldest would send the user back to 429.
      await ledgerOf([59, 58, 30, 20, 5]);

      const response = await launch(10);
      const body = (await response.json()) as Refusal;
      expect(response.status).toBe(429);

      // Advance to exactly the instant the body promised, and the launch is allowed.
      const retryAt = Date.parse(body.retryAt ?? '');
      vi.setSystemTime(new Date(retryAt));
      const retried = await launch(10);

      expect(retried.status).toBe(201);
    });

    it('counts a site’s runs against that site alone', async () => {
      const other = await served.platform.store.sites.create(workspaceId, {
        url: 'https://shop.clipforge.example/checkout',
        token: 'pv_second',
      });
      await ledgerOf([50, 30, 20, 5]);

      // The first site is at its four; a second site of the same workspace is untouched.
      expect((await launch(10)).status).toBe(429);
      siteId = other.id;
      expect((await launch(10)).status).toBe(201);
    });
  });

  describe('the offline deterministic engine', () => {
    it('is bound by the agents cap, like a model run', async () => {
      const response = await launch(140, { engineMode: 'offline' });
      const body = (await response.json()) as Refusal;

      expect(response.status).toBe(429);
      expect(body.cap).toBe('agentsPerRun');
      expect(calls).toStrictEqual([]);
    });

    it('is bound by the hourly cap, like a model run', async () => {
      await ledgerOf([50, 30, 20, 5]);

      const response = await launch(10, { engineMode: 'offline' });
      const body = (await response.json()) as Refusal;

      // The cap is about the site being driven, not about what a run costs us: an offline
      // run opens the same browsers at the same address.
      expect(response.status).toBe(429);
      expect(body.cap).toBe('runsPerSitePerHour');
      expect(calls).toStrictEqual([]);
    });
  });

  describe('a test names its site', () => {
    it('refuses a site of another workspace as an unknown site', async () => {
      siteId = await anotherWorkspacesSite();
      const response = await launch(10);
      const body = (await response.json()) as Refusal;

      // Missing rather than forbidden: that another workspace holds this site is not news
      // we owe anybody, which is the rule the site routes already follow.
      expect(response.status).toBe(400);
      expect(body.error).toBe('There is no such site.');
      expect(calls).toStrictEqual([]);
    });

    it('refuses a launch naming no site at all, at the field', async () => {
      const response = await post({
        site: SITE_URL,
        feature: 'Generating a video from a text prompt.',
        goal: {
          task: 'Generate a video from a text prompt, and wait until it is ready to watch.',
          successCriterion: 'The finished video is playable on the page.',
          lastWrittenBy: 'model',
        },
        audienceId: await audienceOf(10),
      });
      const body = (await response.json()) as { issues?: { path: string; message: string }[] };

      expect(response.status).toBe(400);
      expect((body.issues ?? []).map((issue) => issue.path)).toStrictEqual(['siteId']);
      expect(body.issues?.[0]?.message).toContain('a test names the site it runs against');
      expect(calls).toStrictEqual([]);
    });

    it('refuses a two-variant comparison naming no site, at the same field', async () => {
      // Both forms reach `POST /runs` and both reach the caps, so the comparison form is
      // held to the same rule: a cap counted against nothing is not a cap. Nothing offers
      // this form today (decision 78), and #279's launch step is what sends the id.
      const response = await post({
        task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
        variants: validRun().variants,
        audienceId: await audienceOf(10),
        repeats: 1,
        seed: 1,
        engineMode: 'offline',
      });
      const body = (await response.json()) as { issues?: { path: string }[] };

      expect(response.status).toBe(400);
      expect((body.issues ?? []).map((issue) => issue.path)).toStrictEqual(['siteId']);
      expect(calls).toStrictEqual([]);
    });

    it('refuses a two-variant comparison naming a site of another workspace', async () => {
      const theirs = await anotherWorkspacesSite();

      const response = await post({
        task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
        variants: validRun().variants,
        audienceId: await audienceOf(10),
        siteId: theirs,
        repeats: 1,
        seed: 1,
        engineMode: 'offline',
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as Refusal).error).toBe('There is no such site.');
      expect(calls).toStrictEqual([]);
    });

    it('leaves `personavision run` able to build a request with no site', () => {
      // The contract keeps `siteId` optional, because the CLI has no workspace and no site
      // and never reaches the platform's start path. Requiring it in the contract would
      // break `personavision run`, which is not the product path.
      const parsed = runRequestSchema.safeParse({
        task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
        variants: validRun().variants,
        audienceId: validRun().audience.id,
        repeats: 1,
        seed: 1,
        engineMode: 'offline',
      });

      expect(parsed.success).toBe(true);
      expect(parsed.data?.siteId).toBeUndefined();
    });
  });

  describe('the verification state is recorded and never enforced', () => {
    it('launches identically either side of a site being verified', async () => {
      // Launch one: the site is unverified, as every site starts.
      const before = await launch(100);
      expect(before.status).toBe(201);

      // The state is changed between the two launches, the one way the store allows it.
      await served.platform.store.sites.verify(workspaceId, siteId, passingCheck('pv_capsexample'));
      expect(
        (await served.platform.store.sites.byId(workspaceId, siteId))?.verification.state,
      ).toBe('verified');

      // Launch two: same cap, same answer.
      const after = await launch(100);
      expect(after.status).toBe(201);
      expect(await after.json()).toStrictEqual(await before.json());

      // And the one thing that differs is what the run records, which no cap read.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.site?.verifiedAtLaunch).toBe(false);
      expect(calls[1]?.site?.verifiedAtLaunch).toBe(true);
      expect(calls[0]?.site?.id).toBe(calls[1]?.site?.id);
      expect(calls[0]?.site?.url).toBe(SITE_URL);
    });

    it('refuses an over-cap launch on a verified site exactly as on an unverified one', async () => {
      const unverified = await launch(140);
      const unverifiedBody = (await unverified.json()) as Refusal;

      await served.platform.store.sites.verify(workspaceId, siteId, passingCheck('pv_capsexample'));

      const verified = await launch(140);
      const verifiedBody = (await verified.json()) as Refusal;

      expect(verified.status).toBe(unverified.status);
      expect(verifiedBody).toStrictEqual(unverifiedBody);
    });

    it('treats a fresh unverified site exactly as the verified one it sits beside', async () => {
      await served.platform.store.sites.verify(workspaceId, siteId, passingCheck('pv_capsexample'));
      const onVerified = await launch(100);

      // A site added today — or one a failing re-check left unproved — is capped the same.
      const fresh = await served.platform.store.sites.create(workspaceId, {
        url: 'https://new.clipforge.example/create',
        token: 'pv_fresh',
      });
      siteId = fresh.id;
      const onFresh = await launch(100);

      expect(onFresh.status).toBe(onVerified.status);
      expect(await onFresh.json()).toStrictEqual(await onVerified.json());
      expect(calls[1]?.site?.verifiedAtLaunch).toBe(false);
    });
  });

  describe('the numbers a screen prints', () => {
    it('states them on every site, verified or not, so no screen composes them', async () => {
      const response = await served.request('/sites', {
        headers: { accept: 'application/json', cookie },
      });
      const body = (await response.json()) as { sites: { caps: typeof CAPS }[] };

      expect(response.status).toBe(200);
      // `#screen-sites` prints "100 agents per run allowed" and "4 runs an hour · 10
      // browsers at a time" from these, rather than the word "limited".
      expect(body.sites[0]?.caps).toStrictEqual(CAPS);
    });
  });
});

describe('CapRefusedError', () => {
  it('carries the cap, its limit, the observed value and when it next passes', () => {
    const refusal = refuseTooManyAgents(140);

    expect(refusal).toBeInstanceOf(CapRefusedError);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal?.name).toBe('CapRefusedError');
    expect(refusal?.cap).toBe('agentsPerRun');
    expect(refusal?.limit).toBe(CAPS.agentsPerRun);
    expect(refusal?.observed).toBe(140);
    expect(refusal?.retryAt).toBeNull();
  });

  it('refuses nothing at the limit', () => {
    expect(refuseTooManyAgents(CAPS.agentsPerRun)).toBeNull();
    expect(refuseTooManyAgents(1)).toBeNull();
  });
});
