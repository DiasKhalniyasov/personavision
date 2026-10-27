import { describe, expect, it } from 'vitest';
import {
  OVERLAY_SPAN,
  ZOOM_LEVELS,
  boxToOverlay,
  foldMark,
  overlaySpanY,
  pageBox,
  pageToOverlay,
  pxPerOverlayUnit,
  transformOf,
  zoomLabel,
} from './overlayTransform';
import type { Capture } from './overlayTransform';

/**
 * The stage's arithmetic, on its own.
 *
 * The point this file exists to prove is the seam's one promise: **an overlay coordinate
 * does not depend on the zoom**. Every layer of this screen — the heatmap, the scanpath,
 * the outlines — asks these two functions where a page coordinate goes, and none of them
 * is given the zoom at all, which is why none of them can drift off its element when the
 * reader zooms in.
 */

/** The committed example run's redesign at the review step: a tall mobile capture. */
const MOBILE: Capture = {
  variant: 'B',
  step: 'review',
  path: 'screenshots/B/review.png',
  viewport: { width: 390, height: 844 },
  pageHeight: 1540,
  foldY: 844,
};

/** The same page captured on a desktop viewport, as the prototype labels its fold. */
const DESKTOP: Capture = {
  variant: 'B',
  step: 'review',
  path: 'screenshots/B/review.png',
  viewport: { width: 1280, height: 800 },
  pageHeight: 1600,
  foldY: 800,
};

describe('a page coordinate on the overlay', () => {
  it('is a fraction of the screenshot, so the same point lands in the same place at every zoom', () => {
    const transform = transformOf(MOBILE);
    const halfway = pageToOverlay({ pageX: 195, pageY: 195 }, transform);

    expect(halfway).toEqual({ x: 50, y: 50 });
    // The zoom is not an argument: the surface is sized to the screenshot and transformed
    // with it, so at 50% and at 200% this is still the overlay coordinate.
    expect(pageBox(transform, 0.5)).toEqual({ width: 195, height: 770 });
    expect(pageBox(transform, 2)).toEqual({ width: 780, height: 3080 });
  });

  it('measures down the page in the same unit it measures across, so nothing is stretched', () => {
    const transform = transformOf(MOBILE);
    const square = boxToOverlay({ x: 0, y: 0, width: 100, height: 100 }, transform);

    expect(square.w).toBe(square.h);
    // Which is what makes the surface the capture's own shape: 1540px down a 390px-wide
    // page is just under four widths, and the overlay reaches just as far.
    expect(overlaySpanY(transform)).toBeCloseTo(394.872, 3);
    expect(pxPerOverlayUnit(transform)).toBe(3.9);
  });

  it('puts a fixation the run recorded where the run recorded it', () => {
    // The first fixation of S-13's review screen, in the page coordinates it was stored in.
    const at = pageToOverlay({ pageX: 202.9, pageY: 93 }, transformOf(MOBILE));

    expect(at.x).toBeCloseTo(52.026, 3);
    expect(at.y).toBeCloseTo(23.846, 3);
  });

  it('spans the whole screenshot, corner to corner', () => {
    const transform = transformOf(MOBILE);

    expect(pageToOverlay({ pageX: 0, pageY: 0 }, transform)).toEqual({ x: 0, y: 0 });
    expect(pageToOverlay({ pageX: 390, pageY: 1540 }, transform)).toEqual({
      x: OVERLAY_SPAN,
      y: overlaySpanY(transform),
    });
  });

  it('answers 0 rather than a NaN for a capture of no size', () => {
    const nothing = { pageWidth: 0, pageHeight: 0 };

    expect(overlaySpanY(nothing)).toBe(0);
    expect(pageToOverlay({ pageX: 12, pageY: 12 }, nothing)).toEqual({ x: 0, y: 0 });
    expect(boxToOverlay({ x: 1, y: 2, width: 3, height: 4 }, nothing)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});

describe('an area of interest on the overlay', () => {
  it('keeps the box the run recorded, as a fraction of the screenshot', () => {
    // `B-review-complete`: the button of the demo's whole finding, 1024px down a 1540px page.
    const box = boxToOverlay({ x: 16, y: 1024, width: 358, height: 48 }, transformOf(MOBILE));

    expect(box.x).toBeCloseTo(4.103, 3);
    expect(box.y).toBeCloseTo(262.564, 3);
    expect(box.w).toBeCloseTo(91.795, 3);
    expect(box.h).toBeCloseTo(12.308, 3);
  });

  it('places its own corner where a fixation at that corner is placed', () => {
    const transform = transformOf(MOBILE);
    const box = boxToOverlay({ x: 16, y: 1024, width: 358, height: 48 }, transform);
    const corner = pageToOverlay({ pageX: 16, pageY: 1024 }, transform);

    expect({ x: box.x, y: box.y }).toEqual(corner);
  });
});

describe('the fold', () => {
  it('sits where the first viewport ended and names the viewport it refers to', () => {
    expect(foldMark(MOBILE)).toEqual({ atPct: (844 / 1540) * 100, label: 'fold · 390 × 844' });
  });

  it('reads the same way for a desktop capture', () => {
    expect(foldMark(DESKTOP)).toEqual({ atPct: 50, label: 'fold · 1280 × 800' });
  });

  it('is the page’s own bottom edge when nothing was below it', () => {
    const short = { ...MOBILE, pageHeight: 844 };

    expect(foldMark(short)?.atPct).toBe(100);
  });

  it('is not drawn when the capture puts it outside the page it was taken of', () => {
    expect(foldMark({ ...MOBILE, foldY: 0 })).toBeNull();
    expect(foldMark({ ...MOBILE, foldY: 1541 })).toBeNull();
    expect(foldMark({ ...MOBILE, pageHeight: 0 })).toBeNull();
  });
});

describe('the zoom the stage offers', () => {
  it('opens at the size the page was captured, and offers one step either side', () => {
    expect(ZOOM_LEVELS).toEqual([0.5, 1, 2]);
    expect(ZOOM_LEVELS.map(zoomLabel)).toEqual(['50%', '100%', '200%']);
  });
});
