// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';
import { EXAMPLE_RUN_ID } from './LandingPage';

/**
 * `/` for a visitor with no session, over the repository's own committed example run.
 *
 * What is asserted is what a reader sees and where a click lands. The point of most of it
 * is that **no figure on this page is written into the page**: the sentence and the figures
 * are read from the run, so the tests that matter most here change a field in the fixture
 * and expect the page to follow.
 *
 * Three assertions reach for a `data-section`, which is how a section of a screen is
 * addressed across this app's suites: a page cannot be asked whether a *section* is on it
 * through its words alone, and two of these are about a section that is **absent**.
 */

const SIGNED_OUT = { status: 'signed-out' } as const;

const HEADLINE = 'Know which version your customers can actually use';

const runFile = `/runs/${EXAMPLE_RUN_ID}/run.json`;

/** The committed example run, as the page reads it. */
const exampleRun = (): Run => readRunFile(EXAMPLE_RUN_ID) as unknown as Run;

/** The example run with something changed in it, served in its place. */
const serveChangedRun = async (change: (run: Run) => void) => {
  const run = exampleRun();
  change(run);
  await serveRunData({ files: { [runFile]: JSON.stringify(run) } });
  return run;
};

/** The landing page, mounted at `/` for somebody with no session. */
const landing = () => mountApp(paths.home, { session: SIGNED_OUT });

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the page itself', () => {
  it('leads with what the product answers, as the page’s one h1', async () => {
    await serveRunData();
    landing();

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(HEADLINE);
  });

  it('says how it works in three steps', async () => {
    await serveRunData();
    landing();

    await screen.findByRole('heading', { name: 'How it works' });
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((step) => step.querySelector('p')?.textContent)).toEqual([
      'Describe your audience',
      'Point at two versions and a task',
      'Read the verdict',
    ]);
  });

  it('repeats the headline on the closing band, without a second h1', async () => {
    await serveRunData();
    landing();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByText(HEADLINE)).toHaveLength(2);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('the two actions', () => {
  it('points every *See the demo* at /demo and every *Sign in* at /signin', async () => {
    await serveRunData();
    landing();

    await screen.findByRole('heading', { level: 1 });
    const demo = screen.getAllByRole('link', { name: 'See the demo' });
    const signIn = screen.getAllByRole('link', { name: 'Sign in' });

    expect(demo.length).toBeGreaterThan(0);
    expect(signIn.length).toBeGreaterThan(0);
    for (const link of demo) expect(link.getAttribute('href')).toBe(paths.demo);
    for (const link of signIn) expect(link.getAttribute('href')).toBe(paths.signIn);
  });

  it('navigates to the demo', async () => {
    await serveRunData();
    const { router } = landing();

    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(screen.getAllByRole('link', { name: 'See the demo' })[0] as HTMLElement);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.demo);
    });
  });

  it('navigates to sign-in', async () => {
    await serveRunData();
    const { router } = landing();

    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(screen.getAllByRole('link', { name: 'Sign in' })[0] as HTMLElement);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
  });
});

describe('the evidence, and it is real', () => {
  it('shows the committed example run’s own headline sentence', async () => {
    const run = exampleRun();
    await serveRunData();
    landing();

    expect(await screen.findByText(run.verdict.audienceSentence)).toBeTruthy();
  });

  it('shows both completion figures with the people behind them, and marks the one to ship', async () => {
    await serveRunData();
    landing();

    // The example run: 9 of 11 completed on the current checkout, 2 of 11 on the redesign.
    expect(await screen.findByText(/9 of 11 people completed the task/)).toBeTruthy();
    expect(screen.getByText(/2 of 11 people completed the task/)).toBeTruthy();
    expect(screen.getByText('the one to ship')).toBeTruthy();
    expect(screen.getByText('Current checkout')).toBeTruthy();
    expect(screen.getByText('Redesign candidate')).toBeTruthy();
  });

  it('follows a changed verdict sentence in the fixture', async () => {
    const changed = await serveChangedRun((run) => {
      run.verdict.audienceSentence = 'Your audience completes the purchase on the redesign.';
    });
    landing();

    expect(await screen.findByText(changed.verdict.audienceSentence)).toBeTruthy();
    expect(screen.queryByText(exampleRun().verdict.audienceSentence)).toBeNull();
  });

  it('follows a changed completion rate in the fixture', async () => {
    await serveChangedRun((run) => {
      const score = run.scores[0];
      if (score === undefined) throw new Error('the example run has no score to change');
      // The contract holds `completionRate` to the counts under it, so both move: 5 of
      // the same 11 scored people now complete the task instead of 9.
      score.completionRate = 5 / 11;
      score.outcomeCounts.success = 5;
      score.outcomeCounts.abandoned = 6;
    });
    const { container } = landing();

    const figures = await waitFor(() => {
      const found = container.querySelector('[data-section="completion-figures"]');
      if (found === null) throw new Error('no figures yet');
      return found;
    });

    expect(figures.textContent).toContain('45% · 5 of 11 people completed the task');
    expect(figures.textContent).not.toContain('9 of 11 people completed the task');
  });

  it('gives the heatmap its place, in the one tinted band', async () => {
    await serveRunData();
    const { container } = landing();

    // The Verdict screen's own component, imported rather than drawn again, so the mat,
    // the device label and the caption arrive with #108 and this page changes nothing.
    const evidence = await waitFor(() => {
      const found = container.querySelector('[data-section="hero-evidence"]');
      if (found === null) throw new Error('the heatmap has no place on the page');
      return found;
    });

    expect(evidence.closest('.strip-tint')).not.toBeNull();
  });
});

describe('the figures are labelled simulated', () => {
  it('renders the shared disclaimer, naming the run’s own audience', async () => {
    const run = exampleRun();
    await serveRunData();
    const { container } = landing();

    const disclaimer = await waitFor(() => {
      const found = container.querySelector('[data-shell="simulated-disclaimer"]');
      if (found === null) throw new Error('no disclaimer yet');
      return found;
    });

    expect(disclaimer.textContent).toContain('simulated');
    expect(disclaimer.textContent).toContain(run.audience.name);
    expect(disclaimer.textContent).toContain('not a conversion-lift estimate');
  });
});

describe('when the example run cannot be read', () => {
  it('keeps the headline and the actions, says so quietly, and draws no frame', async () => {
    await serveRunData({ files: { [runFile]: 'this is not a run' } });
    const { container } = landing();

    expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADLINE);
    expect(screen.getAllByRole('link', { name: 'See the demo' }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/people completed the task/)).toBeNull();
    expect(container.querySelector('[data-section="landing-evidence"]')).toBeNull();
    expect(container.querySelector('[data-section="hero-evidence"]')).toBeNull();
  });
});

describe('accessibility', () => {
  it('passes axe', async () => {
    await serveRunData();
    const { container } = landing();

    await screen.findAllByText(/people completed the task/);
    const violations = await axeViolations(container);
    expect(describeViolations(violations)).toBe('');
  });

  it('reaches both actions and the wordmark by keyboard alone', async () => {
    await serveRunData();
    landing();

    await screen.findByRole('heading', { level: 1 });
    const reached: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await userEvent.tab();
      reached.push(document.activeElement?.textContent ?? '');
    }

    expect(reached.slice(0, 3)).toEqual(['PersonaVision', 'See the demo', 'Sign in']);
  });
});
