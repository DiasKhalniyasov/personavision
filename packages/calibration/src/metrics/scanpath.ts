/**
 * The two scanpath metrics: ScanMatch and a sequence score (#84).
 *
 * The four saliency metrics in `saliency.ts` read *where* attention landed and are blind to
 * the order it landed in — `test/metrics-saliency.test.ts` asserts that reversing every
 * participant's scanpath leaves all four figures untouched. These two metrics are what sees
 * the order, so that a scanpath that visits the right places in the wrong sequence cannot
 * pass as human.
 *
 * **ScanMatch** (Cristino, Mathôt, Theeuwes & Gilchrist, *ScanMatch: a novel method for
 * comparing fixation sequences*, Behavior Research Methods 42(3), 2010) bins the image into
 * a grid, maps each fixation to the letter of the region it fell in, repeats that letter once
 * per bin of dwell, aligns the two letter sequences with Needleman–Wunsch over a substitution
 * matrix built from the inter-region distances, and normalises. It therefore reads order,
 * position and dwell at once, and gives partial credit for a near miss.
 *
 * **The sequence score** is the simpler number: a normalised edit distance over the
 * visited-region sequence with consecutive repeats collapsed. It reads order alone — no dwell
 * weighting and no distance credit — so a reader has a figure that is not entangled with
 * duration binning, and the two numbers disagree in a way `docs/metrics-scanpath.md`
 * explains rather than averages away.
 *
 * **Route: TypeScript, no sidecar** — as #83 recorded for the saliency metrics. Both metrics
 * are a grid, an alignment and a division; #11 allows a Python sidecar confined to this
 * package for a metric that proves costly to reproduce faithfully, and neither of these is.
 *
 * Everything here is pure and deterministic: no clock, no randomness, no filesystem, no
 * network. That is what lets #88 report a figure and #90 replay a fit.
 */

import type { Fixation, GroundTruthRecord, ImageSize, Scanpath } from '../types.js';
import type { MetricDirection } from './saliency.js';

/** The two metrics this module publishes. */
export type ScanpathMetricId = 'scanMatch' | 'sequenceScore';

/** Both metrics, in the order a report lists them. */
export const SCANPATH_METRIC_IDS: readonly ScanpathMetricId[] = ['scanMatch', 'sequenceScore'];

/** What a metric reads. Both of these read two scanpaths over one image. */
export type ScanpathMetricInputs = 'two-scanpaths';

/**
 * What one scanpath metric is, as data a report can print.
 *
 * The fields are `SaliencyMetricDescriptor`'s, so #88 and #89 print a scanpath figure with
 * the code that prints a saliency one. `chance` is `null` for both: what an unrelated
 * scanpath scores depends on the grid, the two lengths and how the image's regions are
 * spread, so it is not one number — `SCANPATH_CHANCE` states the level for one documented
 * setup instead, and `#87`'s random baseline measures it on the real corpus.
 */
export interface ScanpathMetricDescriptor {
  readonly id: ScanpathMetricId;
  /** How the metric is named in a report heading, e.g. `ScanMatch`. */
  readonly label: string;
  /** What the label stands for. */
  readonly name: string;
  readonly direction: MetricDirection;
  /** The value a perfect prediction reaches, or `null` when unbounded in that direction. */
  readonly best: number | null;
  /** The value the worst prediction reaches, or `null` when unbounded in that direction. */
  readonly worst: number | null;
  /** What an unrelated scanpath scores, or `null` when that is not one number. */
  readonly chance: number | null;
  readonly inputs: ScanpathMetricInputs;
  /** One sentence on what the number means. */
  readonly summary: string;
  /** One sentence on what a degenerate input does, printable next to a figure. */
  readonly degenerate: string;
}

/**
 * Both descriptors. Frozen, because a report that could rewrite a metric's direction could
 * print a figure upside down.
 */
export const SCANPATH_METRICS: {
  readonly [K in ScanpathMetricId]: ScanpathMetricDescriptor;
} = Object.freeze({
  scanMatch: Object.freeze({
    id: 'scanMatch',
    label: 'ScanMatch',
    name: 'Needleman–Wunsch alignment of duration-weighted region sequences',
    direction: 'higher-is-better',
    best: 1,
    worst: 0,
    chance: null,
    inputs: 'two-scanpaths',
    summary:
      'How well the two scanpaths align once each fixation is written as the letter of its region, repeated once per bin of dwell: 1 is the same regions in the same order for the same time, and 0 no alignment worth making.',
    degenerate:
      'A scanpath with no fixation is refused by name, because there is no order to measure; a single fixation is ordinary, and scores at most the share of the longer letter sequence its own dwell covers — a third against three fixations of the same dwell.',
  }),
  sequenceScore: Object.freeze({
    id: 'sequenceScore',
    label: 'Sequence score',
    name: 'Normalised edit distance over the visited-region sequence',
    direction: 'higher-is-better',
    best: 1,
    worst: 0,
    chance: null,
    inputs: 'two-scanpaths',
    summary:
      'One minus the edit distance between the two sequences of visited regions, over the longer of them: 1 is the same regions in the same order, 0 no region in common at any position.',
    degenerate:
      'A scanpath with no fixation is refused by name; dwell is not read at all, so the same order held for different times scores exactly 1.',
  }),
});

/** One metric's descriptor by id. */
export const scanpathMetric = (id: ScanpathMetricId): ScanpathMetricDescriptor =>
  SCANPATH_METRICS[id];

/**
 * Every number these two metrics are decided by, as committed data with its reason.
 *
 * This is the surface #88 carries as provenance so that no figure is quoted without saying
 * what produced it, and it is deliberately **not** part of any fitting search space: #90 fits
 * the engine, never the ruler (the auto-decision on #11 settles that, and
 * `test/metrics-scanpath.test.ts` asserts it). Frozen for the same reason the descriptors
 * are.
 */
export const SCANPATH_METRIC_PARAMETERS = Object.freeze({
  /**
   * Regions across and down. 12 × 8 is the ScanMatch toolbox's own default, chosen there for
   * a 1024 × 768 display, where a region is about 85 × 96 px — roughly 2° of visual angle at
   * a normal viewing distance, which is the scale at which two fixations are the same look
   * rather than two. The grid is laid over the *image*, not over a fixed pixel size, so one
   * grid serves a 320 × 240 corpus record and a 1920 × 1080 screenshot alike and a figure
   * does not move when the dataset's resolution does.
   */
  gridWidth: 12,
  gridHeight: 8,
  /**
   * Milliseconds of dwell per repeated letter: a fixation of `durationMs` contributes
   * `max(1, round(durationMs / 50))` letters. 50 ms is the toolbox's own temporal bin and
   * sits below the shortest plausible fixation (~100 ms), so an ordinary 300 ms dwell becomes
   * six letters and the weighting is proportional rather than coarse.
   */
  durationBinMs: 50,
  /**
   * Every fixation contributes at least one letter. The published code rounds, which silently
   * drops a fixation shorter than half a bin — a departure named here because a dropped
   * fixation is a changed scanpath, and `docs/metrics-scanpath.md` records it.
   */
  minimumLettersPerFixation: 1,
  /** Distances between region centres are measured in normalised image space (the unit square). */
  substitutionDistance: 'normalised-image-space-euclidean',
  /**
   * The substitution score falls linearly with distance and crosses zero at half the grid's
   * diagonal: the same region scores `substitutionMaximum`, regions half an image apart score
   * 0, and opposite corners score `-substitutionMaximum`. A substitution matrix that only
   * rewards (never penalises) would hand two unrelated scanpaths most of the scale, which is
   * the failure the paper's own threshold exists to prevent.
   */
  substitutionZeroFraction: 0.5,
  /**
   * The score the same region scores against itself. It cancels out of the normalised figure
   * while `gapPenalty` is 0 — the alignment score is linear in the matrix and the divisor
   * carries the same factor — so its value is a unit, not a tuning knob, and a test asserts
   * the invariance.
   */
  substitutionMaximum: 1,
  /**
   * What a gap contributes, not what it costs: 0, the toolbox's default. With a matrix that
   * crosses zero at half the diagonal it means a pairing of two fixations further apart than
   * half the image is never made — two gaps at 0 beat one negative substitution — so distant
   * fixations are left unaligned rather than scored as a bad match.
   */
  gapPenalty: 0,
  /** Ties in the traceback are broken diagonal first, then a gap in the second path. */
  tracebackPreference: 'diagonal-then-gap-in-b-then-gap-in-a',
  /** The alignment score over the longer letter sequence times `substitutionMaximum`. */
  scanMatchNormalisation: 'max-length-times-substitution-maximum',
  /** The sequence score reads the same grid, so the two figures differ only in what they credit. */
  sequenceScoreAlphabet: 'the-same-grid-as-scanmatch',
  /**
   * Consecutive fixations in one region are one visit: the sequence score measures the order
   * regions were visited in, and a refixation in place is a dwell, which this metric does not
   * read. A region returned to after leaving it appears again, so a revisit still counts.
   */
  sequenceScoreRepeats: 'collapse-consecutive',
  /** Insertion, deletion and substitution all cost 1: no distance credit, no near misses. */
  sequenceScoreCosts: 'unit-insert-delete-substitute',
  /** One minus the edit distance over the longer sequence, so the figure lands in [0, 1]. */
  sequenceScoreNormalisation: 'one-minus-edit-distance-over-max-length',
  /** A prediction's figure against several humans is the mean over humans (#84). */
  humanAggregation: 'mean-over-humans',
  /** The ceiling reported next to it is the mean over the distinct pairs of humans. */
  humanToHumanAggregation: 'mean-over-distinct-pairs',
  /**
   * A fixation exactly on the right or bottom edge falls in the last region rather than
   * failing, as the saliency metrics' own rule has it; anything strictly outside the image is
   * refused by name.
   */
  fixationEdgeRule: 'inclusive-upper-edge',
  /** A scanpath with no fixation is refused rather than scored, because nothing is ordered. */
  emptyScanpathRule: 'reject',
  /**
   * The longest dwell a fixation may claim, in milliseconds. UEyes publishes its ground truth
   * at one, three and seven seconds of free viewing, so no single fixation of a record can
   * exceed seven seconds; ten leaves room and still refuses the failure this bound exists
   * for — a converter reporting microseconds, which would expand one fixation into tens of
   * thousands of letters and turn an alignment into a multi-gigabyte table rather than a
   * figure.
   */
  maximumDwellMs: 10_000,
} as const);

/**
 * What an unrelated scanpath scores, for one documented setup, as committed data.
 *
 * Neither metric's chance level is a property of the metric alone: it depends on the grid, on
 * the two lengths and on how far apart the regions a human actually visited are. So the level
 * is stated for one setup and asserted there — a two-region synthetic pair (the humans walk
 * between a region on the left and a region on the right) scored against fixations drawn
 * uniformly over the image, over the seeds `firstSeed … firstSeed + seedCount - 1` of
 * `createSeededRandom`. The figures are the mean over those seeds, and `tolerance` is how far
 * the mean may move before the metric has changed its mind about chance.
 *
 * ScanMatch's level is the higher of the two because its matrix gives partial credit for a
 * near miss, which is exactly why #87's random baseline exists and #88 reports a margin over
 * it rather than a bare score.
 */
export const SCANPATH_CHANCE = Object.freeze({
  setup: 'uniform random fixations against a two-region synthetic human scanpath',
  firstSeed: 1,
  seedCount: 32,
  /** Fixations per scanpath on both sides of the comparison. */
  fixations: 8,
  /** Every fixation of the synthetic setup dwells this long, so dwell explains no difference. */
  durationMs: 300,
  /** Measured: 0.3951 over the 32 seeds, between 0.284 and 0.521 on individual seeds. */
  scanMatch: Object.freeze({ level: 0.4, tolerance: 0.05 }),
  /** Measured: 0.0078 — with 96 regions a random fixation rarely lands in one of the two. */
  sequenceScore: Object.freeze({ level: 0.01, tolerance: 0.03 }),
} as const);

/** Raised when an input is not a scanpath these metrics can measure. */
export class ScanpathMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanpathMetricError';
  }
}

/** How many regions the committed grid has, and so how many letters the alphabet holds. */
export const SCANPATH_REGION_COUNT =
  SCANPATH_METRIC_PARAMETERS.gridWidth * SCANPATH_METRIC_PARAMETERS.gridHeight;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const describeScanpath = (scanpath: Scanpath): string =>
  scanpath.participantId === null
    ? 'the predicted scanpath'
    : `participant ${scanpath.participantId}’s scanpath`;

/**
 * A scanpath these metrics can read, or a named error.
 *
 * The array's order **is** the scanpath's order, as `Scanpath` states, so a scanpath whose
 * `index` values are not 0, 1, 2 … in order is refused rather than measured: both metrics are
 * entirely about order, and a converter that listed a record's fixations out of order would
 * otherwise produce a confident wrong figure.
 */
const assertScanpath = (scanpath: Scanpath, imageSize: ImageSize): void => {
  const where = describeScanpath(scanpath);
  if (
    !isFiniteNumber(imageSize.width) ||
    !isFiniteNumber(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    throw new ScanpathMetricError(
      `the image is ${String(imageSize.width)} × ${String(imageSize.height)}, which is not an image a region can be found in`,
    );
  }
  if (scanpath.fixations.length === 0) {
    throw new ScanpathMetricError(`${where} has no fixation, so there is no order to measure`);
  }
  scanpath.fixations.forEach((fixation, position) => {
    if (fixation.index !== position) {
      throw new ScanpathMetricError(
        `${where} lists fixation ${String(fixation.index)} at position ${String(position)}; these metrics read the array in order, so an out-of-order scanpath is refused rather than scored`,
      );
    }
    if (!isFiniteNumber(fixation.x) || !isFiniteNumber(fixation.y)) {
      throw new ScanpathMetricError(
        `fixation ${String(position)} of ${where} is at (${String(fixation.x)}, ${String(fixation.y)}), which is not a point in the image`,
      );
    }
    if (
      fixation.x < 0 ||
      fixation.y < 0 ||
      fixation.x > imageSize.width ||
      fixation.y > imageSize.height
    ) {
      throw new ScanpathMetricError(
        `fixation ${String(position)} of ${where} is at (${String(fixation.x)}, ${String(fixation.y)}), outside the ${String(imageSize.width)} × ${String(imageSize.height)} image`,
      );
    }
    if (!isFiniteNumber(fixation.durationMs) || fixation.durationMs < 0) {
      throw new ScanpathMetricError(
        `fixation ${String(position)} of ${where} dwells for ${String(fixation.durationMs)} ms, which is not a dwell`,
      );
    }
    if (fixation.durationMs > SCANPATH_METRIC_PARAMETERS.maximumDwellMs) {
      throw new ScanpathMetricError(
        `fixation ${String(position)} of ${where} dwells for ${String(fixation.durationMs)} ms, longer than the ${String(SCANPATH_METRIC_PARAMETERS.maximumDwellMs)} ms a fixation of a record viewed for at most seven seconds can claim; a dwell in the wrong unit is refused rather than aligned`,
      );
    }
  });
};

/**
 * The region a fixation fell in, as an index into the grid, read row-major:
 * `floor(x · gridWidth / imageWidth) + floor(y · gridHeight / imageHeight) · gridWidth`.
 *
 * The image's right and bottom edges are inclusive, by
 * `SCANPATH_METRIC_PARAMETERS.fixationEdgeRule`: a fixation at exactly `imageWidth` falls in
 * the last column rather than failing, because a converter that reports a boundary pixel is
 * not wrong about where the human looked. This is `SaliencyMap`'s own rule for a fixation to
 * a cell, at this metric's grid instead of a map's.
 *
 * Anything strictly outside the image is refused by name here rather than merely clamped, as
 * `saliency.ts`'s own `cellOfFixation` refuses it: this function is exported, and a caller
 * reaching it directly would otherwise be handed the last column for a fixation a hundred
 * pixels off the image, which is a wrong answer rather than a figure.
 */
export const regionOfFixation = (fixation: Fixation, imageSize: ImageSize): number => {
  const { gridWidth, gridHeight } = SCANPATH_METRIC_PARAMETERS;
  if (
    !isFiniteNumber(imageSize.width) ||
    !isFiniteNumber(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    throw new ScanpathMetricError(
      `the image is ${String(imageSize.width)} × ${String(imageSize.height)}, which is not an image a region can be found in`,
    );
  }
  if (!isFiniteNumber(fixation.x) || !isFiniteNumber(fixation.y)) {
    throw new ScanpathMetricError(
      `a fixation at (${String(fixation.x)}, ${String(fixation.y)}) is not a point in the image`,
    );
  }
  if (
    fixation.x < 0 ||
    fixation.y < 0 ||
    fixation.x > imageSize.width ||
    fixation.y > imageSize.height
  ) {
    throw new ScanpathMetricError(
      `a fixation at (${String(fixation.x)}, ${String(fixation.y)}) is outside the ${String(imageSize.width)} × ${String(imageSize.height)} image`,
    );
  }
  const column = Math.min(gridWidth - 1, Math.floor((fixation.x * gridWidth) / imageSize.width));
  const row = Math.min(gridHeight - 1, Math.floor((fixation.y * gridHeight) / imageSize.height));
  return row * gridWidth + column;
};

/**
 * The letter sequence ScanMatch aligns: one letter per region visited, repeated once per bin
 * of dwell.
 *
 * Exported because the test shows the two sequences it aligned rather than asserting a number
 * out of the air.
 */
export const scanMatchLetters = (scanpath: Scanpath, imageSize: ImageSize): readonly number[] => {
  assertScanpath(scanpath, imageSize);
  const { durationBinMs, minimumLettersPerFixation } = SCANPATH_METRIC_PARAMETERS;
  const letters: number[] = [];
  for (const fixation of scanpath.fixations) {
    const region = regionOfFixation(fixation, imageSize);
    const repeats = Math.max(
      minimumLettersPerFixation,
      Math.round(fixation.durationMs / durationBinMs),
    );
    for (let repeat = 0; repeat < repeats; repeat += 1) letters.push(region);
  }
  return letters;
};

/**
 * The visited-region sequence the sequence score reads: the regions in the order they were
 * visited, with consecutive repeats collapsed and dwell ignored.
 */
export const visitedRegions = (scanpath: Scanpath, imageSize: ImageSize): readonly number[] => {
  assertScanpath(scanpath, imageSize);
  const visits: number[] = [];
  for (const fixation of scanpath.fixations) {
    const region = regionOfFixation(fixation, imageSize);
    if (visits.length === 0 || visits[visits.length - 1] !== region) visits.push(region);
  }
  return visits;
};

/** A region's centre in normalised image space, which is where its distances are measured from. */
const regionCentre = (
  region: number,
  gridWidth: number,
  gridHeight: number,
): { readonly x: number; readonly y: number } => ({
  x: ((region % gridWidth) + 0.5) / gridWidth,
  y: (Math.floor(region / gridWidth) + 0.5) / gridHeight,
});

/**
 * The substitution matrix: `count × count` scores, row-major, built from the distances
 * between region centres in normalised image space.
 *
 * `score(p, q) = substitutionMaximum · (1 − d(p, q) / (zeroFraction · dMax))`, where `dMax` is
 * the distance between the two extreme region centres. So the same region scores
 * `substitutionMaximum`, regions `zeroFraction` of the grid's diagonal apart score 0, and
 * opposite corners score `-substitutionMaximum`. Distances are taken on the unit square
 * rather than in region indices — a region of a 12 × 8 grid is wider than it is tall, so a
 * vertical neighbour really is further away than a horizontal one, and the published code's
 * index distance would call them equal.
 *
 * Exported with its grid as arguments so that `test/metrics-scanpath.test.ts` can print a
 * whole small matrix next to the alignment it produced. The metric itself only ever uses the
 * committed grid.
 */
export const scanMatchSubstitutionMatrix = (
  gridWidth: number = SCANPATH_METRIC_PARAMETERS.gridWidth,
  gridHeight: number = SCANPATH_METRIC_PARAMETERS.gridHeight,
): readonly number[] => {
  const { substitutionMaximum, substitutionZeroFraction } = SCANPATH_METRIC_PARAMETERS;
  const count = gridWidth * gridHeight;
  if (!Number.isInteger(gridWidth) || !Number.isInteger(gridHeight) || count < 2) {
    throw new ScanpathMetricError(
      `a ${String(gridWidth)} × ${String(gridHeight)} grid is not a grid two regions can be a distance apart in, so there is no matrix to build from its distances`,
    );
  }
  const furthest = Math.hypot((gridWidth - 1) / gridWidth, (gridHeight - 1) / gridHeight);
  const matrix = new Array<number>(count * count);
  for (let left = 0; left < count; left += 1) {
    const a = regionCentre(left, gridWidth, gridHeight);
    for (let right = left; right < count; right += 1) {
      const b = regionCentre(right, gridWidth, gridHeight);
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const score = substitutionMaximum * (1 - distance / (substitutionZeroFraction * furthest));
      matrix[left * count + right] = score;
      matrix[right * count + left] = score;
    }
  }
  return matrix;
};

/** The committed grid's matrix, built once: 96 × 96 scores that never change. */
const COMMITTED_SUBSTITUTION_MATRIX = scanMatchSubstitutionMatrix();

/** One column of an alignment: a letter from each sequence, or a letter against a gap. */
export interface AlignedPair {
  readonly a: number | null;
  readonly b: number | null;
}

/** An alignment: its score, and the columns that produced it. */
export interface Alignment {
  readonly score: number;
  readonly pairs: readonly AlignedPair[];
}

/**
 * Needleman–Wunsch global alignment of two letter sequences, with the traceback.
 *
 * `substitution(p, q)` is the score for pairing two letters and `gapPenalty` what a gap
 * contributes — not what it costs, so 0 means a gap neither earns nor costs anything. Ties
 * are broken by `SCANPATH_METRIC_PARAMETERS.tracebackPreference`, which changes no score but
 * makes the printed alignment the same on every machine.
 *
 * Exported so the test can assert a hand-computed alignment, column by column, rather than
 * only the number that came out of it. The metric itself calls `alignmentScore` below, the
 * same recurrence over two rows with no traceback: a 62-participant record is nearly two
 * thousand pairs of scanpaths, and not one of those alignments is ever read.
 *
 * ponytail: the plain O(n·m) matrix, retained whole for the traceback. A 7-second scanpath of
 * 20 fixations is about 120 letters, so this is a 120 × 120 table; if a longer corpus ever
 * makes that matter, Hirschberg's linear-space variant computes the same alignment.
 */
export const needlemanWunsch = (
  a: readonly number[],
  b: readonly number[],
  substitution: (left: number, right: number) => number,
  gapPenalty: number,
): Alignment => {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const scores = new Float64Array(rows * columns);
  for (let row = 1; row < rows; row += 1) scores[row * columns] = row * gapPenalty;
  for (let column = 1; column < columns; column += 1) scores[column] = column * gapPenalty;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const diagonal =
        scores[(row - 1) * columns + (column - 1)] + substitution(a[row - 1], b[column - 1]);
      const gapInB = scores[(row - 1) * columns + column] + gapPenalty;
      const gapInA = scores[row * columns + (column - 1)] + gapPenalty;
      scores[row * columns + column] = Math.max(diagonal, gapInB, gapInA);
    }
  }

  // The walk recomputes the three candidates at each step and takes the greatest, rather than
  // testing the stored cell against each candidate in turn: a caller's own gap penalty can
  // make `row · gapPenalty` and `(row − 1) · gapPenalty + gapPenalty` differ in their last
  // bit, and a walk that needed an exact match would then fall through every branch. The two
  // drain loops are what guarantee it reaches the origin.
  const pairs: AlignedPair[] = [];
  let row = a.length;
  let column = b.length;
  while (row > 0 && column > 0) {
    const diagonal =
      scores[(row - 1) * columns + (column - 1)] + substitution(a[row - 1], b[column - 1]);
    const gapInB = scores[(row - 1) * columns + column] + gapPenalty;
    const gapInA = scores[row * columns + (column - 1)] + gapPenalty;
    const best = Math.max(diagonal, gapInB, gapInA);
    if (diagonal === best) {
      pairs.push({ a: a[row - 1], b: b[column - 1] });
      row -= 1;
      column -= 1;
    } else if (gapInB === best) {
      pairs.push({ a: a[row - 1], b: null });
      row -= 1;
    } else {
      pairs.push({ a: null, b: b[column - 1] });
      column -= 1;
    }
  }
  while (row > 0) {
    pairs.push({ a: a[row - 1], b: null });
    row -= 1;
  }
  while (column > 0) {
    pairs.push({ a: null, b: b[column - 1] });
    column -= 1;
  }
  pairs.reverse();
  return { score: scores[a.length * columns + b.length], pairs };
};

/**
 * The alignment score alone, by the same recurrence over two rows: what the metric needs, and
 * all it needs.
 *
 * `scoreScanpathAgainstHumans` on a 62-participant record aligns 1,891 pairs of humans and 62
 * more against the prediction, so `needlemanWunsch`'s traceback would be two thousand arrays
 * nobody reads. The test asserts the two agree on the figures this package publishes.
 */
const alignmentScore = (
  a: readonly number[],
  b: readonly number[],
  substitution: (left: number, right: number) => number,
  gapPenalty: number,
): number => {
  let previous = new Float64Array(b.length + 1);
  for (let column = 1; column <= b.length; column += 1) previous[column] = column * gapPenalty;
  for (let row = 1; row <= a.length; row += 1) {
    const current = new Float64Array(b.length + 1);
    current[0] = row * gapPenalty;
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.max(
        previous[column - 1] + substitution(a[row - 1], b[column - 1]),
        previous[column] + gapPenalty,
        current[column - 1] + gapPenalty,
      );
    }
    previous = current;
  }
  return previous[b.length];
};

const finite = (value: number, metric: string): number => {
  if (!Number.isFinite(value)) {
    throw new ScanpathMetricError(
      `${metric} came out as ${String(value)}, which is a defect in this metric rather than a figure`,
    );
  }
  return value;
};

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * ScanMatch for two scanpaths over one image: 1 for the same regions in the same order for
 * the same time, 0 for no alignment worth making.
 *
 * The figure is the alignment score over `max(lengthA, lengthB) · substitutionMaximum`. An
 * aligned column scores at most `substitutionMaximum` and there are at most
 * `min(lengthA, lengthB)` of them, so the figure cannot exceed 1 and reaches it only for two
 * identical letter sequences; the all-gap alignment scores 0 with `gapPenalty` at 0, so the
 * figure cannot fall below it either. Both bounds hold for the committed gap penalty and are
 * asserted; a different gap penalty would move them, which is one reason the parameters are
 * committed data.
 */
export const scanMatch = (a: Scanpath, b: Scanpath, imageSize: ImageSize): number => {
  const lettersA = scanMatchLetters(a, imageSize);
  const lettersB = scanMatchLetters(b, imageSize);
  const count = SCANPATH_REGION_COUNT;
  const score = alignmentScore(
    lettersA,
    lettersB,
    (left, right) => COMMITTED_SUBSTITUTION_MATRIX[left * count + right],
    SCANPATH_METRIC_PARAMETERS.gapPenalty,
  );
  const divisor =
    Math.max(lettersA.length, lettersB.length) * SCANPATH_METRIC_PARAMETERS.substitutionMaximum;
  return clampUnit(finite(score / divisor, 'ScanMatch'));
};

/** The edit distance between two sequences, with unit insert, delete and substitute costs. */
const editDistance = (a: readonly number[], b: readonly number[]): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, column) => column);
  for (let row = 1; row <= a.length; row += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
};

/**
 * The sequence score for two scanpaths over one image: order agreement alone.
 *
 * One minus the edit distance between the two visited-region sequences, over the longer of
 * them. No dwell, no partial credit for a near miss: a region either matches at that position
 * of the alignment or it does not. That is the point — ScanMatch's figure mixes order,
 * position and dwell, and where the two disagree `docs/metrics-scanpath.md` says which part
 * of the disagreement each number is reading.
 */
export const sequenceScore = (a: Scanpath, b: Scanpath, imageSize: ImageSize): number => {
  const visitsA = visitedRegions(a, imageSize);
  const visitsB = visitedRegions(b, imageSize);
  const longer = Math.max(visitsA.length, visitsB.length);
  return clampUnit(finite(1 - editDistance(visitsA, visitsB) / longer, 'the sequence score'));
};

/** Both figures for one pair of scanpaths. */
export interface ScanpathScores {
  readonly scanMatch: number;
  readonly sequenceScore: number;
}

/** Both metrics for one pair of scanpaths over one image. */
export const scoreScanpath = (a: Scanpath, b: Scanpath, imageSize: ImageSize): ScanpathScores => ({
  scanMatch: scanMatch(a, b, imageSize),
  sequenceScore: sequenceScore(a, b, imageSize),
});

/** What these metrics read of a record: the image's size and the humans who saw it. */
export type ScanpathGroundTruth = Pick<GroundTruthRecord, 'imageSize' | 'scanpaths'>;

/**
 * One prediction's figures against a record's several humans, with the ceiling they are
 * measured against.
 *
 * `humans` is how many human scanpaths `prediction` is the mean over and `humanPairs` how
 * many distinct pairs `humanToHuman` is the mean over, so a reader can see how much either
 * figure rests on. `humanToHuman` is `null` for a record with one participant: there is no
 * pair of humans to agree, and reporting 1 or 0 there would be a claim the record does not
 * make.
 */
export interface ScanpathAgreement {
  /** The mean over humans, by `SCANPATH_METRIC_PARAMETERS.humanAggregation`. */
  readonly prediction: ScanpathScores;
  /** The mean over the distinct pairs of humans, or `null` when there is only one human. */
  readonly humanToHuman: ScanpathScores | null;
  readonly humans: number;
  readonly humanPairs: number;
}

const meanScores = (scores: readonly ScanpathScores[]): ScanpathScores => ({
  scanMatch: scores.reduce((total, one) => total + one.scanMatch, 0) / scores.length,
  sequenceScore: scores.reduce((total, one) => total + one.sequenceScore, 0) / scores.length,
});

/**
 * Score one predicted scanpath against every human scanpath of a record, and report the
 * human-to-human agreement next to it.
 *
 * **The aggregation is the mean over humans** (#84 asks for it to be stated and implemented):
 * the prediction is scored against each participant's scanpath and the figures averaged, not
 * scored against a single representative human and not taken at the best-matching one, which
 * would flatter a prediction that happened to resemble one participant.
 *
 * **The ceiling travels with it.** The human-to-human agreement is the same two metrics over
 * every distinct pair of participants, averaged. A prediction at 0.5 means something
 * different when the humans agree at 0.55 than when they agree at 0.9, so #88 and #89 are
 * given both numbers and the counts behind them rather than one figure to quote alone.
 */
export const scoreScanpathAgainstHumans = (
  prediction: Scanpath,
  truth: ScanpathGroundTruth,
): ScanpathAgreement => {
  const humans = truth.scanpaths;
  if (humans.length === 0) {
    throw new ScanpathMetricError(
      'the record has no human scanpath, so there is nothing to score a prediction against',
    );
  }
  const against = humans.map((human) => scoreScanpath(prediction, human, truth.imageSize));
  const pairs: ScanpathScores[] = [];
  for (let left = 0; left < humans.length; left += 1) {
    for (let right = left + 1; right < humans.length; right += 1) {
      pairs.push(scoreScanpath(humans[left], humans[right], truth.imageSize));
    }
  }
  return {
    prediction: meanScores(against),
    humanToHuman: pairs.length === 0 ? null : meanScores(pairs),
    humans: humans.length,
    humanPairs: pairs.length,
  };
};
