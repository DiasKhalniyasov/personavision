// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../../tests/app';
import { ruleIn, rulesOf } from '../../../../tests/cssom';
import { loadDesignTokens } from '../../../../tests/setup';
import type { AttentionArea } from '../useAttentionAreas';
import { medianScanpath } from './medianScanpath';
import { OVERLAY_LAYERS } from './overlayLayers';
import type { OverlayLayerProps } from './overlayLayers';
import { boxToOverlay } from './overlayTransform';
import type { Transform } from './overlayTransform';
import { SCANPATH_LAYER, ScanpathKey, ScanpathLayer } from './ScanpathLayer';

/**
 * The scanpath, over the repository's own committed example run and over areas this file
 * makes up.
 *
 * What is asserted is the order, the numbers and where a mark is anchored — never a drawn
 * pixel. The arithmetic itself is `medianScanpath.test.ts`; the claim here is that this
 * layer draws those numbers, at the places `boxToOverlay` puts them, that an area nobody
 * looked at is not on the path, and that switching it off takes it and its scale away and
 * leaves the other layers alone.
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

const scanToggle = () => screen.getByRole('button', { name: /Scanpath/ });
const heatToggle = () => screen.getByRole('button', { name: /Attention heatmap/ });
const zoomTo = (level: string) => userEvent.click(screen.getByRole('radio', { name: level }));

const layerIn = (container: HTMLElement) => container.querySelector('[data-overlay-layer="scan"]');
const keyIn = (container: HTMLElement) => container.querySelector('[data-scan-key]');

/** Every mark drawn, in the order the layer drew it: the area it is on and its number. */
const marksIn = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-fixation]')].map((mark) => ({
    aoiId: mark.getAttribute('data-fixation'),
    number: Number(mark.getAttribute('data-fixation-number')),
    x: Number(mark.getAttribute('cx')),
    y: Number(mark.getAttribute('cy')),
    r: Number(mark.getAttribute('r')),
  }));

/** Every number on the page, as a reader reads it. */
const numeralsIn = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-fixation-label]')].map((label) => label.textContent);

const saccadesIn = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-saccade]')].map((line) => ({
    joins: line.getAttribute('data-saccade'),
    x1: Number(line.getAttribute('x1')),
    y1: Number(line.getAttribute('y1')),
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
    nonScalingStroke: line.getAttribute('vector-effect'),
  }));

/** The sentence tied to one switch, as a screen reader is given it. */
const reasonFor = (control: HTMLElement) =>
  document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent ?? '';

/** A page the width of a desktop capture, so an overlay unit is a round number of pixels. */
const PAGE: Transform = { pageWidth: 1000, pageHeight: 4000 };

interface Given {
  readonly ttffMs?: number | null;
  readonly dwellMs?: number;
  readonly x?: number;
  readonly y?: number;
}

const area = (id: string, given: Given = {}): AttentionArea => {
  const { ttffMs = 1000, dwellMs = 500, x = 100, y = 200 } = given;
  return {
    aoi: {
      id,
      variant: 'B',
      step: 'review',
      label: `The ${id} area`,
      source: 'dom',
      role: null,
      bbox: { x, y, width: 400, height: 100 },
      isPrimaryAction: false,
      belowFold: false,
    },
    metric: {
      aoiId: id,
      timeToFirstFixationMs: ttffMs,
      firstFixationDurationMs: ttffMs === null ? null : 240,
      totalDwellMs: dwellMs,
      fixationCount: ttffMs === null ? 0 : 3,
      revisits: 0,
      lookedAtShare: ttffMs === null ? 0 : 1,
      sessionCount: 9,
    },
  };
};

/** An area whose figures disagree about whether anybody looked at it. */
const contradicts = (id: string): AttentionArea => {
  const row = area(id);
  return { ...row, metric: { ...row.metric!, lookedAtShare: 0 } };
};

const given = (over: Partial<OverlayLayerProps> = {}): OverlayLayerProps => ({
  // The sessions' own records. Nothing in this ticket may read them — this is a median
  // scanpath over areas, not one session's trace — and the assertions below would notice.
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
    expect(SCANPATH_LAYER.id).toBe('scan');
    expect(SCANPATH_LAYER.label).toBe('Scanpath');
    expect(SCANPATH_LAYER.hint).toBe('numbered fixations');
    expect(SCANPATH_LAYER.defaultOn).toBe(true);
    // Between the heatmap and the outlines, which is the prototype's order and also back
    // to front: the heat is the ground the order is read over.
    expect(OVERLAY_LAYERS[1]).toBe(SCANPATH_LAYER);
  });
});

describe('on the screen', () => {
  it('draws the order attention moved in without being asked, numbered from one', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    expect(scanToggle().getAttribute('aria-pressed')).toBe('true');
    // The redesign's review step: the order the committed run recorded, by median time to
    // first fixation — the summary first, then the planted fee row, then the payment row,
    // then the help link.
    expect(marksIn(container).map((mark) => [mark.number, mark.aoiId])).toEqual([
      [1, 'B-review-summary'],
      [2, 'B-review-fee-row'],
      [3, 'B-review-pay-with'],
      [4, 'B-review-support'],
    ]);
    expect(numeralsIn(container)).toEqual(['1', '2', '3', '4']);
  });

  it('leaves the button nobody looked at off the path entirely', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    // The completing action of the redesign, which no fixation ever landed in. No mark and
    // no number at all: its absence under the outline is the whole finding.
    expect(container.querySelector('[data-fixation="B-review-complete"]')).toBeNull();
    expect(marksIn(container).length).toBe(4);
  });

  it('joins consecutive marks with a saccade, in that order', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    const marks = marksIn(container);
    const saccades = saccadesIn(container);
    expect(saccades.map((line) => line.joins)).toEqual(['1-2', '2-3', '3-4']);
    expect(saccades.map((line) => [line.x1, line.y1, line.x2, line.y2])).toEqual(
      marks.slice(1).map((mark, index) => {
        const from = marks[index] as (typeof marks)[number];
        return [from.x, from.y, mark.x, mark.y];
      }),
    );
  });

  it('comes away with its scale when the reader switches it off, and leaves the heatmap alone', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    expect(keyIn(container)).not.toBeNull();

    await userEvent.click(scanToggle());

    expect(layerIn(container)).toBeNull();
    expect(keyIn(container)).toBeNull();
    expect(container.querySelector('[data-overlay-layer="heat"]')).not.toBeNull();

    await userEvent.click(scanToggle());
    expect(layerIn(container)).not.toBeNull();
    expect(keyIn(container)).not.toBeNull();
    expect(heatToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('isolates to one area, keeping the number the whole order gave it', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', '?aoi=B-review-fee-row');
    await ready();
    decoded(container);

    expect(marksIn(container).map((mark) => [mark.number, mark.aoiId])).toEqual([
      [2, 'B-review-fee-row'],
    ]);
    expect(numeralsIn(container)).toEqual(['2']);
    // One mark is not a path: there is no second mark for a saccade to reach.
    expect(saccadesIn(container)).toEqual([]);
  });

  it('says an isolated area was never looked at rather than drawing it', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', '?aoi=B-review-complete');
    await ready();
    decoded(container);

    expect(layerIn(container)).toBeNull();
    const control = scanToggle();
    expect(control.getAttribute('aria-disabled')).toBe('true');
    // The label the areas table calls it, never the id: the two are about the same row of
    // the same page.
    expect(reasonFor(control)).toContain(
      'No fixation landed in “Completing action — A: "Place order", B: "Confirm purchase"”',
    );
    expect(reasonFor(control)).toContain('so it has no place in the order');
  });

  it('draws nothing and says so where no area was fixated at all', async () => {
    const run = seedRun();
    // A run whose figures say nobody ever looked anywhere: the committed one has no such
    // step, and "never" has to be a reading this layer can draw rather than a gap.
    const changed: Run = {
      ...run,
      aoiMetrics: run.aoiMetrics.map((metric) => ({
        ...metric,
        timeToFirstFixationMs: null,
        firstFixationDurationMs: null,
        totalDwellMs: 0,
        fixationCount: 0,
        revisits: 0,
        lookedAtShare: 0,
      })),
    };
    await serveRunData({ files: { [`/runs/${RUN_ID}/run.json`]: JSON.stringify(changed) } });
    const { container } = attention();
    await ready();
    decoded(container);

    expect(layerIn(container)).toBeNull();
    expect(keyIn(container)).toBeNull();
    const control = scanToggle();
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(control)).toBe(
      'No fixation landed anywhere on this version of this step, so there is no order to read.',
    );
  });
});

describe('what it draws', () => {
  it('anchors every mark at the centre of its area’s box, through boxToOverlay', () => {
    const { container } = render(
      <ScanpathLayer
        {...given({
          areas: [
            area('read-second', { ttffMs: 2000, x: 500, y: 3000 }),
            area('read-first', { ttffMs: 1000, x: 100, y: 200 }),
          ],
        })}
      />,
    );

    const centre = (x: number, y: number) => {
      const box = boxToOverlay({ x, y, width: 400, height: 100 }, PAGE);
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    };
    expect(marksIn(container).map(({ x, y }) => ({ x, y }))).toEqual([
      centre(100, 200),
      centre(500, 3000),
    ]);
  });

  it('keeps its numbers and its strokes off the zoom, while the marks stay in register', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    const atCapturedSize = marksIn(container);
    const numeralPlaces = () =>
      [...container.querySelectorAll('[data-fixation-label]')].map(
        (label) => (label as HTMLElement).style.cssText,
      );
    const places = numeralPlaces();

    await zoomTo('50%');
    expect(marksIn(container)).toEqual(atCapturedSize);
    expect(numeralPlaces()).toEqual(places);
    await zoomTo('200%');
    expect(marksIn(container)).toEqual(atCapturedSize);
    expect(numeralPlaces()).toEqual(places);

    // A number's place is a percentage of the page's own box and its size is a length in
    // CSS pixels, so neither is in the coordinate space the zoom scales. A saccade says
    // the same of its width, to the renderer rather than to the stylesheet.
    for (const line of saccadesIn(container)) {
      expect(line.nonScalingStroke).toBe('non-scaling-stroke');
    }
    expect(places.every((place) => place.includes('%'))).toBe(true);
  });

  it('leaves the drawing out of the accessibility tree, because it cannot be read out', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    // The areas table under the stage is this screen's accessible representation of it,
    // and the numbers here are text: it is the whole layer that is hidden, not only the
    // vector surface inside it.
    expect((layerIn(container) as HTMLElement).getAttribute('aria-hidden')).toBe('true');
    expect(
      (container.querySelector('[data-overlay-layer="scan"] svg') as SVGElement).getAttribute(
        'aria-hidden',
      ),
    ).toBe('true');
  });

  it('draws nothing over a capture of no size, which is no page to anchor a mark to', () => {
    const nowhere = given({
      areas: [area('summary')],
      transform: { pageWidth: 0, pageHeight: 0 },
    });

    // What the panel says about it is the screenshot's fault and not the areas' — below.
    expect(render(<ScanpathLayer {...nowhere} />).container.querySelector('circle')).toBeNull();
  });

  it('draws only the marks the capture can hold, and says how many it could not', () => {
    const areas = [
      area('summary', { ttffMs: 1000 }),
      // 5000 pixels down a page the capture says is 4000 tall.
      area('ghost', { ttffMs: 2000, y: 5000 }),
    ];
    const { container } = render(<ScanpathLayer {...given({ areas })} />);

    expect(marksIn(container).map((mark) => mark.aoiId)).toEqual(['summary']);
    expect(SCANPATH_LAYER.unavailable?.(given({ areas: [areas[1] as AttentionArea] }))).toContain(
      'sits outside the page this screenshot recorded',
    );
  });

  it('says there is no scanpath where the test marked no area of interest', () => {
    expect(SCANPATH_LAYER.unavailable?.(given())).toBe(
      'This test marked no area of interest on this version of this step, so there is no scanpath to draw.',
    );
  });
});

/**
 * Three ways the artifact can be wrong rather than the audience quiet. Each of them is a
 * different sentence, because "nobody looked" is the one thing this screen must not say
 * about a page it simply could not read.
 */
describe('when the test is at fault rather than the audience', () => {
  it('blames the missing screenshot, not the areas’ boxes', () => {
    const noPage = given({
      areas: [area('summary')],
      transform: { pageWidth: 0, pageHeight: 0 },
    });

    expect(SCANPATH_LAYER.unavailable?.(noPage)).toBe(
      'This test holds no usable screenshot of this version of this step, so there is nowhere to place the scanpath.',
    );
  });

  it('says a row whose figures disagree is off the path, and points at the table', () => {
    const sentence = SCANPATH_LAYER.unavailable?.(given({ areas: [contradicts('fee-row')] }));

    expect(sentence).toBe(
      'One area’s figures disagree about whether anybody looked there, so it is not on the path. The areas table names it.',
    );
  });

  it('names the isolated area whose figures disagree', () => {
    const sentence = SCANPATH_LAYER.unavailable?.(
      given({
        areas: [area('summary', { ttffMs: 1000 }), contradicts('fee-row')],
        isolatedAoiId: 'fee-row',
      }),
    );

    expect(sentence).toBe(
      'The figures for “The fee-row area” disagree about whether anybody looked there, so it is not on the path. The areas table says how.',
    );
  });

  it('states the rows it left off a path it did draw, rather than quietly drawing fewer', () => {
    const { container } = render(
      <ScanpathKey
        {...given({ areas: [area('summary', { ttffMs: 1000 }), contradicts('fee-row')] })}
      />,
    );

    expect(container.querySelector('[data-scan-contradicting]')?.textContent).toContain(
      'disagree about whether anybody looked there',
    );
  });

  it('says nothing is known rather than that nobody looked, where the run holds no figures', () => {
    const unmeasured: AttentionArea = { ...area('summary'), metric: null };

    expect(SCANPATH_LAYER.unavailable?.(given({ areas: [unmeasured] }))).toBe(
      'This test recorded no figures for any area on this version of this step, so there is no order to read. That is a gap in the test, not an audience who looked nowhere.',
    );
    expect(
      SCANPATH_LAYER.unavailable?.(given({ areas: [unmeasured], isolatedAoiId: 'summary' })),
    ).toBe(
      'This test recorded no figures for “The summary area”, so it has no place in the order. That is a gap in the test, not an area nobody looked at.',
    );
  });
});

describe('the scale beside the switch', () => {
  it('names the two ends of it in the prototype’s words', () => {
    const { container } = render(<ScanpathKey {...given({ areas: [area('summary')] })} />);

    expect((keyIn(container) as HTMLElement).dataset.scanKey).toBe('sizes');
    expect(container.textContent).toBe('brieflong dwell');
  });

  it('sits in the Overlays panel, beside the switch it belongs to', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    const key = keyIn(container) as HTMLElement;
    expect(
      screen.getByRole('heading', { name: 'Overlays' }).closest('section')?.contains(key),
    ).toBe(true);
  });

  it('states the marks it could not place on the capture rather than dropping them', () => {
    const { container } = render(
      <ScanpathKey
        {...given({
          areas: [
            area('summary', { ttffMs: 1000 }),
            // 5000 pixels down a page the capture says is 4000 tall.
            area('ghost', { ttffMs: 2000, y: 5000 }),
          ],
        })}
      />,
    );

    expect(container.querySelector('[data-scan-withheld]')?.textContent).toBe(
      'One more area was fixated and is not drawn: its box falls outside the page this screenshot recorded.',
    );
  });

  it('says nothing about placing when every mark was placed', () => {
    const { container } = render(<ScanpathKey {...given({ areas: [area('summary')] })} />);

    expect(container.querySelector('[data-scan-withheld]')).toBeNull();
  });
});

describe('its colours and widths are the gaze tokens and nothing else', () => {
  const source = (file: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');

  it('takes the marks, the numbers and the saccades from --gaze-*', () => {
    const rule = ruleIn(rulesOf(source('scanpathLayer.module.css')));

    expect(rule('.fixation')['fill']).toBe('var(--gaze-fixation)');
    expect(rule('.saccade')['stroke']).toBe('var(--gaze-saccade)');
    expect(rule('.saccade')['stroke-width']).toBe('var(--gaze-saccade-width)');
    expect(rule('.number')['color']).toBe('var(--gaze-fixation-label)');
    expect(rule('.dot')['background']).toBe('var(--gaze-fixation)');
  });

  it('gives a number the type size the tokens keep for an overlay fixation number', () => {
    const rule = ruleIn(rulesOf(source('scanpathLayer.module.css')));

    // The token itself, undivided: a length inside the overlay's `viewBox` would have to be
    // converted into overlay units and would then scale with the page (`--overlay-unit`,
    // which is what the outlines' labels do). A span's is in CSS pixels at every zoom.
    expect(rule('.number')['font-size']).toBe('var(--text-2xs)');
    expect(rule('.number')['font-weight']).toBe('var(--weight-bold)');
    expect(rule('.number')['font-family']).toBe('var(--font-sans)');
  });

  it('states no colour and no length of its own, in the layer or in its stylesheet', () => {
    for (const file of ['ScanpathLayer.tsx', 'medianScanpath.ts', 'scanpathLayer.module.css']) {
      const text = source(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, file).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab|color-mix)\(/);
      // No CSS length written out by hand either: every one of them is a token.
      expect(text, file).not.toMatch(/\b\d+(?:\.\d+)?(?:px|rem|em|pt)\b/);
    }
  });
});

describe('it is a drawing of the medians, not of the sessions', () => {
  it('draws the same path whether or not a single session has been read', () => {
    const areas = [area('summary', { ttffMs: 1000 }), area('support', { ttffMs: 2000 })];
    const marks = (props: OverlayLayerProps) =>
      marksIn(render(<ScanpathLayer {...props} />).container);

    // `loading` is the sessions still arriving, which cannot change a median the pipeline
    // already wrote: the heatmap withholds itself for it and this layer has nothing to
    // withhold. And `fixations` are the replay's own records, which nothing here reads.
    expect(marks(given({ areas, loading: true }))).toEqual(marks(given({ areas })));
    expect(SCANPATH_LAYER.unavailable?.(given({ areas, loading: true }))).toBeNull();
    expect(medianScanpath(areas, PAGE).marks.length).toBe(2);
  });
});
