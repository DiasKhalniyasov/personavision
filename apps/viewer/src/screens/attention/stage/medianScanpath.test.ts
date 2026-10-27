import { describe, expect, it } from 'vitest';
import type { AttentionArea } from '../useAttentionAreas';
import { MARK_RADIUS_BRIEF, MARK_RADIUS_LONG, markRadius, medianScanpath } from './medianScanpath';
import { boxToOverlay } from './overlayTransform';
import type { Transform } from './overlayTransform';

/**
 * The numbers behind the scanpath, which is where this ticket's claims live: the order is
 * the median time to first fixation, the size is the median total dwell, and an area nobody
 * fixated is not on the path at all. Nothing here renders anything — the layer's own test
 * mounts it, and neither file asserts a pixel.
 */

/** A page the width of a desktop capture, so an overlay unit is a round number of pixels. */
const PAGE: Transform = { pageWidth: 1000, pageHeight: 4000 };

interface Given {
  /** `null` is the pipeline saying no fixation ever landed there. */
  readonly ttffMs?: number | null;
  readonly dwellMs?: number;
  readonly y?: number;
  readonly x?: number;
}

/** One area of interest with the figures the run recorded for it. */
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

/** An area the run holds no `aoiMetrics` row for at all: a gap, not a result. */
const unmeasured = (id: string): AttentionArea => ({ ...area(id), metric: null });

const numbersOf = (marks: readonly { number: number; aoiId: string }[]) =>
  marks.map((mark) => [mark.number, mark.aoiId]);

describe('the order attention moved in', () => {
  it('numbers the marks from one, in ascending median time to first fixation', () => {
    const { marks } = medianScanpath(
      [
        area('summary', { ttffMs: 33_339 }),
        area('support', { ttffMs: 37_623 }),
        area('fee-row', { ttffMs: 34_044 }),
        area('pay-with', { ttffMs: 36_759 }),
      ],
      PAGE,
    );

    expect(numbersOf(marks)).toEqual([
      [1, 'summary'],
      [2, 'fee-row'],
      [3, 'pay-with'],
      [4, 'support'],
    ]);
  });

  it('leaves two areas the audience reached at the same median in the artifact’s order', () => {
    const { marks } = medianScanpath(
      [
        area('second', { ttffMs: 2000 }),
        area('first', { ttffMs: 1000 }),
        area('third', { ttffMs: 2000 }),
      ],
      PAGE,
    );

    // The run's own order breaks the tie, so the numbering is the artifact's and not this
    // sort's: the same run numbered the same way twice over.
    expect(numbersOf(marks)).toEqual([
      [1, 'first'],
      [2, 'second'],
      [3, 'third'],
    ]);
  });

  it('gives an area nobody ever fixated no mark and no number', () => {
    const { ordered, marks } = medianScanpath(
      [
        area('ship-to', { ttffMs: null }),
        area('summary', { ttffMs: 33_339 }),
        // The button the whole demo turns on: never looked at, so never on the path.
        area('complete', { ttffMs: null }),
        area('support', { ttffMs: 37_623 }),
      ],
      PAGE,
    );

    expect(marks.map((mark) => mark.aoiId)).toEqual(['summary', 'support']);
    // And the numbers it is not on are contiguous: a gap in the numbering would be a
    // missing mark, which reads as a drawing fault rather than as nobody looking.
    expect(ordered.map((mark) => mark.number)).toEqual([1, 2]);
  });

  it('gives an area the test recorded no figures for no mark either', () => {
    const { marks } = medianScanpath([unmeasured('promo'), area('summary')], PAGE);

    expect(marks.map((mark) => mark.aoiId)).toEqual(['summary']);
  });

  it('is empty on a step where nothing was fixated at all', () => {
    const { ordered, marks, unanchored } = medianScanpath(
      [area('trust', { ttffMs: null }), area('complete', { ttffMs: null })],
      PAGE,
    );

    expect(ordered).toEqual([]);
    expect(marks).toEqual([]);
    expect(unanchored).toBe(0);
  });
});

describe('where a mark is anchored', () => {
  it('is the centre of the area’s box, through boxToOverlay', () => {
    const { marks } = medianScanpath([area('summary', { x: 100, y: 2000 })], PAGE);

    const box = boxToOverlay({ x: 100, y: 2000, width: 400, height: 100 }, PAGE);
    expect(marks[0]?.x).toBe(box.x + box.w / 2);
    expect(marks[0]?.y).toBe(box.y + box.h / 2);
    // Which on this page is a fifth of the way down and three tenths across.
    expect(marks[0]?.x).toBeCloseTo(30);
    expect(marks[0]?.y).toBeCloseTo(205);
  });

  it('places nothing on a capture of no size, and counts what it could not place', () => {
    const { ordered, marks, unanchored } = medianScanpath(
      [area('summary'), area('support', { ttffMs: 2000 })],
      { pageWidth: 0, pageHeight: 0 },
    );

    // Both areas were fixated and both are numbered; neither has a page to be placed on.
    expect(ordered.length).toBe(2);
    expect(marks).toEqual([]);
    expect(unanchored).toBe(2);
  });

  it('counts a fixated area whose box falls off the capture rather than drawing it', () => {
    // 5000 pixels down a page the capture says is 4000 tall: the figures contradict each
    // other, and a mark drawn past the screenshot's edge would be a claim about page that
    // is not there.
    const { ordered, marks, unanchored } = medianScanpath(
      [area('summary', { ttffMs: 1000 }), area('ghost', { ttffMs: 2000, y: 5000 })],
      PAGE,
    );

    expect(marks.map((mark) => mark.aoiId)).toEqual(['summary']);
    expect(unanchored).toBe(1);
    // It still took its place in the order, so the numbers either side of it are the
    // audience's and not a renumbering around a fault in the artifact.
    expect(numbersOf(ordered)).toEqual([
      [1, 'summary'],
      [2, 'ghost'],
    ]);
  });
});

describe('how large a mark is', () => {
  it('scales with the dwell, against the longest dwell on the step', () => {
    const { marks } = medianScanpath(
      [
        area('glanced', { ttffMs: 1000, dwellMs: 500 }),
        area('read', { ttffMs: 2000, dwellMs: 3500 }),
      ],
      PAGE,
    );

    const [glanced, read] = marks;
    expect(glanced?.radius).toBeLessThan(read?.radius ?? 0);
    expect(read?.radius).toBeCloseTo(MARK_RADIUS_LONG);
    expect(glanced?.radius).toBeCloseTo(markRadius(500, 3500));
    expect(glanced?.radius).toBeGreaterThan(MARK_RADIUS_BRIEF);
  });

  it('draws a step where nothing held at all at its briefest, not at its largest', () => {
    const { marks } = medianScanpath(
      [area('one', { ttffMs: 1000, dwellMs: 0 }), area('two', { ttffMs: 2000, dwellMs: 0 })],
      PAGE,
    );

    expect(marks.map((mark) => mark.radius)).toEqual([MARK_RADIUS_BRIEF, MARK_RADIUS_BRIEF]);
  });

  it('reads the dwell the pipeline wrote, and computes no median of its own', () => {
    const { marks } = medianScanpath([area('summary', { dwellMs: 3497 })], PAGE);

    expect(marks[0]?.totalDwellMs).toBe(3497);
    expect(marks[0]?.timeToFirstFixationMs).toBe(1000);
  });
});

describe('with the screen isolated to one area', () => {
  const step = [
    area('summary', { ttffMs: 33_339, dwellMs: 3497 }),
    area('fee-row', { ttffMs: 34_044, dwellMs: 2306 }),
    area('pay-with', { ttffMs: 36_759, dwellMs: 502 }),
    area('complete', { ttffMs: null, dwellMs: 0 }),
  ];

  it('draws that area alone, keeping the number the whole order gave it', () => {
    const { marks } = medianScanpath(step, PAGE, 'fee-row');

    // Second of the three fixated areas, and it still says so: a designer looking at one
    // area has to be able to see where in the order it fell.
    expect(numbersOf(marks)).toEqual([[2, 'fee-row']]);
  });

  it('keeps the mark the size it is on the whole step', () => {
    const whole = medianScanpath(step, PAGE);
    const isolated = medianScanpath(step, PAGE, 'fee-row');

    // Sized against the longest dwell on the step, never against the one mark left: an
    // isolated area swelling to the largest mark on the page would read as a long dwell.
    expect(isolated.marks[0]?.radius).toBe(
      whole.marks.find((mark) => mark.aoiId === 'fee-row')?.radius,
    );
    expect(isolated.marks[0]?.radius).toBeLessThan(MARK_RADIUS_LONG);
  });

  it('draws nothing for an area nobody fixated, and keeps the order it is not on', () => {
    const { ordered, marks, unanchored } = medianScanpath(step, PAGE, 'complete');

    expect(marks).toEqual([]);
    expect(unanchored).toBe(0);
    expect(ordered.length).toBe(3);
  });

  it('draws nothing for an area that is not on this step at all', () => {
    expect(medianScanpath(step, PAGE, 'A-review-ship-to').marks).toEqual([]);
  });
});
