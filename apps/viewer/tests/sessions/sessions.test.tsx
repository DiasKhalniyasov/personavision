// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { axePass, describeViolations } from '../axe';
import { paths } from '../../src/shell/paths';

/**
 * The Sessions screen, over the committed seed example run.
 *
 * Everything here is asserted through the words on screen and the places a click lands —
 * what a designer opening `/runs/:runId/sessions` on a clean checkout actually gets — and
 * nothing is asserted about a component's internals or its classes.
 */

const SEED = '2026-10-24-1402-northwind-demo';

/** The run's own manifest, so the test asserts the artifact's order rather than its own. */
const sessionIds = (): string[] => readRunFile(SEED).sessionIds as string[];

/** JSX wraps a paragraph over several lines; a reader sees one line of prose. */
const prose = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** The table's body rows, once every session file has arrived. */
const dataRows = async (): Promise<HTMLElement[]> => {
  const table = await screen.findByRole('table');
  const [, body] = within(table).getAllByRole('rowgroup');
  return within(body as HTMLElement).getAllByRole('row');
};

const rowFor = async (sessionId: string): Promise<HTMLElement> => {
  const link = await screen.findByRole('link', { name: sessionId });
  const row = link.closest('tr');
  if (row === null) throw new Error(`${sessionId} is not in a row`);
  return row;
};

const cells = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole('cell')
    .map((cell) => prose(cell.textContent));

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the Sessions screen', () => {
  it('leads with what the screen is for, and says the numbers are simulated', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    expect(
      await screen.findByRole('heading', { name: 'What happened to each person' }),
    ).toBeTruthy();
    expect(
      screen.getByText('One row per generated person × version × seed. Open one to watch it back.'),
    ).toBeTruthy();
    expect(screen.getByText(/Every number here is simulated for this audience\./)).toBeTruthy();
  });

  it('lists one row per session in run.json, in that order, named S-01 … S-NN', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    const rows = await dataRows();
    const ids = sessionIds();
    expect(rows).toHaveLength(ids.length);
    expect(ids[0]).toBe('S-01');
    expect(ids.at(-1)).toBe('S-24');

    const rendered = rows.map((row) => within(row).getByRole('link').textContent);
    expect(rendered).toEqual(ids);
  });

  it('shows persona and seed, variant, device, outcome, time, fixations, attribution and where it ended', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    const row = await rowFor('S-15');
    await waitFor(() => {
      expect(cells(row)).toHaveLength(9);
    });

    expect(cells(row)).toEqual([
      'S-15',
      'Rushed buyer seed 3',
      'B',
      'iPhone 15',
      'Abandoned',
      '38.0 s',
      '23',
      'product',
      'Review — service fee revealed, left without ordering',
    ]);
  });

  it('states the totals the run holds, rather than counting the rows on screen', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    // 24 sessions; 11 + 11 scored; one automation failure on each version.
    expect(
      await screen.findByText('24 people · 22 scored · 2 excluded because our automation broke'),
    ).toBeTruthy();
  });

  it('says in its own words why an automation failure is ours and not the checkout’s', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    const footnote = await screen.findByText(/When our own browser automation breaks/);
    expect(prose(footnote.textContent)).toContain(
      "that is our fault and never your checkout's: those people are excluded from every figure, " +
        "including the friction score and each area's numbers",
    );
    expect(prose(footnote.textContent)).toContain(
      'Somebody giving up, somebody ending without the task done, and our automation breaking are ' +
        'three different things and are never merged',
    );
  });
});

describe('abandoned, failed and our automation breaking', () => {
  it('are three different things on the row, and an automation failure is attributed to us', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    // S-09 and S-23 are the run's two automation failures, one on each version.
    for (const sessionId of ['S-09', 'S-23']) {
      const row = await rowFor(sessionId);
      await waitFor(() => {
        expect(cells(row).length).toBe(9);
      });
      const read = cells(row).join(' | ');
      expect(read, sessionId).toContain('Automation failure');
      expect(read, sessionId).toContain('excluded');
      expect(read, sessionId).toContain('automation');
      // It is never a failure of the product under test.
      expect(read, sessionId).not.toContain('Failed');
      expect(read, sessionId).not.toContain('product');
    }

    // The other two non-success outcomes keep their own words.
    const abandoned = cells(await rowFor('S-11')).join(' | ');
    expect(abandoned).toContain('Abandoned');
    expect(abandoned).not.toContain('Automation failure');

    const failed = await rowFor('S-13');
    await waitFor(() => {
      expect(cells(failed).length).toBe(9);
    });
    const read = cells(failed).join(' | ');
    expect(read).toContain('Failed');
    expect(read).toContain('product');
    expect(read).not.toContain('Automation failure');
    expect(read).not.toContain('excluded');
  });
});

describe('the drill-down', () => {
  it('opens that person’s replay when the row is clicked', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(paths.sessions(SEED));

    const row = await rowFor('S-15');
    await waitFor(() => {
      expect(cells(row).length).toBe(9);
    });
    // Anywhere in the row that is not the link itself.
    const where = within(row).getByRole('cell', {
      name: 'Review — service fee revealed, left without ordering',
    });
    await user.click(where);

    expect(router.state.location.pathname).toBe(paths.session(SEED, 'S-15'));
  });

  it('is reachable and activatable from the keyboard', async () => {
    const user = userEvent.setup();
    await serveRunData();
    const { router } = mountApp(paths.sessions(SEED));

    const link = await screen.findByRole('link', { name: 'S-15' });
    expect(link.getAttribute('href')).toBe(paths.session(SEED, 'S-15'));

    link.focus();
    expect(document.activeElement).toBe(link);
    await user.keyboard('{Enter}');

    expect(router.state.location.pathname).toBe(paths.session(SEED, 'S-15'));
  });
});

describe('a run the screen cannot list', () => {
  it('renders the shell’s not-found state for a test id this workspace has no test for', async () => {
    await serveRunData();
    mountApp(paths.sessions('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('[data-shell="chrome"]')).not.toBeNull();
  });

  it('says a test recorded nobody, rather than drawing a table head over nothing', async () => {
    const run = { ...readRunFile(SEED), sessionIds: [], scores: [] };
    await serveRunData({ files: { [`/runs/${SEED}/run.json`]: JSON.stringify(run) } });
    mountApp(paths.sessions(SEED));

    expect(
      await screen.findByRole('heading', { name: 'This test recorded no people' }),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    // "No people" and "no match" are different facts and must not share wording.
    expect(screen.queryByText(/No session matches/)).toBeNull();
  });

  it('keeps the row of a session whose file cannot be read, and says so in place of its numbers', async () => {
    await serveRunData({ files: { [`/runs/${SEED}/sessions/S-15.json`]: null } });
    mountApp(paths.sessions(SEED));

    const rows = await dataRows();
    expect(rows).toHaveLength(sessionIds().length);

    const row = await rowFor('S-15');
    await waitFor(() => {
      expect(prose(row.textContent)).toContain('could not be read');
    });
    expect(prose(row.textContent)).toContain(`/runs/${SEED}/sessions/S-15.json`);
    // The one before it is unharmed: one unreadable file is not a broken screen.
    expect(cells(await rowFor('S-14'))).toContain('Failed');
  });
});

describe('the screen as a screen reader and a keyboard reach it', () => {
  it('passes axe', async () => {
    await serveRunData();
    mountApp(paths.sessions(SEED));

    const row = await rowFor('S-24');
    await waitFor(() => {
      expect(cells(row).length).toBe(9);
    });

    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    const results = await axePass(main as HTMLElement);

    expect(describeViolations(results.violations)).toBe('');
    // And the pass was not vacuous: jsdom decided the rules this screen is made of —
    // the table's headers and their cells, the links' names, the heading order.
    expect(results.passes.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        'empty-table-header',
        'th-has-data-cells',
        'td-headers-attr',
        'link-name',
        'heading-order',
      ]),
    );
  }, 20_000);
});
