// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../../tests/app';
import { ruleIn, rulesOf } from '../../../../tests/cssom';
import { loadDesignTokens } from '../../../../tests/setup';
import type { AttentionArea } from '../useAttentionAreas';
import type { Fixation } from '../useAttentionStepSessions';
import { HEAT_DRAWN_STEPS, HEAT_STEPS, accumulateHeat } from './heatAccumulation';
import { HEATMAP_LAYER, HeatKey, HeatmapLayer } from './HeatmapLayer';
import { OVERLAY_LAYERS } from './overlayLayers';
import type { OverlayLayerProps } from './overlayLayers';
import { pageToOverlay } from './overlayTransform';
import type { Transform } from './overlayTransform';

/**
 * The attention heatmap, over the repository's own committed example run and over fixations
 * this file makes up.
 *
 * What is asserted is what the layer mounts, what it was given and what the heat key says —
 * never a painted pixel. The numbers themselves are `heatAccumulation.test.ts`; the claim
 * here is that this layer draws those numbers, at the places `pageToOverlay` puts them, and
 * that switching it off takes it and its key away and leaves the other layers alone.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = 'Where your audience looked';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const attention = (variant = 'B', step = 'review', query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

const ready = () => screen.findByRole('heading', { level: 1, name: HEADING });

/** The page as it is once its screenshot has arrived, which jsdom never does on its own. */
const decoded = (container: HTMLElement) => {
  fireEvent.load(container.querySelector('#att-page img') as HTMLImageElement);
};

const heatToggle = () => screen.getByRole('button', { name: /Attention heatmap/ });
const outlineToggle = () => screen.getByRole('button', { name: /Areas of interest/ });

const layerIn = (container: HTMLElement) => container.querySelector('[data-overlay-layer="heat"]');
const keyIn = (container: HTMLElement) => container.querySelector('[data-heat-key]');
const blobsIn = (container: HTMLElement) => [...container.querySelectorAll('circle')];

/**
 * The stage once the whole audience is in.
 *
 * The layer withholds itself while the sessions are still arriving, so every assertion
 * about what it drew waits for them — which is the loading state, asserted by being the
 * thing every other test here has to wait out.
 */
const drawn = (container: HTMLElement) =>
  waitFor(() => {
    expect(blobsIn(container).length).toBeGreaterThan(0);
  });

/** The sessions as the run records them, with nobody having fixated anywhere. */
const withoutFixations = async () => {
  const files: Record<string, string> = {};
  for (const sessionId of seedRun().sessionIds) {
    const session = readRunFile(RUN_ID, `sessions/${sessionId}.json`);
    files[`/runs/${RUN_ID}/sessions/${sessionId}.json`] = JSON.stringify({
      ...session,
      fixations: [],
      saccades: [],
    });
  }
  await serveRunData({ files });
};

/** A page the width of a desktop capture, so an overlay unit is a round number of pixels. */
const PAGE: Transform = { pageWidth: 1000, pageHeight: 4000 };

let next = 0;

const fixation = (over: Partial<Fixation> = {}): Fixation => ({
  index: next,
  screenIndex: 0,
  tMs: next++ * 1000,
  durationMs: 400,
  // The replay's coordinates, and deliberately absurd: nothing in this ticket may read
  // them, and the assertions below would notice if anything did.
  x: 999_999,
  y: 999_999,
  pageX: 500,
  pageY: 1000,
  aoiId: null,
  ...over,
});

const given = (over: Partial<OverlayLayerProps> = {}): OverlayLayerProps => ({
  fixations: [],
  saccades: [],
  areas: [],
  isolatedAoiId: null,
  transform: PAGE,
  ...over,
});

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the registry entry', () => {
  it('is the prototype’s own switch: on by default, in its words', () => {
    expect(HEATMAP_LAYER.id).toBe('heat');
    expect(HEATMAP_LAYER.label).toBe('Attention heatmap');
    expect(HEATMAP_LAYER.hint).toBe('dwell-weighted');
    expect(HEATMAP_LAYER.defaultOn).toBe(true);
    expect(OVERLAY_LAYERS).toContain(HEATMAP_LAYER);
    // First in the list, because the heatmap is the ground the rest are read over.
    expect(OVERLAY_LAYERS[0]).toBe(HEATMAP_LAYER);
  });
});

describe('on the screen', () => {
  it('is drawn over the page without being asked for, with its heat key beside the switch', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    await drawn(container);

    expect(heatToggle().getAttribute('aria-pressed')).toBe('true');
    expect(layerIn(container)).not.toBeNull();

    const key = keyIn(container) as HTMLElement;
    expect(key.dataset.heatKey).toBe('ramp');
    expect(key.textContent).toBe('brieflong dwell');
    // Beside the switch it belongs to, in the Overlays panel.
    expect(
      screen.getByRole('heading', { name: 'Overlays' }).closest('section')?.contains(key),
    ).toBe(true);
  });

  it('comes away with its key when the reader switches it off, and leaves the outlines alone', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    await drawn(container);
    await userEvent.click(outlineToggle());
    expect(container.querySelector('[data-overlay-layer="aoi"]')).not.toBeNull();

    await userEvent.click(heatToggle());

    expect(layerIn(container)).toBeNull();
    expect(keyIn(container)).toBeNull();
    expect(container.querySelector('[data-overlay-layer="aoi"]')).not.toBeNull();

    await userEvent.click(heatToggle());
    expect(layerIn(container)).not.toBeNull();
    expect(keyIn(container)).not.toBeNull();
  });

  it('drops to the isolated area’s own fixations, and says so in the numbers', async () => {
    await serveRunData();
    const whole = attention();
    await ready();
    decoded(whole.container);
    await drawn(whole.container);
    const everywhere = blobsIn(whole.container).length;
    whole.unmount();

    const { container } = attention('B', 'review', '?aoi=B-review-fee-row');
    await ready();
    decoded(container);

    await drawn(container);
    const isolated = blobsIn(container).length;
    expect(isolated).toBeLessThan(everywhere);
  });

  it('draws nothing where nobody fixated, and says so instead of showing a ramp', async () => {
    await withoutFixations();
    const { container } = attention();
    await ready();
    decoded(container);
    // Only once the sessions are all in; until then what it says is that they are not.
    await screen.findByText(/No fixation landed anywhere on this version of this step/);

    expect(blobsIn(container).length).toBe(0);
    expect(layerIn(container)).toBeNull();
    // No ramp: a legend for colours that are not on the page is a reading of nothing.
    expect(keyIn(container)).toBeNull();
    // The reason is tied to the switch it is about, which stays reachable and announces
    // itself unavailable rather than being made unreachable.
    const control = screen.getByRole('button', { name: /Attention heatmap/ });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/No fixation landed anywhere/);
  });

  it('leaves the page undimmed when it has nothing to draw over it', async () => {
    await withoutFixations();
    const { container } = attention();
    await ready();
    decoded(container);
    await screen.findByText(/No fixation landed anywhere on this version of this step/);

    // The scrim is there so that what is drawn over the screenshot reads on top of it. A
    // page washed out for a layer that drew nothing is a treatment with nothing to serve.
    expect((container.querySelector('#att-frame') as HTMLElement).hasAttribute('data-dim')).toBe(
      false,
    );
  });
});

describe('what it draws', () => {
  it('places every blob through pageToOverlay, from the page coordinates alone', () => {
    const { container } = render(
      <HeatmapLayer
        {...given({
          fixations: [
            fixation({ pageX: 250, pageY: 2000, durationMs: 300 }),
            fixation({ pageX: 750, pageY: 400, durationMs: 900 }),
          ],
        })}
      />,
    );

    const drawn = blobsIn(container).map((blob) => ({
      x: Number(blob.getAttribute('cx')),
      y: Number(blob.getAttribute('cy')),
    }));

    expect(drawn).toEqual(
      expect.arrayContaining([
        pageToOverlay({ pageX: 250, pageY: 2000 }, PAGE),
        pageToOverlay({ pageX: 750, pageY: 400 }, PAGE),
      ]),
    );
  });

  it('draws one blob per place, in the ramp step and at the radius the dwell earned', () => {
    const point = { pageX: 500, pageY: 1000 };
    const fixations = [
      fixation({ ...point, durationMs: 200 }),
      fixation({ ...point, durationMs: 200 }),
      fixation({ pageX: 500, pageY: 3000, durationMs: 600 }),
    ];
    const { container } = render(<HeatmapLayer {...given({ fixations })} />);

    const drawn = blobsIn(container).map((blob) => ({
      dwellMs: Number(blob.getAttribute('data-dwell-ms')),
      fixations: Number(blob.getAttribute('data-fixations')),
      step: Number(blob.getAttribute('data-heat-step')),
      r: Number(blob.getAttribute('r')),
    }));

    const glanced = drawn.find((blob) => blob.fixations === 2);
    const dwelt = drawn.find((blob) => blob.fixations === 1);
    expect(drawn.length).toBe(2);
    expect(glanced?.dwellMs).toBe(400);
    expect(dwelt?.dwellMs).toBe(600);
    // Two 200 ms looks are cooler and smaller than one 600 ms look at another place.
    expect(glanced?.step).toBeLessThan(dwelt?.step ?? 0);
    expect(glanced?.r).toBeLessThan(dwelt?.r ?? 0);
    expect(dwelt?.step).toBe(HEAT_STEPS);
  });

  it('fills each blob from the ramp gradient of its own step, which is on the page', () => {
    const { container } = render(
      <HeatmapLayer {...given({ fixations: [fixation({ durationMs: 600 })] })} />,
    );

    const blob = blobsIn(container)[0] as SVGCircleElement;
    const fill = blob.getAttribute('fill') ?? '';
    const gradient = /url\(#(.+)\)/.exec(fill)?.[1] ?? '';
    expect(gradient).not.toBe('');
    expect(container.querySelector(`#${gradient}`)?.tagName).toBe('radialGradient');
    // One gradient per ramp step, so a cool place never has the hot token in it at all.
    expect(container.querySelectorAll('radialGradient').length).toBe(HEAT_DRAWN_STEPS.length);
  });

  it('draws nothing at all while the sessions are still being read', () => {
    const fixations = [fixation()];
    const { container } = render(<HeatmapLayer {...given({ fixations, loading: true })} />);

    expect(container.querySelector('[data-overlay-layer="heat"]')).toBeNull();
    // And the panel says why, rather than offering a ramp over half an audience.
    expect(HEATMAP_LAYER.unavailable?.(given({ fixations, loading: true }))).toMatch(
      /Still reading your audience’s sessions/,
    );
  });

  it('draws nothing over a capture of no size, which is no page to place a fixation on', () => {
    const given0 = given({
      fixations: [fixation()],
      transform: { pageWidth: 0, pageHeight: 0 },
    });

    expect(render(<HeatmapLayer {...given0} />).container.querySelector('circle')).toBeNull();
    expect(HEATMAP_LAYER.unavailable?.(given0)).toMatch(/no heat to show/);
  });

  it('draws nothing for fixations that held for no time at all', () => {
    const fixations = [fixation({ durationMs: 0 }), fixation({ pageX: 100, durationMs: 0 })];

    // Weighed against each other they would every one be the hottest place on the page,
    // which would paint a whole heatmap out of a total dwell of nothing.
    expect(accumulateHeat(fixations, PAGE)).toEqual([]);
    expect(
      render(<HeatmapLayer {...given({ fixations })} />).container.querySelector('circle'),
    ).toBeNull();
  });

  it('is a pure renderer: the same fixations draw the same thing twice over', () => {
    const fixations = [fixation({ durationMs: 300 }), fixation({ pageX: 100, durationMs: 900 })];
    const once = render(<HeatmapLayer {...given({ fixations })} />);
    const marks = (container: HTMLElement) =>
      blobsIn(container).map((blob) => `${blob.getAttribute('cx')} ${blob.getAttribute('r')}`);
    const first = marks(once.container);
    once.unmount();
    const again = render(<HeatmapLayer {...given({ fixations })} />);

    expect(marks(again.container)).toEqual(first);
    expect(first.length).toBe(accumulateHeat(fixations, PAGE).length);
  });
});

describe('the heat key', () => {
  it('names the two ends of the ramp in the prototype’s words', () => {
    const { container } = render(<HeatKey />);

    expect(container.textContent).toBe('brieflong dwell');
  });

  it('says there is nothing to show for an area nobody fixated, in the table’s words for it', () => {
    const area = {
      aoi: { id: 'B-review-complete', label: 'Complete purchase' },
    } as unknown as AttentionArea;

    const sentence = HEATMAP_LAYER.unavailable?.(
      given({
        fixations: [fixation({ aoiId: 'B-review-pay-with' })],
        areas: [area],
        isolatedAoiId: 'B-review-complete',
      }),
    );

    // The label, never the id: the areas table beside it calls the area this, and the two
    // are about the same row of the same page.
    expect(sentence).toMatch(/No fixation landed in “Complete purchase”/);
  });

  it('is a ramp whenever it is mounted at all, because the panel only mounts it then', () => {
    expect(HEATMAP_LAYER.unavailable?.(given({ fixations: [fixation()] }))).toBeNull();
    expect(render(<HeatKey />).container.textContent).toContain('long dwell');
  });
});

describe('its colours are the heat tokens and nothing else', () => {
  const source = (file: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');

  it('takes every stop and the ramp from --heat-*, and the layer’s strength from --heat-opacity', () => {
    const rule = ruleIn(rulesOf(source('heatmapLayer.module.css')));

    expect(rule('.heat')['opacity']).toBe('var(--heat-opacity)');
    for (const step of [1, 2, 3, 4, 5]) {
      expect(rule(`.step${step}`)['stop-color']).toBe(`var(--heat-${step})`);
    }
    // The key is the ramp itself: the four steps that have a colour, cool to hot.
    expect(rule('.ramp')['background']).toBe(
      'linear-gradient(to right, var(--heat-2), var(--heat-3), var(--heat-4), var(--heat-5))',
    );
  });

  it('states no colour of its own, in the layer or in its stylesheet', () => {
    for (const file of ['HeatmapLayer.tsx', 'heatAccumulation.ts', 'heatmapLayer.module.css']) {
      // A comment is not a declaration, and the tickets these files name read as hex.
      const text = source(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, file).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab|color-mix)\(/);
    }
  });
});
