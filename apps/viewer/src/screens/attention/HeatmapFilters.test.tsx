// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateSchema, runPaths } from '@personavision/contract';
import type { Aggregate, ScreenSlice } from '@personavision/contract';
import { heatmapLink, paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';
import { noAggregate } from './attentionWording';
import { screenFiguresFrom } from './useScreenFigures';
import { CLICKS_LAYER } from './stage/ClicksLayer';
import { SCROLL_LAYER } from './stage/ScrollDepthLayer';
import type { OverlayLayerProps } from './stage/overlayLayers';

/**
 * The Heatmaps screen's two filters, its three overlays and the URL that carries all of it.
 *
 * This suite is the one that holds the screen to its central promise: **every figure on it
 * is the aggregate's own slice for the composition chosen, and nothing is re-derived in the
 * browser**. The way it does that is to serve an aggregate whose filtered slices do *not*
 * add up to its unfiltered one — a file no honest pipeline would write, and exactly the file
 * that tells a reading apart from a recount. A screen that counted the sessions itself would
 * disagree with every assertion below.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');
const HEADING = 'Where they looked, clicked and stopped scrolling';

const seedAggregate = (): Aggregate => aggregateSchema.parse(readRunFile(RUN_ID, layout.aggregate));

const aggregateFile = `/runs/${RUN_ID}/${layout.aggregate}`;

/** The committed aggregate with something changed in it, served in its place. */
const serveAggregate = async (change: (aggregate: Aggregate) => Aggregate) => {
  const changed = change(seedAggregate());
  await serveRunData({ files: { [aggregateFile]: JSON.stringify(changed) } });
  return changed;
};

/** One slice of the committed file, rewritten. */
const mapSlice = (
  aggregate: Aggregate,
  pick: (slice: ScreenSlice) => boolean,
  change: (slice: ScreenSlice) => ScreenSlice,
): Aggregate => ({
  ...aggregate,
  screenSlices: aggregate.screenSlices.map((slice) => (pick(slice) ? change(slice) : slice)),
});

/** One screen row of a slice, rewritten. */
const mapScreen = (
  slice: ScreenSlice,
  variant: string,
  step: string,
  change: (row: ScreenSlice['screens'][number]) => ScreenSlice['screens'][number],
): ScreenSlice => ({
  ...slice,
  screens: slice.screens.map((row) =>
    row.variant === variant && row.step === step ? change(row) : row,
  ),
});

const heatmaps = (variant: string, step: string, query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

const settled = async () => {
  await screen.findByRole('heading', { level: 1, name: HEADING });
  await waitFor(() => {
    expect(screen.getByText('Reached it').nextElementSibling?.textContent).not.toContain('reading');
  });
  await waitFor(() => {
    expect(document.querySelector('[data-aoi-row]')).not.toBeNull();
  });
};

/** The page as it is once its screenshot has arrived, which jsdom never does on its own. */
const decoded = (container: HTMLElement) => {
  const image = container.querySelector('#att-page img');
  if (image !== null) fireEvent.load(image as HTMLImageElement);
};

/** The Overlays panel's own switch for one layer, by the id it is registered under. */
const toggleFor = (id: string) =>
  document.querySelector(`[data-overlay-toggle="${id}"]`) as HTMLElement;

/** The control-row strip's own button for one overlay. */
const stripButton = (overlay: string) =>
  document.querySelector(`[data-overlay="${overlay}"]`) as HTMLElement;

const layerIn = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-overlay-layer="${id}"]`);

const whyFor = (control: HTMLElement) =>
  document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent ?? '';

const reading = (term: string): string =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

const clicksCellFor = (container: HTMLElement, aoiId: string): string =>
  (container.querySelector(`[data-clicks-cell="${aoiId}"]`) as HTMLElement | null)?.textContent ??
  '';

/** What a layer is handed when the question is only what it says about its figures. */
const NO_LAYER_DATA: Omit<OverlayLayerProps, 'screen'> = {
  fixations: [],
  saccades: [],
  areas: [],
  isolatedAoiId: null,
  transform: { pageWidth: 390, pageHeight: 1540 },
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the three overlays', () => {
  it('each draw over the page, with the fold on it, and toggle independently', async () => {
    await serveRunData();
    // All three at once, which is what "independently" has to be asserted against.
    const { container } = heatmaps(
      'B',
      'payment',
      '?overlay=clicks&overlay=attention&overlay=scroll',
    );
    await settled();
    decoded(container);

    await waitFor(() => {
      expect(layerIn(container, 'clicks')).not.toBeNull();
    });
    expect(layerIn(container, 'heat')).not.toBeNull();
    expect(layerIn(container, 'scroll')).not.toBeNull();
    // The fold is the page's own, drawn whatever is over it.
    expect(container.querySelector('#att-page [data-fold]')).not.toBeNull();

    // One switch off takes one layer away and leaves the other two where they were.
    await userEvent.click(toggleFor('clicks'));
    expect(layerIn(container, 'clicks')).toBeNull();
    expect(layerIn(container, 'heat')).not.toBeNull();
    expect(layerIn(container, 'scroll')).not.toBeNull();

    await userEvent.click(toggleFor('scroll'));
    expect(layerIn(container, 'clicks')).toBeNull();
    expect(layerIn(container, 'heat')).not.toBeNull();
    expect(layerIn(container, 'scroll')).toBeNull();
  });

  it('mounts the existing attention layer, and no second heat accumulation exists here', () => {
    // The acceptance criterion is about this screen's **files**: the dwell-weighted layer is
    // #71's, mounted, and nothing in this directory accumulates heat a second time.
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      ...readdirSync(here).map((name) => join(here, name)),
      ...readdirSync(join(here, 'stage')).map((name) => join(here, 'stage', name)),
    ].filter(
      (path) => /\.tsx?$/.test(path) && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'),
    );

    const accumulators = files.filter((path) =>
      /export (const|function) accumulate/.test(readFileSync(path, 'utf8')),
    );
    expect(accumulators.map((path) => path.replace(`${here}/`, ''))).toEqual([
      'stage/heatAccumulation.ts',
    ]);
  });

  it('each name what they show, in words, beside the switch', async () => {
    await serveRunData();
    const { container } = heatmaps(
      'B',
      'payment',
      '?overlay=clicks&overlay=attention&overlay=scroll',
    );
    await settled();
    decoded(container);

    // Not "there is a heatmap here": what it shows, with the figures in it, because a
    // coloured rectangle and a shaded band are nothing to a reader who cannot see them.
    await waitFor(() => {
      expect(document.querySelector('[data-clicks-key]')).not.toBeNull();
    });
    const clicks = document.querySelector('[data-clicks-key]') as HTMLElement;
    expect(clicks.textContent).toContain('one click');
    expect(clicks.textContent).toMatch(/\d+ on /);

    const scroll = document.querySelector('[data-scroll-key]') as HTMLElement;
    expect(scroll.textContent).toContain('scrolled past the fold');
    expect(scroll.textContent).toContain('bands down the page');

    expect(document.querySelector('[data-heat-key]')).not.toBeNull();
  });
});

describe('the clicks and scroll-depth layers read the aggregate’s own rows', () => {
  it('draws a different clicks mark when the fixture’s click count changes', async () => {
    await serveRunData();
    const first = heatmaps('B', 'payment', '?overlay=clicks');
    await settled();
    decoded(first.container);
    await waitFor(() => {
      expect(
        first.container.querySelector('[data-clicks-area="B-payment-primary"]'),
      ).not.toBeNull();
    });
    const before = first.container
      .querySelector('[data-clicks-area="B-payment-primary"]')
      ?.getAttribute('data-clicks');
    expect(before).toBe('9');

    first.unmount();
    forgetRuns();

    // One bin changed in the file and nothing else.
    await serveAggregate((aggregate) =>
      mapSlice(
        aggregate,
        (slice) => slice.segment === null && slice.outcome === null,
        (slice) =>
          mapScreen(slice, 'B', 'payment', (row) => ({
            ...row,
            clicksByAoi: row.clicksByAoi.map((entry) =>
              entry.aoiId === 'B-payment-primary' ? { ...entry, clicks: 4 } : entry,
            ),
          })),
      ),
    );
    const second = heatmaps('B', 'payment', '?overlay=clicks');
    await settled();
    decoded(second.container);

    await waitFor(() => {
      expect(
        second.container
          .querySelector('[data-clicks-area="B-payment-primary"]')
          ?.getAttribute('data-clicks'),
      ).toBe('4');
    });
  });

  it('shades a different band when the fixture’s scroll bins change', async () => {
    // The committed run's B payment screen: ten people, all of them in the last band.
    await serveAggregate((aggregate) =>
      mapSlice(
        aggregate,
        (slice) => slice.segment === null && slice.outcome === null,
        (slice) =>
          mapScreen(slice, 'B', 'payment', (row) => ({
            ...row,
            scrollDepth: { bins: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0], pastFoldSessions: 0 },
          })),
      ),
    );
    const { container } = heatmaps('B', 'payment', '?overlay=scroll');
    await settled();
    decoded(container);

    // Everybody's deepest band is the first, so the first band is everyone and the rest are
    // nobody — which is the opposite of what the committed file says, and is drawn as such.
    await waitFor(() => {
      expect(container.querySelector('[data-scroll-band="0"]')?.getAttribute('data-saw-it')).toBe(
        '10',
      );
    });
    expect(container.querySelector('[data-scroll-band="9"]')).toBeNull();
  });

  it('states a screen with no click recorded rather than drawing an empty layer', async () => {
    await serveAggregate((aggregate) =>
      mapSlice(
        aggregate,
        (slice) => slice.segment === null && slice.outcome === null,
        (slice) =>
          mapScreen(slice, 'B', 'payment', (row) => ({
            ...row,
            clicksByAoi: row.clicksByAoi.map((entry) => ({ ...entry, clicks: 0 })),
          })),
      ),
    );
    const { container } = heatmaps('B', 'payment', '?overlay=clicks');
    await settled();
    decoded(container);

    await waitFor(() => {
      expect(layerIn(container, 'clicks')).toBeNull();
    });
    expect(whyFor(toggleFor('clicks'))).toBe(
      'Not one of these people pressed anything on this screen. That is the reading, not a gap: there is no click to draw.',
    );
    // No key either: a ramp for colours that are not on the page is a reading of nothing.
    expect(document.querySelector('[data-clicks-key]')).toBeNull();
  });

  it('offers both bin layers and says what is absent when neither was recorded', async () => {
    // Decision 74: the overlays are offered and name what is missing, rather than vanishing.
    // Here the file is there and says, honestly, that nothing was pressed and nobody's depth
    // was measured on this screen — which is not the same as a run with no aggregate at all.
    await serveAggregate((aggregate) =>
      mapSlice(
        aggregate,
        (slice) => slice.segment === null && slice.outcome === null,
        (slice) =>
          mapScreen(slice, 'B', 'payment', (row) => ({
            ...row,
            clicksByAoi: row.clicksByAoi.map((entry) => ({ ...entry, clicks: 0 })),
            scrollDepth: { bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pastFoldSessions: 0 },
          })),
      ),
    );
    const { container } = heatmaps(
      'B',
      'payment',
      '?overlay=clicks&overlay=attention&overlay=scroll',
    );
    await settled();
    decoded(container);

    await waitFor(() => {
      expect(layerIn(container, 'clicks')).toBeNull();
    });
    expect(whyFor(toggleFor('clicks'))).toContain('Not one of these people pressed anything');
    expect(whyFor(toggleFor('scroll'))).toContain('recorded no scroll depth on this screen');
    // Both switches are still there: a reader who cannot find the layer cannot tell it
    // apart from a product that does not have one.
    expect(toggleFor('clicks')).not.toBeNull();
    expect(toggleFor('scroll')).not.toBeNull();
    // The attention layer reads the sessions themselves, so it is unaffected.
    await waitFor(() => {
      expect(layerIn(container, 'heat')).not.toBeNull();
    });
  });

  it('says a run computed no aggregate at all, which is not a run of zeroes', () => {
    // A run directory with no `aggregate.json` answers 404, which `useAggregate` reports as
    // `none`. Asserted on the view rather than over a server, because the harness serves
    // the committed file for every run it knows.
    const nothing = screenFiguresFrom({ status: 'none' }, 'B', 'payment', null, null);
    for (const layer of [CLICKS_LAYER, SCROLL_LAYER]) {
      expect(layer.unavailable?.({ ...NO_LAYER_DATA, screen: nothing }), layer.id).toContain(
        'This test recorded no clicks and no scroll depth',
      );
    }
    expect(noAggregate()).toContain('The attention overlay reads the sessions themselves');
  });
});

describe('marks stay registered to the screenshot', () => {
  it('are placed in the page’s own units, so two frame widths draw them identically', async () => {
    await serveRunData();
    const { container } = heatmaps('B', 'payment', '?overlay=clicks&overlay=scroll');
    await settled();
    decoded(container);
    await waitFor(() => {
      expect(layerIn(container, 'clicks')).not.toBeNull();
    });

    const placed = () => ({
      clicks: [...container.querySelectorAll('[data-clicks-area]')].map((mark) => [
        mark.getAttribute('x'),
        mark.getAttribute('y'),
        mark.getAttribute('width'),
        mark.getAttribute('height'),
      ]),
      viewBox: container
        .querySelector('[data-overlay-layer="clicks"] svg')
        ?.getAttribute('viewBox'),
      bands: [...container.querySelectorAll('[data-scroll-band]')].map(
        (band) => (band as HTMLElement).style.cssText,
      ),
    });

    const atOneWidth = placed();

    // The frame is the window onto the page and the zoom is what changes its width; the
    // marks are in the page's own coordinates, so neither reaches them.
    await userEvent.click(screen.getByRole('radio', { name: '50%' }));
    expect(placed()).toEqual(atOneWidth);
    await userEvent.click(screen.getByRole('radio', { name: '200%' }));
    expect(placed()).toEqual(atOneWidth);

    // And they are percentages and overlay units rather than pixels, which is what makes
    // that true by construction rather than by arithmetic.
    expect(atOneWidth.bands.every((band) => band.includes('%'))).toBe(true);
    expect(atOneWidth.clicks.length).toBeGreaterThan(0);
  });
});

describe('the two filters', () => {
  it('offer every slice the aggregate holds, with its own words and count', async () => {
    await serveRunData();
    heatmaps('B', 'payment');
    await settled();

    const words = (section: string) =>
      [
        ...within(document.querySelector(`[data-section="${section}"]`) as HTMLElement)
          .getAllByRole('button')
          .values(),
      ].map((button) => button.textContent);

    expect(words('outcome-strip')).toEqual(['All 22', 'Completed 11', 'Gave up 8', 'Failed 3']);
    expect(words('segment-strip')).toEqual([
      'All 22',
      'Desktop · compares carefully 6',
      'Desktop · first visit 5',
      'Mobile · in a hurry 6',
      'Mobile · price-sensitive 5',
    ]);
  });

  it('compose, and every figure is the composed slice’s own rather than a recount', async () => {
    // A file whose composed slice disagrees with any arithmetic over the two filters alone:
    // a browser-side recount could not produce these numbers from the others.
    await serveAggregate((aggregate) =>
      mapSlice(
        aggregate,
        (slice) => slice.segment === 'mobile · in a hurry' && slice.outcome === 'abandoned',
        (slice) =>
          mapScreen(slice, 'B', 'payment', (row) => ({
            ...row,
            reached: 1,
            leftHere: 1,
            medianMsOnIt: 77_000,
            clicksByAoi: [{ aoiId: 'B-payment-primary', clicks: 6 }],
            scrollDepth: { bins: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], pastFoldSessions: 1 },
          })),
      ),
    );
    const { container } = heatmaps(
      'B',
      'payment',
      '?overlay=clicks&outcome=abandoned&segment=mobile%20%C2%B7%20in%20a%20hurry',
    );
    await settled();
    decoded(container);

    expect(reading('Reached it')).toBe('1 of 1');
    expect(reading('Median time on it')).toBe('77.0 s');
    expect(reading('Scrolled past the fold')).toBe('1 of 1');
    // Six clicks on the primary action, which is more than the 1 person in this slice: a
    // recount of a session's actions could never give this, and the screen prints it.
    expect(clicksCellFor(container, 'B-payment-primary')).toBe('6');
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-clicks-area="B-payment-primary"]')
          ?.getAttribute('data-clicks'),
      ).toBe('6');
    });
  });

  it('state the line, not an empty frame, for a composition no session satisfies', async () => {
    await serveRunData();
    // The committed run has a price-sensitive segment and failed sessions, and nobody who is
    // both — so the aggregate holds no slice for them, which is the reading.
    const { container } = heatmaps(
      'B',
      'payment',
      '?outcome=failed&segment=mobile%20%C2%B7%20price-sensitive',
    );
    await screen.findByRole('heading', { level: 1, name: HEADING });

    const stated = await screen.findByText(/no session in this test satisfies both/);
    expect(stated.textContent).toContain('Nobody in “mobile · price-sensitive” ended as “failed”');
    expect(container.querySelector('[data-section="no-people-match"]')).not.toBeNull();
    // And no frame at all: an empty one would read as "they looked nowhere".
    expect(container.querySelector('#att-frame')).toBeNull();
  });

  it('narrow the areas table’s clicks column, and leave never and 0% alone', async () => {
    await serveRunData();
    const { container } = heatmaps('B', 'review', '?outcome=abandoned');
    await settled();

    // Two people pressed the redesign's completing action, and **neither of them gave up**:
    // the unfiltered column reads 2 and this one reads 0. A column that had not narrowed
    // would read 2 here, which is the whole point of the filter being on this screen.
    expect(clicksCellFor(container, 'B-review-complete')).toBe('0');

    // The gaze figures are the run's own `aoiMetrics` across everybody scored, and the
    // footnote says so rather than letting a reader assume both columns narrowed.
    const row = container.querySelector('tr[data-aoi-row="B-review-complete"]') as HTMLElement;
    expect(row.textContent).toContain('never');
    expect(row.textContent).toContain('0%');
    expect(
      screen.getByText(/Clicks are the people these filters leave; the gaze figures are medians/),
    ).toBeDefined();

    // And unfiltered it is the whole test's two.
    container.remove();
    forgetRuns();
    await serveRunData();
    const everybody = heatmaps('B', 'review');
    await settled();
    expect(clicksCellFor(everybody.container, 'B-review-complete')).toBe('2');
  });
});

describe('the URL carries the overlay, the segment and the outcome', () => {
  it('renders exactly the state a link built by the shared builder asks for', async () => {
    await serveRunData();
    // The builder a recommendation cites through, not a string this screen spells.
    const cited = heatmapLink(RUN_ID, 'B', 'payment', {
      aoi: 'B-payment-primary',
      overlay: 'scroll',
      segment: 'mobile · in a hurry',
      outcome: 'abandoned',
    });
    expect(cited).toBe(
      `/runs/${RUN_ID}/attention/B/payment?aoi=B-payment-primary&overlay=scroll&segment=mobile+%C2%B7+in+a+hurry&outcome=abandoned`,
    );

    const { container } = mountApp(cited);
    await settled();
    decoded(container);

    // The overlay it named, and only that one.
    expect(stripButton('scroll').getAttribute('aria-pressed')).toBe('true');
    expect(stripButton('clicks').getAttribute('aria-pressed')).toBe('false');
    expect(stripButton('attention').getAttribute('aria-pressed')).toBe('false');
    expect(toggleFor('scroll').getAttribute('aria-pressed')).toBe('true');
    // The two filters it named, pressed in their own strips.
    expect(
      (document.querySelector('[data-filter="abandoned"]') as HTMLElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(
      (document.querySelector('[data-filter="mobile · in a hurry"]') as HTMLElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    // And the area it named.
    expect(document.querySelector('#att-caption')?.textContent).toContain(
      'Primary action — A: "Continue to review", B: "Place order"',
    );
  });

  it('writes the overlays a reader turns on, so the view stays a link', async () => {
    await serveRunData();
    const { router, container } = heatmaps('B', 'payment', '?overlay=clicks');
    await settled();
    decoded(container);

    await userEvent.click(toggleFor('heat'));
    // In the registry's order, so two readers who turned the same overlays on are at the
    // same URL however they got there.
    await waitFor(() => {
      expect(router.state.location.search).toBe('?overlay=clicks&overlay=attention');
    });

    await userEvent.click(stripButton('scroll'));
    // The strip selects one: it is three states of one view, and it is the way back from
    // two overlays to one.
    await waitFor(() => {
      expect(router.state.location.search).toBe('?overlay=scroll');
    });
  });

  it('lets a reader switch the last overlay off, and says so rather than snapping back', async () => {
    await serveRunData();
    const opened = heatmaps('B', 'payment', '?overlay=clicks');
    const { router, container } = opened;
    await settled();
    decoded(container);
    await waitFor(() => {
      expect(layerIn(container, 'clicks')).not.toBeNull();
    });

    await userEvent.click(toggleFor('clicks'));

    // Nothing drawn, the switch off, and the page left undimmed — the page as the audience
    // saw it, which is a view a reader is entitled to. A default that turned the clicks
    // straight back on would make this switch do nothing at all.
    await waitFor(() => {
      expect(layerIn(container, 'clicks')).toBeNull();
    });
    expect(toggleFor('clicks').getAttribute('aria-pressed')).toBe('false');
    expect(stripButton('clicks').getAttribute('aria-pressed')).toBe('false');
    expect((container.querySelector('#att-frame') as HTMLElement).hasAttribute('data-dim')).toBe(
      false,
    );
    // And it survives a reload, because it is in the address: the empty value is this
    // screen's own way of saying none, and `heatmapLink` cannot write it.
    expect(router.state.location.search).toBe('?overlay=');

    // Closed and opened again on the same link, so the screen has nothing but the URL left
    // to rebuild itself from.
    const link = `${paths.attention(RUN_ID, 'B', 'payment')}${router.state.location.search}`;
    opened.unmount();
    forgetRuns();
    await serveRunData();
    const reopened = mountApp(link);
    await settled();
    decoded(reopened.container);
    expect(reopened.container.querySelector('[data-overlay-layer]')).toBeNull();
  });

  it('clears both filters in one write when the stated line offers it', async () => {
    await serveRunData();
    const { router } = heatmaps(
      'B',
      'payment',
      '?outcome=failed&segment=mobile%20%C2%B7%20price-sensitive',
    );
    await screen.findByRole('heading', { level: 1, name: HEADING });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Show every outcome and segment' }),
    );

    // **Both**, not one. Two separate writes in one handler each build their query from the
    // same render's, so the second is of a URL that never had the first's change in it.
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await settled();
    expect(reading('Reached it')).toBe('10 of 22');
  });

  it('writes each filter as its own parameter, and clears it rather than writing empty', async () => {
    await serveRunData();
    const { router } = heatmaps('B', 'payment');
    await settled();

    await userEvent.click(document.querySelector('[data-filter="abandoned"]') as HTMLElement);
    await waitFor(() => {
      expect(router.state.location.search).toContain('outcome=abandoned');
    });

    await userEvent.click(
      document.querySelector('[data-filter="mobile · in a hurry"]') as HTMLElement,
    );
    await waitFor(() => {
      expect(router.state.location.search).toContain('segment=mobile');
    });

    // "All" is a button with a value; what reaches the URL is the filter's absence.
    const allOutcomes = within(
      document.querySelector('[data-section="outcome-strip"]') as HTMLElement,
    ).getByRole('button', { name: 'All 22' });
    await userEvent.click(allOutcomes);
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('outcome');
    });
    expect(router.state.location.search).toContain('segment=mobile');
  });

  it('says so and shows the overlays it can when a link names one this screen has not', async () => {
    await serveRunData();
    heatmaps('B', 'payment', '?overlay=scanpath');
    await settled();

    expect(
      screen.getByText('This screen has no overlay “scanpath”. Showing clicks.'),
    ).toBeDefined();
    expect(stripButton('clicks').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('accessibility and the shape of it', () => {
  it('passes axe with all three overlays drawn and both filters set', async () => {
    await serveRunData();
    const { container } = heatmaps(
      'B',
      'payment',
      '?overlay=clicks&overlay=attention&overlay=scroll&outcome=abandoned',
    );
    await settled();
    decoded(container);

    const screenOnly = container.querySelector('[data-section="heatmaps"]') as HTMLElement;
    expect(describeViolations(await axeViolations(screenOnly))).toBe('');
  });

  it('passes axe on the filter composition nobody satisfies', async () => {
    await serveRunData();
    const { container } = heatmaps(
      'B',
      'payment',
      '?outcome=failed&segment=mobile%20%C2%B7%20price-sensitive',
    );
    await screen.findByText(/no session in this test satisfies both/);

    const screenOnly = container.querySelector('[data-section="heatmaps"]') as HTMLElement;
    expect(describeViolations(await axeViolations(screenOnly))).toBe('');
  });

  it('is operable from the keyboard, with a focus ring the tokens draw', async () => {
    await serveRunData();
    const { container } = heatmaps('B', 'payment', '?overlay=clicks');
    await settled();
    decoded(container);

    const scroll = stripButton('scroll');
    scroll.focus();
    expect(document.activeElement).toBe(scroll);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(layerIn(container, 'scroll')).not.toBeNull();
    });

    const outcome = document.querySelector('[data-filter="abandoned"]') as HTMLElement;
    outcome.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => {
      expect(outcome.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('lays the control row and the stage out so a narrow window has no sideways scroll', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sheet = readFileSync(join(here, 'attentionPage.module.css'), 'utf8');

    // The strips wrap rather than overflowing, and the side column goes under the page at
    // the prototype's own breakpoint — the two things that would otherwise push a phone
    // sideways.
    expect(sheet).toContain('flex-wrap: wrap');
    expect(sheet).toMatch(/@media \(max-width: 1000px\)/);
    // And the one column width on the screen is written on the spacing scale, not in pixels:
    // the breakpoint itself is the only length in this file that is not a token.
    const declarations = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+/g, '');
    expect(declarations).not.toMatch(/:\s*\d+px/);
  });

  it('draws the three overlays with no animation of their own, settled on mount', () => {
    const here = join(dirname(fileURLToPath(import.meta.url)), 'stage');
    // Complete and still under `prefers-reduced-motion: reduce` because they are complete
    // and still always: the heatmap-warming-up moment stays where #125 put it, and these
    // layers are pure renderers with no timer, no transition and no keyframes.
    for (const name of ['clicksLayer.module.css', 'scrollDepthLayer.module.css']) {
      const sheet = readFileSync(join(here, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(sheet, name).not.toMatch(/transition|animation|@keyframes/);
    }
    for (const name of ['ClicksLayer.tsx', 'ScrollDepthLayer.tsx']) {
      const source = readFileSync(join(here, name), 'utf8');
      expect(source, name).not.toMatch(/useEffect|setTimeout|requestAnimationFrame/);
    }
  });
});
