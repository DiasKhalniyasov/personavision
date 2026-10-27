/**
 * The demo, as a test.
 *
 * One browser-level walk over the **built platform** and the **committed example run**,
 * following `docs/FLOW.md` section 7 beat by beat from a cold start to the closing screen,
 * asserting the words on screen at each beat — so the moment the demo depends on is
 * verified by CI rather than hoped for on the day.
 *
 * It is the cross-screen path and not a second copy of any screen's own tests: #19 walks the
 * assembled Verdict screen in isolation, and a defect this walk finds is fixed in the screen
 * that owns it. This file owns no markup and no element id: every selector here is one a
 * screen ticket already built.
 *
 * **What is read and what is asserted.** Session ids, scores and counts are read from the
 * committed artifact, because the real run's numbers are the run's and not the prototype's
 * illustrative ones. **Wording is asserted verbatim** — beat 5's sentence, the verdict's
 * sentence, the reasons, the findings, the simulated-data disclaimer — because wording is
 * what a demo lives or dies by and what a refactor quietly loses.
 *
 * **It is tagged**, as `./pipeline.test.ts` is, because it builds nothing but costs a server
 * start and a browser: `pnpm test` collects it and runs nothing in it, `pnpm test:acceptance`
 * sets the tag, and CI's own `acceptance` job runs that after `pnpm build`.
 *
 * **Offline, with no key, and nothing left behind.** The command is given an environment
 * holding a path and a home and nothing else, every request the page makes to anywhere but
 * the loopback port it started is aborted and reported, the committed run directory is
 * fingerprinted before the walk and compared after it, and the server is stopped however the
 * walk ends.
 *
 * ## The beats, and the two places this file reads the contract rather than the criteria
 *
 * `docs/FLOW.md` section 7 was rewritten by the owner's direction on #1 and #80's own
 * "What to build" was rewritten with it; two lines of #80's acceptance criteria were not.
 * Where they disagree the rewritten contract wins, and the disagreement is named here:
 *
 * - **The first screen.** The criteria say the Comparison screen; the contract says the
 *   sign-in screen, and the Comparison screen no longer exists — what it led with is the
 *   Score breakdown, one click deeper. Beat 1 asserts sign-in, and that every screen of the
 *   product sends a signed-out visitor there.
 * - **The click counts.** The criteria say two clicks to beat 2 and four to beat 5; the
 *   contract says **zero** from sign-in to beat 2 and **one** to beat 5, which is the whole
 *   point of the owner's direction — a test that clicked to reach the answer would not have
 *   tested it. Zero and one are asserted.
 *
 * The criteria's score table and per-segment outcomes are asserted where the rewrite moved
 * them: the Score breakdown, visited after the closing beat rather than inside it, because
 * the demo ends on the Verdict and that screen is deliberately quiet.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRun } from '@personavision/contract';
import type { Device, PageHandle } from '@personavision/browser';
import type { RunArtifact, Session } from '@personavision/contract';
import { committedRunDir, fingerprint } from './helpers/harness.js';
import {
  bareEnvironment,
  discard,
  openBrowserOver,
  scratch,
  servePlatform,
} from './helpers/platform.js';
import type { OpenedBrowser, ServedPlatform } from './helpers/platform.js';

/**
 * The page the walk drives, taken off the launcher's own handle rather than imported from
 * `playwright`: this package does not depend on the browser driver, `@personavision/browser`
 * does, and the walk is a caller of that package.
 */
type Page = PageHandle['page'];

/** The tag. `pnpm test` leaves it unset and this suite does not run. */
const TAG = 'PERSONAVISION_ACCEPTANCE';
const tagged = process.env[TAG] === '1';

/** A build, a server start, a browser launch and seven screens. */
const WALK_TIMEOUT = 300_000;
/** One beat: a click, a navigation and the reads behind the screen it lands on. */
const BEAT_TIMEOUT = 120_000;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The one click beat 1 spends — the sign-in form's own action.
 *
 * Every later click goes through `click`, so `clicks` is the number of clicks the walk has
 * spent and the two claims about the path are assertions about this counter.
 */
const SIGN_IN_CLICKS = 1;

/** A value the artifact must carry, or a failure naming what was looked for. */
const must = <Value>(value: Value | null | undefined, what: string): Value => {
  if (value === null || value === undefined)
    throw new Error(`the committed run carries no ${what}`);
  return value;
};

/** What a beat's failure is named by, so a red walk says which beat broke. */
const beat = (number: number, what: string): string => `beat ${String(number)} — ${what}`;

/** An element's words, with the line breaks of the markup closed up. */
const words = async (page: Page, selector: string): Promise<string> => {
  const text = await page.locator(selector).first().textContent();
  return (text ?? '').replace(/\s+/gu, ' ').trim();
};

/** How many of these a screen draws. */
const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

/**
 * The elements these selectors name: one each, and drawn in this order down the page.
 *
 * Where each one is drawn rather than where it sits in the markup, because "in page order"
 * is a claim about what the reader meets first and a section moved by CSS has moved.
 */
const inPageOrder = async (page: Page, selectors: readonly string[]): Promise<void> => {
  const drawn: { selector: string; top: number }[] = [];
  for (const selector of selectors) {
    expect(await count(page, selector), selector).toBe(1);
    const box = await page.locator(selector).first().boundingBox();
    drawn.push({ selector, top: must(box, `a drawn box for ${selector}`).y });
  }

  expect(drawn.map((one) => one.selector)).toEqual(
    [...drawn].sort((left, right) => left.top - right.top).map((one) => one.selector),
  );
};

/**
 * The share out of ten, as `apps/viewer/src/screens/verdict/completionBand.ts#inTen` writes
 * it: **10 and 0 are reserved for everybody and nobody**, and rounding never reaches them.
 */
const inTen = (rate: number): number => {
  if (rate === 1) return 10;
  if (rate === 0) return 0;
  return Math.min(9, Math.max(1, Math.round(rate * 10)));
};

/** `9 in 10` and `92% · 11 of 12 people completed the task`, as `CompletionFigures` says them. */
const completionWords = (rate: number, success: number, scored: number): string[] => [
  `${String(inTen(rate))} in 10`,
  `${String(Math.round(rate * 100))}% · ${String(success)} of ${String(scored)} people completed the task`,
];

/**
 * A friction score or a spread in points, as `apps/viewer/src/screens/breakdown/scoreBand.ts`
 * writes it: one decimal, and none at all on a whole number.
 */
const points = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/** The closing screen, section by section, in the order it draws them (#19's own list). */
const CLOSING_SCREEN = [
  '[data-shell="simulated-badge"]',
  '[data-section="audience-line"]',
  '[data-section="headline"]',
  '[data-section="completion-figures"]',
  '[data-section="reasons"]',
  '[data-section="hero-evidence"]',
  '[data-section="headline-findings"]',
  '[data-section="detail-doors"]',
  '[data-shell="simulated-disclaimer"]',
] as const;

/** The one heatmap, which #71's layer withholds until every session has arrived. */
const HEAT = '[data-overlay-layer="heat"]';
/** The three findings the verdict named, as cards on the page. */
const FINDING = '[data-section="headline-findings"] [data-sev]';

/**
 * The screens the Verdict must not carry: everything the owner's direction moved one click
 * deeper. Each was on the old Comparison screen, and without an assertion they drift back
 * one well-meaning ticket at a time.
 */
const NOT_ON_THE_VERDICT: readonly [string, string][] = [
  ['[data-section="areas-of-interest"]', 'the area-of-interest table'],
  ['[data-overlay-layer="scan"]', 'the scanpath'],
  ['[data-section="score-cards"]', 'the component bars'],
  ['.score-value', 'the friction score'],
];

describe.skipIf(!tagged)('the demo, beat by beat, over the built platform', () => {
  let scratchRoot: string | undefined;
  let dataDir: string | undefined;
  let served: ServedPlatform | undefined;
  let browser: OpenedBrowser | undefined;
  let page!: Page;
  let artifact: RunArtifact;
  let before: string[];
  let clicks = 0;

  /** A click the walk spends, counted: the two claims about the path are about this number. */
  const click = async (selector: string): Promise<void> => {
    clicks += 1;
    await page.locator(selector).first().click();
  };

  /** A tab of the product chrome, by its label. */
  const tab = (label: string): string => `[data-shell="tabbar"] a:text-is("${label}")`;

  beforeAll(async () => {
    artifact = await readRun(committedRunDir);
    before = fingerprint(committedRunDir);
    // The directory itself must not exist yet: a fresh one is what beat 1 is about.
    scratchRoot = await scratch('data');
    dataDir = join(scratchRoot, 'workspace');
    served = await servePlatform({ dataDir });
    const desktop = must(
      artifact.run.audience.devices.find((device) => device.name === 'desktop'),
      'desktop device in its audience',
    );
    const device: Device = {
      name: desktop.name,
      viewport: desktop.viewport,
      deviceScaleFactor: desktop.deviceScaleFactor,
      touch: desktop.touch,
    };
    browser = await openBrowserOver(served.base, device);
    page = browser.handle.page;
  }, WALK_TIMEOUT);

  // `undefined` whenever the start above threw, which is one of the cases this suite exists
  // to catch: the failure that matters is reported, rather than a second one about tearing
  // down something that never came up.
  afterAll(async () => {
    await browser?.close();
    await served?.stop();
    await discard(scratchRoot);
  });

  it(
    'beat 1 — sign in: a fresh data directory, no key, and the sign-in screen first',
    async () => {
      const platform = must(served, 'served platform');
      const credentials = must(platform.credentials, 'seeded workspace');

      // No `PERSONAVISION_*` variable reaches the command, which is what "no API key" means
      // as a claim about this sequence rather than as a sentence in a README.
      expect(
        Object.keys(bareEnvironment()).filter((name) => name.startsWith('PERSONAVISION_')),
        beat(1, 'the command is given no PERSONAVISION_* variable'),
      ).toEqual([]);
      // The password is printed once, in the credentials block, and nowhere else it writes.
      expect(
        platform.log(),
        beat(1, 'the password is printed once and in no log line'),
      ).not.toContain(credentials.password);

      // The product behind sign-in is behind sign-in: a page request for the answer is sent
      // to the sign-in screen carrying where it was going, so sign-in is the first screen a
      // visitor meets and beat 2 is the first screen of the product.
      const protectedPage = await fetch(new URL(`runs/${artifact.run.runId}`, platform.base), {
        redirect: 'manual',
        headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
      });
      expect(protectedPage.status, beat(1, 'the product redirects a signed-out visitor')).toBe(302);
      expect(protectedPage.headers.get('location'), beat(1, 'it redirects to /signin')).toContain(
        '/signin',
      );

      await page.goto(new URL('signin', platform.base).toString());
      await page.waitForSelector('form.signin-card');

      expect(await words(page, 'form.signin-card h1'), beat(1, 'the sign-in screen')).toBe(
        'Sign in',
      );
      expect(
        await words(page, 'form.signin-card'),
        beat(1, 'it names the seeded workspace’s own address'),
      ).toContain(credentials.email);

      // One screen, one action.
      await page.fill('input[name="email"]', credentials.email);
      await page.fill('input[name="password"]', credentials.password);
      clicks += SIGN_IN_CLICKS;
      await page.locator('form.signin-card button[type="submit"]').click();
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 2 — the verdict is already there, in zero clicks',
    async () => {
      const { run } = artifact;

      // No navigation of the walk's between the sign-in and the answer: the app arrives on
      // the Verdict of the workspace's most recent test by itself.
      await page.waitForURL(new RegExp(`/runs/${run.runId}$`));
      await page.waitForSelector('[data-section="headline"]');

      expect(clicks, beat(2, 'zero clicks from the sign-in to the answer')).toBe(SIGN_IN_CLICKS);

      expect(
        await words(page, '[data-section="headline"] h1'),
        beat(2, 'the headline sentence'),
      ).toBe(run.verdict.audienceSentence);

      const figures = await words(page, '[data-section="completion-figures"]');
      for (const variant of run.variants) {
        const score = must(
          run.scores.find(
            (candidate) => candidate.variant === variant.id && candidate.taskId === run.task.id,
          ),
          `score for variant ${variant.id}`,
        );
        for (const said of completionWords(
          score.completionRate,
          score.outcomeCounts.success,
          score.scoredSessionCount,
        )) {
          expect(figures, beat(2, `the completion figure of variant ${variant.id}`)).toContain(
            said,
          );
        }
      }

      const audience = await words(page, '[data-section="audience-line"]');
      expect(audience, beat(2, 'the audience the answer is about')).toContain(run.audience.name);
      expect(audience, beat(2, 'the audience’s age range')).toContain(
        `${String(run.audience.ageRange.min)}–${String(run.audience.ageRange.max)}`,
      );
      expect(audience, beat(2, 'the people behind the answer')).toContain(
        `${String(run.personas.length)} simulated people`,
      );
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 3 — the two reasons, and one heatmap of variant B’s review step',
    async () => {
      const { run } = artifact;
      const hero = run.verdict.heroEvidence;

      await page.waitForSelector(HEAT);

      const reasons = await words(page, '[data-section="reasons"]');
      for (const reason of run.verdict.reasons) {
        expect(reasons, beat(3, 'both reasons, in the pipeline’s own words')).toContain(reason);
      }

      expect(await count(page, HEAT), beat(3, 'exactly one heatmap on this screen')).toBe(1);

      const variantName = must(
        run.variants.find((variant) => variant.id === hero.variant),
        `variant ${hero.variant}`,
      ).name;
      const stepLabel = must(
        run.steps.find((step) => step.id === hero.step),
        `step ${hero.step}`,
      ).label;
      expect(
        await words(page, '[data-section="hero-evidence"] h2'),
        beat(3, 'the heatmap is of the step the verdict turns on'),
      ).toBe(`Where your audience looked on ${variantName}, at the ${stepLabel} step`);

      const area = must(
        run.aois.find((aoi) => aoi.id === hero.aoiId),
        `area of interest ${String(hero.aoiId)}`,
      );
      expect(
        await words(page, '[data-section="hero-evidence"] figcaption'),
        beat(3, 'the caption names what nothing landed on'),
      ).toContain(`Nothing at all lands on “${area.label}”`);
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 4 — the three findings, and nothing else on the screen',
    async () => {
      const { run, findings } = artifact;

      const cards = page.locator(FINDING);
      expect(await cards.count(), beat(4, 'the three findings the verdict named')).toBe(3);

      const shown = await cards.allTextContents();
      const said = shown.map((text) => text.replace(/\s+/gu, ' ').trim());
      run.verdict.headlineFindingIds.forEach((id, position) => {
        const finding = must(
          findings.findings.find((candidate) => candidate.id === id),
          `finding ${id}`,
        );
        const card = must(said[position], `finding card ${String(position)}`);
        expect(card, beat(4, `the claim of ${id}, in the owner’s words`)).toContain(finding.claim);
        expect(card, beat(4, `the evidence sentence of ${id}`)).toContain(finding.evidence);
      });

      for (const [selector, what] of NOT_ON_THE_VERDICT) {
        expect(await count(page, selector), beat(4, `${what} is not on this screen`)).toBe(0);
      }
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 5 — one click: the completing action reads never and 0%, and the page says so in words',
    async () => {
      const { run, sessions } = artifact;
      const hero = run.verdict.heroEvidence;
      const aoiId = must(hero.aoiId, 'area of interest on its hero evidence');
      const area = must(
        run.aois.find((aoi) => aoi.id === aoiId),
        `area of interest ${aoiId}`,
      );

      await click('[data-section="hero-evidence"] figcaption a');

      expect(clicks, beat(5, 'one click from the answer to the moment')).toBe(SIGN_IN_CLICKS + 1);

      await page.waitForURL(
        (url) =>
          url.pathname === `/runs/${run.runId}/attention/${hero.variant}/${hero.step}` &&
          url.searchParams.get('aoi') === aoiId,
      );

      const row = `[data-aoi-row="${aoiId}"]`;
      await page.waitForSelector(`${row}[aria-selected="true"]`);
      const cells = await page.locator(`${row} td`).allTextContents();
      const read = cells.map((cell) => cell.replace(/\s+/gu, ' ').trim());
      expect(read, beat(5, 'the row reads never')).toContain('never');
      expect(read, beat(5, 'the row reads 0%')).toContain('0%');

      // The denominator the sentence states, counted the way the screen counts it: this
      // version's people who stood on this step and whose session the scores include.
      const reached = sessions.filter(
        (session: Session) =>
          session.variant === hero.variant &&
          !session.outcome.excludedFromScores &&
          session.screens.some((screen) => screen.step === hero.step),
      ).length;

      // Verbatim, as `apps/viewer/src/screens/attention/attentionWording.ts` writes it. This
      // is the moment the whole demo turns on, and the one sentence a refactor must not lose.
      const sentence =
        `No fixation ever landed in “${area.label}” on variant ${hero.variant}. ` +
        `0 of ${String(reached)} people in your audience who reached this step looked at it. ` +
        'Nothing is missing from the data: the area was simply never seen.';

      await page.waitForSelector('[data-section="isolated-area"] span');
      expect(
        await words(page, '[data-section="isolated-area"]'),
        beat(5, 'the never-fixated sentence, verbatim'),
      ).toBe(sentence);
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 6 — one person: the rushed buyer on mobile, on the version that failed',
    async () => {
      const { run, sessions } = artifact;
      const harder = run.verdict.harderVariant;

      // By id read from the artifact, not written here: the rushed buyer's own sessions on
      // the version the verdict is against. `docs/FLOW.md` section 7 beat 6 walks the last
      // of them, S-15, and the walk is about the beat rather than about that id.
      // The persona in the audience's own words: on mobile, in a hurry. The segment is
      // `run.personas`' — a session records only which persona it was and what it ran on —
      // and the device is the session's, so "on mobile" is asserted of the run that happened.
      const WORDS = ['mobile', 'in a hurry'] as const;
      const rushedPersona = must(
        run.personas.find((persona) => WORDS.every((word) => persona.segment.includes(word))),
        `persona whose segment says ${WORDS.join(' and ')}`,
      );
      const theirs = (session: Session): boolean =>
        session.persona?.id === rushedPersona.id && session.persona.device.touch;
      const rushed = sessions
        .filter(
          (session: Session) =>
            session.variant === harder && theirs(session) && !session.outcome.excludedFromScores,
        )
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      const person = must(rushed.at(-1), `session of ${rushedPersona.name} on variant ${harder}`);

      await click(tab('Sessions'));
      await page.waitForSelector(`a:text-is("${person.sessionId}")`);
      await click(`a:text-is("${person.sessionId}")`);

      await page.waitForURL(`**/runs/${run.runId}/sessions/${person.sessionId}`);
      await page.waitForSelector('[data-screen-card]');

      const named = await words(page, 'h1');
      expect(named, beat(6, 'this one person’s replay')).toContain(person.sessionId);
      expect(named, beat(6, 'and says which of the audience it is')).toContain(rushedPersona.name);

      // Their stated intent per screen, in their own words.
      const stated = await words(page, '#rp-timeline');
      for (const screen of person.screens) {
        expect(stated, beat(6, 'the intent it stated on each screen')).toContain(screen.intent);
      }

      expect(
        await count(page, '[data-screen-card] li'),
        beat(6, 'the event log of what it did'),
      ).toBeGreaterThan(0);

      // The scrubber moves the gaze: the overlay's current fixation is a different one after.
      const currentFixation = (): Promise<string | null> =>
        page.locator('[data-fixation][data-current]').first().getAttribute('data-fixation');
      const atFirst = await currentFixation();
      await click('[aria-label="Next fixation"]');
      await expect.poll(currentFixation, { timeout: 10_000 }).not.toBe(atFirst);

      const outcome = await words(page, `[data-outcome="${person.outcome.status}"]`);
      expect(outcome, beat(6, 'the outcome card names its attribution')).toContain(
        `the ${person.outcome.attribution} was at fault, not our simulation`,
      );
      expect(outcome, beat(6, 'the outcome card confirms automation integrity')).toContain(
        'no selector failures',
      );
    },
    BEAT_TIMEOUT,
  );

  it(
    'beat 7 — back to the Verdict: the closing screen, in page order',
    async () => {
      const { run, findings } = artifact;

      await click(tab('Verdict'));
      await page.waitForURL(`**/runs/${run.runId}`);
      await page.waitForSelector(HEAT);
      await expect.poll(() => count(page, FINDING), { timeout: 30_000 }).toBe(3);

      await inPageOrder(page, CLOSING_SCREEN);

      const figures = await words(page, '[data-section="completion-figures"]');
      for (const score of run.scores.filter((candidate) => candidate.taskId === run.task.id)) {
        for (const said of completionWords(
          score.completionRate,
          score.outcomeCounts.success,
          score.scoredSessionCount,
        )) {
          expect(figures, beat(7, 'both completion figures, with their populations')).toContain(
            said,
          );
        }
      }

      const cards = (await page.locator(FINDING).allTextContents())
        .map((text) => text.replace(/\s+/gu, ' ').trim())
        .join(' ');
      for (const id of run.verdict.headlineFindingIds) {
        const finding = must(
          findings.findings.find((candidate) => candidate.id === id),
          `finding ${id}`,
        );
        expect(cards, beat(7, `the claim of ${id}`)).toContain(finding.claim);
        expect(cards, beat(7, `the evidence of ${id}`)).toContain(finding.evidence);
      }

      expect(
        await words(page, '[data-shell="simulated-badge"]'),
        beat(7, 'the header badge'),
      ).toContain('Simulated audience');
      const closing = await words(page, '[data-shell="simulated-disclaimer"]');
      expect(closing, beat(7, 'the closing line says every figure is simulated')).toContain(
        `Every figure on this screen is simulated, for the audience named at the top — ${run.audience.name}`,
      );
      expect(closing, beat(7, 'and that it is no conversion-lift estimate')).toContain(
        'it is not a conversion-lift estimate and does not replace a test on real customers',
      );
    },
    BEAT_TIMEOUT,
  );

  it(
    'one click deeper: both scores with their spread, and the outcomes per segment',
    async () => {
      const { run } = artifact;

      await click(tab('Score breakdown'));
      await page.waitForURL(`**/runs/${run.runId}/breakdown`);
      await page.waitForSelector('[data-section="score-cards"]');

      const cards = await words(page, '[data-section="score-cards"]');
      for (const score of run.scores.filter((candidate) => candidate.taskId === run.task.id)) {
        const variant = must(
          run.variants.find((candidate) => candidate.id === score.variant),
          `variant ${score.variant}`,
        );
        expect(cards, `the score of ${variant.name}`).toContain(variant.name);
        expect(cards, `the score of ${variant.name}`).toContain(points(score.frictionScore.median));
        expect(cards, `the spread of ${variant.name}`).toContain(
          `± ${points(score.frictionScore.sd)}`,
        );
      }

      await page.waitForSelector('[data-section="segments"]');
      const segments = await words(page, '[data-section="segments"]');
      for (const segment of new Set(run.personas.map((persona) => persona.segment))) {
        expect(segments, `the outcomes of the ${segment} segment`).toContain(segment);
      }
    },
    BEAT_TIMEOUT,
  );

  it(
    'the two public pages render from the committed run, and a reduced-motion visitor sees the figures at once',
    async () => {
      const platform = must(served, 'served platform');
      const { run } = artifact;
      const figures = run.scores
        .filter((score) => score.taskId === run.task.id)
        .flatMap((score) =>
          completionWords(
            score.completionRate,
            score.outcomeCounts.success,
            score.scoredSessionCount,
          ),
        );

      // Signed out, and asking not to be animated at.
      await browser?.handle.context.clearCookies();
      await page.emulateMedia({ reducedMotion: 'reduce' });

      await page.goto(platform.base);
      await page.waitForSelector('[data-section="landing-evidence"]');
      const landing = await words(page, '[data-section="landing-evidence"]');
      for (const said of figures) {
        expect(landing, 'the landing page’s figures, final the moment it renders').toContain(said);
      }

      await page.goto(new URL('demo', platform.base).toString());
      await page.waitForSelector('[data-section="headline"]');
      expect(await count(page, '[data-shell="public-bar"]'), 'the demo page is public').toBe(1);
      expect(await words(page, '[data-section="headline"] h1'), 'the demo page’s verdict').toBe(
        run.verdict.audienceSentence,
      );
      const demo = await words(page, '[data-section="completion-figures"]');
      for (const said of figures) {
        expect(demo, 'the demo page’s figures, final the moment it renders').toContain(said);
      }
    },
    BEAT_TIMEOUT,
  );

  it(
    'reaches no network, writes nothing into the committed run, and leaves no process behind',
    async () => {
      const platform = must(served, 'served platform');
      const credentials = must(platform.credentials, 'seeded workspace');

      expect(browser?.offMachine(), 'the walk asked nothing of any machine but this one').toEqual(
        [],
      );
      expect(fingerprint(committedRunDir), 'the committed run is unchanged').toEqual(before);

      await browser?.close();
      browser = undefined;
      await platform.stop();
      expect(platform.exited(), 'the server’s process is gone').toBe(true);

      // Twice in a row: the same data directory, which is seeded once and read from then on.
      const again = await servePlatform({ dataDir: must(dataDir, 'data directory') });
      try {
        expect(again.credentials, 'a second start seeds nothing and prints no password').toBeNull();

        const signedIn = await fetch(new URL('auth/signin', again.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(credentials),
        });
        expect(signedIn.status, 'the seeded account survives the restart').toBe(200);

        const listing = await fetch(new URL('runs/index.json', again.base), {
          headers: { cookie: must(signedIn.headers.getSetCookie()[0], 'session cookie') },
        });
        expect(listing.status, 'and still owns the committed example run').toBe(200);
        expect(
          ((await listing.json()) as { runId: string }[]).map((entry) => entry.runId),
        ).toContain(artifact.run.runId);
      } finally {
        await again.stop();
      }
      expect(again.exited(), 'and the second start’s process is gone too').toBe(true);
    },
    WALK_TIMEOUT,
  );
});

describe('the gate CI runs this walk in', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('runs it in the acceptance job, after the build, so a red walk fails the build', () => {
    const job = workflow.slice(workflow.indexOf('\n  acceptance:'));
    const steps = [...job.matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1]);

    expect(steps, 'the acceptance job builds').toContain('pnpm build');
    expect(steps, 'and then runs the tagged suite this walk is part of').toContain(
      'pnpm test:acceptance',
    );
    expect(steps.indexOf('pnpm build')).toBeLessThan(steps.indexOf('pnpm test:acceptance'));
  });

  it('collects this file: the command runs the directory it lives in, with the tag set', () => {
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toContain(
      `${TAG}=1 vitest run tests/acceptance`,
    );
  });
});
