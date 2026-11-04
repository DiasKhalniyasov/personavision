// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { funnelLink, heatmapLink, paths, sessionAtSecond } from '../../src/shell/paths';
import { publishable } from '../../src/screens/analysis/Claim';
import { forgetRuns, mountApp, serveRunData } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { rulesOf } from '../cssom';
import { loadDesignTokens } from '../setup';
import {
  OUR_BREAKAGE,
  RUN_ID,
  UNCITED_SESSION,
  baseDocument,
  claimWords,
  claimsOn,
  finishedAggregate,
  generatedWriteUp,
  hrefsOn,
  openAnalysis,
  part,
  seedRun,
  url,
  written,
} from './fixture';

/**
 * The Analysis screen — Muse Wonder's full write-up, at `/runs/:runId/analysis`.
 *
 * `#screen-analysis` of `docs/design/prototype.html` and section 14.6 of `docs/FLOW.md`:
 * *what does the model make of all of it?* Every claim on it carries the evidence it came
 * from, so somebody who doubts a sentence can check it in one click.
 *
 * What this suite is here to hold:
 *
 * - **the write-up is rendered, not written.** Every heading, paragraph and citation on the
 *   screen is one the generator produced from the recommendation objects — asserted by
 *   generating the fixture's write-up with `@personavision/scoring`'s own `writeUp` and
 *   holding the screen to it, claim for claim and in its order.
 * - **every link is built from structured fields.** A session and a second, a heatmap
 *   region, a funnel step: each becomes the URL the product's own builders make of those
 *   fields, and **no sentence is parsed to find one** — a claim whose prose names a session
 *   its citations do not produces no link to it.
 * - **a claim a reader could not check is not published.** One with nothing to cite, and one
 *   resting on a session our own automation broke (`docs/FLOW.md` section 11).
 * - **the provenance is read, never assembled**: how much was read, how it was sampled, what
 *   the aggregate is of and when — each from the file that stores it, asserted by moving the
 *   file and watching the line move with it.
 * - **the closing footnote states our own breakage**, and the screen ends with the simulated
 *   line and implies no conversion lift.
 * - **it is quiet**: clean under axe, reachable by keyboard with a focus ring, holding at
 *   390 px, and complete and still under `prefers-reduced-motion: reduce`.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** One of the app's own stylesheets, read as source — jsdom applies none of them. */
const stylesheet = (path: string): string => readFileSync(join(here, '../../src', path), 'utf8');

/** Every stylesheet this screen's directory holds. */
const styleSheetsUnder = (screenDir: string): string[] =>
  readdirSync(join(here, '../../src/screens', screenDir))
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => join(here, '../../src/screens', screenDir, entry));

/** jsdom answers every media query `false`; this makes one of them answer `true`. */
const prefersReducedMotion = (matches: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
};

/** Nothing on this screen is being animated by JavaScript, which sets inline styles. */
const expectNothingInMotion = (container: HTMLElement): void => {
  for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
    expect(element.style.animation, element.outerHTML).toBe('');
    expect(element.style.animationDuration, element.outerHTML).toBe('');
    expect(element.style.transitionDuration, element.outerHTML).toBe('');
  }
};

/** The claim the fixture's third recommendation would make: the one resting on our breakage. */
const CLAIM_ON_OUR_BREAKAGE = 'Four people went back to the cart from the payment step.';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the write-up the pipeline generated', () => {
  it('renders every publishable claim, in the generator’s order, heading and prose', async () => {
    const document = written();
    const { container } = await openAnalysis({ recommendations: document });
    const generated = document.writeUp ?? [];

    // The fixture's third recommendation rests on a session our automation broke, so the
    // generator makes four claims and the screen publishes three of them.
    expect(generated).toHaveLength(4);
    const rendered = claimsOn(container);
    expect(rendered).toHaveLength(3);

    const published = generated.filter((claim) => claim.heading !== CLAIM_ON_OUR_BREAKAGE);
    rendered.forEach((element, position) => {
      const claim = published[position];
      if (claim === undefined) throw new Error('more claims on screen than were generated');
      expect(element.querySelector('h2')?.textContent).toBe(claim.heading);
      expect(claimWords(element)).toContain(claim.body);
    });
  });

  it('writes no sentence of its own: nothing on the screen the generator did not produce', async () => {
    const document = written();
    const { container } = await openAnalysis({ recommendations: document });
    const generated = document.writeUp ?? [];

    for (const element of claimsOn(container)) {
      const heading = element.querySelector('h2')?.textContent ?? '';
      const paragraph = element.querySelector('p.lede')?.textContent ?? '';
      expect(generated.some((claim) => claim.heading === heading)).toBe(true);
      expect(generated.some((claim) => claim.body === paragraph)).toBe(true);
    }
  });

  it('reads the whole write-up at the prose measure of the prototype’s narrow column', async () => {
    const { container } = await openAnalysis();

    const column = container.querySelector('[data-screen="analysis"] > .wrap-narrow');
    expect(column).not.toBeNull();
    expect(column?.querySelector('[data-section="write-up"]')).not.toBeNull();
    // The card is the `.card.card-lg` the prototype draws the write-up in.
    const card = part(container, 'write-up');
    expect(card.classList.contains('card')).toBe(true);
    expect(card.classList.contains('card-lg')).toBe(true);
  });
});

describe('the provenance line', () => {
  it('states how much was read, how it was drawn, what the aggregate is of, when, and by what', async () => {
    const { container } = await openAnalysis();
    const line = part(container, 'provenance').textContent ?? '';

    expect(line).toContain('Read 20 of 22 sessions');
    // The sampler's own stored phrase, printed and never parsed (the owner's decision 86).
    expect(line).toContain('stratified by outcome, then segment');
    expect(line).toContain('the aggregate of all 22');
    // `3 Nov 09:41`, in the reader's own time zone, from the aggregate's `computedAt`.
    expect(line).toMatch(/\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}/u);
    expect(line).toContain('muse-wonder');
  });

  it('is read from the files: it moves when the stored figures move', async () => {
    const aggregate = finishedAggregate();
    const { container } = await openAnalysis({
      aggregate,
      recommendations: written(
        { sample: { read: 7, of: 22, strategy: 'every session of the run', seed: 3 } },
        aggregate,
      ),
    });

    const line = part(container, 'provenance').textContent ?? '';
    expect(line).toContain('Read 7 of 22 sessions');
    expect(line).toContain('every session of the run');
  });

  it('keeps the write-up when the aggregate cannot be read, and goes without its clauses', async () => {
    // The write-up is this screen; a corrupt `aggregate.json` is reported on the screens
    // whose subject it is, and here it costs the two clauses it carries and nothing else.
    const { container } = await openAnalysis({
      aggregate: null,
      recommendations: written({}, finishedAggregate()),
      files: { [url.aggregate]: '{ "runId": ' },
    });

    expect(claimsOn(container)).toHaveLength(3);
    const line = part(container, 'provenance').textContent ?? '';
    expect(line).toContain('Read 20 of 22 sessions');
    expect(line).not.toContain('the aggregate of all');
    expect(container.querySelector('[data-part="excluded-footnote"]')).toBeNull();
  });

  it('leaves out what no file carries rather than inventing it', async () => {
    // A run with no aggregate: the two clauses that come from it go, and the line still
    // states what was read and by what.
    const { container } = await openAnalysis({
      aggregate: null,
      recommendations: written({}, finishedAggregate()),
    });

    const line = part(container, 'provenance').textContent ?? '';
    expect(line).toContain('Read 20 of 22 sessions');
    expect(line).not.toContain('the aggregate of all');
    expect(line).not.toMatch(/\d{2}:\d{2}/u);
    expect(line).toContain('muse-wonder');
  });
});

describe('every claim carries its citations as links', () => {
  it('renders one link per citation, and the simulated chip that is not one', async () => {
    const document = written();
    const { container } = await openAnalysis({ recommendations: document });
    const generated = (document.writeUp ?? []).filter(
      (claim) => claim.heading !== CLAIM_ON_OUR_BREAKAGE,
    );

    claimsOn(container).forEach((element, position) => {
      const claim = generated[position];
      if (claim === undefined) throw new Error('more claims on screen than were generated');
      const cites = element.querySelector('[data-part="cites"]');
      expect(cites?.querySelectorAll('a')).toHaveLength(claim.citations.length);
      expect([...(cites?.querySelectorAll('span') ?? [])].map((chip) => chip.textContent)).toEqual([
        'simulated',
      ]);
    });
  });

  it('opens a session citation on the replay, paused on the second it names', async () => {
    const { container } = await openAnalysis();

    const hrefs = hrefsOn(container);
    // `S-17 · 0:48` — the contract stores 48 000 ms and the replay opens on the second.
    expect(hrefs).toContain(sessionAtSecond(RUN_ID, 'S-17', 48));
    expect(hrefs).toContain(sessionAtSecond(RUN_ID, 'S-18', 19.5));
    expect(
      [...container.querySelectorAll('[data-part="cites"] a')].map((link) => link.textContent),
    ).toContain('S-17 · 0:48');
  });

  it('opens a heatmap citation on that version, step, area and overlay', async () => {
    const { container } = await openAnalysis();

    const hrefs = hrefsOn(container);
    expect(hrefs).toContain(
      heatmapLink(RUN_ID, 'A', 'review', { aoi: 'A-review-summary', overlay: 'attention' }),
    );
    // A region that is the whole step carries no area, and the link carries none either.
    expect(hrefs).toContain(heatmapLink(RUN_ID, 'A', 'review', { overlay: 'attention' }));
  });

  it('opens a funnel citation on the funnel at that step', async () => {
    const { container } = await openAnalysis();

    expect(hrefsOn(container)).toContain(funnelLink(RUN_ID, { step: 'review' }));
  });

  it('parses no sentence to find a link: a session the prose names and the citations do not', async () => {
    const { container } = await openAnalysis();

    // The claim's own heading names S-07, which none of its citations carry.
    expect(part(container, 'write-up').textContent).toContain(UNCITED_SESSION);
    for (const href of hrefsOn(container)) {
      expect(href, href).not.toContain(UNCITED_SESSION);
    }
  });
});

describe('a claim a reader could not check is not published', () => {
  it('holds back a claim resting on an excluded automation-failure session', async () => {
    // `docs/FLOW.md` section 11: an automation failure is our own, is excluded from every
    // figure, and no claim rests on one — a claim whose every cited person is one of them is
    // a claim about our harness and not about the site.
    const document = written();
    const { container } = await openAnalysis({ recommendations: document });

    const onOurBreakage = (document.writeUp ?? []).find(
      (claim) => claim.heading === CLAIM_ON_OUR_BREAKAGE,
    );
    expect(onOurBreakage?.citations).toEqual([
      { kind: 'session', sessionId: OUR_BREAKAGE[0], offsetMs: 12_000 },
    ]);

    expect(part(container, 'write-up').textContent).not.toContain(CLAIM_ON_OUR_BREAKAGE);
    for (const href of hrefsOn(container)) {
      expect(href, href).not.toContain(OUR_BREAKAGE[0]);
    }
  });

  it('publishes a claim that cites an excluded session beside people the run measured', () => {
    // One excluded session among several is not a claim resting on our breakage: the
    // excluded person is simply not one of the people the claim is about, which is the
    // reading `validateRecommendations` spells out.
    const ours = new Set<string>(OUR_BREAKAGE);
    const claim = {
      heading: 'A claim about people the run measured.',
      body: 'Eight of them left on the review step.',
      citations: [
        { kind: 'session' as const, sessionId: OUR_BREAKAGE[0], offsetMs: 1_000 },
        { kind: 'session' as const, sessionId: 'S-17', offsetMs: 2_000 },
      ],
    };

    expect(publishable(claim, ours)).toBe(true);
    expect(publishable({ ...claim, citations: [claim.citations[0]!] }, ours)).toBe(false);
  });

  it('does not render a claim with nothing to cite, and the file carrying one is refused', async () => {
    const HEADING = 'A claim with nothing behind it.';
    expect(publishable({ heading: HEADING, body: 'No evidence.', citations: [] }, new Set())).toBe(
      false,
    );

    // The contract refuses such a document — a claim carries its evidence or is not
    // published — so a file with one in it never reaches the write-up at all: it is a broken
    // run, and the screen says which file and what is wrong with it.
    const { container } = await openAnalysis({
      recommendations: JSON.stringify({
        ...written(),
        writeUp: [{ heading: HEADING, body: 'No evidence.', citations: [] }],
      }),
    });

    expect(container.textContent).not.toContain(HEADING);
    expect(screen.getByRole('heading', { name: 'That test could not be read' })).toBeTruthy();
    expect(container.textContent).toContain(url.recommendations);
  });
});

describe('what I did not find', () => {
  it('is the last claim of the write-up, cited like the others', async () => {
    const { container } = await openAnalysis();

    const last = claimsOn(container).at(-1);
    expect(last?.querySelector('h2')?.textContent).toBe('What I did not find');
    expect(last?.querySelectorAll('[data-part="cites"] a').length).toBeGreaterThan(0);
  });

  it('says that nothing here says what real customers would do', async () => {
    const { container } = await openAnalysis();

    const last = claimWords(claimsOn(container).at(-1) as HTMLElement);
    expect(last).toContain('simulated people generated from the audience you described');
    expect(last).toContain('nothing here says what real customers would do');
    expect(last).toContain(seedRun().audience.name);
  });
});

describe('the closing footnote and the simulated line', () => {
  it('states our own breakage with its count, and that no claim rests on one', async () => {
    const { container } = await openAnalysis();

    expect(part(container, 'excluded-footnote').textContent).toBe(
      'Automation failures — 2 of the 24 — are excluded from every number above, and no claim rests on one.',
    );
  });

  it('states none for a run that excluded nobody, rather than a zero', async () => {
    const aggregate = finishedAggregate({ excludedAutomationFailures: 0 });
    const { container } = await openAnalysis({
      aggregate,
      recommendations: written({}, aggregate),
    });

    expect(container.querySelector('[data-part="excluded-footnote"]')).toBeNull();
    expect(part(container, 'write-up').textContent).not.toContain('Automation failures');
  });

  it('ends with the simulated line, and implies no conversion lift', async () => {
    const { container } = await openAnalysis();

    const line = part(container, 'simulated-disclaimer');
    expect(line.textContent).toContain('simulated');
    expect(line.textContent).toContain('not a conversion-lift estimate');
    // The one mention of a lift on the screen is the one that denies it.
    expect((container.textContent ?? '').match(/lift/gu)).toEqual(['lift']);
  });
});

describe('the states of the screen', () => {
  it('keeps the stated card for a run that recorded no analysis', async () => {
    const { container } = await openAnalysis({ recommendations: null });

    const card = part(container, 'no-analysis');
    expect(card.textContent).toContain('This test did not record an analysis.');
    expect(container.querySelector('[data-section="write-up"]')).toBeNull();
    // Never a zero and never an empty write-up.
    expect(card.textContent).not.toMatch(/\d/u);
  });

  it('states a file with no write-up as what it is, with the way on to what it has', async () => {
    const { container } = await openAnalysis({ recommendations: baseDocument() });

    const card = part(container, 'no-write-up');
    expect(card.textContent).toContain('This test records no write-up.');
    expect(card.textContent).toContain('a claim with nothing to cite is not published');
    const hrefs = [...card.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(paths.run(RUN_ID));
    expect(hrefs).toContain(paths.sessions(RUN_ID));
  });

  it('stands the stored reason in place of the claims for a run that recommended nothing', async () => {
    // The owner's decision 147: the reason, and the "What I did not find" claim under it.
    const aggregate = finishedAggregate();
    const document = written(
      {
        recommendations: [],
        nothingToRecommend: 'Nothing these people did pointed at a change worth making.',
      },
      aggregate,
    );
    const { container } = await openAnalysis({ aggregate, recommendations: document });

    expect(document.writeUp).toHaveLength(1);
    expect(part(container, 'nothing-to-recommend').textContent).toBe(
      'Nothing these people did pointed at a change worth making.',
    );
    const claims = claimsOn(container);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.querySelector('h2')?.textContent).toBe('What I did not find');
  });

  it('holds the card’s height while the files are read, and the header is already there', async () => {
    await serveRunData({
      files: { [url.recommendations]: JSON.stringify(written()) },
    });
    const { container } = mountApp(paths.analysis(RUN_ID));

    expect(
      screen.getByRole('heading', { level: 1, name: 'What Muse Wonder makes of it' }),
    ).toBeTruthy();
    const holding = container.querySelector('[data-analysis="loading"]');
    expect(holding).not.toBeNull();
    expect(holding?.getAttribute('aria-busy')).toBe('true');
    expect(holding?.classList.contains('card')).toBe(true);
  });

  it('falls to the run-not-found screen for a run it cannot find', async () => {
    await serveRunData();
    mountApp(paths.analysis('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(document.querySelector('[data-section="write-up"]')).toBeNull();
  });
});

describe('the screen as a whole', () => {
  it('is clean under axe over the whole write-up', async () => {
    const { container } = await openAnalysis();

    const violations = await axeViolations(
      part(container, 'write-up').closest('div.strip') ?? container,
    );
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('reaches every citation by keyboard, in page order', async () => {
    const user = userEvent.setup();
    const { container } = await openAnalysis();

    const controls = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-screen="analysis"] a[href], [data-screen="analysis"] button:not([disabled])',
      ),
    ];
    expect(controls.length).toBeGreaterThan(0);

    // Focus starts above the screen, in the chrome, so the walk is of this screen's own
    // controls from the first of them.
    controls[0]?.focus();
    const stops: Element[] = [controls[0] as Element];
    while (stops.length < controls.length) {
      await user.tab();
      stops.push(document.activeElement as Element);
    }
    expect(stops).toEqual(controls);
  });

  it('never takes a focus ring away without putting one back', async () => {
    const { container } = await openAnalysis();

    for (const control of container.querySelectorAll<HTMLElement>('a[href], button')) {
      const classes = control.getAttribute('class') ?? '';
      if (!classes.includes('outline-none')) continue;
      expect(classes, control.outerHTML).toMatch(/focus-visible:ring-/u);
    }

    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--color-focus').trim(),
    ).not.toBe('');
  });

  it('scrolls vertically only: nothing on it is given a width a phone cannot honour', () => {
    const fixed = ['width', 'min-width', 'min-inline-size', 'inline-size'];

    for (const rule of rulesOf(stylesheet('screens/analysis/analysis.module.css'))) {
      for (const [property, value] of Object.entries(rule.declarations)) {
        const where = `${rule.selector} ${property}: ${value}`;
        if (property === 'overflow-x') expect(['auto', 'scroll'], where).not.toContain(value);
        if (fixed.includes(property)) expect(value, where).not.toMatch(/\d\s*px/u);
      }
    }
  });

  it('wraps a claim’s citations rather than squashing them', () => {
    const rules = rulesOf(stylesheet('screens/analysis/analysis.module.css'));
    const cites = rules.find((rule) => rule.selector === '.cites' && rule.condition === '');

    expect(cites?.declarations['flex-wrap']).toBe('wrap');
  });

  it('restates no visual value: every colour and every length is a token', () => {
    const body = stylesheet('screens/analysis/analysis.module.css')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/@media[^{]*/gu, '');

    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(body).not.toMatch(/\brgba?\(/iu);
    expect(body).not.toMatch(/\d\s*(px|rem|em)\b/iu);
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('is complete and still', async () => {
    prefersReducedMotion(true);
    const { container } = await openAnalysis();

    expect(claimsOn(container)).toHaveLength(3);
    expect(part(container, 'provenance').textContent).toContain('Read 20 of 22 sessions');
    expectNothingInMotion(container);
  });

  it('animates nothing in its stylesheet at all', () => {
    for (const sheet of styleSheetsUnder('analysis')) {
      const source = readFileSync(sheet, 'utf8');
      expect(source, sheet).not.toMatch(/\banimation\b/u);
      expect(source, sheet).not.toMatch(/@keyframes/u);
      expect(source, sheet).not.toMatch(/\btransition\b/u);
    }
  });
});

describe('the write-up is the generator’s, not this screen’s', () => {
  it('is the same claims the pipeline would have written for the same file', () => {
    const document = baseDocument();
    const once = generatedWriteUp(document);
    const again = generatedWriteUp(document);

    expect(again).toEqual(once);
    expect(once.map((claim) => claim.heading)).toEqual([
      'The fee is what loses people on the review step, and S-07 is not one of them.',
      'Three people believed the order was placed when it was not.',
      CLAIM_ON_OUR_BREAKAGE,
      'What I did not find',
    ]);
  });
});
