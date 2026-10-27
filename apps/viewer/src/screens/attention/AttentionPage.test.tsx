// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPaths, runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths, sessionsWithVariant } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';

/**
 * `/runs/:runId/attention/:variant/:step?aoi=` over the repository's own committed example
 * run: no API key, no network, every figure the pipeline wrote.
 *
 * What is asserted is what a designer reads and where a click goes. The selection is the
 * URL, so most of these tests are about a URL: what one link opens on, what a version
 * switch keeps, what a reload reproduces, and what a link asking for something this test
 * never ran is answered with.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');
const runFile = `/runs/${RUN_ID}/run.json`;

const HEADING = 'Where your audience looked';
const LEDE =
  'Every look your audience took on this version, over the page as they saw it. Fixation, dwell and scanpath are the technical words for it; the table under the page is the same thing in numbers.';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/** The committed run with something changed in it, served in its place. */
const serveChangedRun = async (change: (run: Run) => Run) => {
  const changed = change(seedRun());
  await serveRunData({ files: { [runFile]: JSON.stringify(changed) } });
  return changed;
};

const attention = (variant: string, step: string, query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

/** The screen, once the run and its people have been read. */
const settled = async () => {
  await screen.findByRole('heading', { level: 1, name: HEADING });
  await waitFor(() => {
    expect(screen.getByText('Reached this step').nextElementSibling?.textContent).not.toContain(
      'reading',
    );
  });
};

const reading = (term: string): string =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

const version = (name: string) => screen.getByRole('button', { name });

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the screen the evidence is on', () => {
  it('renders over the committed example run, with no key and no network of its own', async () => {
    await serveRunData();
    attention('B', 'review');

    await settled();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING);
    expect(screen.getByText(LEDE)).toBeDefined();
  });

  it('says what the aggregate covers and who it leaves out, from the run’s own score', async () => {
    await serveRunData();
    attention('B', 'review');

    await settled();
    expect(
      screen.getByText('Aggregate of 11 people · the 1 our automation broke is excluded'),
    ).toBeDefined();
  });

  it('follows the run rather than its own text when the score changes', async () => {
    await serveChangedRun((run) => ({
      ...run,
      scores: run.scores.map((score) =>
        score.variant === 'B'
          ? {
              ...score,
              scoredSessionCount: 10,
              completionRate: 0.2,
              outcomeCounts: { ...score.outcomeCounts, abandoned: 5, automationFailure: 2 },
            }
          : score,
      ),
    }));
    attention('B', 'review');

    await settled();
    expect(
      screen.getByText('Aggregate of 10 people · the 2 our automation broke are excluded'),
    ).toBeDefined();
  });

  it('states the median caveat and carries the shell’s simulated line', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');

    await settled();
    expect(
      screen.getByText(/Medians across the people whose session was scored, never one person/),
    ).toBeDefined();
    expect(container.querySelector('[data-shell="simulated-disclaimer"]')).not.toBeNull();
  });

  it('says how to read the overlays, in the prototype’s words', async () => {
    await serveRunData();
    attention('B', 'review');

    await settled();
    expect(screen.getByRole('heading', { name: 'Reading this' })).toBeDefined();
    expect(
      screen.getByText(
        'Numbers are fixation order, median across sessions. Fixation size is dwell time. Click a row in the table to isolate one area of interest.',
      ),
    ).toBeDefined();
  });

  it('leaves the test’s not-found state to the shell rather than answering for it', async () => {
    await serveRunData({ runIds: [] });
    mountApp(paths.attention('a-test-that-is-not-here', 'B', 'review'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 1, name: HEADING })).toBeNull();
  });
});

describe('the version switch', () => {
  it('lists every version of the run by its name and marks the one shown', async () => {
    await serveRunData();
    attention('B', 'review');

    await settled();
    expect(version('A · Current checkout').getAttribute('aria-pressed')).toBe('false');
    expect(version('B · Redesign candidate').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the step and the isolated area when the version changes', async () => {
    await serveRunData();
    const { router } = attention('B', 'review', '?aoi=B-review-fee-row');
    await settled();

    await userEvent.click(version('A · Current checkout'));

    await waitFor(() => {
      expect(version('A · Current checkout').getAttribute('aria-pressed')).toBe('true');
    });
    const { pathname, search } = router.state.location;
    expect(pathname).toBe(paths.attention(RUN_ID, 'A', 'review'));
    expect(search).toBe('?aoi=B-review-fee-row');
  });

  it('is operable from the keyboard', async () => {
    await serveRunData();
    const { router } = attention('B', 'review');
    await settled();

    const other = version('A · Current checkout');
    other.focus();
    expect(document.activeElement).toBe(other);
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'A', 'review'));
    });
  });
});

describe('the URL is the whole of what is on screen', () => {
  it('opens on the area a link names, with no click', async () => {
    await serveRunData();
    attention('B', 'review', '?aoi=B-review-fee-row');

    await settled();
    expect(reading('Isolated')).toBe('Service fee row — planted defect');
  });

  it('reproduces the same view when the same URL is opened again', async () => {
    await serveRunData();
    const opened = attention('B', 'review', '?aoi=B-review-fee-row');
    await settled();
    const first = ['Fixations', 'Total dwell', 'Reached this step', 'Isolated'].map(reading);

    // Closed and opened again on the same link, with every run and session forgotten: the
    // screen has nothing left but the URL to rebuild itself from.
    opened.unmount();
    forgetRuns();
    await serveRunData();
    attention('B', 'review', '?aoi=B-review-fee-row');
    await settled();

    expect(['Fixations', 'Total dwell', 'Reached this step', 'Isolated'].map(reading)).toEqual(
      first,
    );
    expect(first).toEqual([
      '4 median per session',
      '2.3 s',
      '9 of 11',
      'Service fee row — planted defect',
    ]);
  });
});

describe('a link asking for something this test does not have', () => {
  it('shows the first version and says which one was asked for', async () => {
    await serveRunData();
    attention('C', 'review');

    await settled();
    expect(
      screen.getByText(
        'This test has no version “C”. Showing Current checkout, the first version it ran.',
      ),
    ).toBeDefined();
    expect(version('A · Current checkout').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the earliest step and says which one was asked for', async () => {
    await serveRunData();
    attention('B', 'delivery');

    await settled();
    expect(
      screen.getByText(
        'This test has no step “delivery”. Showing Cart, the earliest step your audience reached.',
      ),
    ).toBeDefined();
    expect(reading('Reached this step')).toBe('11 of 11');
  });

  it('drops an ?aoi= that names no area here and says so', async () => {
    await serveRunData();
    attention('B', 'review', '?aoi=a-box-that-does-not-exist');

    await settled();
    expect(
      screen.getByText(
        'There is no area “a-box-that-does-not-exist” on Redesign candidate at the Review step. Showing every area.',
      ),
    ).toBeDefined();
    expect(reading('Isolated')).toBe('all areas');
  });
});

describe('a step nobody in the audience reached', () => {
  /** The run with a step after the confirmation nobody ever stood on. */
  const withUnreachedStep = () =>
    serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
    }));

  it('says so in words instead of showing an empty frame', async () => {
    await withUnreachedStep();
    const { container } = attention('B', 'delivery');

    await settled();
    expect(
      screen.getByRole('heading', {
        name: 'Nobody in your audience reached this step on variant B',
      }),
    ).toBeDefined();
    expect(
      screen.getByText(
        'There is no attention to show here, and that is the result: everyone ended earlier.',
      ),
    ).toBeDefined();
    expect(container.querySelector('[data-section="nobody-reached"]')).not.toBeNull();
  });

  it('offers the list of where they ended instead', async () => {
    await withUnreachedStep();
    attention('B', 'delivery');

    await settled();
    expect(screen.getByRole('link', { name: 'See where they ended' }).getAttribute('href')).toBe(
      sessionsWithVariant(RUN_ID, 'B'),
    );
  });

  it('is not shown while the sessions are still being read', async () => {
    await withUnreachedStep();
    const { container } = attention('B', 'delivery');

    await screen.findByRole('heading', { level: 1, name: HEADING });
    expect(container.querySelector('[data-section="nobody-reached"]')).toBeNull();
  });
});

describe('a session file that cannot be read', () => {
  it('is stated with its path rather than quietly shortening the aggregate', async () => {
    await serveRunData({
      files: { [`/runs/${RUN_ID}/${layout.session('S-13')}`]: 'this is not an artifact' },
    });
    attention('B', 'review');

    await screen.findByRole('heading', { level: 1, name: HEADING });
    const stated = await screen.findByText(/could not be read/);
    expect(stated.textContent).toContain(layout.session('S-13'));
  });
});

describe('accessibility', () => {
  it('passes axe over the screen’s own content', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const screenOnly = container.querySelector('[data-section="attention"]') as HTMLElement;
    const violations = await axeViolations(screenOnly);

    expect(describeViolations(violations)).toBe('');
  });

  it('passes axe on the step nobody reached, which is a sentence and an action', async () => {
    await serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
    }));
    const { container } = attention('B', 'delivery');
    await settled();

    const screenOnly = container.querySelector('[data-section="attention"]') as HTMLElement;
    expect(describeViolations(await axeViolations(screenOnly))).toBe('');
  });
});
