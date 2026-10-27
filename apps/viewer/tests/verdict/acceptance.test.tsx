// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findingsSchema, runSchema } from '@personavision/contract';
import type { Findings, Run } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readFindingsFile, readRunFile, serveRunData } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { rulesOf, ruleIn } from '../cssom';
import { paths } from '../../src/shell/paths';

/**
 * The acceptance walk-through of the screen the demo ends on.
 *
 * Beats 2, 3, 4 and 7 of `docs/FLOW.md` section 7, driven over the committed example run
 * and asserted as a reader meets them: the audience the answer is about, the headline
 * sentence, the two completion figures with their populations, the reasons, the one heatmap
 * with its caption, the three findings with their evidence, the doors to the detail, the
 * header badge, and the closing line that every figure is simulated for this audience and
 * is not a conversion-lift estimate.
 *
 * It owns no section of the screen. The sections are #14's, #15's, #16's and #108's, and a
 * defect this walk-through finds is fixed in the section that owns it — what is here is
 * only what cannot be asserted until they are composed:
 *
 * - **that the screen is quiet.** No area-of-interest table, no scanpath, no component
 *   bars, no friction score, no session rows and exactly one heatmap. Every one of those
 *   was on this screen before the owner's direction and was deliberately moved one click
 *   deeper; without an assertion they drift back one well-meaning ticket at a time.
 * - an axe pass over the whole assembled screen rather than over a section of it;
 * - that the screen stacks rather than squashes below the prototype's breakpoint, and
 *   scrolls vertically only;
 * - that it is reachable and operable by keyboard from the chrome down to the last door;
 * - that it is still, under `prefers-reduced-motion: reduce`, and that no screen one click
 *   deeper animates at all.
 *
 * Everything numeric is read out of `run.json` and `findings.json` as the pipeline wrote
 * them, so the walk-through asserts the screen rather than a second copy of the artifact's
 * figures. The suite is offline: the harness serves the repository's own run directory over
 * a stubbed `fetch` and nothing here needs a key or a network.
 */

/** The committed example run. #78 replaces the artifact in place under the same schema. */
const SEED = '2026-10-24-1402-northwind-demo';

/** The run and the findings the demo ends on, parsed through `packages/contract`. */
const run: Run = runSchema.parse(readRunFile(SEED));
const findings: Findings = findingsSchema.parse(readFindingsFile(SEED));

/** The score of one version for this run's task, as the figures read it. */
const scoreOf = (variant: string) =>
  run.scores.find((score) => score.variant === variant && score.taskId === run.task.id);

const here = dirname(fileURLToPath(import.meta.url));

/** One of the app's own stylesheets, read as source — jsdom applies none of them. */
const stylesheet = (path: string): string => readFileSync(join(here, '../../src', path), 'utf8');

/** Every stylesheet one screen's directory holds, a nested one included. */
const styleSheetsUnder = (screen: string): string[] => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name))
        : entry.name.endsWith('.css')
          ? [join(directory, entry.name)]
          : [],
    );

  return walk(join(here, '../../src/screens', screen));
};

/** The design contract itself, which is where a breakpoint is declared. */
const prototype = (): string =>
  readFileSync(join(here, '../../../../docs/design/prototype.html'), 'utf8');

/** Every slot the screen draws, chrome included, in the order it draws them. */
const SLOTS = '[data-section], [data-shell]';

/** The three findings the verdict named, as cards on the page. */
const FINDING = '[data-section="headline-findings"] [data-sev]';

/** A section of the assembled screen, by the slot it declares. */
const slot = (container: HTMLElement, name: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(
    `[data-section="${name}"], [data-shell="${name}"]`,
  );
  if (element === null) throw new Error(`there is no ${name} on this screen`);
  return element;
};

/** What a slot says, with the line breaks of the markup closed up. */
const words = (container: HTMLElement, name: string): string =>
  (slot(container, name).textContent ?? '').replace(/\s+/gu, ' ');

/** The one heatmap, which #71's layer withholds until every session has arrived. */
const HEAT = '[data-overlay-layer="heat"]';

/**
 * The assembled screen, with every section's data resolved.
 *
 * Two beats arrive after the run file does and are the last to settle: the findings, which
 * are a second file, and the heat, which is an aggregate over every session — the layer
 * draws nothing while they are still arriving. Both on the page is what says the whole
 * screen is there.
 */
async function openVerdict(path: string = paths.run(SEED)) {
  const served = await serveRunData();
  const mounted = mountApp(path);

  await waitFor(() => {
    expect(mounted.container.querySelectorAll(FINDING)).toHaveLength(3);
    expect(mounted.container.querySelector(HEAT)).not.toBeNull();
  });

  return { ...mounted, ...served };
}

/** The elements these selectors name: one each, and in this order down the page. */
const inPageOrder = (container: HTMLElement, selectors: readonly string[]): void => {
  for (const selector of selectors) {
    expect(container.querySelectorAll(selector), selector).toHaveLength(1);
  }

  const drawn = [...container.querySelectorAll(selectors.join(', '))].map((element) =>
    selectors.find((selector) => element.matches(selector)),
  );

  expect(drawn).toEqual([...selectors]);
};

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

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the demo’s closing beats', () => {
  it('draws them in the order the screen draws them, and nothing between', async () => {
    const { container } = await openVerdict();

    // The badge is in the chrome, above the screen: every screen of a test carries it, so
    // it is the first of these and not — as the beat list reads it — the second to last.
    inPageOrder(container, [
      '[data-shell="simulated-badge"]',
      '[data-section="audience-line"]',
      '[data-section="excluded-banner"]',
      '[data-section="headline"]',
      '[data-section="completion-figures"]',
      '[data-section="reasons"]',
      '[data-section="hero-evidence"]',
      '[data-section="headline-findings"]',
      '[data-section="detail-doors"]',
      '[data-shell="simulated-disclaimer"]',
    ]);
  });

  it('names the audience the answer is true of, above the answer', async () => {
    const { container } = await openVerdict();
    const audience = words(container, 'audience-line');

    expect(audience).toContain(run.audience.name);
    expect(audience).toContain(
      `${String(run.audience.ageRange.min)}–${String(run.audience.ageRange.max)}`,
    );
    for (const region of run.audience.regions) expect(audience).toContain(region);
    expect(audience).toContain(`${String(run.personas.length)} simulated people`);
  });

  it('leads with the sentence the pipeline wrote, as the screen’s one heading of its rank', async () => {
    const { container } = await openVerdict();
    const headings = container.querySelectorAll('h1');

    expect(headings).toHaveLength(1);
    expect((headings[0] as HTMLElement).textContent).toBe(run.verdict.audienceSentence);
  });

  it('puts both figures under it, each as N in 10, a percentage and the people behind it', async () => {
    const { container } = await openVerdict();
    const figures = words(container, 'completion-figures');

    for (const variant of run.variants) {
      const score = scoreOf(variant.id);
      if (score === undefined) throw new Error(`the run carries no score for ${variant.id}`);
      const rate = score.completionRate;

      expect(figures, variant.id).toContain(variant.name);
      expect(figures, variant.id).toContain(`${String(Math.round(rate * 10))} in 10`);
      expect(figures, variant.id).toContain(`${String(Math.round(rate * 100))}%`);
      expect(figures, variant.id).toContain(
        `${String(score.outcomeCounts.success)} of ${String(score.scoredSessionCount)} people completed the task`,
      );
    }

    // And which of the two the reader should ship, said next to the figure rather than left
    // to be worked out from the two percentages.
    const preferred = run.variants.find((variant) => variant.id === run.verdict.preferredVariant);
    expect(preferred, 'the run names a preferred version').not.toBeUndefined();
    expect(figures).toContain('the one to ship');
  });

  it('gives the one or two reasons, in the pipeline’s words and no others', async () => {
    const { container } = await openVerdict();
    const reasons = words(container, 'reasons');

    expect(run.verdict.reasons.length).toBeLessThanOrEqual(2);
    for (const reason of run.verdict.reasons) expect(reasons).toContain(reason);
  });

  it('shows the one heatmap, in the one tinted band, captioned with what it is', async () => {
    const { container } = await openVerdict();
    const hero = run.verdict.heroEvidence;
    const evidence = words(container, 'hero-evidence');

    expect(container.querySelectorAll(HEAT)).toHaveLength(1);
    expect(container.querySelectorAll('.strip-tint')).toHaveLength(1);

    const variant = run.variants.find((candidate) => candidate.id === hero.variant);
    const step = run.steps.find((candidate) => candidate.id === hero.step);
    expect(evidence).toContain((variant as { name: string }).name);
    expect(evidence).toContain((step as { label: string }).label);

    // The caption is the one click to beat 5: the same version and the same step, opened in
    // Attention. Where exactly it lands is #108's; that it goes there is this screen's.
    const into = slot(container, 'hero-evidence').querySelector('a');
    expect(into?.getAttribute('href')).toContain(paths.attention(SEED, hero.variant, hero.step));
  });

  it('carries the three findings the verdict named, each with its evidence sentence', async () => {
    const { container } = await openVerdict();
    const cards = [...container.querySelectorAll(FINDING)];

    expect(run.verdict.headlineFindingIds).toHaveLength(3);
    run.verdict.headlineFindingIds.forEach((id, index) => {
      const finding = findings.findings.find((candidate) => candidate.id === id);
      if (finding === undefined) throw new Error(`the findings file carries no ${id}`);
      const card = (cards[index] as HTMLElement).textContent ?? '';

      expect(card, id).toContain(finding.claim);
      expect(card, id).toContain(finding.evidence);
    });
  });

  it('offers the four doors to everything taken off this screen', async () => {
    const { container } = await openVerdict();
    const doors = slot(container, 'detail-doors');

    expect(doors.querySelectorAll('a')).toHaveLength(4);
    for (const door of ['Score breakdown', 'Attention', 'People', 'Watch one person']) {
      expect(doors.textContent, door).toContain(door);
    }
  });

  it('states in the chrome how human-like the simulation is, from the run’s calibration', async () => {
    const { container } = await openVerdict();
    const calibration = run.calibration;
    if (calibration === null) throw new Error('the committed run records no calibration');

    expect(words(container, 'simulated-badge')).toContain(
      `Simulated audience · gaze similarity ${String(calibration.cc)}`,
    );
  });

  it('closes on the line that the figures are simulated and are not a conversion-lift estimate', async () => {
    const { container } = await openVerdict();
    const slots = [...container.querySelectorAll(SLOTS)];

    expect(slots.at(-1)?.getAttribute('data-shell')).toBe('simulated-disclaimer');
    const closing = words(container, 'simulated-disclaimer');
    expect(closing).toContain('simulated');
    expect(closing).toContain(run.audience.name);
    expect(closing).toContain('not a conversion-lift estimate');
  });
});

describe('the screen is quiet', () => {
  it('carries exactly one heatmap and no second piece of evidence', async () => {
    const { container } = await openVerdict();

    expect(container.querySelectorAll(HEAT)).toHaveLength(1);
    expect(container.querySelectorAll('[data-section="hero-evidence"]')).toHaveLength(1);
    // One screenshot, in the one tinted band: a second chart would need a second of each.
    expect(container.querySelectorAll('[data-section="hero-evidence"] img')).toHaveLength(1);
    expect(container.querySelectorAll('.strip-tint')).toHaveLength(1);
  });

  it('has no area-of-interest table, no scanpath, no component bars, no friction score and no session rows', async () => {
    const { container } = await openVerdict();

    // Each of these is a section of a screen one click deeper, named by the slot that
    // screen declares — so a section moved back here fails this test by its own handle.
    const moved = {
      'the areas-of-interest table': '[data-section="areas-of-interest"]',
      'the scanpath layer': '[data-overlay-layer="scan"]',
      'a numbered fixation or a saccade': '[data-fixation-number], [data-saccade]',
      'the friction score and its four components': '[data-section="score-cards"]',
      'the breakdown’s score sentence': '[data-section="verdict"]',
      'outcomes by audience segment': '[data-section="segments"]',
      'the full findings list': '[data-section="all-findings"]',
      'the people table': '[aria-label="The people in this test"]',
      'any table at all': 'table',
    };

    for (const [what, selector] of Object.entries(moved)) {
      expect(container.querySelectorAll(selector), what).toHaveLength(0);
    }
  });
});

describe('the assembled screen, to a screen reader', () => {
  it('reports no axe violation', async () => {
    const { container } = await openVerdict();

    const violations = await axeViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

describe('from the chrome down to the last door, by keyboard', () => {
  it('reaches every control in the order the page draws them', async () => {
    const { container } = await openVerdict();
    const user = userEvent.setup();

    const controls = [
      ...container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    // The walk has to end on the last door, past the three findings: a stop that is not
    // reachable, or reachable out of order, fails the comparison below.
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.at(-1)?.textContent).toContain('Watch one person');

    const stops: Element[] = [];
    while (stops.length < controls.length) {
      await user.tab();
      stops.push(document.activeElement as Element);
    }

    expect(stops).toEqual(controls);
  });

  it('never takes a focus ring away without putting one back', async () => {
    const { container } = await openVerdict();

    // jsdom lays nothing out and paints nothing, so a ring is not measurable here. What is
    // decidable is that no control on this screen suppresses the one it would otherwise
    // draw: a shadcn primitive turns the outline off and draws its own ring at
    // `--border-width-strong`, and everything else keeps the one it is given.
    for (const control of container.querySelectorAll<HTMLElement>('a[href], button')) {
      const classes = control.getAttribute('class') ?? '';
      if (!classes.includes('outline-none')) continue;
      expect(classes, control.outerHTML).toMatch(/focus-visible:ring-/u);
    }

    // And the colour the ring is drawn in is the tokens', not a value typed out here.
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--color-focus').trim(),
    ).not.toBe('');
  });
});

describe('a narrow window', () => {
  it('stacks the headline, the figures and the heatmap below the prototype’s breakpoint', () => {
    const verdict = ruleIn(rulesOf(stylesheet('screens/verdict/verdict.css')));
    const mat = ruleIn(rulesOf(stylesheet('screens/verdict/heroEvidence.module.css')));
    const doors = ruleIn(rulesOf(stylesheet('screens/verdict/doors.module.css')));

    // The headline drops a type step rather than wrapping into the figures.
    expect(verdict('.hero h1', '(max-width: 1000px)')['font-size']).toBe('var(--text-display-sm)');
    // The figures are a wrapping row: side by side while they fit, stacked when they do not.
    expect(verdict('.figures')['flex-wrap']).toBe('wrap');
    // The heatmap's frame is width-relative and its head wraps, so neither squashes.
    expect(mat('.frame').width).toBe('100%');
    expect(mat('.head')['flex-wrap']).toBe('wrap');
    // Four doors become one column rather than four slivers.
    expect(doors('.doors', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });

  it('scrolls vertically only: nothing on it is wider than the window', () => {
    const sheets = [
      'screens/verdict/verdict.css',
      'screens/verdict/heroEvidence.module.css',
      'screens/verdict/doors.module.css',
      'screens/verdict/finding.module.css',
      'screens/verdict/excludedBanner.module.css',
    ];
    const fixed = ['width', 'min-width', 'min-inline-size', 'inline-size'];

    for (const sheet of sheets) {
      for (const rule of rulesOf(stylesheet(sheet))) {
        for (const [property, value] of Object.entries(rule.declarations)) {
          const where = `${sheet} ${rule.selector} ${property}: ${value}`;
          // A horizontal scrollbar is never the answer on this screen.
          if (property === 'overflow-x') expect(['auto', 'scroll'], where).not.toContain(value);
          // And no box is given a width in pixels that a narrow window cannot honour.
          if (fixed.includes(property)) expect(value, where).not.toMatch(/\d\s*px/u);
        }
      }
    }
  });

  it('takes its breakpoints from the prototype and invents none', () => {
    const contract = prototype();
    const queries = new Set(
      [
        ...rulesOf(stylesheet('screens/verdict/verdict.css')),
        ...rulesOf(stylesheet('screens/verdict/heroEvidence.module.css')),
        ...rulesOf(stylesheet('screens/verdict/doors.module.css')),
        ...rulesOf(stylesheet('screens/verdict/finding.module.css')),
      ]
        .map((rule) => rule.condition)
        .filter((condition) => condition !== ''),
    );

    expect(queries.size).toBeGreaterThan(0);
    for (const query of queries) expect(contract, query).toContain(query);
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('renders the final figures on first paint, with nothing in motion', async () => {
    prefersReducedMotion(true);
    const { container } = await openVerdict();

    // The figures the reader is reading are the run's own, at once: no ticker counting up
    // to them, and nothing left mid-animation.
    const figures = words(container, 'completion-figures');
    for (const variant of run.variants) {
      const score = scoreOf(variant.id);
      if (score === undefined) throw new Error(`the run carries no score for ${variant.id}`);
      expect(figures, variant.id).toContain(
        `${String(Math.round(score.completionRate * 10))} in 10`,
      );
    }

    expectNothingInMotion(container);
  });

  it('and no screen one click deeper animates at all', async () => {
    prefersReducedMotion(true);
    await serveRunData();

    const hero = run.verdict.heroEvidence;
    const deeper = [
      [paths.breakdown(SEED), '[data-section="score-cards"]'],
      [paths.attention(SEED, hero.variant, hero.step), '[data-section="attention"]'],
      [paths.sessions(SEED), '[aria-label="The people in this test"]'],
    ] as const;

    for (const [path, resolved] of deeper) {
      const { container } = mountApp(path);
      await waitFor(() => {
        expect(container.querySelector(resolved), path).not.toBeNull();
      });
      expectNothingInMotion(container);
    }

    // Nor in their stylesheets: the direction allows these screens the base transition and
    // `pv-pulse` on a live or loading state, and no entrance animation — a number a reader
    // is reading must not be moving.
    const screens = ['breakdown', 'attention', 'sessions'];
    for (const screen of screens) {
      for (const sheet of styleSheetsUnder(screen)) {
        for (const rule of rulesOf(readFileSync(sheet, 'utf8'))) {
          for (const [property, value] of Object.entries(rule.declarations)) {
            if (!property.startsWith('animation')) continue;
            expect(value, `${sheet} ${rule.selector} ${property}`).toContain('pv-pulse');
          }
        }
      }
    }
  });
});

describe('the page settling', () => {
  it('does not shift once the run resolves: the same slots, in the same order', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));
    const drawn = (): (string | null)[] =>
      [...container.querySelectorAll(SLOTS)].map(
        (element) => element.getAttribute('data-section') ?? element.getAttribute('data-shell'),
      );

    // The run file is what the screen is composed from; the findings and the heat arrive
    // after it, each over a file of its own. From the paint the run resolves on, every
    // section is on the page — loading, but holding its place — so the two slower beats
    // fill a space that is already there rather than pushing the screen around as they
    // land. The reservations that keep each section's own height are its stylesheet's,
    // which `tests/verdict/stylesheet.test.ts` holds.
    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    const resolved = drawn();

    await waitFor(() => {
      expect(container.querySelectorAll(FINDING)).toHaveLength(3);
      expect(container.querySelector(HEAT)).not.toBeNull();
    });

    expect(drawn()).toEqual(resolved);
  });
});

describe('offline, against the committed run only', () => {
  it('reads the run directory over the documented paths and asks for nothing else', async () => {
    const { requests } = await openVerdict();

    // `docs/adr/0001-run-data-over-http-as-static-files.md`'s paths, and nothing else: the
    // index, the run, its findings, and one file per person — the heat is an aggregate over
    // the sessions, so the one heatmap is what reads them.
    const documented = new RegExp(
      `^(?:/runs/index\\.json|/runs/${SEED}/(?:run|findings)\\.json|/runs/${SEED}/sessions/[^/]+\\.json|/audiences(?:/[^/]+)?)$`,
      'u',
    );
    const unexpected = [...new Set(requests)].filter((path) => !documented.test(path));

    expect(unexpected).toEqual([]);
    // And it really did read the run it was asked for, rather than passing on an empty list.
    expect(requests).toContain(`/runs/${SEED}/run.json`);
  });
});
