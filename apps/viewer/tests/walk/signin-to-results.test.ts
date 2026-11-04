import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureSource } from '../../../../packages/browser/src/index.js';
import { audienceFromSentence, updateAudience } from '../../src/screens/audience/store';
import { estimateTest, startSiteTest } from '../../src/screens/newtest/start';
import { askForGoal } from '../../src/screens/newtest/wizard/goal/goal';
import { createWorkspace } from '../../src/screens/signup/signup';
import { openRun } from '../../src/session';
import { runDataBase } from '../../src/shell/useRun';
import { createSite } from '../../src/sites/store';
import { browserAt } from './browser';
import { FIXTURE_SITE, heldAtFirstCapture, onePageCaptureSet } from './captures';
import { startWalkServer } from './server';
import type { SiteTestRequest } from '../../src/screens/newtest/start';
import type { CaptureSource } from '../../../../packages/browser/src/index.js';
import type { BrowserAt } from './browser';
import type { RunSessions } from '../../src/session';
import type { OnePageCaptures } from './captures';
import type { WalkServer } from './server';

/**
 * **Sign-up to results, in one walk, through the real server** (#399, `docs/FLOW.md`
 * sections 12, 13 and 16).
 *
 * The owner walked sign-in → results on `main` and it broke three times, each time at a
 * call the app makes and the server does not answer (#396, #397, #398). Nothing in CI
 * noticed, because every screen test fakes the network and every platform test calls its
 * routes directly. This is the walk that would have caught all three: **the app's own
 * request modules**, in the order a person meets them, against a `personavision serve`
 * started on an ephemeral port with a data directory and a runs root of its own.
 *
 * **Nothing is stubbed between the two sides.** No route is replaced, no handler is called
 * as a function and no path or body is retyped here: the eight calls below are
 * `screens/signup/signup`, `sites/store`, `screens/audience/store`,
 * `screens/newtest/wizard/goal/goal`, `screens/newtest/start` and `session/reading` doing
 * what they do in a browser, so a path that changes on one side breaks this on the other.
 * What stands in for the browser is where the page is and a cookie jar, and nothing else
 * (`./browser.ts`).
 *
 * **Nothing reaches a network or a model.** The pages are a committed capture set, the
 * engine is the offline deterministic one, and the one-shot Wonder implementation is
 * replaced at the provider seam the platform selects through — the walk is about the
 * wiring, not about what a model would say.
 *
 * The guard beside it is `tests/viewer-calls-have-routes.test.ts`: it reads the path
 * literals out of the modules allowed to `fetch` and fails when the platform mounts no
 * route for one, which is the cheap half of the same promise. This file is the half that
 * drives the live path end to end.
 */

/** The fields of `#screen-signup`, which are the three the sign-up route reads. */
const EMAIL = 'owner@clipforge.example';
const PASSWORD = 'correct-horse-battery-staple';
const WORKSPACE_NAME = 'ClipForge';

/** The sentence the wizard's audience step sends, in the words a person would type. */
const SENTENCE = 'first-time creators in Kazakhstan, mostly on phones';

/** The feature, in the user's own words, carried on exactly as written. */
const FEATURE = 'buying the canvas tote bag';

/**
 * How many people the walk runs, set by the edit of step 3.
 *
 * Four, because a hundred is the same code and twenty minutes of it: what this walk is
 * about is that the calls reach each other, and `tests/acceptance/hundred-agents.test.ts`
 * is the gate that runs the hundred.
 */
const FOUR_PEOPLE = 4;

/**
 * The engine the walk names, and the **one field in it the browser does not send**.
 *
 * The launch step sends no `engineMode` on purpose: *"no key means offline"* is a fact only
 * the server holds (decision 44), so the deployment decides. But a workspace created by
 * `POST /auth/signup` is `standard` — `packages/platform/src/auth/signup.ts`, deliberately,
 * since a mode nobody stated must not be answered by a model the user did not choose — and
 * a `standard` test on a deployment with no key is **refused**, not run offline. So a walk
 * that sent exactly what the browser sends would end at that refusal rather than at a
 * finished run, and a walk that set a key would call a model.
 *
 * The draft accepts the engine (`SiteTestDraft`), so the walk names it and the sibling case
 * below pins the refusal the browser's own body gets. That gap — sign-up to results needs a
 * model key today — is the product's and is recorded on #399 rather than papered over here.
 */
const OFFLINE = { engineMode: 'offline' } as const;

/** A result the app answers with, or the reason it did not, as a failure worth reading. */
const must = <Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
  what: string,
): Value => {
  if (!result.ok) throw new Error(`${what} was not answered: ${JSON.stringify(result)}`);
  return result.value;
};

describe('sign-up to results, through the real server', () => {
  let captures: OnePageCaptures;
  let gate: { source: CaptureSource; release: () => void };
  let server: WalkServer;
  let browser: BrowserAt;

  beforeAll(async () => {
    captures = await onePageCaptureSet();
    gate = heldAtFirstCapture(createFixtureSource(captures.dir));
    server = await startWalkServer(gate.source);
    browser = browserAt(server.served.url);
  }, 120_000);

  afterAll(async () => {
    gate.release();
    browser.restore();
    await server.cleanup();
    await captures.discard();
  });

  /**
   * The run as a reader of `/runs/:runId/` sees it, **asked again on a torn read**.
   *
   * `run.json` is rewritten as the run progresses and `writeFile` is not atomic, so a reader
   * outside the turn the swarm serialises its writes in can be served the file half written:
   * the mount streams what is on disk, and `session/reading` reports an artifact it could
   * not parse. It happens at exactly this moment — `POST /runs` answers the instant the
   * first `run.json` is written, and the sessions start rewriting it — so the walk polls the
   * way the Running screen's watcher does rather than calling the first torn read a broken
   * run.
   *
   * **That the screen's own first read has no such retry is a finding of this walk**, not
   * something it papers over: `useRun`'s `readRun` answers `unreadable`, and only the
   * five-second watcher comes back. It is recorded on #399 for the ticket that owns it.
   */
  const readRun = async (base: URL): Promise<RunSessions> =>
    vi.waitFor(async () => openRun({ baseUrl: base, fetch: browser.fetch }), {
      timeout: 30_000,
      interval: 50,
    });

  it('runs on a runs root of its own, so nothing touches runs/ in the repository', () => {
    expect(server.runsRoot.startsWith(tmpdir())).toBe(true);
    expect(server.served.platform.runsRoot.startsWith(tmpdir())).toBe(true);
    // A port the operating system picked, so two of these in parallel cannot collide.
    expect(server.served.port).toBeGreaterThan(0);
  });

  it('walks the sign-up, the site, the audience, the goal, the estimate, the launch, the running run and the results', async () => {
    /* ── 1. POST /auth/signup, as the sign-up screen sends it ──────────────────── */

    expect(browser.cookie()).toBeNull();
    const signedUp = await createWorkspace({
      email: EMAIL,
      password: PASSWORD,
      workspaceName: WORKSPACE_NAME,
    });
    expect(signedUp).toStrictEqual({ ok: true });
    // The account, the workspace and the session all exist, and the cookie is what signs
    // this browser in for every call below.
    expect(browser.cookie()).not.toBeNull();

    /* ── 2. POST /sites with the fixture site's URL ─────────────────────────────── */

    const site = must(await createSite(FIXTURE_SITE), 'the site');
    expect(site.url).toBe(FIXTURE_SITE);
    // The caps arrive as data: the concurrency the estimate below quotes is the site's own.
    expect(site.caps.concurrentSessionsPerSite).toBeGreaterThan(0);

    /* ── 3. POST /audiences/from-sentence, then PATCH /audiences/:id ───────────── */

    const drawn = must(await audienceFromSentence(SENTENCE), 'the audience');
    expect(drawn.issues).toStrictEqual([]);
    // The people come back in the same answer, because the step renders them.
    expect(drawn.people).toHaveLength(drawn.audience.size);

    // The edit the audience step makes: four people, on the device the committed captures
    // were recorded under — a replayed session is refused a device its variant was not
    // recorded under, since every `belowFold` in a capture came from one fold.
    const audience = must(
      await updateAudience(drawn.id, {
        ...drawn.audience,
        size: FOUR_PEOPLE,
        devices: [{ ...captures.device, share: 1 }],
      }),
      'the edited audience',
    );
    expect(audience.id).toBe(drawn.id);
    expect(audience.audience.size).toBe(FOUR_PEOPLE);
    expect(audience.people).toHaveLength(FOUR_PEOPLE);

    /* ── 4. POST /runs/goal, and the goal it answers carried forward unchanged ─── */

    const written = await askForGoal({ siteUrl: FIXTURE_SITE, feature: FEATURE });
    if (!written.ok) throw new Error(`the goal was refused: ${written.reason}`);
    const goal = written.value;
    expect(goal.lastWrittenBy).toBe('model');
    expect(goal.task).not.toBe('');
    expect(goal.successCriterion).not.toBe('');

    /* ── 5. POST /runs/estimate, as the launch step quotes it ──────────────────── */

    const quoted = await estimateTest({
      participants: audience.audience.size,
      siteUrl: FIXTURE_SITE,
      concurrency: site.caps.concurrentSessionsPerSite,
    });
    if (!quoted.ok) throw new Error(`the estimate was not read: ${quoted.problem}`);
    expect(quoted.estimate.siteUrl).toBe(FIXTURE_SITE);
    expect(quoted.estimate.agents.participants).toBe(FOUR_PEOPLE);
    expect(quoted.estimate.agents.sessions).toBe(FOUR_PEOPLE);

    /* ── 6. POST /runs with the launch step's one-URL draft ────────────────────── */

    const submitted: SiteTestRequest = {
      site: FIXTURE_SITE,
      siteId: site.id,
      feature: FEATURE,
      goal,
      audienceId: audience.id,
    };
    // The cast is the engine above, and it reaches the server only because `startSiteTest`
    // hands its argument straight to `JSON.stringify`. The day it builds a body out of the
    // five fields `SiteTestRequest` declares, the engine is dropped with no type error and
    // this walk fails at the launch with the 503 — so the dependency is named here.
    const launched = await startSiteTest({ ...submitted, ...OFFLINE } as SiteTestRequest);
    if (!launched.ok) throw new Error(`the launch was refused: ${JSON.stringify(launched)}`);
    // A run directory is named for the minute it was created.
    expect(launched.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-/);

    /* ── 7. GET the run over the read-only mount, as the Running screen polls ──── */

    // The run's directory as the app addresses it, through the app's own spelling of it.
    const base = new URL(runDataBase(launched.runId), server.served.url);

    const running = await readRun(base);
    // The id was answered while the run was still going: every session is held at its
    // first screen, so this is not a run that finished before the read.
    expect(running.run.runId).toBe(launched.runId);
    expect(running.run.status).toBe('open');
    expect(running.run.finishedAt).toBeUndefined();
    expect(running.run.progress?.totalSessions).toBe(FOUR_PEOPLE);
    expect(running.run.progress?.finishedSessions ?? 0).toBe(0);

    gate.release();
    const finished = await vi.waitFor(
      async () => {
        const read = await readRun(base);
        expect(read.run.status).toBe('finished');
        return read;
      },
      { timeout: 90_000, interval: 50 },
    );

    /* ── 8. GET the finished run and its sessions, as a reader of the results ──── */

    // The sessions the audience asked for, each with an outcome.
    expect(finished.sessionIds).toHaveLength(FOUR_PEOPLE);
    const sessions = await Promise.all(
      finished.sessionIds.map(async (sessionId) => finished.session(sessionId)),
    );
    expect(sessions.map((session) => session.sessionId).sort()).toStrictEqual(
      [...finished.sessionIds].sort(),
    );
    for (const session of sessions) {
      expect(typeof session.outcome.status).toBe('string');
      expect(typeof session.outcome.attribution).toBe('string');
    }

    // And the run's own counts, the site it was pointed at, the words it was asked in and
    // the goal that was approved — carried through unchanged from step 4.
    expect(finished.run.progress?.finishedSessions).toBe(FOUR_PEOPLE);
    expect(finished.run.audience.size).toBe(FOUR_PEOPLE);
    expect(finished.run.site).toStrictEqual({ url: FIXTURE_SITE });
    expect(finished.run.feature).toBe(FEATURE);
    expect(finished.run.goal).toStrictEqual(goal);
    expect(finished.run.engine.mode).toBe('offline');

    // And the server said nothing about a run that broke: a background run that fails after
    // its id was answered is one line in `serve`'s own log and nothing else.
    expect(server.logged.filter((line) => line.includes('did not finish'))).toStrictEqual([]);
  }, 180_000);
});

/**
 * The gap the walk above names: **the launch step's own body, with no engine in it**.
 *
 * `POST /auth/signup` creates a `standard` workspace, and a `standard` test on a deployment
 * with no `MODEL_API_KEY` is refused rather than run offline (#143, #144) — so the product
 * as it stands cannot be walked from sign-up to results without a model key, which is what
 * the owner's walk of 2026-11-04 had set. It is pinned here rather than left to be
 * rediscovered: when a signed-up workspace can run a test on a keyless deployment, this case
 * fails and the walk above loses its one named field.
 */
describe('the launch the browser really sends, on a deployment with no key', () => {
  let captures: OnePageCaptures;
  let gate: { source: CaptureSource; release: () => void };
  let server: WalkServer;
  let browser: BrowserAt;

  beforeAll(async () => {
    captures = await onePageCaptureSet();
    gate = heldAtFirstCapture(createFixtureSource(captures.dir));
    server = await startWalkServer(gate.source);
    browser = browserAt(server.served.url);
  }, 120_000);

  afterAll(async () => {
    gate.release();
    browser.restore();
    await server.cleanup();
    await captures.discard();
  });

  it('is refused in words, and starts nothing', async () => {
    expect(
      await createWorkspace({ email: EMAIL, password: PASSWORD, workspaceName: WORKSPACE_NAME }),
    ).toStrictEqual({ ok: true });
    const site = must(await createSite(FIXTURE_SITE), 'the site');
    const drawn = must(await audienceFromSentence(SENTENCE), 'the audience');
    const audience = must(
      await updateAudience(drawn.id, {
        ...drawn.audience,
        size: 1,
        devices: [{ ...captures.device, share: 1 }],
      }),
      'the edited audience',
    );
    const written = await askForGoal({ siteUrl: FIXTURE_SITE, feature: FEATURE });
    if (!written.ok) throw new Error(`the goal was refused: ${written.reason}`);

    const refused = await startSiteTest({
      site: FIXTURE_SITE,
      siteId: site.id,
      feature: FEATURE,
      goal: written.value,
      audienceId: audience.id,
    });

    if (refused.ok) throw new Error(`the launch started a test: ${refused.runId}`);
    // Not a cap and not a field: the model this deployment cannot serve, which is the 503
    // the New test screen renders as a sentence above the form.
    if (refused.kind !== 'platform') {
      throw new Error(`the launch was refused as "${refused.kind}": ${JSON.stringify(refused)}`);
    }
    // The platform's own sentence, which the screen renders unchanged.
    expect(refused.problem).toContain('Nothing was simulated');
  }, 180_000);
});
