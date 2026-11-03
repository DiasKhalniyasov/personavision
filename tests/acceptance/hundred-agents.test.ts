/**
 * **A hundred agents on one URL**, from the audience to the finished artifact — the
 * demoable end of the "Test my site" step (#222, #286).
 *
 * One walk, five beats, over the fixture site with the offline engine and the recorded
 * captures: an extended audience of a hundred participants stored on the platform and the
 * people it generates previewed; an estimate quoted before launch and recomputed here from
 * the figures it reports; a one-URL test started, with one variant named for the site; a
 * hundred sessions, ten at a time, read while the run is still open; and a finished run that
 * validates and carries the site, the feature and the goal with its author.
 *
 * **What it is for.** Four packages own those beats — `@personavision/contract` declares the
 * blocks, `@personavision/personas` draws the people, `@personavision/swarm` runs the
 * sessions and `@personavision/platform` starts the test — and each is tested apart. Nothing
 * else asks them to agree, and the seam between them is where a one-URL test would quietly
 * stop working: an audience the generator will not draw a hundred people from, an estimate
 * quoted for a concurrency the pool does not keep to, a feature sentence that reaches the
 * request and not the artifact. The walk is a caller of the real pipeline
 * (`packages/cli/src/run/start.ts`, which is what the New test form is handed) rather than a
 * second copy of one, so a break in any of them is a red gate here.
 *
 * **Offline, with no key, no network and no browser download.** Every session replays bytes
 * `pnpm -F @personavision/browser record:captures` committed, the decision layer is the
 * offline deterministic provider, and the pipeline is handed an environment that holds
 * nothing to reach a model with. It is therefore fast enough to run in `pnpm test` as well
 * as in `pnpm test:acceptance`, and it is deliberately not behind this suite's
 * `PERSONAVISION_ACCEPTANCE` tag: the two walks beside it build the viewer and launch
 * Chromium, and this one does neither.
 *
 * **It assumes nothing of step #221.** The site record, the ownership verification, the caps
 * and the run's own `site` block are #239, #241 and #243: this walk starts a test the way
 * #282 does, names the concurrency as a caller, and asserts nothing about verification.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureSource } from '@personavision/browser';
import { readRun, runPaths, validate } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aHundredParticipants,
  committedRunDir,
  exampleRunIn,
  fingerprint,
  FIXTURE_SITE,
  FIXTURE_SITE_ERRAND,
  FIXTURE_SITE_STEPS,
  oneUrlCaptureSet,
  readOpenRun,
  watchingFlight,
} from './helpers/harness.js';
import { discard, oneUrlPipeline, scratch } from './helpers/platform.js';
import {
  acceptedEstimateRequest,
  createPlatform,
  DEFAULT_PARTICIPANTS,
  estimateRun,
  measuredHistoryOfRuns,
  ONE_URL_VARIANT_ID,
  startSiteTest,
  withPeople,
} from '../../packages/platform/src/index.js';
import type { Goal } from '@personavision/contract';
import type { OneUrlCaptures, OpenRunObservation } from './helpers/harness.js';

/**
 * **Wall clock: about 1 s** on an idle machine for the walk itself — a hundred replayed
 * four-screen sessions take most of it, and the hundred reads and schema parses it makes of
 * the open run take the rest — plus about half a second in its hooks for the capture set and
 * the copy of the example run: **under 2 s**. The suite's total grows by no more, because
 * this adds one test and slows nothing that was already here.
 *
 * Everything before and after the run is arithmetic over committed bytes, so the figure
 * cannot depend on a network: nothing is downloaded, no browser is launched and no model is
 * called.
 */
const WALK_TIMEOUT = 120_000;

/**
 * How many sessions may be open at once, **named by the caller**.
 *
 * Ten, which is `docs/FLOW.md` section 13's cap on browsers open against one site. It is
 * written here, in the caller's position: the swarm states no per-site number of its own,
 * section 13 puts every such cap in `packages/platform`, and #239 and #241 own the module
 * that will hand the real one over. A test is a caller, so the test states it.
 */
const TEN_AT_A_TIME = 10;

/** A hundred participants, one attempt each, on one variant: a hundred sessions. */
const A_HUNDRED = 100;

/** The feature, in the words a user would have typed, carried on exactly as written. */
const FEATURE = 'Checking out and paying for one item on my phone, start to finish.';

/** The goal as a person approved it before launch, which makes its author `user`. */
const GOAL: Goal = {
  task: FIXTURE_SITE_ERRAND,
  successCriterion: 'The confirmation screen shows an order number.',
  lastWrittenBy: 'user',
};

/**
 * The outcomes a completion rate is computed over: how a person's own attempt ended.
 *
 * `automation_failure` is deliberately not among them — it is a browser of ours dying and
 * says nothing about the product (`docs/FLOW.md` section 8) — so a session carrying one is
 * excluded before this list is applied.
 */
const COUNTED_OUTCOMES: readonly string[] = ['success', 'abandoned', 'failed'];

/** A value the walk cannot go on without, or a failure naming what was looked for. */
const must = <Value>(value: Value | null | undefined, what: string): Value => {
  if (value === null || value === undefined) throw new Error(`the walk found no ${what}`);
  return value;
};

/** How many people each value of a drawn field went to. */
const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

/**
 * How many of `size` people a share is worth — 46% of a hundred is 46 of them.
 *
 * The arithmetic a user does when they read *54% women*, and not a second copy of the
 * generator's largest-remainder rule, which is asserted where that rule lives. Every share
 * this walk reads divides a hundred whole.
 */
const peopleIn = (share: number, size: number): number => Math.round(share * size);

describe('a hundred agents on one URL', () => {
  let dir: string;
  let dataDir: string;
  let runsRoot: string;
  let captures: OneUrlCaptures;
  let exampleRunId: string;

  beforeAll(async () => {
    dir = await scratch('hundred-agents');
    dataDir = join(dir, '.personavision');
    runsRoot = join(dir, 'runs');
    captures = await oneUrlCaptureSet(ONE_URL_VARIANT_ID);
    // A fresh clone's runs root holds the committed example run and nothing else, and the
    // platform seeds a workspace that owns it. A copy, so the committed artifact is only
    // ever read.
    exampleRunId = await exampleRunIn(runsRoot);
  });

  afterAll(async () => {
    await discard(captures?.dir);
    await discard(dir);
  });

  it(
    'walks the audience, the estimate, the launch, the hundred sessions and the artifact',
    async () => {
      const committedBefore = fingerprint(committedRunDir);

      const platform = await createPlatform({ dataDir, runsRoot });
      const seeded = must(platform.seeded, 'seeded workspace');
      const { workspaceId } = seeded;
      expect(seeded.runIds).toStrictEqual([exampleRunId]);

      /* ── Beat 1: a hundred participants, stored, and the people they generate ────── */

      const audience = aHundredParticipants(captures.device);
      // The hundred is the platform's own default for an audience created on it (#285), so
      // the walk's audience is the size the product would have given it.
      expect(audience.size).toBe(DEFAULT_PARTICIPANTS);
      expect(audience.size).toBe(A_HUNDRED);

      const created = await platform.store.audiences.create(workspaceId, audience);
      // Read back through the store rather than kept from the create: what the New test
      // wizard will launch from is the record on disk.
      const stored = must(
        await platform.store.audiences.byId(workspaceId, created.id),
        'stored audience',
      );
      expect(stored.audience).toStrictEqual(audience);

      const previewed = withPeople(stored);
      expect(previewed.issues).toStrictEqual([]);
      expect(previewed.people).toHaveLength(A_HUNDRED);

      // The gender split, the age groups and the languages are the shares the user
      // authored, person for person — not a sample of them.
      const genderSplit = must(audience.genderSplit, 'gender split');
      expect(tally(previewed.people.map((person) => String(person.gender)))).toStrictEqual(
        Object.fromEntries(
          Object.entries(genderSplit).map(([word, share]) => [
            word,
            peopleIn(share, audience.size),
          ]),
        ),
      );

      // The age groups are stored and carried, and they are **not** counted here: a person
      // does not carry the bracket they were dealt — it moves their own patience and
      // reading instead — so the brackets are counted where they are observable, against
      // `@personavision/personas`' own committed rows (#278). What this walk owns is that
      // they survive the store and reach the artifact, which is asserted at both ends.
      const ageGroups = must(audience.ageGroups, 'age groups');
      expect(ageGroups.reduce((total, entry) => total + entry.share, 0)).toBeCloseTo(1);
      expect(audience.ageRange).toStrictEqual({ min: 28, max: 44 });
      expect(audience.regions).toStrictEqual(['Almaty']);

      const languages = must(audience.languages, 'languages');
      for (const person of previewed.people) expect(languages).toContain(person.language);
      expect(tally(previewed.people.map((person) => String(person.language)))).toStrictEqual(
        Object.fromEntries(
          languages.map((language) => [language, peopleIn(1 / languages.length, audience.size)]),
        ),
      );

      // And the device mix the replay answers for: one class, the whole audience on it.
      expect(audience.devices.map((device) => device.share)).toStrictEqual([1]);
      expect(
        new Set(previewed.people.map((person) => person.device.viewport.height)),
      ).toStrictEqual(new Set([captures.device.viewport.height]));

      /* ── Beat 2: the estimate, quoted before launch and recomputed from its figures ─ */

      const workspace = must(await platform.store.workspaces.byId(workspaceId), 'workspace');
      const history = await measuredHistoryOfRuns({
        runsRoot,
        runIds: workspace.runIds,
      })(FIXTURE_SITE);
      const quoted = estimateRun(
        acceptedEstimateRequest(
          {
            participants: previewed.people.length,
            siteUrl: FIXTURE_SITE,
            engineMode: 'offline',
            concurrency: TEN_AT_A_TIME,
          },
          workspace.modelMode,
        ),
        history,
      );

      expect(quoted.agents).toStrictEqual({
        participants: A_HUNDRED,
        sessions: A_HUNDRED,
        concurrency: TEN_AT_A_TIME,
      });

      const { time } = quoted;
      if (time.state !== 'known') throw new Error(`the estimate quoted no time: ${time.reason}`);
      // Recomputed from the inputs the estimate returned rather than trusted: sessions ÷
      // concurrency × the median session on that site, plus browser start-up per batch.
      expect(time.sessions).toBe(A_HUNDRED);
      expect(time.concurrency).toBe(TEN_AT_A_TIME);
      expect(time.batches).toBe(Math.ceil(A_HUNDRED / TEN_AT_A_TIME));
      expect(time.sessionsMeasured).toBeGreaterThan(0);
      // This site has never been tested, so the median is somebody else's and says so.
      expect(time.measuredFrom).toBe('other-sites');
      expect(time.sessionMs.low).toBeLessThan(time.sessionMs.high);
      const perBatch = time.browserStartupMs ?? 0;
      expect(time.ms).toStrictEqual({
        low: time.batches * (time.sessionMs.low + perBatch),
        high: time.batches * (time.sessionMs.high + perBatch),
      });
      expect(time.ms.low).toBeLessThan(time.ms.high);

      // An offline run reports no cost **and why**, rather than a zero that would read as a
      // price somebody checked; a figure nothing has measured says which figure it is.
      expect(quoted.cost.state).toBe('nothing-to-pay');
      if (quoted.cost.state === 'nothing-to-pay') {
        expect(quoted.cost.reason).toContain('calls no model');
      }
      expect(quoted.cost).not.toHaveProperty('usd');
      expect(quoted.storage.state).toBe('unknown');
      if (quoted.storage.state === 'unknown') expect(quoted.storage.reason).toContain('video');

      /* ── Beat 3: a one-URL test started ───────────────────────────────────────────── */

      const watched = watchingFlight(createFixtureSource(captures.dir));
      const seenWhileOpen: OpenRunObservation[] = [];
      const run = oneUrlPipeline({
        runsRoot,
        source: watched.source,
        steps: FIXTURE_SITE_STEPS,
        concurrency: TEN_AT_A_TIME,
        // One observation per reported line. The line a landed session reports is written
        // from inside the turn the swarm serialises its writes in, which is the one moment
        // a reader is promised `run.json` as that session left it.
        report: () => {
          const open = readOpenRun(runsRoot, [exampleRunId]);
          if (open !== null) seenWhileOpen.push(open);
        },
      });

      const started = await startSiteTest({
        workspaces: platform.store.workspaces,
        audiences: platform.store.audiences,
        workspaceId,
        draft: {
          site: FIXTURE_SITE,
          feature: FEATURE,
          goal: GOAL,
          audienceId: created.id,
          // The seed the audience was previewed at, so the hundred people quoted above are
          // the hundred that run. A launch that names none runs on the day's own seed.
          seed: audience.generatedFrom.seed,
          engineMode: 'offline',
        },
        pipeline: run.pipeline,
      });

      expect(started.engineMode).toBe('offline');
      expect(started.modelMode).toBeUndefined();
      const ran = run.ran();
      expect(ran.runId).toBe(started.runId);
      expect(ran.stopped).toBe(false);
      // Registered against the workspace only once something ran.
      expect(must(await platform.store.workspaces.byId(workspaceId), 'workspace').runIds).toContain(
        started.runId,
      );

      // One variant, named for the site and carrying its URL. Nothing forked.
      expect(ran.run.variants).toStrictEqual([
        { id: ONE_URL_VARIANT_ID, name: new URL(FIXTURE_SITE).host, url: FIXTURE_SITE },
      ]);
      // The people who ran are the people who were previewed, and the audience is the
      // audience by value: editing the stored one cannot restate this test.
      expect(ran.run.personas.map((person) => person.id)).toStrictEqual(
        previewed.people.map((person) => person.id),
      );
      expect(ran.run.audience).toStrictEqual(audience);

      /* ── Beat 4: a hundred sessions, ten at a time, readable as they land ─────────── */

      const files = (await readdir(runPaths(ran.runDir).sessionsDir))
        .map((file) => file.replace(/\.json$/, ''))
        .sort();
      expect(files).toHaveLength(A_HUNDRED);
      expect(new Set(files)).toStrictEqual(new Set(ran.run.sessionIds));

      // Never more in flight than the caller named, and more than one at a time, so the walk
      // cannot pass by having run them one after another.
      expect(watched.peak()).toBeLessThanOrEqual(TEN_AT_A_TIME);
      expect(watched.peak()).toBeGreaterThan(1);
      expect(watched.peak()).toBe(TEN_AT_A_TIME);

      // A hundred observations of an open run, each one session further on, each with that
      // session's own file already complete and valid beside it. `readOpenRun` parses both
      // against the contract, so an observation that reached this list is one a reader with
      // nothing but the directory could have made.
      expect(seenWhileOpen).toHaveLength(A_HUNDRED);
      expect(seenWhileOpen.map((open) => open.finishedSessions)).toStrictEqual(
        Array.from({ length: A_HUNDRED }, (_unused, index) => index + 1),
      );
      for (const open of seenWhileOpen) {
        expect(open.status).toBe('open');
        expect(open.totalSessions).toBe(A_HUNDRED);
        expect(open.listedSessions).toBe(open.finishedSessions);
      }
      expect(new Set(seenWhileOpen.map((open) => open.session.sessionId)).size).toBeGreaterThan(0);

      /* ── Beat 5: the finished artifact ───────────────────────────────────────────── */

      expect(await validate(ran.runDir)).toStrictEqual([]);
      const artifact = await readRun(ran.runDir);
      expect(artifact.run.status).toBe('finished');
      expect(artifact.run.variants).toHaveLength(1);
      expect(artifact.run.sessionIds).toHaveLength(A_HUNDRED);
      expect(artifact.sessions).toHaveLength(A_HUNDRED);
      // The feature as it was written — no normalisation, no rewording, no trimming — and
      // the goal with whoever last wrote it, which is what makes a completion rate mean
      // something a month later.
      expect(artifact.run.feature).toBe(FEATURE);
      expect(artifact.run.goal).toStrictEqual(GOAL);
      expect(artifact.run.goal?.lastWrittenBy).toBe('user');
      expect(artifact.run.engine.mode).toBe('offline');
      expect(artifact.run.usage).toMatchObject({ calls: 0, estimatedCostUsd: 0 });

      // The completion figures are about the sessions that are not ours to answer for: a
      // crashed browser is one session and is excluded from every figure
      // (`docs/FLOW.md` section 8), so the hundred are counted as ninety-nine or a hundred
      // and never as a hundred with a failure folded in.
      const ours = artifact.sessions.filter(
        (session) => session.outcome.attribution === 'automation',
      );
      expect(ours.length).toBeLessThanOrEqual(1);
      const counted = artifact.sessions.filter((session) => !session.outcome.excludedFromScores);
      expect(counted).toHaveLength(A_HUNDRED - ours.length);
      expect(counted.length).toBeGreaterThanOrEqual(A_HUNDRED - 1);
      for (const session of counted) {
        expect(session.outcome.attribution).toBe('product');
        expect(session.screens.length).toBeGreaterThan(0);
      }
      // Every session the run walked ended on an outcome a completion rate is computed
      // from, so the rate is over the whole of what counted rather than over whatever
      // happened to carry a status.
      expect(
        counted.filter((session) => COUNTED_OUTCOMES.includes(session.outcome.status)),
      ).toHaveLength(counted.length);

      // The progress block the Running screen reads says whose each session was, for all of
      // them, which is what the automation-failure share is computed from.
      const entries = artifact.run.progress?.sessions ?? [];
      expect(entries).toHaveLength(A_HUNDRED);
      expect(entries.filter((entry) => entry.attribution !== undefined)).toHaveLength(A_HUNDRED);
      expect(entries.filter((entry) => entry.attribution === 'automation')).toHaveLength(
        ours.length,
      );
      expect(artifact.run.progress?.perVariant).toStrictEqual([
        { variant: ONE_URL_VARIANT_ID, totalSessions: A_HUNDRED, finishedSessions: A_HUNDRED },
      ]);

      // And the committed example run is byte for byte what it was.
      expect(fingerprint(committedRunDir)).toStrictEqual(committedBefore);
    },
    WALK_TIMEOUT,
  );
});
