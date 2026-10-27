// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../../tests/app';
import { AOI_OUTLINE_LAYER } from './AoiOutlineLayer';
import { OVERLAY_LAYERS } from './overlayLayers';
import type { OverlayLayer, OverlayLayerProps, StageLayer } from './overlayLayers';
import { OverlayTogglesPanel } from './OverlayTogglesPanel';
import { loadDesignTokens } from '../../../../tests/setup';

/**
 * The Overlays panel: one switch per registered layer, and nothing else.
 *
 * Two halves. The first mounts the real screen, because "inside the scaffold's side panel,
 * with the registry's entries in it" is a claim about the screen. The second renders the
 * panel over layers this file makes up, because "toggling one touches only that one" is a
 * claim about the panel that cannot be made with one layer registered — and the heatmap
 * (#71) and the scanpath (#72) are not built yet.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = 'Where your audience looked';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const serveChangedRun = async (change: (run: Run) => Run) => {
  await serveRunData({
    files: { [`/runs/${RUN_ID}/run.json`]: JSON.stringify(change(seedRun())) },
  });
};

const attention = (variant = 'B', step = 'review') =>
  mountApp(paths.attention(RUN_ID, variant, step));

const ready = () => screen.findByRole('heading', { level: 1, name: HEADING });

/**
 * The page as it is once its screenshot has arrived, which jsdom never does on its own.
 * Until it has, the stage draws no layer at all — the frame is holding its box open — so a
 * test about mounting one has to let the page land first.
 */
const decoded = (container: HTMLElement) => {
  fireEvent.load(container.querySelector('#att-page img') as HTMLImageElement);
};

const panelOf = (): HTMLElement =>
  screen.getByRole('heading', { name: 'Overlays' }).closest('section') as HTMLElement;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the panel on the screen', () => {
  it('sits in the side column, in a panel of its own', async () => {
    await serveRunData();
    attention();
    await ready();

    const panel = panelOf();
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('[data-overlay-toggle]').length).toBe(OVERLAY_LAYERS.length);
  });

  it('offers one switch per registered layer, in the registry’s words', async () => {
    await serveRunData();
    attention();
    await ready();

    for (const layer of OVERLAY_LAYERS) {
      const control = panelOf().querySelector(`[data-overlay-toggle="${layer.id}"]`) as HTMLElement;
      expect(control, layer.id).not.toBeNull();
      expect(control.textContent).toContain(layer.label);
      if (layer.hint !== undefined) expect(control.textContent).toContain(layer.hint);
      expect(control.getAttribute('aria-pressed')).toBe(String(layer.defaultOn));
    }
  });

  it('calls the outlines what the prototype calls them, and starts them off', () => {
    expect(AOI_OUTLINE_LAYER.label).toBe('Areas of interest');
    expect(AOI_OUTLINE_LAYER.hint).toBeUndefined();
    expect(AOI_OUTLINE_LAYER.defaultOn).toBe(false);
    expect(OVERLAY_LAYERS).toContain(AOI_OUTLINE_LAYER);
  });

  it('mounts the layer the reader switches on, and unmounts it again', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    const outlines = screen.getByRole('button', { name: /Areas of interest/ });
    expect(container.querySelector('[data-overlay-layer="aoi"]')).toBeNull();

    await userEvent.click(outlines);
    expect(container.querySelector('[data-overlay-layer="aoi"]')).not.toBeNull();
    expect(outlines.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(outlines);
    expect(container.querySelector('[data-overlay-layer="aoi"]')).toBeNull();
  });

  it('is operable from the keyboard', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    const outlines = screen.getByRole('button', { name: /Areas of interest/ });
    outlines.focus();
    await userEvent.keyboard('{Enter}');

    expect(container.querySelector('[data-overlay-layer="aoi"]')).not.toBeNull();
  });
});

describe('a step with no areas of interest', () => {
  const withoutAreas = () =>
    serveChangedRun((run) => ({
      ...run,
      aois: run.aois.filter((aoi) => !(aoi.variant === 'B' && aoi.step === 'review')),
      aoiMetrics: run.aoiMetrics.filter((metric) => !metric.aoiId.startsWith('B-review-')),
    }));

  it('says why the outline switch is unavailable, rather than offering an empty layer', async () => {
    await withoutAreas();
    attention();
    await ready();

    const outlines = screen.getByRole('button', { name: /Areas of interest/ });
    expect(outlines.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(
        'This test marked no area of interest on this version of this step, so there is nothing to outline.',
      ),
    ).toBeDefined();
    expect(outlines.getAttribute('aria-describedby')).toBe(
      (panelOf().querySelector('[data-overlay-unavailable="aoi"]') as HTMLElement).getAttribute(
        'id',
      ),
    );
  });

  it('keeps that switch reachable, so the reason is announced rather than shown only', async () => {
    await withoutAreas();
    const { container } = attention();
    await ready();

    // A native `disabled` button is skipped by the keyboard and by a screen reader's focus
    // mode, so the sentence under it would never reach the reader it is written for.
    const outlines = screen.getByRole('button', { name: /Areas of interest/ });
    expect(outlines).toHaveProperty('disabled', false);
    outlines.focus();
    expect(document.activeElement).toBe(outlines);

    await userEvent.click(outlines);
    expect(outlines.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-overlay-layer="aoi"]')).toBeNull();
  });

  it('offers the switch again on a step that does have areas', async () => {
    await withoutAreas();
    attention('B', 'payment');
    await ready();

    expect(
      screen.getByRole('button', { name: /Areas of interest/ }).getAttribute('aria-disabled'),
    ).toBeNull();
    expect(screen.queryByText(/nothing to outline/)).toBeNull();
  });
});

describe('a screen that is not showing a stage at all', () => {
  /** A step after the confirmation that nobody ever stood on, as the scaffold's tests do. */
  const withUnreachedStep = () =>
    serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'delivery', label: 'Delivery' }],
    }));

  it('takes the panel away with it, rather than offering switches for nothing', async () => {
    await withUnreachedStep();
    attention('B', 'delivery');
    await screen.findByRole('heading', {
      name: 'Nobody in your audience reached this step on variant B',
    });

    expect(screen.queryByRole('heading', { name: 'Overlays' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Areas of interest/ })).toBeNull();
    // The readings beside it are about the step, not about the page, and stay.
    expect(screen.getByRole('heading', { name: 'Reading this' })).toBeDefined();
  });

  it('takes it away when a session file could not be read either', async () => {
    await serveRunData({
      files: { [`/runs/${RUN_ID}/sessions/S-13.json`]: 'this is not an artifact' },
    });
    attention();
    await ready();
    await screen.findByText(/could not be read/);

    expect(screen.queryByRole('heading', { name: 'Overlays' })).toBeNull();
  });
});

describe('the panel over layers of its own', () => {
  /** Two layers, so "only that one" is a thing this file can tell apart. */
  const fakeLayer = (id: string, label: string, hint?: string): OverlayLayer => ({
    id,
    label,
    ...(hint === undefined ? {} : { hint }),
    defaultOn: false,
    Component: () => null,
  });

  const stageLayer = (layer: OverlayLayer, on: boolean, unavailable: string | null = null) => ({
    layer,
    on,
    unavailable,
    drawn: on && unavailable === null,
  });

  it('switches the one that was clicked, and tells nothing else', async () => {
    const setShown = vi.fn();
    const layers: StageLayer[] = [
      stageLayer(fakeLayer('heat', 'Attention heatmap', 'dwell-weighted'), false),
      stageLayer(fakeLayer('scan', 'Scanpath', 'numbered fixations'), false),
    ];
    render(<OverlayTogglesPanel layers={layers} setShown={setShown} />);

    await userEvent.click(screen.getByRole('button', { name: /Scanpath/ }));

    expect(setShown.mock.calls).toEqual([['scan', true]]);
  });

  it('carries each layer’s hint beside its label, as the prototype writes them', () => {
    const layers: StageLayer[] = [
      stageLayer(fakeLayer('heat', 'Attention heatmap', 'dwell-weighted'), true),
    ];
    render(<OverlayTogglesPanel layers={layers} setShown={vi.fn()} />);

    const control = screen.getByRole('button', { name: /Attention heatmap/ });
    expect(control.textContent).toBe('Attention heatmapdwell-weighted');
    expect(control.getAttribute('aria-pressed')).toBe('true');
  });

  it('switches a layer off when it is on', async () => {
    const setShown = vi.fn();
    render(
      <OverlayTogglesPanel
        layers={[stageLayer(fakeLayer('heat', 'Attention heatmap'), true)]}
        setShown={setShown}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Attention heatmap/ }));

    expect(setShown.mock.calls).toEqual([['heat', false]]);
  });

  it('never calls out for a layer it has disabled', async () => {
    const setShown = vi.fn();
    render(
      <OverlayTogglesPanel
        layers={[stageLayer(fakeLayer('heat', 'Attention heatmap'), false, 'Nothing to warm.')]}
        setShown={setShown}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Attention heatmap/ }));

    expect(setShown).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing to warm.')).toBeDefined();
  });
});

/** The props a layer is handed, for the registry's own `unavailable`. */
const noData: OverlayLayerProps = {
  fixations: [],
  saccades: [],
  areas: [],
  isolatedAoiId: null,
  transform: { pageWidth: 390, pageHeight: 1540 },
};

describe('the registry entry', () => {
  it('reports itself unavailable when the step has no areas, and available when it has', () => {
    expect(AOI_OUTLINE_LAYER.unavailable?.(noData)).toContain('nothing to outline');

    const run = seedRun();
    const areas = run.aois
      .filter((aoi) => aoi.variant === 'B' && aoi.step === 'review')
      .map((aoi) => ({ aoi, metric: null }));
    expect(AOI_OUTLINE_LAYER.unavailable?.({ ...noData, areas })).toBeNull();
  });
});
