// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { axePass, describeViolations } from '../axe';
import { paths } from '../../src/shell/paths';

/**
 * Filtering the Sessions screen, over the committed seed example run.
 *
 * Everything is asserted through what a designer sees and the URL they can share: which
 * rows survive a filter, what the query string reads after a control is used, and the words
 * of the screen a filter matching nothing produces. Nothing is asserted about component
 * state, because there is none to assert — the filters are the URL.
 */

const SEED = '2026-10-24-1402-northwind-demo';

/** The run's own facts, from `scripts/seed-example-run.ts`. */
const SUCCEEDED_ON_A = ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08', 'S-10'];
const AUTOMATION_FAILURES = ['S-09', 'S-23'];
/** `Confirm purchase` on the redesign's review step: no session ever fixated it. */
const CONFIRM_PURCHASE = 'B-review-complete';
/** `Place order` on the current checkout's review step: every session that got there did. */
const PLACE_ORDER = 'A-review-complete';

const prose = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** The session ids the table is listing, once the run's sessions have been read. */
const listed = async (expected: number): Promise<string[]> => {
  const table = await screen.findByRole('table');
  const [, body] = within(table).getAllByRole('rowgroup');
  return await waitFor(() => {
    const rows = within(body as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(expected);
    return rows.map((row) => within(row).getByRole('link').textContent ?? '');
  });
};

/**
 * One segmented control. The registry's toggle group is a **toolbar** of pressed buttons,
 * which is the role a row of toggles carries; what says which way the list is narrowed is
 * each button's own `aria-pressed`.
 */
const segment = (name: string): HTMLElement => screen.getByRole('toolbar', { name });

const option = (group: string, name: string): HTMLElement =>
  within(segment(group)).getByRole('button', { name });

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the filters a URL carries', () => {
  it('narrows the list to one outcome', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?outcome=automation_failure`);

    expect(await listed(2)).toEqual(AUTOMATION_FAILURES);
    // And the counts line says how much of the test is on screen.
    expect(screen.getByText('2 of 24 sessions')).toBeTruthy();
  });

  it('narrows the list to the people who fixated one area of interest', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?aoi=${PLACE_ORDER}`);

    expect(await listed(SUCCEEDED_ON_A.length)).toEqual(SUCCEEDED_ON_A);
  });

  it('narrows further as a version and an outcome combine', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?variant=B&outcome=failed`);

    expect(await listed(3)).toEqual(['S-13', 'S-14', 'S-19']);
  });

  it('narrows further still with an area of interest on top of both', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?variant=A&outcome=success&aoi=${PLACE_ORDER}`);

    expect(await listed(SUCCEEDED_ON_A.length)).toEqual(SUCCEEDED_ON_A);
  });

  it('shows a chip naming the area a reader arrived from, and widens the list when it is dismissed', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(`${paths.sessions(SEED)}?aoi=${PLACE_ORDER}`);

    await listed(SUCCEEDED_ON_A.length);
    const chip = screen.getByRole('button', { name: 'Fixated: Place order' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    await user.click(chip);

    expect(router.state.location.search).toBe('');
    expect(await listed(24)).toHaveLength(24);
    expect(screen.queryByRole('button', { name: /^Fixated:/ })).toBeNull();
  });

  it('states the run’s own totals when nothing is filtered', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    expect(
      await screen.findByText('24 people · 22 scored · 2 excluded because our automation broke'),
    ).toBeTruthy();
    expect(screen.queryByText(/of 24 sessions/)).toBeNull();
  });
});

describe('the segmented controls', () => {
  it('write the filter into the URL and show which way the list is narrowed', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(paths.sessions(SEED));

    await listed(24);
    const outcomes = segment('Filter by outcome');
    expect(
      within(outcomes).getByRole('button', { name: 'All outcomes' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await user.click(within(outcomes).getByRole('button', { name: 'Abandoned' }));

    expect(router.state.location.search).toBe('?outcome=abandoned');
    expect(await listed(8)).toEqual([
      'S-11',
      'S-12',
      'S-15',
      'S-17',
      'S-18',
      'S-20',
      'S-22',
      'S-24',
    ]);
    expect(
      within(segment('Filter by outcome'))
        .getByRole('button', { name: 'Abandoned' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(segment('Filter by outcome'))
        .getByRole('button', { name: 'All outcomes' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('offers Automation failure, so those two people are findable rather than spotted by eye', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(paths.sessions(SEED));

    await listed(24);
    await user.click(option('Filter by outcome', 'Automation failure'));

    expect(router.state.location.search).toBe('?outcome=automation_failure');
    expect(await listed(2)).toEqual(AUTOMATION_FAILURES);
  });

  it('combine with one another, and the “All …” option clears one filter without the other', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(`${paths.sessions(SEED)}?outcome=success`);

    await listed(11);
    await user.click(option('Filter by version', 'B'));

    expect(router.state.location.search).toBe('?outcome=success&variant=B');
    expect(await listed(2)).toEqual(['S-16', 'S-21']);

    await user.click(option('Filter by outcome', 'All outcomes'));

    expect(router.state.location.search).toBe('?variant=B');
    expect(await listed(12)).toHaveLength(12);
  });

  it('are operable from the keyboard', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(paths.sessions(SEED));

    await listed(24);
    const all = option('Filter by version', 'All variants');
    all.focus();
    expect(document.activeElement).toBe(all);

    // A segmented control is one tab stop, and the arrow keys walk its options.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(option('Filter by version', 'A'));
    await user.keyboard('{Enter}');

    expect(router.state.location.search).toBe('?variant=A');
    expect(await listed(12)).toHaveLength(12);
  });
});

describe('a filter that matches nothing', () => {
  const impossible = `${paths.sessions(SEED)}?variant=B&outcome=success&aoi=${CONFIRM_PURCHASE}`;

  it('says so in words, with the finding behind it', async () => {
    await serveRunData();
    mountApp(impossible);

    expect(await screen.findByRole('heading', { name: 'No session matches' })).toBeTruthy();

    const sentence = await screen.findByText(/nobody both looked at/);
    expect(prose(sentence.textContent)).toBe(
      'On Redesign candidate, nobody both looked at Confirm purchase and finished the task. ' +
        'That is the finding, not an empty table: of the 9 people who reached the Review step, ' +
        'not one ever looked at it.',
    );
    // The area is the one word the sentence leans on.
    expect(within(sentence).getByText('Confirm purchase').tagName).toBe('B');

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 of 24 sessions')).toBeTruthy();
  });

  it('clears the filters back to the unfiltered list', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(impossible);

    await screen.findByRole('heading', { name: 'No session matches' });
    await user.click(screen.getByRole('link', { name: 'Clear filters' }));

    expect(router.state.location.pathname).toBe(paths.sessions(SEED));
    expect(router.state.location.search).toBe('');
    expect(await listed(24)).toHaveLength(24);
  });

  it('opens the heatmap for the version and step the reader asked about', async () => {
    await serveRunData();
    mountApp(impossible);

    await screen.findByRole('heading', { name: 'No session matches' });
    const heatmap = screen.getByRole('link', { name: 'See the heatmap for Redesign candidate' });

    expect(heatmap.getAttribute('href')).toBe(paths.attention(SEED, 'B', 'review'));
  });

  it('is never what a test that recorded nobody gets, even on this very URL', async () => {
    // A test with no people and a filter matching none of them are different facts, and a
    // reader who read one as the other would draw the wrong conclusion about their
    // checkout. So the same impossible URL over a run with no sessions keeps #21's wording.
    const run = { ...readRunFile(SEED), sessionIds: [], scores: [] };
    await serveRunData({ files: { [`/runs/${SEED}/run.json`]: JSON.stringify(run) } });
    mountApp(impossible);

    expect(
      await screen.findByRole('heading', { name: 'This test recorded no people' }),
    ).toBeTruthy();
    expect(screen.queryByText('No session matches')).toBeNull();
    // And no filter row over a test with nothing to filter.
    expect(screen.queryByRole('toolbar', { name: 'Filter by outcome' })).toBeNull();
  });
});

describe('a URL naming something this test has no entry for', () => {
  it('drops the bad value and lists the test, rather than rendering a blank screen', async () => {
    await serveRunData();
    const { router } = mountApp(`${paths.sessions(SEED)}?variant=Z&outcome=sideways&aoi=no-such`);

    expect(await listed(24)).toHaveLength(24);
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(screen.queryByText('No session matches')).toBeNull();
  });

  it('keeps the half of the link that does name something', async () => {
    await serveRunData();
    const { router } = mountApp(`${paths.sessions(SEED)}?variant=A&aoi=no-such-area`);

    expect(await listed(12)).toHaveLength(12);
    await waitFor(() => {
      expect(router.state.location.search).toBe('?variant=A');
    });
  });
});

describe('the filtered screen as a screen reader and a keyboard reach it', () => {
  it('passes axe with the filters applied', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?variant=A&outcome=success&aoi=${PLACE_ORDER}`);

    await listed(SUCCEEDED_ON_A.length);
    const main = document.querySelector('main');
    const results = await axePass(main as HTMLElement);

    expect(describeViolations(results.violations)).toBe('');
    expect(results.passes.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(['button-name', 'aria-allowed-attr', 'aria-valid-attr-value']),
    );
  }, 60_000);

  it('passes axe on the no-match screen', async () => {
    await serveRunData();
    mountApp(`${paths.sessions(SEED)}?variant=B&outcome=success&aoi=${CONFIRM_PURCHASE}`);

    await screen.findByRole('heading', { name: 'No session matches' });
    const main = document.querySelector('main');
    const results = await axePass(main as HTMLElement);

    expect(describeViolations(results.violations)).toBe('');
    expect(results.passes.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(['link-name', 'heading-order', 'button-name']),
    );
  }, 60_000);
});
