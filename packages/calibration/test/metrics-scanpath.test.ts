import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSeededRandom } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  loadCorpusRecord,
  needlemanWunsch,
  regionOfFixation,
  SCANPATH_CHANCE,
  SCANPATH_METRIC_IDS,
  SCANPATH_METRIC_PARAMETERS,
  SCANPATH_METRICS,
  SCANPATH_REGION_COUNT,
  ScanpathMetricError,
  scanMatch,
  scanMatchLetters,
  scanMatchSubstitutionMatrix,
  scanpathMetric,
  scoreScanpath,
  scoreScanpathAgainstHumans,
  sequenceScore,
  visitedRegions,
} from '../src/index.js';
import type { Fixation, ImageSize, Scanpath, ScanpathMetricId } from '../src/index.js';

/**
 * The two scanpath metrics, each asserted against a value computed by hand with the
 * arithmetic written out, and against the properties #84 asks of them: identity at the top,
 * the same regions reversed strictly below it, the same order at a different dwell between
 * the two, and a random scanpath at the documented chance level.
 *
 * Every input here is built in this file — three regions of a 320 × 240 image, dwells chosen
 * so the letter counts can be read off — so this ticket never waited for the corpus. The
 * committed corpus is used at the end, for the one property it was generated to hold: that a
 * reversed scanpath, invisible to all four saliency metrics, is visible to these two.
 *
 * The published definition is Cristino, Mathôt, Theeuwes and Gilchrist, *ScanMatch: a novel
 * method for comparing fixation sequences*, Behavior Research Methods 42(3):692–700, 2010,
 * and the MATLAB toolbox the paper publishes with it (`ScanMatch.m`,
 * `ScanMatch_CreateSubMatrix.m`). Where this implementation departs from that code — a
 * substitution distance taken in normalised image space rather than in region indices, and a
 * fixation shorter than half a temporal bin kept rather than rounded away — the departure is
 * asserted here with its consequence and stated in `docs/metrics-scanpath.md`.
 */

const IMAGE: ImageSize = { width: 320, height: 240 };

/** Three points of the image, far enough apart to fall in three regions of the committed grid. */
const POINTS = {
  topLeft: { x: 40, y: 40 },
  centre: { x: 160, y: 120 },
  bottomRight: { x: 280, y: 200 },
} as const;

/** The regions those three points fall in, which the letter sequences below are written from. */
const REGION = {
  topLeft: 13,
  centre: 54,
  bottomRight: 82,
} as const;

const fixation = (
  index: number,
  point: { x: number; y: number },
  durationMs: number,
): Fixation => ({
  index,
  tMs: index * 400,
  durationMs,
  x: point.x,
  y: point.y,
});

const scanpath = (participantId: string | null, fixations: readonly Fixation[]): Scanpath => ({
  participantId,
  fixations,
});

/** The distance between two region centres in normalised image space, as the matrix measures it. */
const distance = (dx: number, dy: number): number => Math.hypot(dx, dy);

/** The committed grid's diagonal: the distance between the two extreme region centres. */
const FURTHEST = distance(11 / 12, 7 / 8);

/** One substitution score, re-derived from the parameters rather than read from the module. */
const substitution = (dx: number, dy: number): number =>
  SCANPATH_METRIC_PARAMETERS.substitutionMaximum *
  (1 - distance(dx, dy) / (SCANPATH_METRIC_PARAMETERS.substitutionZeroFraction * FURTHEST));

/** The three substitution scores this file's alignments are built out of. */
const SUB = {
  /** Region 13 (column 1, row 1) against region 54 (column 6, row 4): 5/12 across, 3/8 down. */
  topLeftToCentre: substitution(5 / 12, 3 / 8),
  /** Region 54 against region 82 (column 10, row 6): 4/12 across, 2/8 down. */
  centreToBottomRight: substitution(4 / 12, 2 / 8),
  /** Region 13 against region 82: 9/12 across, 5/8 down — more than half the diagonal, so negative. */
  topLeftToBottomRight: substitution(9 / 12, 5 / 8),
} as const;

const substitutionOf =
  (matrix: readonly number[]) =>
  (left: number, right: number): number =>
    matrix[left * SCANPATH_REGION_COUNT + right];

describe('the grid and the substitution matrix the alignment is scored over', () => {
  it('maps a fixation to the region of the committed 12 × 8 grid it fell in', () => {
    // floor(40 · 12 / 320) = 1 across, floor(40 · 8 / 240) = 1 down, read row-major: 1 · 12 + 1.
    expect(regionOfFixation(fixation(0, POINTS.topLeft, 300), IMAGE)).toBe(REGION.topLeft);
    expect(regionOfFixation(fixation(0, POINTS.centre, 300), IMAGE)).toBe(REGION.centre);
    expect(regionOfFixation(fixation(0, POINTS.bottomRight, 300), IMAGE)).toBe(REGION.bottomRight);
    expect(SCANPATH_REGION_COUNT).toBe(12 * 8);
  });

  it('shows the whole matrix of a 2 × 2 grid, where every entry can be read at a glance', () => {
    // On a 2 × 2 grid the centres sit at (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75),
    // the furthest pair is √2/2 apart and the matrix crosses zero at half of that. So a
    // neighbour, 0.5 away, scores 1 − 0.5/(√2/4) = 1 − √2, and a diagonal pair scores −1.
    const neighbour = 1 - Math.SQRT2;
    const expected = [
      1,
      neighbour,
      neighbour,
      -1,
      neighbour,
      1,
      -1,
      neighbour,
      neighbour,
      -1,
      1,
      neighbour,
      -1,
      neighbour,
      neighbour,
      1,
    ];
    const matrix = scanMatchSubstitutionMatrix(2, 2);

    expect(matrix).toHaveLength(expected.length);
    matrix.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index], 12);
    });
  });

  it('scores the same region at the maximum, half the diagonal at zero and the extremes at its negative', () => {
    const matrix = scanMatchSubstitutionMatrix();
    const score = substitutionOf(matrix);

    expect(score(REGION.topLeft, REGION.topLeft)).toBe(
      SCANPATH_METRIC_PARAMETERS.substitutionMaximum,
    );
    expect(score(0, SCANPATH_REGION_COUNT - 1)).toBeCloseTo(
      -SCANPATH_METRIC_PARAMETERS.substitutionMaximum,
      12,
    );
    // The three entries every alignment in this file is built from, each hand-derived above.
    expect(score(REGION.topLeft, REGION.centre)).toBeCloseTo(SUB.topLeftToCentre, 12);
    expect(score(REGION.centre, REGION.bottomRight)).toBeCloseTo(SUB.centreToBottomRight, 12);
    expect(score(REGION.topLeft, REGION.bottomRight)).toBeCloseTo(SUB.topLeftToBottomRight, 12);
    // Their values, so a reader need not run the arithmetic to follow the alignments below.
    expect(SUB.topLeftToCentre).toBeCloseTo(0.115295, 6);
    expect(SUB.centreToBottomRight).toBeCloseTo(0.342404, 6);
    expect(SUB.topLeftToBottomRight).toBeCloseTo(-0.540797, 6);
  });

  it('is symmetric, and measures distance in image space rather than in region indices', () => {
    const score = substitutionOf(scanMatchSubstitutionMatrix());

    expect(score(REGION.centre, REGION.topLeft)).toBe(score(REGION.topLeft, REGION.centre));
    // A region of the 12 × 8 grid is wider than it is tall, so the neighbour below is further
    // away than the neighbour to the right. The published code's index distance calls the two
    // equal; this one does not, which is the departure `docs/metrics-scanpath.md` records.
    const right = score(REGION.centre, REGION.centre + 1);
    const below = score(REGION.centre, REGION.centre + 12);
    expect(below).toBeLessThan(right);
    expect(right).toBeCloseTo(substitution(1 / 12, 0), 12);
    expect(below).toBeCloseTo(substitution(0, 1 / 8), 12);
  });
});

describe('ScanMatch on a short pair, hand-computed column by column', () => {
  // Two fixations each, dwelling 50 ms — one temporal bin, so one letter per fixation and the
  // whole alignment is two columns wide.
  const human = scanpath('p1', [
    fixation(0, POINTS.topLeft, 50),
    fixation(1, POINTS.bottomRight, 50),
  ]);
  const prediction = scanpath(null, [
    fixation(0, POINTS.topLeft, 50),
    fixation(1, POINTS.centre, 50),
  ]);

  it('writes each scanpath as its letters, one per bin of dwell', () => {
    expect(scanMatchLetters(prediction, IMAGE)).toEqual([REGION.topLeft, REGION.centre]);
    expect(scanMatchLetters(human, IMAGE)).toEqual([REGION.topLeft, REGION.bottomRight]);
  });

  it('aligns them diagonally, because the gapped alternative scores less', () => {
    const alignment = needlemanWunsch(
      [...scanMatchLetters(prediction, IMAGE)],
      [...scanMatchLetters(human, IMAGE)],
      substitutionOf(scanMatchSubstitutionMatrix()),
      SCANPATH_METRIC_PARAMETERS.gapPenalty,
    );

    expect(alignment.pairs).toEqual([
      { a: REGION.topLeft, b: REGION.topLeft },
      { a: REGION.centre, b: REGION.bottomRight },
    ]);
    // 1 for the matched first region, plus 0.342404 for the near miss on the second.
    expect(alignment.score).toBeCloseTo(1 + SUB.centreToBottomRight, 12);
    // The alternative, pairing nothing and paying two gaps at 0 each, scores 1 — less than
    // 1.3424 — which is why the diagonal won. Any pair further apart than half the image
    // would have flipped that, and does below.
    expect(alignment.score).toBeGreaterThan(1 + 2 * SCANPATH_METRIC_PARAMETERS.gapPenalty);
  });

  it('normalises by the longer sequence, so the figure is the alignment over two columns', () => {
    expect(scanMatch(prediction, human, IMAGE)).toBeCloseTo((1 + SUB.centreToBottomRight) / 2, 12);
    expect(scanMatch(prediction, human, IMAGE)).toBeCloseTo(0.671202, 6);
  });

  it('leaves a pairing further apart than half the image unaligned rather than scoring it', () => {
    // The two scanpaths now cross: top-left then bottom-right against bottom-right then
    // top-left. Pairing the two columns diagonally would score −0.540797 twice, so with a gap
    // at 0 the alignment shifts instead and keeps the one region the two have in common: one
    // matched column at 1, two gaps at 0, over a sequence of two letters.
    const crossed = scanpath(null, [
      fixation(0, POINTS.bottomRight, 50),
      fixation(1, POINTS.topLeft, 50),
    ]);
    const matrix = scanMatchSubstitutionMatrix();
    const alignment = needlemanWunsch(
      [...scanMatchLetters(crossed, IMAGE)],
      [...scanMatchLetters(human, IMAGE)],
      substitutionOf(matrix),
      SCANPATH_METRIC_PARAMETERS.gapPenalty,
    );
    const matched = alignment.pairs.filter((pair) => pair.a !== null && pair.b !== null);

    expect(alignment.score).toBe(1);
    expect(matched).toHaveLength(1);
    expect(matched[0].a).toBe(matched[0].b);
    // No column pairs two regions further apart than half the image: such a pairing scores
    // below zero, and two gaps at zero always beat it.
    for (const pair of matched) {
      expect(substitutionOf(matrix)(pair.a ?? 0, pair.b ?? 0)).toBeGreaterThanOrEqual(0);
    }
    expect(scanMatch(crossed, human, IMAGE)).toBe(1 / 2);
  });
});

describe('identity, reverse and dwell: the order #84 asks these metrics to hold', () => {
  // Three regions, 300 ms each: six letters per fixation, eighteen in all.
  const human = scanpath('p1', [
    fixation(0, POINTS.topLeft, 300),
    fixation(1, POINTS.centre, 300),
    fixation(2, POINTS.bottomRight, 300),
  ]);
  const reversed = scanpath('p2', [
    fixation(0, POINTS.bottomRight, 300),
    fixation(1, POINTS.centre, 300),
    fixation(2, POINTS.topLeft, 300),
  ]);
  /** The same three regions in the same order, dwelling 350, 250 and 300 ms. */
  const nudged = scanpath('p3', [
    fixation(0, POINTS.topLeft, 350),
    fixation(1, POINTS.centre, 250),
    fixation(2, POINTS.bottomRight, 300),
  ]);
  /** The same three regions in the same order, each held twice as long. */
  const doubled = scanpath('p4', [
    fixation(0, POINTS.topLeft, 600),
    fixation(1, POINTS.centre, 600),
    fixation(2, POINTS.bottomRight, 600),
  ]);

  it('scores the documented maximum of exactly 1 on an identical scanpath', () => {
    expect(scanMatch(human, human, IMAGE)).toBe(1);
    expect(SCANPATH_METRICS.scanMatch.best).toBe(1);
  });

  it('scores the same regions in reverse order strictly lower, at exactly a third', () => {
    // Eighteen letters each. The middle six match at 1; every other pairing is between the
    // top-left and the bottom-right region, which scores −0.540797, so the alignment leaves
    // them to gaps at 0. Six out of eighteen.
    expect(scanMatchLetters(reversed, IMAGE)).toHaveLength(18);
    expect(scanMatch(reversed, human, IMAGE)).toBeCloseTo(6 / 18, 12);
    expect(scanMatch(reversed, human, IMAGE)).toBeLessThan(scanMatch(human, human, IMAGE));
  });

  it('scores the same order at a nudged dwell between the two', () => {
    // 350 ms is seven letters and 250 ms five, so the sequence is still eighteen letters but
    // the boundary between the first two regions has moved by one: seventeen columns match at
    // 1 and one column pairs the top-left region with the centre, at 0.115295.
    expect(scanMatchLetters(nudged, IMAGE)).toHaveLength(18);
    const figure = scanMatch(nudged, human, IMAGE);

    expect(figure).toBeCloseTo((17 + SUB.topLeftToCentre) / 18, 12);
    expect(figure).toBeLessThan(scanMatch(human, human, IMAGE));
    expect(figure).toBeGreaterThan(scanMatch(reversed, human, IMAGE));
    expect(figure).toBeCloseTo(0.95085, 5);
  });

  it('reads dwell, so holding every region twice as long halves the figure', () => {
    // Thirty-six letters against eighteen: every one of the human's letters matches, and the
    // other eighteen columns are gaps. This is the published behaviour of duration-weighted
    // ScanMatch and the sharpest disagreement with the sequence score, which reads 1.
    expect(scanMatch(doubled, human, IMAGE)).toBeCloseTo(18 / 36, 12);
    expect(sequenceScore(doubled, human, IMAGE)).toBe(1);
  });

  it('is symmetric: neither scanpath is the reference', () => {
    expect(scanMatch(human, reversed, IMAGE)).toBe(scanMatch(reversed, human, IMAGE));
    expect(sequenceScore(human, nudged, IMAGE)).toBe(sequenceScore(nudged, human, IMAGE));
  });

  describe('the sequence score on the same pairs, reading order alone', () => {
    it('writes each scanpath as its visited regions, with consecutive repeats collapsed', () => {
      expect(visitedRegions(human, IMAGE)).toEqual([
        REGION.topLeft,
        REGION.centre,
        REGION.bottomRight,
      ]);
      const refixated = scanpath(null, [
        fixation(0, POINTS.topLeft, 300),
        fixation(1, { x: POINTS.topLeft.x + 2, y: POINTS.topLeft.y + 2 }, 300),
        fixation(2, POINTS.centre, 300),
      ]);
      expect(visitedRegions(refixated, IMAGE)).toEqual([REGION.topLeft, REGION.centre]);
    });

    it('counts a region returned to after leaving it, so a revisit is not collapsed', () => {
      const revisit = scanpath(null, [
        fixation(0, POINTS.topLeft, 300),
        fixation(1, POINTS.centre, 300),
        fixation(2, POINTS.topLeft, 300),
      ]);

      expect(visitedRegions(revisit, IMAGE)).toEqual([
        REGION.topLeft,
        REGION.centre,
        REGION.topLeft,
      ]);
      expect(sequenceScore(revisit, human, IMAGE)).toBeCloseTo(1 - 1 / 3, 12);
    });

    it('scores 1 on an identical scanpath and a third on the reverse', () => {
      expect(sequenceScore(human, human, IMAGE)).toBe(1);
      // Three visits each; the middle one matches and the outer two are substituted, so the
      // edit distance is 2 over a length of 3.
      expect(sequenceScore(reversed, human, IMAGE)).toBeCloseTo(1 - 2 / 3, 12);
    });

    it('scores exactly 1 on the same order at a different dwell, which is where it parts from ScanMatch', () => {
      expect(sequenceScore(nudged, human, IMAGE)).toBe(1);
      expect(scanMatch(nudged, human, IMAGE)).toBeLessThan(1);
    });

    it('gives a near miss no credit at all, which is the other place the two part', () => {
      // One region out of three replaced by its neighbour: ScanMatch still scores most of the
      // scale, because the neighbour is close; the sequence score takes the whole position
      // away, because the region is not the same region.
      const nearMiss = scanpath(null, [
        fixation(0, POINTS.topLeft, 300),
        fixation(1, { x: POINTS.centre.x + 30, y: POINTS.centre.y }, 300),
        fixation(2, POINTS.bottomRight, 300),
      ]);

      expect(visitedRegions(nearMiss, IMAGE)).not.toEqual(visitedRegions(human, IMAGE));
      expect(sequenceScore(nearMiss, human, IMAGE)).toBeCloseTo(1 - 1 / 3, 12);
      // The figure `docs/metrics-scanpath.md` quotes for this row of its disagreement table.
      expect(scanMatch(nearMiss, human, IMAGE)).toBeCloseTo(0.95616, 5);
    });
  });
});

describe('a random scanpath against a two-region pair, over the documented seed set', () => {
  /** The human walks between a region on the left and a region on the right, eight times. */
  const human = scanpath(
    'p1',
    Array.from({ length: SCANPATH_CHANCE.fixations }, (_, index) =>
      fixation(
        index,
        index % 2 === 0 ? { x: 40, y: 120 } : { x: 280, y: 120 },
        SCANPATH_CHANCE.durationMs,
      ),
    ),
  );

  /** Fixations drawn uniformly over the image from `createSeededRandom`, as #87's baseline will. */
  const randomScanpath = (seed: number): Scanpath => {
    const random = createSeededRandom(seed);
    return scanpath(
      null,
      Array.from({ length: SCANPATH_CHANCE.fixations }, (_, index) =>
        fixation(
          index,
          { x: random() * IMAGE.width, y: random() * IMAGE.height },
          SCANPATH_CHANCE.durationMs,
        ),
      ),
    );
  };

  const seeds = Array.from(
    { length: SCANPATH_CHANCE.seedCount },
    (_, offset) => SCANPATH_CHANCE.firstSeed + offset,
  );
  const figures = seeds.map((seed) => scoreScanpath(randomScanpath(seed), human, IMAGE));
  const mean = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;

  it('lands at the documented chance level for ScanMatch, within its stated tolerance', () => {
    expect(mean(figures.map((figure) => figure.scanMatch))).toBeCloseTo(
      SCANPATH_CHANCE.scanMatch.level,
      2,
    );
    expect(
      Math.abs(mean(figures.map((figure) => figure.scanMatch)) - SCANPATH_CHANCE.scanMatch.level),
    ).toBeLessThan(SCANPATH_CHANCE.scanMatch.tolerance);
  });

  it('lands at the documented chance level for the sequence score, far below ScanMatch’s', () => {
    expect(
      Math.abs(
        mean(figures.map((figure) => figure.sequenceScore)) - SCANPATH_CHANCE.sequenceScore.level,
      ),
    ).toBeLessThan(SCANPATH_CHANCE.sequenceScore.tolerance);
    // ScanMatch's chance level is high because its matrix pays for a near miss, and with 96
    // regions a random fixation is near *something*. That is why #87 measures a random
    // baseline and #88 reports a margin over it rather than a bare figure.
    expect(SCANPATH_CHANCE.sequenceScore.level).toBeLessThan(SCANPATH_CHANCE.scanMatch.level);
  });

  it('never reaches the figure the humans’ own order scores, on any seed', () => {
    for (const figure of figures) {
      expect(figure.scanMatch).toBeLessThan(scanMatch(human, human, IMAGE));
      expect(figure.sequenceScore).toBeLessThan(sequenceScore(human, human, IMAGE));
      expect(Number.isFinite(figure.scanMatch)).toBe(true);
      expect(Number.isFinite(figure.sequenceScore)).toBe(true);
    }
  });
});

describe('several humans per record: the mean over humans, with the ceiling next to it', () => {
  const walk = (participantId: string, points: readonly { x: number; y: number }[]): Scanpath =>
    scanpath(
      participantId,
      points.map((point, index) => fixation(index, point, 300)),
    );
  const humans = [
    walk('p1', [POINTS.topLeft, POINTS.centre, POINTS.bottomRight]),
    walk('p2', [POINTS.topLeft, POINTS.bottomRight, POINTS.centre]),
    walk('p3', [POINTS.centre, POINTS.topLeft, POINTS.bottomRight]),
  ];
  const prediction = walk('ignored', [POINTS.topLeft, POINTS.centre, POINTS.bottomRight]);
  const truth = { imageSize: IMAGE, scanpaths: humans };

  it('scores the prediction against every human and reports the mean, by the documented aggregation', () => {
    const agreement = scoreScanpathAgainstHumans(prediction, truth);
    const against = humans.map((human) => scoreScanpath(prediction, human, IMAGE));

    expect(SCANPATH_METRIC_PARAMETERS.humanAggregation).toBe('mean-over-humans');
    expect(agreement.humans).toBe(3);
    expect(agreement.prediction.scanMatch).toBeCloseTo(
      (against[0].scanMatch + against[1].scanMatch + against[2].scanMatch) / 3,
      12,
    );
    expect(agreement.prediction.sequenceScore).toBeCloseTo(
      (against[0].sequenceScore + against[1].sequenceScore + against[2].sequenceScore) / 3,
      12,
    );
    // Not the best-matching human: p1's scanpath is the prediction's own, and taking the
    // maximum would report 1 for a prediction that matches one participant of three.
    expect(agreement.prediction.scanMatch).toBeLessThan(1);
  });

  it('returns the human-to-human agreement as the ceiling, over the distinct pairs', () => {
    const agreement = scoreScanpathAgainstHumans(prediction, truth);
    const pairs = [
      scoreScanpath(humans[0], humans[1], IMAGE),
      scoreScanpath(humans[0], humans[2], IMAGE),
      scoreScanpath(humans[1], humans[2], IMAGE),
    ];

    expect(agreement.humanPairs).toBe(3);
    expect(agreement.humanToHuman?.scanMatch).toBeCloseTo(
      pairs.reduce((total, pair) => total + pair.scanMatch, 0) / 3,
      12,
    );
    expect(agreement.humanToHuman?.sequenceScore).toBeCloseTo(
      pairs.reduce((total, pair) => total + pair.sequenceScore, 0) / 3,
      12,
    );
    // The figure the prediction is read against: a prediction at the ceiling is as human-like
    // as the humans are like each other, and one above it agrees with the humans more than
    // they agree among themselves.
    expect(agreement.humanToHuman?.scanMatch).toBeLessThan(1);
  });

  it('reports no ceiling for a record with one participant rather than inventing one', () => {
    const agreement = scoreScanpathAgainstHumans(prediction, {
      imageSize: IMAGE,
      scanpaths: [humans[0]],
    });

    expect(agreement.humans).toBe(1);
    expect(agreement.humanPairs).toBe(0);
    expect(agreement.humanToHuman).toBeNull();
    expect(agreement.prediction.scanMatch).toBe(1);
  });

  it('does not depend on the order the record lists its participants in', () => {
    const forwards = scoreScanpathAgainstHumans(prediction, truth);
    const backwards = scoreScanpathAgainstHumans(prediction, {
      imageSize: IMAGE,
      scanpaths: [...humans].reverse(),
    });

    expect(backwards.prediction.scanMatch).toBeCloseTo(forwards.prediction.scanMatch, 12);
    expect(backwards.humanToHuman?.scanMatch).toBeCloseTo(
      forwards.humanToHuman?.scanMatch ?? Number.NaN,
      12,
    );
  });

  it('refuses a record with no human scanpath, by name', () => {
    expect(() =>
      scoreScanpathAgainstHumans(prediction, { imageSize: IMAGE, scanpaths: [] }),
    ).toThrow(ScanpathMetricError);
    expect(() =>
      scoreScanpathAgainstHumans(prediction, { imageSize: IMAGE, scanpaths: [] }),
    ).toThrow(/no human scanpath/);
  });
});

describe('degenerate inputs: a documented value or a named error, and never a NaN', () => {
  const human = scanpath('p1', [
    fixation(0, POINTS.topLeft, 300),
    fixation(1, POINTS.centre, 300),
    fixation(2, POINTS.bottomRight, 300),
  ]);
  const single = scanpath(null, [fixation(0, POINTS.topLeft, 300)]);
  const empty = scanpath(null, []);

  it('treats a single fixation as ordinary: 1 against itself, a third against three regions', () => {
    expect(scoreScanpath(single, single, IMAGE)).toEqual({ scanMatch: 1, sequenceScore: 1 });
    // Six letters against eighteen: the six match and the other twelve columns are gaps.
    expect(scanMatch(single, human, IMAGE)).toBeCloseTo(6 / 18, 12);
    expect(sequenceScore(single, human, IMAGE)).toBeCloseTo(1 / 3, 12);
  });

  it('refuses a scanpath with no fixation, by name, from both metrics', () => {
    expect(() => scanMatch(empty, human, IMAGE)).toThrow(ScanpathMetricError);
    expect(() => scanMatch(empty, human, IMAGE)).toThrow(/no fixation/);
    expect(() => sequenceScore(human, empty, IMAGE)).toThrow(/no fixation/);
    expect(() => scanMatch(empty, empty, IMAGE)).toThrow(/no fixation/);
    expect(SCANPATH_METRIC_PARAMETERS.emptyScanpathRule).toBe('reject');
  });

  it('refuses a fixation outside the image, naming its position and its coordinates', () => {
    const outside = scanpath(null, [fixation(0, { x: 321, y: 120 }, 300)]);

    expect(() => scanMatch(outside, human, IMAGE)).toThrow(/321/);
    expect(() => scanMatch(outside, human, IMAGE)).toThrow(/outside the 320 × 240 image/);
    expect(() => sequenceScore(outside, human, IMAGE)).toThrow(ScanpathMetricError);
  });

  it('puts a fixation exactly on the right or bottom edge in the last region rather than failing', () => {
    const edge = scanpath(null, [fixation(0, { x: 320, y: 240 }, 300)]);

    expect(regionOfFixation(edge.fixations[0], IMAGE)).toBe(SCANPATH_REGION_COUNT - 1);
    expect(scanMatch(edge, edge, IMAGE)).toBe(1);
    expect(SCANPATH_METRIC_PARAMETERS.fixationEdgeRule).toBe('inclusive-upper-edge');
  });

  it('keeps a fixation shorter than half a temporal bin rather than rounding it away', () => {
    // 20 ms rounds to no letter at all in the published code, which silently drops the
    // fixation; here it contributes one letter, so the scanpath keeps its shape.
    const brief = scanpath(null, [fixation(0, POINTS.topLeft, 20), fixation(1, POINTS.centre, 20)]);

    expect(scanMatchLetters(brief, IMAGE)).toEqual([REGION.topLeft, REGION.centre]);
    expect(SCANPATH_METRIC_PARAMETERS.minimumLettersPerFixation).toBe(1);
  });

  it('refuses a dwell that is not a dwell, and a point that is not a point', () => {
    const negative = scanpath(null, [fixation(0, POINTS.topLeft, -1)]);
    const notANumber = scanpath(null, [fixation(0, { x: Number.NaN, y: 10 }, 300)]);

    expect(() => scanMatch(negative, human, IMAGE)).toThrow(/not a dwell/);
    expect(() => scanMatch(notANumber, human, IMAGE)).toThrow(/not a point in the image/);
  });

  it('refuses a scanpath whose fixations are not in order, because order is the whole figure', () => {
    const shuffled = scanpath('p9', [
      fixation(1, POINTS.centre, 300),
      fixation(0, POINTS.topLeft, 300),
    ]);

    expect(() => scanMatch(shuffled, human, IMAGE)).toThrow(/out-of-order scanpath/);
    expect(() => scanMatch(shuffled, human, IMAGE)).toThrow(/participant p9/);
  });

  it('refuses an image no region can be found in', () => {
    expect(() => scanMatch(human, human, { width: 0, height: 240 })).toThrow(
      /not an image a region can be found in/,
    );
  });

  it('lets no NaN and no Infinity out of either metric, over every input above that is scored', () => {
    const scored: readonly Scanpath[] = [
      human,
      single,
      scanpath(null, [fixation(0, { x: 0, y: 0 }, 0)]),
      scanpath(null, [fixation(0, { x: 320, y: 240 }, 7000)]),
      scanpath(null, [fixation(0, POINTS.topLeft, 1), fixation(1, POINTS.topLeft, 1)]),
    ];

    for (const left of scored) {
      for (const right of scored) {
        const figures = scoreScanpath(left, right, IMAGE);
        expect(Number.isFinite(figures.scanMatch)).toBe(true);
        expect(Number.isFinite(figures.sequenceScore)).toBe(true);
        expect(figures.scanMatch).toBeGreaterThanOrEqual(0);
        expect(figures.scanMatch).toBeLessThanOrEqual(1);
        expect(figures.sequenceScore).toBeGreaterThanOrEqual(0);
        expect(figures.sequenceScore).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('each metric reports its direction as data', () => {
  it('covers both metrics exactly once, with a complete descriptor', () => {
    expect(SCANPATH_METRIC_IDS).toEqual(['scanMatch', 'sequenceScore']);
    expect(new Set(SCANPATH_METRIC_IDS).size).toBe(SCANPATH_METRIC_IDS.length);

    for (const id of SCANPATH_METRIC_IDS) {
      const descriptor = scanpathMetric(id);
      expect(descriptor.id).toBe(id);
      expect(descriptor.direction).toBe('higher-is-better');
      expect(descriptor.best).toBe(1);
      expect(descriptor.worst).toBe(0);
      expect(descriptor.inputs).toBe('two-scanpaths');
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.summary.length).toBeGreaterThan(0);
      expect(descriptor.degenerate.length).toBeGreaterThan(0);
      // Neither chance level is one number: `SCANPATH_CHANCE` states it for one setup.
      expect(descriptor.chance).toBeNull();
    }
  });

  it('moves in the direction its descriptor claims as a prediction improves', () => {
    const human = scanpath('p1', [
      fixation(0, POINTS.topLeft, 300),
      fixation(1, POINTS.centre, 300),
      fixation(2, POINTS.bottomRight, 300),
    ]);
    const worse = scanpath(null, [
      fixation(0, POINTS.bottomRight, 300),
      fixation(1, POINTS.centre, 300),
      fixation(2, POINTS.topLeft, 300),
    ]);
    const better = scanpath(null, [
      fixation(0, POINTS.topLeft, 300),
      fixation(1, POINTS.centre, 300),
      fixation(2, { x: POINTS.bottomRight.x, y: POINTS.bottomRight.y - 10 }, 300),
    ]);

    for (const id of SCANPATH_METRIC_IDS) {
      const metric: Record<ScanpathMetricId, (a: Scanpath, b: Scanpath) => number> = {
        scanMatch: (a, b) => scanMatch(a, b, IMAGE),
        sequenceScore: (a, b) => sequenceScore(a, b, IMAGE),
      };
      expect(metric[id](better, human)).toBeGreaterThan(metric[id](worse, human));
    }
  });
});

describe('the parameters are committed data, and no fit may search them', () => {
  /** The repository root, three directories above `packages/calibration/test`. */
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

  it('publishes them as frozen committed data, not as inline constants', () => {
    expect(Object.isFrozen(SCANPATH_METRIC_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(SCANPATH_METRICS)).toBe(true);
    expect(Object.isFrozen(SCANPATH_METRICS.scanMatch)).toBe(true);
    expect(Object.isFrozen(SCANPATH_CHANCE)).toBe(true);
    expect(Object.isFrozen(SCANPATH_CHANCE.scanMatch)).toBe(true);
    expect(SCANPATH_METRIC_PARAMETERS.gridWidth).toBe(12);
    expect(SCANPATH_METRIC_PARAMETERS.gridHeight).toBe(8);
    expect(SCANPATH_METRIC_PARAMETERS.durationBinMs).toBe(50);
    expect(SCANPATH_METRIC_PARAMETERS.gapPenalty).toBe(0);
    expect(() => {
      (SCANPATH_METRICS.scanMatch as { direction: string }).direction = 'lower-is-better';
    }).toThrow(TypeError);
    expect(() => {
      (SCANPATH_METRIC_PARAMETERS as unknown as { gridWidth: number }).gridWidth = 20;
    }).toThrow(TypeError);
  });

  it('exposes no way to score with a parameter of one’s own: the fit searches the engine, never the ruler', () => {
    // Every scoring entry point takes scanpaths and an image size, and nothing else. A
    // parameter a caller could pass is a parameter #90's search would find.
    expect(scanMatch).toHaveLength(3);
    expect(sequenceScore).toHaveLength(3);
    expect(scoreScanpath).toHaveLength(3);
    expect(scoreScanpathAgainstHumans).toHaveLength(2);
    // The one function that does take a grid builds a matrix for a reader; it cannot reach
    // the matrix the metric scores with.
    const before = scanMatch(
      scanpath(null, [fixation(0, POINTS.topLeft, 300), fixation(1, POINTS.centre, 300)]),
      scanpath('p1', [fixation(0, POINTS.topLeft, 300), fixation(1, POINTS.bottomRight, 300)]),
      IMAGE,
    );
    scanMatchSubstitutionMatrix(2, 2);
    expect(
      scanMatch(
        scanpath(null, [fixation(0, POINTS.topLeft, 300), fixation(1, POINTS.centre, 300)]),
        scanpath('p1', [fixation(0, POINTS.topLeft, 300), fixation(1, POINTS.bottomRight, 300)]),
        IMAGE,
      ),
    ).toBe(before);
  });

  it('shares no name with the engine’s fittable configuration, which is the search space #90 will walk', () => {
    // The search space of #90 is `EngineConfig` and nothing else (#11's auto-decision). This
    // asserts the two surfaces do not overlap, without importing the engine: the dependency
    // runs one way and `test/dependency-direction.test.ts` keeps it that way.
    const configPath = `${ROOT}packages/engine/src/config.ts`;
    if (!existsSync(configPath)) {
      throw new Error('packages/engine/src/config.ts is not in this repository');
    }
    const config = readFileSync(configPath, 'utf8');

    for (const name of Object.keys(SCANPATH_METRIC_PARAMETERS)) {
      expect(config).not.toMatch(new RegExp(String.raw`\b${name}\s*[?:]`));
    }
  });
});

describe('pure and deterministic', () => {
  const human = scanpath('p1', [
    fixation(0, POINTS.topLeft, 300),
    fixation(1, POINTS.centre, 250),
    fixation(2, POINTS.bottomRight, 410),
  ]);
  const prediction = scanpath(null, [
    fixation(0, POINTS.centre, 180),
    fixation(1, POINTS.bottomRight, 300),
  ]);

  it('gives the identical number twice, to the last bit', () => {
    expect(scoreScanpath(prediction, human, IMAGE)).toEqual(
      scoreScanpath(prediction, human, IMAGE),
    );
  });

  it('does not touch its inputs', () => {
    const before = JSON.stringify([prediction, human]);
    scoreScanpath(prediction, human, IMAGE);
    scoreScanpathAgainstHumans(prediction, { imageSize: IMAGE, scanpaths: [human] });

    expect(JSON.stringify([prediction, human])).toBe(before);
  });

  it('is invariant to the scale of the substitution matrix while the gap penalty is 0', () => {
    // The alignment score is linear in the matrix and the divisor carries the same factor, so
    // `substitutionMaximum` is a unit rather than a knob — which is why it is committed at 1
    // and why a changed gap penalty, and only that, would move the figure.
    const letters = [...scanMatchLetters(prediction, IMAGE)];
    const humanLetters = [...scanMatchLetters(human, IMAGE)];
    const matrix = scanMatchSubstitutionMatrix();
    const scale = 7.5;
    const plain = needlemanWunsch(letters, humanLetters, substitutionOf(matrix), 0);
    const scaled = needlemanWunsch(
      letters,
      humanLetters,
      (left, right) => scale * substitutionOf(matrix)(left, right),
      0,
    );

    expect(scaled.score / scale).toBeCloseTo(plain.score, 12);
    expect(scaled.pairs).toEqual(plain.pairs);
  });
});

describe('against the committed corpus', () => {
  it('sees the order a scanpath was walked in, which the four saliency metrics cannot', () => {
    // The complement of `test/metrics-saliency.test.ts`'s own claim: reversing every
    // participant's scanpath leaves all four saliency figures untouched, and moves both of
    // these.
    const record = loadCorpusRecord('desktop-two-panels');
    const reversed = [...record.scanpaths[0].fixations]
      .reverse()
      .map((entry, index) => ({ ...entry, index }));

    const forwards = scoreScanpath(record.scanpaths[0], record.scanpaths[1], record.imageSize);
    const against = scoreScanpath(
      { participantId: null, fixations: reversed },
      record.scanpaths[1],
      record.imageSize,
    );

    expect(against.scanMatch).not.toBeCloseTo(forwards.scanMatch, 6);
    expect(against.sequenceScore).not.toBeCloseTo(forwards.sequenceScore, 6);
  });

  it('reports a record’s human-to-human agreement as the ceiling a prediction is read against', () => {
    const record = loadCorpusRecord('desktop-two-panels');
    const agreement = scoreScanpathAgainstHumans(record.scanpaths[0], record);

    expect(agreement.humans).toBe(record.scanpaths.length);
    expect(agreement.humanPairs).toBe(1);
    // Two synthetic participants who walk the panels in different orders: they agree at
    // 0.706 on ScanMatch and a third on the sequence score, so that is the ceiling, not 1.
    expect(agreement.humanToHuman?.scanMatch).toBeCloseTo(0.705882, 6);
    expect(agreement.humanToHuman?.sequenceScore).toBeCloseTo(1 / 3, 6);
  });

  it('reports no ceiling for the one-participant record, rather than a fabricated 1', () => {
    const record = loadCorpusRecord('mobile-single-fixation');
    const agreement = scoreScanpathAgainstHumans(record.scanpaths[0], record);

    expect(agreement.humans).toBe(1);
    expect(agreement.humanToHuman).toBeNull();
    expect(agreement.prediction).toEqual({ scanMatch: 1, sequenceScore: 1 });
  });
});
