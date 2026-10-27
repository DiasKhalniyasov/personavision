// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths, sessionsWithArea } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';
import { lookedAtShare, medianCaveat, notPresentInVariant } from './attentionWording';

/**
 * The "Areas of interest" table of `#screen-attention`, over the repository's own committed
 * example run: no key, no network, every figure the pipeline wrote.
 *
 * What is asserted is the words a designer reads in a cell and the URL a link carries. The
 * reading that matters is on variant B's review step, where the button that completes the
 * order was never seen: that row has to say `never` and `0%` and nothing that could be read
 * as a very fast look.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const runFile = `/runs/${RUN_ID}/run.json`;

const HEADING = 'Where your audience looked';

/** The eight columns the prototype names, in its order. */
const COLUMNS = [
  'Area of interest',
  'Source',
  'Time to first fixation',
  'First fixation',
  'Total dwell',
  'Fixations',
  'Revisits',
  'Looked at it',
];

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/** One `aoiMetrics` row naming an area this run has no entry for. */
const orphanMetric = (aoiId: string): Run['aoiMetrics'][number] => ({
  aoiId,
  timeToFirstFixationMs: 900,
  firstFixationDurationMs: 300,
  totalDwellMs: 1200,
  fixationCount: 2,
  revisits: 1,
  lookedAtShare: 0.5,
  sessionCount: 9,
});

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

const section = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-section="areas-of-interest"]') as HTMLElement;

/**
 * One area's row, addressed by the id the artifact gives it.
 *
 * The id rather than the label, because the sweep below walks all 55 areas of the committed
 * run and several of them are called the same thing on two steps. What is read out of the
 * row is its cells' own text.
 */
const rowFor = (container: HTMLElement, aoiId: string): HTMLElement =>
  container.querySelector(`tr[data-aoi-row="${aoiId}"]`) as HTMLElement;

const cellsOf = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent?.trim() ?? '');

/** What each of the six metric columns may say, in the order the table draws them. */
const FIGURE_SHAPES = [
  /^(never|\d+(,\d+)*\.\d s)$/,
  /^(—|\d+(,\d+)* ms)$/,
  /^\d+(,\d+)*\.\d s$/,
  /^\d+(,\d+)*$/,
  /^\d+(,\d+)*$/,
  /^(\d+%|<1%|>99%)$/,
];

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the section the figures are in', () => {
  it('carries the prototype’s heading, lede and column set', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    expect(within(section(container)).getByRole('heading', { level: 2 }).textContent).toBe(
      'Areas of interest',
    );
    expect(within(section(container)).getByText(/One row per area of the page/)).toBeDefined();
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual([...COLUMNS, 'The people who looked at it']);
  });

  it('states in its footnote that the figures are medians, and what “looked at it” means', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    expect(within(section(container)).getByText(medianCaveat())).toBeDefined();
  });

  it('ties the table to the overlays as their accessible equivalent', async () => {
    await serveRunData();
    attention('B', 'review');
    await settled();

    const caption = screen.getByRole('table').querySelector('caption');
    expect(caption?.textContent).toContain('heatmap, scanpath and area overlays');
    expect(caption?.textContent).toContain('accessible equivalent');
  });
});

describe('one row per area, with all six metrics', () => {
  it.each([
    ['A', 'cart'],
    ['A', 'payment'],
    ['A', 'review'],
    ['A', 'confirm'],
    ['B', 'cart'],
    ['B', 'payment'],
    ['B', 'review'],
    ['B', 'confirm'],
  ])('reads every figure of every area on variant %s, %s step', async (variant, step) => {
    await serveRunData();
    const { container } = attention(variant, step);
    await settled();

    const here = seedRun().aois.filter((aoi) => aoi.variant === variant && aoi.step === step);
    expect(here.length).toBeGreaterThan(0);

    for (const aoi of here) {
      const cells = cellsOf(rowFor(container, aoi.id));
      expect(cells[0], aoi.id).toBe(aoi.label);
      expect(cells[1], aoi.id).not.toBe('');
      FIGURE_SHAPES.forEach((shape, index) => {
        expect(cells[index + 2], `${aoi.id} column ${index + 3}`).toMatch(shape);
      });
    }
  });

  it('keeps the areas in the artifact’s own order', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const drawn = [...container.querySelectorAll('tr[data-aoi-row]')].map((row) =>
      row.getAttribute('data-aoi-row'),
    );
    const ordered = seedRun()
      .aois.filter((aoi) => aoi.variant === 'B' && aoi.step === 'review')
      .map((aoi) => aoi.id);
    expect(drawn.slice(0, ordered.length)).toEqual(ordered);
  });

  it('names where each boundary came from, and marks the step’s primary action', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const sources = seedRun().aois.filter((aoi) => aoi.variant === 'B' && aoi.step === 'review');
    const words = { dom: 'DOM', a11y: 'Accessibility tree', sam: 'SAM 3.1 segment' };
    for (const aoi of sources) {
      const source = cellsOf(rowFor(container, aoi.id))[1] ?? '';
      expect(source, aoi.id).toContain(words[aoi.source]);
      expect(source.includes('primary action'), aoi.id).toBe(aoi.isPrimaryAction);
    }
    expect(cellsOf(rowFor(container, 'B-review-complete'))[1]).toBe('DOM · primary action');
  });
});

describe('the area nobody in the audience ever looked at', () => {
  it('reads “never” and “0%” on variant B’s completing action', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const cells = cellsOf(rowFor(container, 'B-review-complete'));
    expect(cells[2]).toBe('never');
    expect(cells[7]).toBe('0%');
  });

  it('reads an em dash for the first fixation, and never a zero or a blank', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const cells = cellsOf(rowFor(container, 'B-review-complete'));
    expect(cells[3]).toBe('—');
    expect(cells.slice(2, 8)).not.toContain('0 ms');
    expect(cells.slice(2, 8)).not.toContain('');
  });

  it('is the same area that reads a real first fixation on variant A', async () => {
    await serveRunData();
    const { container } = attention('A', 'review');
    await settled();

    const cells = cellsOf(rowFor(container, 'A-review-complete'));
    expect(cells[2]).toMatch(/^\d+(,\d+)*\.\d s$/);
    expect(cells[2]).not.toBe('never');
  });
});

describe('the people who looked at an area', () => {
  it('offers each row the Sessions list, filtered to that version and area', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    for (const aoi of seedRun().aois.filter(
      (aoi) => aoi.variant === 'B' && aoi.step === 'review',
    )) {
      const link = within(rowFor(container, aoi.id)).getByRole('link');
      expect(link.getAttribute('href'), aoi.id).toBe(sessionsWithArea(RUN_ID, 'B', aoi.id));
      expect(link.textContent, aoi.id).toContain('sessions');
    }
  });

  it('offers it for the area nobody looked at too: that list is a finding, not an error', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    expect(
      within(rowFor(container, 'B-review-complete')).getByRole('link').getAttribute('href'),
    ).toBe(sessionsWithArea(RUN_ID, 'B', 'B-review-complete'));
  });
});

describe('an area this version does not have', () => {
  it('keeps its row and says there is nothing to compare', async () => {
    await serveRunData();
    const { container } = attention('A', 'review');
    await settled();

    const promo = seedRun().aois.find(
      (aoi) => aoi.variant === 'B' && aoi.step === 'review' && aoi.label === 'Promo banner',
    ) as Run['aois'][number];
    const row = rowFor(container, promo.id);
    expect(row).not.toBeNull();
    expect(cellsOf(row)[0]).toBe('Promo banner');
    expect(cellsOf(row)).toContain(notPresentInVariant('A'));
    expect(within(row).queryByRole('link')).toBeNull();
  });
});

describe('a run artifact that disagrees with itself', () => {
  /** One metrics row with only one half of "never" written on it. */
  const withHalfOfNever = (half: 'no-fixation' | 'nobody-looked') =>
    serveChangedRun((run) => ({
      ...run,
      aoiMetrics: run.aoiMetrics.map((metric) =>
        metric.aoiId === 'B-review-complete'
          ? half === 'no-fixation'
            ? { ...metric, lookedAtShare: 0.5 }
            : { ...metric, timeToFirstFixationMs: 1200, firstFixationDurationMs: 300 }
          : metric,
      ),
    }));

  it.each(['no-fixation', 'nobody-looked'] as const)(
    'states the fault and names the area instead of a number (%s)',
    async (half) => {
      await withHalfOfNever(half);
      const { container } = attention('B', 'review');
      await settled();

      const row = rowFor(container, 'B-review-complete');
      expect(row.getAttribute('data-area-fault')).toBe('inconsistent');
      const stated = cellsOf(row).join(' ');
      expect(stated).toContain('B-review-complete');
      expect(stated).toContain('These figures disagree');
      expect(stated).not.toContain('never');
      expect(stated).not.toMatch(/\d+ ms/);
    },
  );

  it('states figures that name no area of this test rather than dropping them', async () => {
    await serveChangedRun((run) => ({
      ...run,
      aoiMetrics: [...run.aoiMetrics, orphanMetric('a-box-that-is-not-here')],
    }));
    const { container } = attention('B', 'review');
    await settled();

    const fault = container.querySelector('tr[data-area-fault="unknown-area"]') as HTMLElement;
    expect(fault).not.toBeNull();
    expect(fault.textContent).toContain('a-box-that-is-not-here');
    expect(fault.textContent).toContain('not an area of this test');
  });

  it('states the fault when nothing was fixated but a first fixation is timed', async () => {
    await serveChangedRun((run) => ({
      ...run,
      aoiMetrics: run.aoiMetrics.map((metric) =>
        metric.aoiId === 'B-review-complete' ? { ...metric, firstFixationDurationMs: 480 } : metric,
      ),
    }));
    const { container } = attention('B', 'review');
    await settled();

    const row = rowFor(container, 'B-review-complete');
    expect(row.getAttribute('data-area-fault')).toBe('inconsistent');
    const stated = cellsOf(row).join(' ');
    expect(stated).toContain('B-review-complete');
    expect(stated).toContain('480 ms');
    expect(stated).not.toContain('never');
  });

  it('states one row per unknown area, however many rows of figures name it', async () => {
    await serveChangedRun((run) => ({
      ...run,
      aoiMetrics: [
        ...run.aoiMetrics,
        orphanMetric('a-box-that-is-not-here'),
        { ...orphanMetric('a-box-that-is-not-here'), fixationCount: 5 },
      ],
    }));
    const { container } = attention('B', 'review');
    await settled();

    expect(container.querySelectorAll('tr[data-area-fault="unknown-area"]').length).toBe(1);
  });

  it('keeps the rest of the areas readable while one of them is a fault', async () => {
    await withHalfOfNever('nobody-looked');
    const { container } = attention('B', 'review');
    await settled();

    const summary = cellsOf(rowFor(container, 'B-review-summary'));
    expect(summary[7]).toBe(lookedAtShare(1));
  });
});

describe('a step with no areas of interest', () => {
  /** A step after the confirmation that nothing was ever marked on. */
  const withBareStep = () =>
    serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
    }));

  it('says so in one sentence rather than an empty table body', async () => {
    await withBareStep();
    const { container } = attention('B', 'delivery');
    await settled();

    expect(
      within(section(container)).getByText(/marked no areas of interest on this step of variant B/),
    ).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('still says so when the artifact also carries figures naming no area at all', async () => {
    // The two are different statements about different things, so one never silences the
    // other: this step holds nothing, and the run is wrong somewhere else.
    await serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
      aoiMetrics: [...run.aoiMetrics, orphanMetric('a-box-that-is-not-here')],
    }));
    const { container } = attention('B', 'delivery');
    await settled();

    expect(
      within(section(container)).getByText(/marked no areas of interest on this step of variant B/),
    ).toBeDefined();
    expect(
      (container.querySelector('tr[data-area-fault="unknown-area"]') as HTMLElement).textContent,
    ).toContain('a-box-that-is-not-here');
  });
});

describe('accessibility', () => {
  it('passes axe over the table', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    expect(describeViolations(await axeViolations(section(container)))).toBe('');
  });

  it('passes axe over a step whose areas are a sentence rather than a table', async () => {
    await serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
    }));
    const { container } = attention('B', 'delivery');
    await settled();

    expect(describeViolations(await axeViolations(section(container)))).toBe('');
  });

  it('reaches the first row from the keyboard, and scrolls the table with it', async () => {
    await serveRunData();
    const { container } = attention('B', 'review');
    await settled();

    const region = within(section(container)).getByRole('region', {
      name: 'Areas of interest and their figures',
    });
    region.focus();
    expect(document.activeElement).toBe(region);

    await userEvent.tab();
    const first = seedRun().aois.find((aoi) => aoi.variant === 'B' && aoi.step === 'review');
    expect(document.activeElement).toBe(
      within(rowFor(container, (first as Run['aois'][number]).id)).getByRole('link'),
    );
  });
});
