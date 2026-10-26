import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HURRIED_SCANNER,
  MIDDLING,
  PATIENT_READER,
  SEEDS,
  allFixations,
  areaIdLabelled,
  areaIdsLabelled,
  assertContractShape,
  firstPositionOf,
  fixationShareOn,
  median,
  metricOf,
  orderOverlap,
  primaryActionId,
  resetCaches,
  runSession,
  runSessions,
  sessionShareReaching,
  totalDwellMs,
  withTrait,
} from './harness.js';
import type { SessionRequest, SessionRun } from './harness.js';

/**
 * The behavioural half of the engine's credibility harness (#70).
 *
 * The earlier tickets each test their own piece — salience reads the pixels it says it
 * reads (#65), the distributions have the shape they advertise (#63), the sampler consumes
 * its generator in the order it documents (#67). This suite tests the *claims the product
 * makes*, end to end over the public entry point: a capture goes in, a scanpath comes out,
 * and the properties a designer would expect hold. It is the suite a change to any term
 * has to keep green.
 *
 * **Every claim is a property of the output.** Not one assertion below reads a salience
 * value, a relevance value or a logit: a claim is made about fixations, about the order
 * they arrive in, or about the per-area metrics `aggregate` computes — the numbers the
 * screens actually show. So any of the terms is free to be rewritten underneath, and this
 * suite still says whether the engine behaves as advertised.
 *
 * **Why the numbers below cannot flake.** Every claim runs over `SEEDS`, a fixed set of
 * twenty-four, through a sampler whose only source of randomness is the seed it is handed.
 * A share here is therefore a number and not a sample, and each band states the mechanism
 * that puts it where it is, so a future change that narrows one is a decision somebody took
 * rather than a test that happened to still pass.
 *
 * **Time budget.** The two suites together are budgeted at **5 seconds** of wall time and
 * measure **0.7 s** on a laptop — 0.4 s of test time, of which the cross-process
 * determinism check is 0.17 s, plus vitest's start-up. The whole thing runs with no API
 * key, no network and no run directory, over the five committed fixture captures; the
 * budget and what buys the headroom are restated in `packages/engine/README.md`.
 */

/** The goal most claims are made under: an ordinary shopper, nothing contrived. */
const SHOPPING = { text: 'buy a pair of hiking boots' };

describe('a high-contrast banner attracts an early fixation', () => {
  const fixture = 'high-contrast-banner' as const;
  const bannerLabel = 'Spring sale — 40% off every boot';
  /** The page's quietest area: body copy, the lowest-contrast thing on it. */
  const paragraphLabel = 'A waterproof three-season boot with a rubber toe cap.';

  it('is among the first three fixations in more than half the sessions', async () => {
    const banner = await areaIdLabelled(fixture, bannerLabel);
    const runs = await runSessions(
      { fixture, personaId: 'middling', persona: MIDDLING, goal: SHOPPING },
      SEEDS,
    );

    const early = runs.filter((run) => {
      const at = firstPositionOf(run, banner);
      return at !== null && at < 3;
    });

    /**
     * 13 of the 24 seeds on the defaults — 0.542, against a floor of 0.50.
     *
     * **Read the margin honestly.** Five areas and three looks put chance at about 0.49
     * (`1 - (4/5)³`), so the banner clears it by a session and a half. That is the claim
     * the *uncalibrated* defaults support and no more: the six salience terms are
     * normalised to 0..1 and then averaged, which compresses this page's range to 0.30 for
     * the body copy against 0.468 for the banner, and `alpha` is 1, so the softmax turns
     * that gap into a factor of about 1.18 per draw. The next test states the part of this
     * claim that is robust, and the `alpha` test below shows the lead is salience's doing
     * and widens with the weight — which is what calibration (#11) is for. A floor above
     * 0.55 would be a band describing this seed set rather than the engine: it holds at 24
     * seeds and not at 48.
     */
    expect(early.length / runs.length).toBeGreaterThanOrEqual(0.5);
  });

  it('takes more of the sessions’ fixations than the low-contrast paragraph below it', async () => {
    const [banner, paragraph] = await Promise.all([
      areaIdLabelled(fixture, bannerLabel),
      areaIdLabelled(fixture, paragraphLabel),
    ]);
    const runs = await runSessions(
      { fixture, personaId: 'middling', persona: MIDDLING, goal: SHOPPING },
      SEEDS,
    );

    /**
     * 0.196 of the sessions' fixations against 0.175 — the same direction, and about the
     * same margin, at 24, 48 and 96 seeds, which is why this is the form of the claim the
     * suite leans on. It is the comparison #7's Testing Decisions ask for: an area is
     * fixated more often *than a distractor on the same page*, under the same goal, the
     * same persona and the same seeds, with only the pixels different.
     */
    expect(fixationShareOn(runs, [banner])).toBeGreaterThan(fixationShareOn(runs, [paragraph]));
  });
});

describe('a control below the fold is fixated later than one above it, or not at all', () => {
  const fixture = 'below-fold-primary-action' as const;
  const ORDERING = { text: 'place the order' };

  it('is fixated later than the heading above the fold, and on a later screen', async () => {
    const [primary, heading] = await Promise.all([
      primaryActionId(fixture),
      areaIdLabelled(fixture, 'Review your order'),
    ]);
    const runs = await runSessions(
      { fixture, personaId: 'patient-reader', persona: PATIENT_READER, goal: ORDERING },
      SEEDS,
    );

    const above = metricOf(runs, heading);
    const below = metricOf(runs, primary);

    /**
     * The page is 760 px of content in a 240 px viewport, so the primary action needs
     * three scrolls to be on screen at all. The bands are an order of magnitude apart
     * because the mechanism is: the heading is on the first screen (its median time to
     * first fixation is 0 ms, the session's first look), the primary action cannot be
     * looked at before the screen it sits on arrives. Stated as bounds rather than as a
     * bare `>` so that a change which merely *reorders* the two still reads as the
     * regression it is: on the defaults the heading's median is 0 ms and the primary
     * action's 9,561 ms.
     */
    expect(above.timeToFirstFixationMs).toBeLessThan(500);
    expect(below.timeToFirstFixationMs).toBeGreaterThan(4_000);

    /**
     * And it is a scroll that put it there, not a lucky draw inside the first screen: in
     * all twenty-four sessions the first look at it falls on screen 2, the third of the
     * four this page has.
     */
    const firstLooks = runs.map(
      (run) => run.session.fixations.find((fixation) => fixation.aoiId === primary)?.screenIndex,
    );
    expect(firstLooks.every((screenIndex) => screenIndex !== undefined && screenIndex >= 2)).toBe(
      true,
    );
  });

  it('is reached by no session in the seed set when the persona never scrolls to it', async () => {
    const primary = await primaryActionId(fixture);
    const runs = await runSessions(
      { fixture, personaId: 'hurried-scanner', persona: HURRIED_SCANNER, goal: ORDERING },
      SEEDS,
    );

    /**
     * The never-fixated case, asserted rather than tolerated — #7's user story 11 and the
     * reason `aggregate` answers `null` instead of a near-zero.
     *
     * It is not a near miss and it is not luck: a hurried scanner's
     * `screenPersistenceScale` is below 1, so the session stays on the first screen, and
     * the primary action is 380 px below the bottom of it. Nobody can look at a control
     * they never scrolled to, and the engine does not pretend otherwise — so the right
     * number of fixations is exactly zero, in all twenty-four sessions, and the metric a
     * screen reads has to carry that through as a `null` and a 0.
     */
    expect(runs.every((run) => run.session.screens.length === 1)).toBe(true);
    expect(allFixations(runs).filter((fixation) => fixation.aoiId === primary)).toEqual([]);

    const row = metricOf(runs, primary);
    expect(row).toMatchObject({
      timeToFirstFixationMs: null,
      firstFixationDurationMs: null,
      lookedAtShare: 0,
      fixationCount: 0,
      sessionCount: SEEDS.length,
    });
  });
});

describe('a price-seeking goal raises the probability of fixating the price area', () => {
  const fixture = 'price-and-fees' as const;
  /** The goal names the total; the two areas that say "Total" are the price area. */
  const TOTAL_SEEKING = { text: 'check the total' };
  const UNRELATED = { text: 'read the delivery and returns policy' };

  it('raises the share of fixations on the total over the same page with an unrelated goal', async () => {
    const totalRow = await areaIdsLabelled(fixture, 'Total', 2);
    const [seeking, unrelated] = await Promise.all([
      runSessions(
        { fixture, personaId: 'middling', persona: MIDDLING, goal: TOTAL_SEEKING },
        SEEDS,
      ),
      runSessions({ fixture, personaId: 'middling', persona: MIDDLING, goal: UNRELATED }, SEEDS),
    ]);

    /**
     * 0.325 of the fixations against 0.279: a sixth more of the agent's looks on the row it
     * was sent to read, with everything else about the two runs identical — same page, same
     * persona, same seeds, only the goal's words different. The margin is stated at 0.03
     * rather than at the measured 0.046 to leave the relevance weights room to be refitted;
     * what it may not do is fall to zero, because then a goal would have stopped reaching
     * the eyes.
     */
    expect(fixationShareOn(seeking, totalRow)).toBeGreaterThan(
      fixationShareOn(unrelated, totalRow) + 0.03,
    );

    /**
     * And every session reaches it. Both goals manage that on a page this short — eight
     * areas and nine looks — which is why the claim above is about the *share of the
     * looks* and not about how many sessions got there: on a page of this size the second
     * number has no room to move, and saying so here is cheaper than a reader finding it
     * out.
     */
    expect(sessionShareReaching(seeking, totalRow)).toBe(1);
  });
});

describe('a scanning persona produces more and shorter fixations than a reading one', () => {
  const fixture = 'price-and-fees' as const;
  const PAYING = { text: 'pay for the boots' };
  const scanner = withTrait('scanningVsReading', 0.95);
  const reader = withTrait('scanningVsReading', 0.05);

  it('makes more fixations and shorter ones on the same page and seed', async () => {
    const [scanning, reading] = await Promise.all([
      runSessions({ fixture, personaId: 'scanner', persona: scanner, goal: PAYING }, SEEDS),
      runSessions({ fixture, personaId: 'reader', persona: reader, goal: PAYING }, SEEDS),
    ]);

    /**
     * The one trait moved and the other five held at the middle, so this is the
     * `scanningVsReading` row of the persona-trait table and nothing else: 12 fixations
     * against 8, and a median duration of 188 ms against 293 ms. Both directions are the
     * table's, and the comparison is per seed — every one of the twenty-four, not the
     * averages — so no seed is allowed to run the other way.
     */
    SEEDS.forEach((seed, at) => {
      const quick = scanning[at];
      const slow = reading[at];
      expect({
        seed,
        more: quick.session.fixations.length > slow.session.fixations.length,
        shorter:
          median(quick.session.fixations.map((fixation) => fixation.durationMs)) <
          median(slow.session.fixations.map((fixation) => fixation.durationMs)),
      }).toEqual({ seed, more: true, shorter: true });
    });
  });
});

describe('two personas on the same page produce visibly different scanpaths', () => {
  const fixture = 'price-and-fees' as const;
  const PAYING = { text: 'pay for the boots' };

  it('differ in order, in length and in dwell, on every seed in the set', async () => {
    const [hurried, patient] = await Promise.all([
      runSessions(
        { fixture, personaId: 'hurried-scanner', persona: HURRIED_SCANNER, goal: PAYING },
        SEEDS,
      ),
      runSessions(
        { fixture, personaId: 'patient-reader', persona: PATIENT_READER, goal: PAYING },
        SEEDS,
      ),
    ]);

    const overlaps = SEEDS.map((_seed, at) => orderOverlap(hurried[at], patient[at]));

    /**
     * "Visibly different" as a number: the scanpaths agree on at most 0.818 of their
     * positions on any of the twenty-four seeds, so no seed produces the same scanpath
     * twice. The bound is 0.85 — above the measured worst case, below 1 — because the
     * claim is that they differ, not that they differ by this much.
     */
    expect(Math.max(...overlaps)).toBeLessThan(0.85);

    /**
     * Where the difference comes from, stated so a later change to the engine is read
     * against it: the hurried scanner takes 9 looks and the patient reader 11 (the count
     * and persistence rows), and the reader's dwell is more than twice the scanner's (the
     * duration and dwell rows). The *order* of areas moves only through
     * `interfaceFamiliarity`, which scales the role prior — one of the six salience terms
     * — so on most seeds the two agree until the shorter scanpath runs out, and on 5 of
     * the 24 they diverge inside the common prefix. The floor below is 3 rather than 5
     * because 5 is this seed set's number and the claim is that the order moves at all. A
     * trait with a more direct path into the area draw would raise it; #67 and #7 own that
     * decision, not this suite.
     */
    const divergedEarly = SEEDS.filter((_seed, at) => {
      const a = hurried[at].session.fixations.map((fixation) => fixation.aoiId);
      const b = patient[at].session.fixations.map((fixation) => fixation.aoiId);
      const shared = Math.min(a.length, b.length);
      return a.slice(0, shared).some((aoiId, position) => aoiId !== b[position]);
    });
    expect(divergedEarly.length).toBeGreaterThanOrEqual(3);

    /** 2.08× on the defaults: 11 looks at the reader's durations against 9 at the scanner's. */
    expect(median(patient.map(totalDwellMs)) / median(hurried.map(totalDwellMs))).toBeGreaterThan(
      1.6,
    );
  });
});

describe('the engine is deterministic end to end', () => {
  const request: SessionRequest = {
    fixture: 'price-and-fees',
    personaId: 'middling',
    persona: MIDDLING,
    goal: { text: 'pay for the boots' },
    seed: 4242,
  };

  it('answers byte-identical fixations for a fixed capture, persona, goal and seed', async () => {
    const first = await runSession(request);
    /**
     * The memo tables go, so the second session rebuilds the areas, re-reads the
     * screenshot and rescores salience from the committed bytes. Two sessions sharing a
     * cached salience map would prove the sampler repeatable and say nothing about the
     * half of the path that reads an image.
     */
    resetCaches();
    const again = await runSession(request);

    expect(JSON.stringify(again.session.fixations)).toBe(JSON.stringify(first.session.fixations));
    expect(JSON.stringify(again.session.saccades)).toBe(JSON.stringify(first.session.saccades));
    /** And the whole session, so no field of it is quietly a clock or a counter. */
    expect(JSON.stringify(again.session)).toBe(JSON.stringify(first.session));
  });

  it('answers the same bytes in a second process', async () => {
    const here = await runSession(request);
    const child = fileURLToPath(new URL('session.child.ts', import.meta.url));

    const elsewhere = execFileSync(
      process.execPath,
      ['--conditions', 'development', '--import', 'tsx', child, JSON.stringify(request)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );

    expect(elsewhere).toBe(JSON.stringify(here.session));
  });

  it('answers a different scanpath for a different seed', async () => {
    const [one, other] = await Promise.all([
      runSession(request),
      runSession({ ...request, seed: request.seed + 1 }),
    ]);

    expect(JSON.stringify(other.session.fixations)).not.toBe(JSON.stringify(one.session.fixations));
  });

  it('builds a session the contract accepts', async () => {
    const { session } = await runSession(request);
    expect(() => assertContractShape(session)).not.toThrow();
  });
});

describe('the suite is sensitive to the weights it is testing', () => {
  /**
   * The criterion this describe block exists for: a deliberate change to one configuration
   * weight has to move the behavioural outcome in the documented direction, or the claims
   * above are not really about the terms they name. Each weight is raised from its default
   * of 1 to 6 through a run's `engine.weights` — the same seam calibration (#11) uses —
   * with the page, the persona, the goal and the seeds held still.
   */
  it('raising beta raises the share of fixations on the area the goal names', async () => {
    const fixture = 'price-and-fees' as const;
    const goal = { text: 'check the total' };
    const totalRow = await areaIdsLabelled(fixture, 'Total', 2);
    const [atDefault, raised] = await Promise.all([
      runSessions({ fixture, personaId: 'middling', persona: MIDDLING, goal }, SEEDS),
      runSessions(
        { fixture, personaId: 'middling', persona: MIDDLING, goal, weights: { beta: 6 } },
        SEEDS,
      ),
    ]);

    /** 0.325 to 0.608: relevance pulls harder, as `beta` is the weight that says so. */
    expect(fixationShareOn(raised, totalRow)).toBeGreaterThan(
      fixationShareOn(atDefault, totalRow) + 0.15,
    );
  });

  it("raising alpha widens the banner's lead over the low-contrast paragraph", async () => {
    const fixture = 'high-contrast-banner' as const;
    /**
     * A goal no area on the page says anything about, so relevance is the floor everywhere
     * and the only term left that can move is salience — the same control
     * `sample-fixations.test.ts` uses, for the same reason.
     */
    const goal = { text: 'wgzq xhvl' };
    const [banner, paragraph] = await Promise.all([
      areaIdLabelled(fixture, 'Spring sale — 40% off every boot'),
      areaIdLabelled(fixture, 'A waterproof three-season boot with a rubber toe cap.'),
    ]);
    const lead = (runs: readonly SessionRun[]): number =>
      fixationShareOn(runs, [banner]) - fixationShareOn(runs, [paragraph]);

    const [off, atDefault, raised] = await Promise.all([
      runSessions(
        { fixture, personaId: 'middling', persona: MIDDLING, goal, weights: { alpha: 0 } },
        SEEDS,
      ),
      runSessions({ fixture, personaId: 'middling', persona: MIDDLING, goal }, SEEDS),
      runSessions(
        { fixture, personaId: 'middling', persona: MIDDLING, goal, weights: { alpha: 6 } },
        SEEDS,
      ),
    ]);

    /**
     * This is the test that makes the banner claim above mean something. With `alpha` at 0
     * the banner has no lead at all over the quietest area on the page (−0.013 — the
     * paragraph is marginally ahead, which is what no preference looks like); at the
     * default weight of 1 the lead is +0.017; at 6 it is +0.121, and the banner is fixated
     * before the paragraph in 22 of the 24 sessions instead of 14. So the small margin the
     * defaults give is bottom-up salience and nothing else, and it is a weight — the one
     * calibration (#11) fits — that decides how loud it is.
     */
    expect(lead(off)).toBeLessThanOrEqual(0);
    expect(lead(atDefault)).toBeGreaterThan(lead(off));
    expect(lead(raised)).toBeGreaterThan(lead(off) + 0.08);
  });

  it('raising gamma pushes a revisit further out', async () => {
    const fixture = 'price-and-fees' as const;
    const goal = { text: 'pay for the boots' };
    const [atDefault, raised] = await Promise.all([
      runSessions({ fixture, personaId: 'middling', persona: MIDDLING, goal }, SEEDS),
      runSessions(
        { fixture, personaId: 'middling', persona: MIDDLING, goal, weights: { gamma: 6 } },
        SEEDS,
      ),
    ]);

    /**
     * How far apart two looks at one area are, counted in fixations of the sequence: 4.40
     * on the defaults, 4.87 with the history term weighted six times as heavily. `gamma`
     * scales inhibition of return, so raising it has to space revisits out — and must not
     * change which areas the run cap holds, which `sample-fixations.test.ts` owns.
     */
    const meanRevisitDistance = (runs: readonly SessionRun[]): number => {
      const distances = runs.flatMap((run) => {
        const lastAt = new Map<string, number>();
        const spans: number[] = [];
        run.session.fixations.forEach((fixation, position) => {
          if (fixation.aoiId === null) return;
          const previous = lastAt.get(fixation.aoiId);
          if (previous !== undefined) spans.push(position - previous);
          lastAt.set(fixation.aoiId, position);
        });
        return spans;
      });
      return distances.reduce((sum, span) => sum + span, 0) / distances.length;
    };

    expect(meanRevisitDistance(raised)).toBeGreaterThan(meanRevisitDistance(atDefault) + 0.2);
  });
});

describe('the suite tests the engine the way a caller gets it', () => {
  const files = ['harness.ts', 'behaviour.test.ts', 'statistical.test.ts', 'session.child.ts'];
  const sources = files.map((file) => ({
    file,
    text: readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'),
  }));

  it('imports the package only through its published entry point', () => {
    /**
     * `package.json`'s `exports` publishes `src/index.ts` and nothing else, so a claim
     * made through `../src/sampling/index.js` would be a claim about a module a caller
     * cannot reach — and would keep passing after the package stopped publishing the
     * function it tests. The fixtures and this harness are the suite's own material and
     * are imported by path; everything the engine publishes comes from the one barrel.
     */
    const reaching = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/from '(\.\.\/src\/[^']*)'/g)]
        .map((match) => match[1])
        .filter((specifier) => specifier !== '../src/index.js')
        .map((specifier) => `${file} imports ${specifier}`),
    );

    expect(reaching).toEqual([]);
  });

  it('reaches for nothing of the platform but files, paths and one child process', () => {
    /**
     * The whole suite has to pass on a cold clone with no API key and no network:
     * `buildAois` runs the offline heuristic segmenter, relevance is lexical and
     * role-based, and the only bytes read are the committed fixtures' and these source
     * files'. The engine's own purity is held by `config.test.ts` over `src/`; this holds
     * the line over the suite that drives it, so a later claim cannot quietly reach for a
     * socket to make itself true. `node:child_process` is the second process the
     * determinism test needs, and it runs this repository's own child script.
     */
    const allowed = ['node:child_process', 'node:fs', 'node:path', 'node:url'];
    const reaching = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/from '(node:[^']*)'/g)]
        .map((match) => match[1])
        .filter((specifier) => !allowed.includes(specifier))
        .map((specifier) => `${file} imports ${specifier}`),
    );

    expect(reaching).toEqual([]);
  });
});
