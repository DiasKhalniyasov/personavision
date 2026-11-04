// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recommendationsSchema } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, serveRunData } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { rulesOf } from '../cssom';
import { paths, sessionAtSecond } from '../../src/shell/paths';
import {
  SEED,
  completedCount,
  oneVersionAggregate,
  oneVersionRun,
  openSummary,
  recommendations,
  seedRun,
  sections,
  slot,
  url,
  wholeRunSlice,
  withAutomationFailures,
  words,
} from './fixture';

/**
 * The Summary — the lead screen of a hundred-agent test, at `/runs/:runId`.
 *
 * `#screen-results` of `docs/design/prototype.html` and section 14.1 of `docs/FLOW.md`:
 * *what should I change, and how did my audience do?* Somebody who reads only this screen
 * has the answer.
 *
 * What this suite is here to hold:
 *
 * - **the branch is on the run, not on a "path".** One version leads with the
 *   recommendations and the three headline figures; two leads with the Verdict's own
 *   components, mounted — asserted by which component files rendered — with the
 *   recommendations under them. One route, and no flag in the URL either way.
 * - **no figure is computed on the screen.** Every figure is a field of `aggregate.json`,
 *   asserted by moving the fixture's aggregate and watching the rendered figure move with
 *   it. A browser that re-aggregated a hundred sessions could disagree with the summary.
 * - **every evidence link is built from structured fields.** A citation names a session and
 *   a moment, a heatmap region, or a funnel step, and each becomes the URL the product's own
 *   builders make of those fields. No sentence is parsed to find a link.
 * - **the exclusion is stated, not buried.** The count our own automation lost, said above
 *   the reader's own figures, and in none of them.
 * - **it stays quiet**, is reachable by keyboard, passes axe, holds at 390 px and is
 *   complete and still under `prefers-reduced-motion: reduce`.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** One of the app's own stylesheets, read as source — jsdom applies none of them. */
const stylesheet = (path: string): string => readFileSync(join(here, '../../src', path), 'utf8');

/** Every stylesheet one screen's directory holds. */
const styleSheetsUnder = (screen: string): string[] =>
  readdirSync(join(here, '../../src/screens', screen))
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => join(here, '../../src/screens', screen, entry));

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

/** The links of one section, as `[text, href]` pairs in page order. */
const links = (container: HTMLElement, section: string): [string, string][] =>
  [...slot(container, section).querySelectorAll('a')].map((link) => [
    link.textContent ?? '',
    link.getAttribute('href') ?? '',
  ]);

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the screen branches on the run', () => {
  it('leads a one-version run with the recommendations and the three headline figures', async () => {
    const { container } = await openSummary();

    expect(sections(container)).toEqual([
      'workspace-name',
      'test-picker',
      'simulated-badge',
      'account-menu',
      'audience-line',
      'headline',
      'headline-figures',
      'excluded-banner',
      'recommendations',
      'summary-doors',
      'simulated-disclaimer',
    ]);

    // Three figures, each with its own label and population, in the prototype's order.
    const figures = slot(container, 'headline-figures').querySelectorAll('figure');
    expect(figures).toHaveLength(3);
    expect(
      [...figures].map((figure) => figure.querySelector('.figure-label')?.textContent),
    ).toEqual(['Completed', 'Median time to complete', 'Dropped out on the Review step']);
  });

  it('leads a two-version run with the Verdict’s own components, mounted', async () => {
    const { container } = await openSummary({ run: seedRun() });

    // The slots are the component files': a lead rewritten here rather than mounted would
    // not draw them. The Verdict's composition, unchanged, with what to change under it.
    expect(sections(container)).toEqual([
      'workspace-name',
      'test-picker',
      'simulated-badge',
      'account-menu',
      'audience-line',
      'excluded-banner',
      'headline',
      'completion-figures',
      'reasons',
      'hero-evidence',
      'headline-findings',
      'recommendations',
      'detail-doors',
      'simulated-disclaimer',
    ]);

    // And it is the before/after comparison, not the one-version summary: two completion
    // figures, and none of the aggregate's three.
    expect(container.querySelector('[data-section="headline-figures"]')).toBeNull();
    expect(words(container, 'completion-figures')).toContain('Current checkout');
    expect(words(container, 'completion-figures')).toContain('Redesign candidate');
  });

  it('resolves both shapes at /runs/:runId, with no second route and no flag in the URL', async () => {
    const one = await openSummary();
    expect(one.router.state.location.pathname).toBe(paths.run(SEED));
    expect(one.router.state.location.search).toBe('');
    forgetRuns();

    const two = await openSummary({ run: seedRun() });
    expect(two.router.state.location.pathname).toBe(paths.run(SEED));
    expect(two.router.state.location.search).toBe('');
    // One pattern mounts this screen, and the route table holds no second lead.
    expect(
      two.router.routes.flatMap((route) => route.children ?? []).map((route) => route.path),
    ).not.toContain('/runs/:runId/summary');
  });
});

describe('every figure is a field of the stored aggregate', () => {
  it('reads the completion share, the median time and the top failure point off it', async () => {
    const { aggregate, container } = await openSummary();
    if (aggregate === null) throw new Error('this fixture serves an aggregate');
    const slice = wholeRunSlice(aggregate);
    const figures = words(container, 'headline-figures');

    const completed = completedCount(aggregate);
    expect(completed).toBe(11);
    expect(figures).toContain('50%');
    expect(figures).toContain(`${String(completed)} of ${String(aggregate.scoredSessionCount)}`);
    // 35_200 ms, as the aggregate stores the median of the whole run's session durations.
    expect(slice.timing.total.p50Ms).toBe(35_200);
    expect(figures).toContain('0:35');
    // The top failure point: the step that lost the most people, and how many it lost.
    expect(slice.biggestDrop?.step).toBe('review');
    expect(figures).toContain('7');
    expect(figures).toContain('of the 18 who got there');
  });

  it('moves when the aggregate moves, so nothing is counted in the browser', async () => {
    const aggregate = oneVersionAggregate();
    const slice = wholeRunSlice(aggregate);
    // The same sessions, aggregated differently: a slower median, and a drop on another step.
    const slower = {
      sampleCount: 22,
      p25Ms: 60_000,
      p50Ms: 72_000,
      p75Ms: 84_000,
      p90Ms: 96_000,
      binWidthMs: 10_000,
      bins: [0, 0, 0, 0, 0, 0, 5, 6, 5, 4, 2, 0],
      medianBin: 7,
    };
    const moved = oneVersionAggregate({
      funnelSlices: aggregate.funnelSlices.map((candidate) =>
        candidate.key === slice.key
          ? {
              ...candidate,
              biggestDrop: {
                step: 'payment',
                left: 14,
                ofReached: 19,
                reason: 'left while the card was being entered',
              },
              timing: { ...slice.timing, total: slower },
            }
          : candidate,
      ),
    });

    const { container } = await openSummary({ aggregate: moved });
    const figures = words(container, 'headline-figures');

    expect(figures).toContain('1:12');
    expect(figures).toContain('14');
    expect(figures).toContain('of the 19 who got there');
    expect(figures).toContain('Dropped out on the Payment step');
  });

  it('shows no figure at all for a run that computed no aggregate', async () => {
    const { container } = await openSummary({ aggregate: null });

    // Never a zero: a run with no aggregate measured nothing, and the figures are absent
    // rather than rendered empty.
    expect(container.querySelector('[data-section="headline-figures"]')).toBeNull();
    expect(container.querySelector('[data-section="excluded-banner"]')).toBeNull();
    // The hero and the recommendations are still the run's own.
    expect(words(container, 'headline')).toContain('Your audience completes the purchase');
    expect(words(container, 'recommendations')).toContain('What to change, in order');
  });
});

describe('what to change, in order', () => {
  it('renders each recommendation’s rank, its one sentence and the reason under it', async () => {
    const { container, recommendations: recommended } = await openSummary();
    if (typeof recommended === 'string' || recommended === null) {
      throw new Error('this fixture serves parsed recommendations');
    }
    const recs = [...slot(container, 'recommendations').querySelectorAll('[data-part="rec"]')];

    expect(recs).toHaveLength(recommended.recommendations.length);
    recs.forEach((rec, position) => {
      const recommendation = recommended.recommendations[position];
      if (recommendation === undefined) throw new Error('more rendered than stored');
      expect(rec.getAttribute('data-rank')).toBe(String(recommendation.rank));
      expect(rec.querySelector('h3')?.textContent).toBe(recommendation.sentence);
      expect(rec.textContent).toContain(recommendation.evidence);
    });

    // The provenance line is the file's own sample, not a number this screen invented.
    expect(words(container, 'recommendations')).toContain(
      `from the aggregate and ${String(recommended.sample.read)} of the sessions`,
    );
  });

  it('renders one link per citation, each URL built from the citation’s own fields', async () => {
    const { container, recommendations: recommended } = await openSummary();
    if (typeof recommended === 'string' || recommended === null) {
      throw new Error('this fixture serves parsed recommendations');
    }
    const recs = [...slot(container, 'recommendations').querySelectorAll('[data-part="rec"]')];

    recs.forEach((rec, position) => {
      const recommendation = recommended.recommendations[position];
      if (recommendation === undefined) throw new Error('more rendered than stored');
      const cited = [...rec.querySelectorAll('[data-part="cites"] a')];
      expect(cited, recommendation.id).toHaveLength(recommendation.citations.length);
      // And the closing chip is the word *simulated*, which is not a link.
      expect(rec.querySelector('[data-part="cites"]')?.textContent).toContain('simulated');
    });
  });

  it('links a session citation to that person’s replay, paused on the second cited', async () => {
    const { container } = await openSummary();
    const cited = links(container, 'recommendations');

    // S-17 at 48_000 ms: the replay at 48 seconds, as `?t=` means them.
    expect(cited).toContainEqual(['S-17 · 0:48', sessionAtSecond(SEED, 'S-17', 48)]);
    expect(cited).toContainEqual(['S-18 · 0:19', sessionAtSecond(SEED, 'S-18', 19.5)]);
  });

  it('links a heatmap citation to that version, step, area and overlay', async () => {
    const { container } = await openSummary();
    const cited = links(container, 'recommendations');

    expect(cited).toContainEqual([
      'heatmap · Review · Order summary',
      `/runs/${SEED}/attention/A/review?aoi=A-review-summary&overlay=attention`,
    ]);
    // A region with no area is the whole step, and says so by naming only the step.
    expect(cited).toContainEqual([
      'heatmap · Review',
      `/runs/${SEED}/attention/A/review?overlay=attention`,
    ]);
  });

  it('links a funnel citation to the funnel at that step', async () => {
    const { container } = await openSummary();
    const cited = links(container, 'recommendations');

    expect(cited).toContainEqual(['funnel · Review', `/runs/${SEED}/funnel?step=review`]);
    expect(cited).toContainEqual(['funnel · Payment', `/runs/${SEED}/funnel?step=payment`]);
  });

  it('offers the full write-up under the list', async () => {
    const { container } = await openSummary();

    expect(links(container, 'recommendations')).toContainEqual([
      'Read the full analysis',
      paths.analysis(SEED),
    ]);
  });

  it('never renders a recommendation with nothing to cite', async () => {
    // Why: a claim is published with the evidence it rests on or not at all
    // (`docs/FLOW.md` section 14). The contract refuses such a file outright — so it cannot
    // reach the screen as data — and the screen drops the entry as well, for a file written
    // by an older pipeline. Both halves are asserted, because either alone would let a
    // sentence a reader cannot check onto the lead screen.
    const uncited = {
      ...recommendations(),
      recommendations: [
        {
          id: 'R-0',
          rank: 1,
          sentence: 'Trust me on this one.',
          evidence: 'Nothing to see.',
          findingIds: ['F-1'],
          citations: [],
          peopleAffected: 9,
          step: 'review',
        },
      ],
    };

    const refused = recommendationsSchema.safeParse(uncited);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message).join(' ')).toContain(
      'a claim carries its evidence as citations',
    );

    const { container } = await openSummary({ recommendations: JSON.stringify(uncited) });

    expect(container.textContent).not.toContain('Trust me on this one.');
    expect(words(container, 'recommendations')).toContain('could not be read');
  });

  it('states the absence for a run that recommends nothing, and never a zero', async () => {
    const { container } = await openSummary({ recommendations: null });
    const said = words(container, 'recommendations');

    expect(said).toContain('nothing recorded');
    expect(said).toContain('This test recommends nothing to change.');
    expect(said).not.toContain('0');
    // The figures are still shown: the aggregate has them, and they are not what is missing.
    expect(words(container, 'headline-figures')).toContain('Completed');
  });

  it('is that card alone for a run with neither an aggregate nor a recommendation', async () => {
    const { container } = await openSummary({ aggregate: null, recommendations: null });

    expect(container.querySelector('[data-section="headline-figures"]')).toBeNull();
    expect(words(container, 'recommendations')).toContain(
      'This test recommends nothing to change.',
    );
    expect(container.querySelectorAll('[data-section="recommendations"]')).toHaveLength(1);
  });

  it('prints the pipeline’s own reason where the file states one', async () => {
    const why = 'Every person completed the task on the first attempt, so there is nothing to fix.';
    const { container } = await openSummary({
      recommendations: recommendations({ recommendations: [], nothingToRecommend: why }),
    });

    expect(words(container, 'recommendations')).toContain(why);
  });
});

describe('the people our own automation lost', () => {
  it('states the count, says it was ours and not the site, and links to them', async () => {
    const { aggregate, container, run } = await openSummary();
    if (aggregate === null) throw new Error('this fixture serves an aggregate');
    const banner = words(container, 'excluded-banner');

    expect(banner).toContain('2 of 24 sessions were our own automation failing');
    expect(banner).toContain('not your site');
    expect(banner).toContain(
      'excluded from every figure on this page and from every recommendation',
    );
    expect(links(container, 'excluded-banner')).toEqual([
      ['See them', `/runs/${SEED}/sessions?outcome=automation_failure`],
    ]);

    // The count and the scored count are the two the figures were computed from, and they
    // add up to the run's own sessions.
    expect(aggregate.excludedAutomationFailures + aggregate.scoredSessionCount).toBe(
      run.sessionIds.length,
    );
  });

  it('keeps every one of them out of every figure and every recommendation', async () => {
    const { aggregate, container, run } = await openSummary();
    if (aggregate === null) throw new Error('this fixture serves an aggregate');

    // The two excluded sessions would move the completion share if they were counted: 11 of
    // 22 is 50%, 11 of 24 is 46%, and the aggregate's own denominator is the scored one.
    expect(run.sessionIds).toHaveLength(24);
    expect(aggregate.scoredSessionCount).toBe(22);
    const figures = words(container, 'headline-figures');
    expect(figures).toContain('50%');
    expect(figures).not.toContain('46%');
    expect(figures).toContain('of 22');

    // And no recommendation cites one of them.
    for (const excluded of ['S-09', 'S-23']) {
      expect(words(container, 'recommendations'), excluded).not.toContain(excluded);
    }
  });

  it('renders no banner for a run that excluded nobody', async () => {
    const { container } = await openSummary({
      aggregate: oneVersionAggregate({ excludedAutomationFailures: 0 }),
    });

    expect(container.querySelector('[data-section="excluded-banner"]')).toBeNull();
  });

  it('says so above the summary when more than a fifth of the sessions were ours', async () => {
    // Six of twenty-four finished sessions, which is a quarter: past the fifth the contract
    // declares, and the fraction itself is read from `@personavision/contract`.
    const { container } = await openSummary({
      run: withAutomationFailures(oneVersionRun(), 6),
    });
    const notice = words(container, 'harness-notice');

    expect(notice).toContain('More than a fifth');
    expect(notice).toContain('our own automation failing');
    // Above the summary: before the audience bar, the sentence and the figures.
    expect(sections(container).indexOf('harness-notice')).toBeLessThan(
      sections(container).indexOf('headline'),
    );
  });

  it('says nothing of the sort on a run under that share', async () => {
    const { container } = await openSummary();

    expect(container.querySelector('[data-section="harness-notice"]')).toBeNull();
  });
});

describe('the screen is quiet, and labelled', () => {
  it('embeds no heatmap, no table, no chart, no session list and no score', async () => {
    const { container } = await openSummary();

    const moved = {
      'a heatmap': '[data-overlay-layer="heat"], [data-section="hero-evidence"]',
      'the areas-of-interest table': '[data-section="areas-of-interest"]',
      'the scanpath layer': '[data-overlay-layer="scan"]',
      'the friction score and its four components': '[data-section="score-cards"]',
      'outcomes by audience segment': '[data-section="segments"]',
      'the full findings list': '[data-section="all-findings"]',
      'the people table': '[aria-label="The people in this test"]',
      'any table at all': 'table',
    };

    for (const [what, selector] of Object.entries(moved)) {
      expect(container.querySelectorAll(selector), what).toHaveLength(0);
    }
  });

  it('offers the four doors to the evidence', async () => {
    const { container } = await openSummary();
    const doors = slot(container, 'summary-doors');

    expect(doors.querySelectorAll('a')).toHaveLength(4);
    expect([...doors.querySelectorAll('h3')].map((door) => door.textContent)).toEqual([
      'Sessions',
      'Heatmaps',
      'Funnel and timing',
      'Improve my site',
    ]);
    expect(doors.textContent).toContain('24 videos');
  });

  it('ends on the simulated line, naming the audience, implying no conversion lift', async () => {
    const { container, run } = await openSummary();
    const drawn = sections(container);

    expect(drawn.at(-1)).toBe('simulated-disclaimer');
    const closing = words(container, 'simulated-disclaimer');
    expect(closing).toContain('simulated');
    expect(closing).toContain(run.audience.name);
    expect(closing).toContain('not a conversion-lift estimate');
    // A one-version run compares nothing, so the line does not claim it ranks two versions.
    expect(closing).toContain('It ranks what to fix for these people');
    expect(closing).not.toContain('your two versions');
    // The only mention of a lift anywhere on the screen is the line that denies one.
    const anywhere = (container.textContent ?? '').match(/lift/gu) ?? [];
    expect(anywhere).toHaveLength((closing.match(/lift/gu) ?? []).length);
  });

  it('names the feature that was tested under the sentence the pipeline wrote', async () => {
    const feature = 'checking out with a saved card';
    const { container } = await openSummary({ run: oneVersionRun({ feature }) });
    const hero = words(container, 'headline');

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(hero).toContain('Your audience completes the purchase');
    expect(hero).toContain(`Feature tested: “${feature}”`);
  });
});

describe('the states of the screen', () => {
  it('holds the hero and the figure row while the run is read, so the page does not jump', async () => {
    await serveRunData({
      files: {
        [url.run]: JSON.stringify(oneVersionRun()),
        [url.aggregate]: JSON.stringify(oneVersionAggregate()),
        [url.recommendations]: JSON.stringify(recommendations()),
      },
    });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(container.querySelector('[data-section="audience-line"]')).not.toBeNull();
    });
    // From the paint the run resolves on, every slot is on the page — the figures and the
    // recommendations holding their heights — so the two slower files fill a space that is
    // already there rather than pushing the screen around as they land.
    // The hero, the figure row, what to change, the doors and the closing line are all on
    // the page from that paint, the two middle ones holding their heights, and they are in
    // the same order once the files land. The banner is the one block that cannot be
    // reserved: whether a run excluded anybody is what the aggregate answers.
    const held = ['headline', 'headline-figures', 'recommendations', 'summary-doors'];
    const order = (drawn: (string | null)[]): (string | null)[] =>
      drawn.filter((name) => name !== null && held.includes(name));
    const resolved = order(sections(container));
    expect(resolved).toEqual(held);

    await waitFor(() => {
      expect(words(container, 'recommendations')).toContain('What to change, in order');
    });
    expect(order(sections(container))).toEqual(resolved);
  });

  it('falls to the run-not-found screen for a run directory that cannot be read', async () => {
    await serveRunData({ files: { [url.run]: 'not json at all' } });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).toBeNull();
    });
    expect(container.textContent).toContain('could not be read');
    expect(container.textContent).toContain(url.run);
  });
});

describe('to a screen reader, a keyboard and a narrow window', () => {
  it('reports no axe violation', async () => {
    const { container } = await openSummary();

    const violations = await axeViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('reaches every control in the order the page draws them', async () => {
    const { container } = await openSummary();
    const user = userEvent.setup();

    const controls = [
      ...container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    expect(controls.length).toBeGreaterThan(0);
    // The walk ends on the last door, past every citation above it.
    expect(controls.at(-1)?.textContent).toContain('Improve my site');

    const stops: Element[] = [];
    while (stops.length < controls.length) {
      await user.tab();
      stops.push(document.activeElement as Element);
    }

    expect(stops).toEqual(controls);
  });

  it('never takes a focus ring away without putting one back', async () => {
    const { container } = await openSummary();

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

    for (const rule of rulesOf(stylesheet('screens/summary/summary.module.css'))) {
      for (const [property, value] of Object.entries(rule.declarations)) {
        const where = `${rule.selector} ${property}: ${value}`;
        if (property === 'overflow-x') expect(['auto', 'scroll'], where).not.toContain(value);
        if (fixed.includes(property)) expect(value, where).not.toMatch(/\d\s*px/u);
      }
    }
  });

  it('wraps the recommendation’s citations rather than squashing them', () => {
    const rules = rulesOf(stylesheet('screens/summary/summary.module.css'));
    const cites = rules.find((rule) => rule.selector === '.cites' && rule.condition === '');

    expect(cites?.declarations['flex-wrap']).toBe('wrap');
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('is complete and still', async () => {
    prefersReducedMotion(true);
    const { aggregate, container } = await openSummary();
    if (aggregate === null) throw new Error('this fixture serves an aggregate');

    // The figures the reader is reading are the aggregate's own, at once: no ticker counting
    // up to them, and nothing left mid-animation.
    expect(words(container, 'headline-figures')).toContain('50%');
    expect(words(container, 'recommendations')).toContain('What to change, in order');
    expectNothingInMotion(container);
  });

  it('animates nothing in its stylesheet but a loading state', () => {
    for (const sheet of styleSheetsUnder('summary')) {
      for (const rule of rulesOf(readFileSync(sheet, 'utf8'))) {
        for (const [property, value] of Object.entries(rule.declarations)) {
          if (!property.startsWith('animation')) continue;
          expect(value, `${sheet} ${rule.selector} ${property}`).toContain('pv-pulse');
        }
      }
    }
  });
});
