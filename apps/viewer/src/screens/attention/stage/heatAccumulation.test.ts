import { describe, expect, it } from 'vitest';
import type { Fixation } from '../useAttentionStepSessions';
import {
  HEAT_CELL,
  HEAT_DRAWN_STEPS,
  HEAT_FIRST_STEP,
  HEAT_STEPS,
  accumulateHeat,
  heatRadius,
  heatStep,
} from './heatAccumulation';
import { pageToOverlay } from './overlayTransform';
import type { Transform } from './overlayTransform';

/**
 * The numbers behind the heatmap, which is where this ticket's one real claim lives: the
 * heat is dwell, not footfall. Nothing here renders anything — the layer's own test mounts
 * it, and neither file asserts a pixel.
 */

/** A page the width of a desktop capture, so an overlay unit is a round number of pixels. */
const PAGE: Transform = { pageWidth: 1000, pageHeight: 4000 };

let next = 0;

const fixation = (over: Partial<Fixation> = {}): Fixation => ({
  index: next,
  screenIndex: 0,
  tMs: next++ * 1000,
  durationMs: 200,
  // The replay's coordinates, deliberately nonsense here: nothing in this ticket may read
  // them, and a test that passed with them set to the answer would not say so.
  x: -1,
  y: -1,
  pageX: 500,
  pageY: 1000,
  aoiId: null,
  ...over,
});

describe('the heat is how long attention held, not how often it landed', () => {
  it('reads two 200 ms fixations at a point cooler than one 600 ms fixation at the same point', () => {
    const point = { pageX: 500, pageY: 1000 };
    const elsewhere = { pageX: 500, pageY: 3000 };

    const blobs = accumulateHeat(
      [
        fixation({ ...point, durationMs: 200 }),
        fixation({ ...point, durationMs: 200 }),
        fixation({ ...elsewhere, durationMs: 600 }),
      ],
      PAGE,
    );

    expect(blobs.length).toBe(2);
    const glanced = blobs.find((blob) => blob.fixationCount === 2);
    const dwelt = blobs.find((blob) => blob.fixationCount === 1);

    // Two looks against one, and the one look is the hotter place: the count is the thing
    // that would have said the opposite.
    expect(glanced?.dwellMs).toBe(400);
    expect(dwelt?.dwellMs).toBe(600);
    expect(glanced?.intensity).toBeLessThan(dwelt?.intensity ?? 0);
    expect(glanced?.step).toBeLessThan(dwelt?.step ?? 0);
    expect(glanced?.radius).toBeLessThan(dwelt?.radius ?? 0);
  });

  it('adds the dwell of every fixation that landed in one place', () => {
    const point = { pageX: 500, pageY: 1000 };

    const [blob] = accumulateHeat(
      [
        fixation({ ...point, durationMs: 120 }),
        fixation({ ...point, durationMs: 380 }),
        fixation({ ...point, durationMs: 500 }),
      ],
      PAGE,
    );

    expect(blob?.dwellMs).toBe(1000);
    expect(blob?.fixationCount).toBe(3);
    // The hottest place on the page is the top of the ramp, whatever its dwell is in
    // milliseconds: the key carries no number and this is what it is the legend for.
    expect(blob?.intensity).toBe(1);
    expect(blob?.step).toBe(HEAT_STEPS);
  });

  it('keeps two places apart when they are further apart than one fixation', () => {
    const apart = HEAT_CELL * 2 * (PAGE.pageWidth / 100);

    const blobs = accumulateHeat(
      [fixation({ pageX: 200, pageY: 1000 }), fixation({ pageX: 200 + apart, pageY: 1000 })],
      PAGE,
    );

    expect(blobs.length).toBe(2);
  });
});

describe('where a fixation is drawn', () => {
  it('places it through pageToOverlay, from its page coordinates', () => {
    const [blob] = accumulateHeat([fixation({ pageX: 250, pageY: 2000 })], PAGE);

    expect({ x: blob?.x, y: blob?.y }).toEqual(pageToOverlay({ pageX: 250, pageY: 2000 }, PAGE));
  });

  it('draws one place at the mean of the fixations in it, not at a grid position', () => {
    const near = HEAT_CELL * 0.1 * (PAGE.pageWidth / 100);

    const [blob] = accumulateHeat(
      [fixation({ pageX: 500, pageY: 1000 }), fixation({ pageX: 500 + near, pageY: 1000 })],
      PAGE,
    );

    expect(blob?.fixationCount).toBe(2);
    expect(blob?.x).toBeGreaterThan(pageToOverlay({ pageX: 500, pageY: 1000 }, PAGE).x);
    expect(blob?.x).toBeLessThan(pageToOverlay({ pageX: 500 + near, pageY: 1000 }, PAGE).x);
  });

  it('answers nothing for a page of no size rather than placing anything at NaN', () => {
    const blobs = accumulateHeat([fixation()], { pageWidth: 0, pageHeight: 0 });

    expect(blobs.every((blob) => Number.isFinite(blob.x) && Number.isFinite(blob.y))).toBe(true);
  });
});

describe('with one area of interest isolated', () => {
  const fixations = [
    fixation({ aoiId: 'pay', pageX: 500, pageY: 1000, durationMs: 300 }),
    fixation({ aoiId: 'cart', pageX: 500, pageY: 2000, durationMs: 900 }),
    fixation({ aoiId: null, pageX: 500, pageY: 3000, durationMs: 900 }),
  ];

  it('draws only the fixations that landed in that area', () => {
    const blobs = accumulateHeat(fixations, PAGE, 'pay');

    expect(blobs.length).toBe(1);
    expect(blobs[0]?.dwellMs).toBe(300);
    // And the one area left is the hottest thing on the page, because the page is now it.
    expect(blobs[0]?.intensity).toBe(1);
  });

  it('draws nothing at all for an area nobody fixated', () => {
    expect(accumulateHeat(fixations, PAGE, 'complete')).toEqual([]);
  });

  it('draws every place again once nothing is isolated', () => {
    expect(accumulateHeat(fixations, PAGE, null).length).toBe(3);
  });
});

describe('the ramp', () => {
  it('is the heat key’s own four steps, and never answers outside them', () => {
    expect(HEAT_STEPS).toBe(5);
    // `--heat-1` is the transparent edge a blob fades to, not a colour a place is drawn in,
    // so nothing is ever drawn in it: the page's colours are the key's four.
    expect(HEAT_DRAWN_STEPS).toEqual([2, 3, 4, 5]);
    expect(heatStep(0)).toBe(HEAT_FIRST_STEP);
    expect(heatStep(-1)).toBe(HEAT_FIRST_STEP);
    expect(heatStep(1)).toBe(HEAT_STEPS);
    expect(heatStep(2)).toBe(HEAT_STEPS);
    expect(new Set([0.2, 0.3, 0.6, 0.8, 1].map(heatStep)).size).toBe(HEAT_DRAWN_STEPS.length);
  });

  it('spreads a place’s heat further the hotter it is, and never off the page', () => {
    expect(heatRadius(1)).toBeGreaterThan(heatRadius(0));
    expect(heatRadius(0)).toBeGreaterThan(0);
    // The hottest place on a page is the prototype's own blob at a second of dwell; a page
    // of eleven people adding up to nine seconds on one button does not swallow the rest.
    expect(heatRadius(1)).toBe(15);
    expect(heatRadius(2)).toBe(heatRadius(1));
  });
});
