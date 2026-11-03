import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validRun } from '../../contract/tests/fixtures.js';
import { CAPS, concurrencyForSite } from '../src/caps.js';
import type { SiteAtLaunch } from '../src/run/start.js';
import type { Audience, RunRequest } from '@personavision/contract';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * **Ten concurrent sessions per site** (#241): the cap on how many of these browsers may be
 * on one site at once, enforced where a session is handed a browser rather than where a
 * screen asks for one.
 *
 * Every case goes **over the API**, because that is the criterion: a cap a screen or a
 * submitted body could get round is not a cap. What stands in for the swarm is a pool shaped
 * exactly like `runSwarm`'s — as many workers as the concurrency it was handed, each taking
 * the next session when it finishes — with a counter raised as a session starts and lowered
 * as it lands. That the **real** pool holds at a hundred sessions, writes each one as it
 * lands and loses only the session that crashed is #275's, proved there against the fixture
 * site; what is proved here is the number it is handed, which is the half that makes it a
 * cap. `packages/platform` does not depend on `packages/swarm` — the platform is what starts
 * runs — so the pool is modelled here rather than imported.
 *
 * The counter is **shared between runs**, so "two runs on this site are still ten browsers"
 * is asserted as the sessions in flight on the site and not as two tidy halves.
 */

const RUN_ID = '2026-11-04-1030-clipforge-create';

/** The site of the wizard's worked example, as `#screen-newtest-feature` names it. */
const SITE_URL = 'https://app.clipforge.example/create';

/** A second address in the same workspace: another site, and so another ten. */
const OTHER_SITE_URL = 'https://shop.clipforge.example/checkout';

/** What the stand-in swarm was handed for one run. */
interface Handed {
  request: RunRequest;
  audience: Audience;
  site?: SiteAtLaunch;
  concurrency?: number;
}

/** The sessions in flight across every run being driven, and the most there ever were. */
interface Flight {
  inFlight: number;
  peak: number;
  started: number;
}

/**
 * The number a caller is handed, for the callers that bring one of their own —
 * `personavision run --concurrency`, and whatever else ever drives a run from outside the
 * product. The platform's own runs are handed the cap and ask for nothing.
 */
describe('the concurrency a caller is handed', () => {
  it('is the cap when nobody asked', () => {
    expect(concurrencyForSite()).toStrictEqual({
      concurrency: CAPS.concurrentSessionsPerSite,
      lowered: null,
    });
  });

  it('honours a number under the cap, saying nothing', () => {
    // Less load than the cap allows is not something to be corrected.
    expect(concurrencyForSite(2)).toStrictEqual({ concurrency: 2, lowered: null });
    expect(concurrencyForSite(CAPS.concurrentSessionsPerSite)).toStrictEqual({
      concurrency: CAPS.concurrentSessionsPerSite,
      lowered: null,
    });
  });

  it('bounds a number above the cap and says which number is being run', () => {
    const bounded = concurrencyForSite(50);

    expect(bounded.concurrency).toBe(CAPS.concurrentSessionsPerSite);
    expect(bounded.lowered).toBe(
      `A site takes ${String(CAPS.concurrentSessionsPerSite)} browsers at a time, so this run is bounded to ${String(CAPS.concurrentSessionsPerSite)} rather than the 50 it asked for.`,
    );
  });

  it('raises a run of nobody to one, rather than passing on a pool of no workers', () => {
    // A pool of none takes no session, and what that writes is a finished run with nothing
    // in it. A surface that collects the number refuses it at the field; this is the
    // backstop under it.
    expect(concurrencyForSite(0).concurrency).toBe(1);
    expect(concurrencyForSite(-4).concurrency).toBe(1);
    expect(concurrencyForSite(2.5).concurrency).toBe(2);
  });
});

describe('ten concurrent sessions per site', () => {
  let served: TestServer;
  let handed: Handed[];
  let flight: Flight;
  let cookie: string;
  let workspaceId: string;
  let siteId: string;
  let otherSiteId: string;
  /** What each run does: drive its sessions, or wait to be released. */
  let hold: ((release: () => void) => void) | null;
  /** What each run reported as it began and as it ended, in the order it happened. */
  let order: string[];

  /** An audience of `size` people in the session's workspace, by id. */
  const audienceOf = async (size: number): Promise<string> =>
    (await served.platform.store.audiences.create(workspaceId, { ...validRun().audience, size }))
      .id;

  /**
   * One session: a tick of the event loop between the counter going up and coming down.
   *
   * A real session opens a browser; what matters here is only that it is in flight while
   * another could be, so the tick is the whole of it.
   */
  const session = async (): Promise<void> => {
    flight.inFlight += 1;
    flight.started += 1;
    flight.peak = Math.max(flight.peak, flight.inFlight);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    flight.inFlight -= 1;
  };

  /**
   * `sessions` sessions, `concurrency` at a time — `runSwarm`'s own pool: one cursor, as many
   * workers as the bound, each taking the next session when it finishes, so no more than the
   * bound are ever between a start and a finish.
   *
   * A run handed **no** bound drives them all at once, which is what makes this suite able to
   * fail: a platform that forgot to hand the number over would peak at a hundred here.
   */
  const drive = async (sessions: number, concurrency?: number): Promise<void> => {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(concurrency ?? sessions, sessions) },
      async () => {
        while (next < sessions) {
          next += 1;
          await session();
        }
      },
    );
    await Promise.all(workers);
  };

  /** How many sessions the request plans: the people, their repeats, on each version. */
  const plannedSessions = (request: RunRequest, audience: Audience): number =>
    audience.size * request.repeats * request.variants.length;

  const post = (body: unknown): Promise<Response> =>
    served.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
      body: JSON.stringify(body),
    });

  /** What the launch step submits, for an audience of `size` people against a site. */
  const launch = async (
    size: number,
    extra: Record<string, unknown> = {},
    site = siteId,
    url = SITE_URL,
  ): Promise<Response> =>
    post({
      site: url,
      siteId: site,
      feature: 'Generating a video from a text prompt.',
      goal: {
        task: 'Generate a video from a text prompt, and wait until it is ready to watch.',
        successCriterion: 'The finished video is playable on the page.',
        lastWrittenBy: 'model',
      },
      audienceId: await audienceOf(size),
      ...extra,
    });

  beforeEach(async () => {
    handed = [];
    flight = { inFlight: 0, peak: 0, started: 0 };
    hold = null;
    order = [];
    served = await startTestServer({
      pipeline: async (request, audience, site, concurrency) => {
        handed.push({ request, audience, site, concurrency });
        order.push(`started ${site?.url ?? 'nowhere'}`);
        if (hold === null) await drive(plannedSessions(request, audience), concurrency);
        else {
          await new Promise<void>((release) => {
            hold?.(release);
          });
        }
        order.push(`finished ${site?.url ?? 'nowhere'}`);
        return {
          runId: RUN_ID,
          engineMode: request.engineMode,
          ...(request.engineMode === 'model' ? { modelMode: request.modelMode } : {}),
        };
      },
    });
    const seeded = served.platform.seeded;
    const signedIn = await served.signIn({
      email: seeded?.email ?? '',
      password: seeded?.password ?? '',
    });
    expect(signedIn.status).toBe(200);
    cookie = cookieOf(signedIn);
    workspaceId = seeded?.workspaceId ?? '';
    siteId = (
      await served.platform.store.sites.create(workspaceId, {
        url: SITE_URL,
        token: 'pv_capsexample',
      })
    ).id;
    otherSiteId = (
      await served.platform.store.sites.create(workspaceId, {
        url: OTHER_SITE_URL,
        token: 'pv_otherexample',
      })
    ).id;
  });

  afterEach(async () => {
    await served.close();
  });

  describe('within one run', () => {
    it('never has more than the cap in flight on a run of a hundred agents', async () => {
      const response = await launch(CAPS.agentsPerRun);

      expect(response.status).toBe(201);
      // The number the swarm was handed is the caps module's, and nothing else.
      expect(handed[0]?.concurrency).toBe(CAPS.concurrentSessionsPerSite);
      expect(flight.peak).toBeLessThanOrEqual(CAPS.concurrentSessionsPerSite);
      // And it really ran them in parallel: a suite that walked them one at a time would
      // pass the line above while proving nothing.
      expect(flight.peak).toBeGreaterThan(1);
    });

    it('runs every session it planned: the eleventh waits rather than being dropped', async () => {
      // The other half of the criterion. A cap that shed the sessions it could not fit would
      // hold the peak down and report a run of a hundred that simulated ten people.
      const response = await launch(CAPS.agentsPerRun);

      expect(response.status).toBe(201);
      expect(flight.started).toBe(CAPS.agentsPerRun);
      expect(flight.inFlight).toBe(0);
    });

    it('holds an offline run to the same number', async () => {
      // The cap is about the site being driven, not about what a run costs us.
      const response = await launch(CAPS.agentsPerRun, { engineMode: 'offline' });

      expect(response.status).toBe(201);
      expect(handed[0]?.request.engineMode).toBe('offline');
      expect(handed[0]?.concurrency).toBe(CAPS.concurrentSessionsPerSite);
      expect(flight.peak).toBeLessThanOrEqual(CAPS.concurrentSessionsPerSite);
      expect(flight.started).toBe(CAPS.agentsPerRun);
    });

    it('is not raised by a submitted body naming a concurrency of its own', async () => {
      // Refused outright rather than honoured, and one step earlier than this ticket: the
      // contract's request is strict, so a key it does not declare is a refusal at that key.
      // Nothing ran, so nothing was bounded — which is the criterion from the safe side.
      const response = await launch(CAPS.agentsPerRun, {
        concurrency: CAPS.agentsPerRun,
        concurrentSessions: CAPS.agentsPerRun,
      });

      expect(response.status).toBe(400);
      expect(handed).toStrictEqual([]);
      expect(flight.started).toBe(0);
    });

    it('computes the number itself, so no field of a request could carry one', async () => {
      // The structural half: the swarm's bound is handed over beside the request, and what
      // is handed over is read from the caps module. A launch that named nothing of the kind
      // gets exactly the same number as one that tried to.
      const response = await launch(CAPS.agentsPerRun);

      expect(response.status).toBe(201);
      expect(handed[0]?.concurrency).toBe(CAPS.concurrentSessionsPerSite);
      expect(Object.keys(handed[0]?.request ?? {})).not.toContain('concurrency');
    });
  });

  describe('across runs on one site', () => {
    it('waits for the run in flight rather than refusing the second launch', async () => {
      const waiting: (() => void)[] = [];
      hold = (release) => waiting.push(release);

      const first = launch(10);
      await vi.waitUntil(() => waiting.length === 1, { timeout: 2000 });

      const second = launch(10);
      // Nothing else starts while the site has a run on it: a second ten would be twenty
      // browsers on one address.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(handed).toHaveLength(1);

      waiting[0]?.();
      await vi.waitUntil(() => waiting.length === 2, { timeout: 2000 });
      waiting[1]?.();

      // Waited and then ran: neither is refused, and both answer with a run.
      expect((await first).status).toBe(201);
      expect((await second).status).toBe(201);
      expect(handed).toHaveLength(2);
      expect(order).toStrictEqual([
        `started ${SITE_URL}`,
        `finished ${SITE_URL}`,
        `started ${SITE_URL}`,
        `finished ${SITE_URL}`,
      ]);
    });

    it('keeps two runs on one site under the cap between them', async () => {
      // Fifty each, launched together: a platform that let both run would peak at twenty
      // browsers on this site, which is the load the cap exists to keep off it.
      const both = await Promise.all([launch(50), launch(50)]);

      for (const response of both) expect(response.status).toBe(201);
      expect(flight.peak).toBeLessThanOrEqual(CAPS.concurrentSessionsPerSite);
      expect(flight.peak).toBeGreaterThan(1);
      // Both runs ran every session they planned.
      expect(flight.started).toBe(100);
    });
  });

  describe('another site', () => {
    it('starts at once while the first site is still being driven', async () => {
      const waiting: (() => void)[] = [];
      hold = (release) => waiting.push(release);

      const first = launch(10);
      await vi.waitUntil(() => waiting.length === 1, { timeout: 2000 });

      // A different address: its own ten, and no wait at all.
      const elsewhere = launch(10, {}, otherSiteId, OTHER_SITE_URL);
      await vi.waitUntil(() => waiting.length === 2, { timeout: 2000 });
      expect(handed.map((call) => call.site?.url)).toStrictEqual([SITE_URL, OTHER_SITE_URL]);

      for (const release of waiting) release();
      expect((await first).status).toBe(201);
      expect((await elsewhere).status).toBe(201);
    });
  });
});
