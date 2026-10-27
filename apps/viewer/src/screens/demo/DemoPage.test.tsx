// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '@personavision/contract';
import { NEXT_PARAM, patterns, paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';
import { EXAMPLE_RUN_ID } from '../landing/LandingPage';

/**
 * `/demo` — the committed example run's Verdict, public and read-only.
 *
 * Three things are worth asserting here and the rest is the Verdict screen's own suites'
 * business:
 *
 * 1. **It is the same screen.** The sections on this page are the Verdict screen's own
 *    component files, in the same order and with the same words, which is asserted by
 *    rendering both screens and comparing what came out — not by re-asserting the sentence,
 *    the figures and the findings a second time.
 * 2. **It is read-only, and visibly so.** Nothing of the signed-in chrome is on it and the
 *    four doors are not rendered; what stands in their place is one line and one action.
 * 3. **It is one run, fixed.** The route takes no id and the page reads the committed
 *    example run's paths and nothing else, so no workspace's data is reachable through it.
 */

const SIGNED_OUT = { status: 'signed-out' } as const;

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(join(here, file), 'utf8');

const runFile = `/runs/${EXAMPLE_RUN_ID}/run.json`;

/** The committed example run, as the page reads it. */
const exampleRun = (): Run => readRunFile(EXAMPLE_RUN_ID) as unknown as Run;

/** The demo, mounted at `/demo` for somebody with no session at all. */
const demo = () => mountApp(paths.demo, { session: SIGNED_OUT });

/** The same run on the signed-in Verdict screen, which this page has to agree with. */
const signedInVerdict = () => mountApp(paths.run(EXAMPLE_RUN_ID));

/**
 * The screen once every read it makes has come back: the run, its findings, and the session
 * files the excluded banner and the heatmap's aggregate are both made of. Collecting the
 * sections before then would compare one screen's loading state with another's.
 */
const settled = async (container: HTMLElement): Promise<void> => {
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => {
    expect(container.querySelector('[data-state="loading"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText(/reading the sessions/)).toBeNull();
  });
};

/** The sections a screen rendered, in the order they appear in the document. */
const sectionsOf = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-section]')].map(
    (section) => section.getAttribute('data-section') as string,
  );

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('with no session at all', () => {
  it('shows the committed example run’s verdict rather than sending the visitor to sign in', async () => {
    await serveRunData();
    const { router } = demo();

    const headline = await screen.findByRole('heading', { level: 1 });
    expect(headline.textContent).toBe(exampleRun().verdict.audienceSentence);
    expect(router.state.location.pathname).toBe(paths.demo);
  });

  it('needs no stubbed workspace: nothing but the run directory is read', async () => {
    const served = await serveRunData();
    const { container } = demo();
    await settled(container);

    // `/runs/index.json` is the workspace's own listing of its tests. A public page that
    // asked for it would be showing somebody's most recent test.
    expect(served.requests).not.toContain('/runs/index.json');
    expect(served.requests.filter((path) => path.startsWith('/audiences'))).toEqual([]);
  });
});

describe('it is one run, fixed', () => {
  it('takes no run id: the route has no parameter and the page reads none', () => {
    expect(patterns.demo).not.toContain(':');
    expect(source('DemoPage.tsx')).not.toContain('useParams');
    expect(source('DemoPage.tsx')).not.toContain('useSearchParams');
  });

  it('reads only the committed example run’s own paths', async () => {
    const served = await serveRunData();
    const { container } = demo();
    await settled(container);

    const runData = served.requests.filter((path) => path.startsWith('/runs/'));
    expect(runData.length).toBeGreaterThan(0);
    for (const path of runData) {
      expect(path.startsWith(`/runs/${EXAMPLE_RUN_ID}/`), path).toBe(true);
    }
  });

  it('names the run once, with the landing page, so the two public pages read the same test', () => {
    // The id is `LandingPage`'s export, imported. A second literal would be two public
    // pages that can drift apart.
    expect(source('DemoPage.tsx')).toContain(
      "import { EXAMPLE_RUN_ID } from '@/screens/landing/LandingPage'",
    );
    expect(source('DemoPage.tsx')).not.toContain('northwind');
  });
});

describe('the sections are the Verdict screen’s own', () => {
  it('renders the same sections, in the same order, as the signed-in Verdict screen', async () => {
    await serveRunData();
    const page = demo();
    await settled(page.container);
    const onDemo = sectionsOf(page.container);

    cleanup();
    forgetRuns();
    await serveRunData();
    const verdict = signedInVerdict();
    await settled(verdict.container);
    const onVerdict = sectionsOf(verdict.container);

    // The one difference the screen contract allows: the `.doors` block becomes the single
    // sign-in action. Everything between the bar and it is the signed-in screen.
    expect(onVerdict).toContain('detail-doors');
    expect(onDemo).toEqual(
      onVerdict.map((section) => (section === 'detail-doors' ? 'behind-sign-in' : section)),
    );
  });

  it('says the same words, section for section, as the signed-in Verdict screen', async () => {
    await serveRunData();
    const page = demo();
    await settled(page.container);
    const words = (container: HTMLElement): Record<string, string> =>
      Object.fromEntries(
        [...container.querySelectorAll('[data-section]')].map((section) => [
          section.getAttribute('data-section') as string,
          (section.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ]),
      );
    const onDemo = words(page.container);

    cleanup();
    forgetRuns();
    await serveRunData();
    const verdict = signedInVerdict();
    await settled(verdict.container);
    const onVerdict = words(verdict.container);

    for (const section of Object.keys(onVerdict).filter((name) => name !== 'detail-doors')) {
      expect(onDemo[section], section).toBe(onVerdict[section]);
    }
  });

  it('draws the heatmap over the run it was handed, on a route that names no test', async () => {
    // The aggregate the heat is drawn from used to be read from the route's `:runId`, which
    // `/demo` and `/` do not have: the block would have sat on "reading the sessions" for
    // ever and drawn nothing. `HeroEvidence` hands its own run down instead, so the one
    // piece of evidence on this page is the evidence and not an empty frame.
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const evidence = container.querySelector('[data-section="hero-evidence"]') as HTMLElement;
    expect(evidence.textContent).toContain('Redesign candidate');
    expect(evidence.textContent).not.toContain('reading the sessions');
    expect(evidence.querySelectorAll('[data-overlay-layer="heat"] circle').length).toBeGreaterThan(
      0,
    );
  });

  it('imports every section rather than holding a copy of one', () => {
    const page = source('DemoPage.tsx');

    for (const section of [
      'AudienceLine',
      'ExcludedBanner',
      'Headline',
      'CompletionFigures',
      'Reasons',
      'HeroEvidence',
      'HeadlineFindings',
    ]) {
      expect(page, section).toContain(`from '@/screens/verdict/${section}'`);
    }
  });
});

describe('read-only, and visibly so', () => {
  it('puts the public bar where the product chrome is: the wordmark, the badge and one way in', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    expect(container.querySelector('[data-shell="public-bar"]')).not.toBeNull();
    const bar = container.querySelector('[data-shell="public-bar"]') as HTMLElement;
    expect(bar.querySelector('.logo')?.textContent).toBe('PersonaVision');
    expect(bar.querySelector('[data-shell="simulated-badge"]')).not.toBeNull();
    expect(bar.querySelector(`a[href="${paths.signIn}"]`)).not.toBeNull();
  });

  it('renders no workspace name, test picker, account menu, New test button or tab bar', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    for (const shell of ['chrome', 'tabbar', 'workspace-name', 'test-picker', 'account-menu']) {
      expect(container.querySelector(`[data-shell="${shell}"]`), shell).toBeNull();
    }
    expect(screen.queryByRole('link', { name: 'New test' })).toBeNull();
    expect(container.querySelector(`a[href="${paths.newTest}"]`)).toBeNull();
  });

  it('does not render the four doors to the detail', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    expect(container.querySelector('[data-section="detail-doors"]')).toBeNull();
    for (const door of ['Score breakdown', 'People', 'Watch one person']) {
      expect(screen.queryByRole('heading', { name: door }), door).toBeNull();
    }
  });
});

describe('the one action', () => {
  it('states in a line that the detail is behind sign-in', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const block = container.querySelector('[data-section="behind-sign-in"]') as HTMLElement;
    expect(block.textContent).toContain('is behind sign-in');
  });

  it('offers *Sign in to run this on your own pages*, and it goes to /signin', async () => {
    await serveRunData();
    const { container, router } = demo();
    await settled(container);

    const action = screen.getByRole('link', { name: 'Sign in to run this on your own pages' });
    expect(action.getAttribute('href')).toBe(paths.signIn);
    await userEvent.click(action);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
  });

  it('turns a link into the detail into that same sign-in, carrying where it was going', async () => {
    // The sections are the signed-in screen unchanged, so a finding still links to its
    // evidence. For a visitor with no session that link is not a door that fails: the
    // protected route sends them to sign-in with the destination on it, and signing in
    // finishes the journey they started.
    await serveRunData();
    const { container, router } = demo();
    await settled(container);

    const finding = container.querySelector(
      '[data-section="headline-findings"] a[data-sev]',
    ) as HTMLElement;
    const destination = finding.getAttribute('href') as string;
    await userEvent.click(finding);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(new URLSearchParams(router.state.location.search).get(NEXT_PARAM)).toBe(destination);
  });
});

describe('every figure is labelled simulated, and none is a conversion claim', () => {
  it('carries the badge, with the run’s own gaze-similarity figure', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const badge = container.querySelector('[data-shell="simulated-badge"]') as HTMLElement;
    expect(badge.textContent).toContain('Simulated audience · gaze similarity 0.68');
  });

  it('ends with the shared disclaimer, naming the run’s own audience', async () => {
    const run = exampleRun();
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const disclaimer = container.querySelector(
      '[data-shell="simulated-disclaimer"]',
    ) as HTMLElement;
    expect(disclaimer.textContent).toContain('simulated');
    expect(disclaimer.textContent).toContain(run.audience.name);
    expect(disclaimer.textContent).toContain('not a conversion-lift estimate');
  });

  it('says the word *conversion* only to deny the claim', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text.match(/conversion/g)).toHaveLength(1);
    expect(text).toContain('not a conversion-lift estimate');
  });
});

describe('the example run cannot be read', () => {
  it('states what it looked for, inside the public bar, and offers the one way in', async () => {
    await serveRunData({ files: { [runFile]: 'this is not a run' } });
    const { container } = demo();

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(container.querySelector('[data-shell="public-bar"]')).not.toBeNull();
    expect(screen.getByText(runFile)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Sign in to run this on your own pages' }),
    ).toBeTruthy();
    // No figure stands without its run, and no empty frame is drawn.
    expect(container.querySelector('[data-section="completion-figures"]')).toBeNull();
    expect(container.querySelector('[data-section="hero-evidence"]')).toBeNull();
    // Nothing on the page is labelled simulated, because nothing on it is a figure.
    expect(container.querySelector('[data-shell="simulated-badge"]')).toBeNull();
  });

  it('says so for a run directory that is not there at all', async () => {
    await serveRunData({ runIds: [] });
    const { container } = demo();

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(runFile)).toBeTruthy();
    expect(container.querySelector('[data-shell="public-bar"]')).not.toBeNull();
  });
});

describe('while the run is being read', () => {
  it('reserves the sections’ space rather than leaving the page to jump', async () => {
    await serveRunData();
    const { container } = demo();

    const waiting = container.querySelector('[data-section="demo-waiting"]') as HTMLElement;
    expect(waiting).not.toBeNull();
    // The three strips of `#screen-verdict`, each already carrying the shape of the section
    // that will fill it.
    expect(waiting.querySelectorAll('.strip').length).toBe(3);
    expect(waiting.querySelector('.strip-tint')).not.toBeNull();
    expect(waiting.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);

    await settled(container);
    expect(container.querySelector('[data-section="demo-waiting"]')).toBeNull();
  });
});

describe('under prefers-reduced-motion', () => {
  /** jsdom answers every media query `false`; this makes one of them answer `true`. */
  const prefersReducedMotion = (): void => {
    vi.stubGlobal(
      'matchMedia',
      (query: string): MediaQueryList =>
        ({
          matches: query.includes('prefers-reduced-motion'),
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

  it('renders the final figures and the heatmap, complete and still', async () => {
    prefersReducedMotion();
    await serveRunData();
    const { container } = demo();
    await settled(container);

    // The figures are their final values, not a number mid-count.
    const figures = container.querySelector('[data-section="completion-figures"]') as HTMLElement;
    expect(figures.textContent).toContain('82% · 9 of 11 people completed the task');
    expect(figures.textContent).toContain('18% · 2 of 11 people completed the task');
    // And the heatmap is simply present.
    expect(container.querySelector('[data-section="hero-evidence"]')).not.toBeNull();
  });

  it('animates nothing of its own, so there is no shortened animation to collapse', () => {
    const css = source('demo.module.css').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(css).not.toContain('@keyframes');
    expect(css).not.toContain('animation');
    expect(css).not.toContain('transition');
  });
});

describe('a narrow window', () => {
  it('stretches the one action across a phone-width window rather than wrapping its label', () => {
    const rule = ruleIn(rulesOf(source('demo.module.css')));

    expect(rule('.behind > :last-child', '(max-width: 640px)')['justify-self']).toBe('stretch');
    // The line above it is prose and takes the prose measure, so it does not run the width
    // of a desktop window either.
    expect(rule('.behind')['max-width']).toBe('var(--layout-max-narrow)');
  });
});

describe('accessibility', () => {
  it('passes axe', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const violations = await axeViolations(container);
    expect(describeViolations(violations)).toBe('');
  });

  it('is one h1 — the run’s own sentence — and no skipped heading level', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const levels = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    for (const [index, level] of levels.entries()) {
      expect(level - (levels[index - 1] ?? level), `heading ${index}`).toBeLessThanOrEqual(1);
    }
  });

  it('reaches the wordmark, the badge and the way in by keyboard alone', async () => {
    await serveRunData();
    const { container } = demo();
    await settled(container);

    const reached: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      await userEvent.tab();
      reached.push(document.activeElement?.textContent ?? '');
    }

    // The badge is a stop of its own because it carries the three benchmark figures as
    // text: a reader who cannot hover reaches them, and the bar's own order is unchanged.
    expect(reached[0]).toBe('PersonaVision');
    expect(reached[1]).toContain('Simulated audience');
    expect(reached[2]).toBe('Sign in');
  });
});
