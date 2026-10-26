/**
 * The four standard saliency metrics — CC, NSS, KLD and AUC-Judd — so that a predicted
 * saliency map can be compared with a human one in numbers comparable to published work
 * (#11, user story 6).
 *
 * All four are implemented here in TypeScript. #11 allows a Python sidecar confined to this
 * package for a metric that proves costly to reproduce faithfully; none of these four did,
 * so there is no sidecar, nothing here leaves the main build, and the route taken is
 * recorded on #83 and #11 as that ticket requires.
 *
 * **What is compared.** Two maps are compared cell for cell on the ground truth's grid, and
 * a fixation is read at the cell it falls in by the rule `SaliencyMap` documents in
 * `src/types.ts`: row-major in image space, origin top-left, `y` downwards. Nothing here
 * resamples silently and nothing here guesses an image size —
 * `docs/metrics-saliency.md` states every rule below in one place, because a figure that
 * does not say what it compared is not a figure.
 *
 * **Nothing escapes as `NaN` or `Infinity`.** Each metric either returns a documented value
 * on a degenerate input or refuses it with a `SaliencyMetricError` that names the reason.
 * `test/metrics-saliency.test.ts` walks every degenerate case in this file's doc comments.
 *
 * **Pure and deterministic.** No clock, no randomness, no filesystem, no network: the same
 * inputs give the identical number twice, which is what lets a reported score be repeated
 * (#88) and a fit be replayed (#90).
 *
 * The published definitions these follow are the MIT saliency benchmark's — Bylinskii,
 * Judd, Oliva, Torralba and Durand, *What do different evaluation metrics tell us about
 * saliency models?*, IEEE TPAMI 41(3), 2019 (arXiv:1604.03605), and the reference
 * implementations the same group publishes as `code_forMetrics`
 * (<https://github.com/cvzoya/saliency>). Where this file departs from that code it is to
 * remove a non-determinism or a division by zero, and each departure is named at the
 * function it affects and in the doc.
 */

import type { Fixation, GroundTruthRecord, SaliencyMap, Scanpath } from '../types.js';

/**
 * Which way a metric reads, as data rather than as prose: #88 and #89 must not be able to
 * print a figure without knowing whether a larger number is a better one.
 */
export type MetricDirection = 'higher-is-better' | 'lower-is-better';

/** The four metrics this module publishes. */
export type SaliencyMetricId = 'cc' | 'nss' | 'kld' | 'aucJudd';

/** Every metric, in the order a report lists them. */
export const SALIENCY_METRIC_IDS: readonly SaliencyMetricId[] = ['cc', 'nss', 'kld', 'aucJudd'];

/** What a metric reads: two continuous maps, or one map and the human fixations. */
export type SaliencyMetricInputs = 'two-maps' | 'map-and-fixations';

/**
 * What one metric is, as data a report can print.
 *
 * `best` and `worst` are the attainable extremes, `null` where the metric is unbounded on
 * that side. `chance` is what an *uninformative* prediction scores — a finite prediction
 * with no variation, which expresses no preference at all — and is `null` for KLD, whose
 * value against a flat prediction depends on the human map's own spread and so is not one
 * number.
 */
export interface SaliencyMetricDescriptor {
  readonly id: SaliencyMetricId;
  /** How the metric is named in a report heading, e.g. `CC`. */
  readonly label: string;
  /** What the abbreviation stands for. */
  readonly name: string;
  readonly direction: MetricDirection;
  /** The value a perfect prediction reaches, or `null` when unbounded in that direction. */
  readonly best: number | null;
  /** The value the worst prediction reaches, or `null` when unbounded in that direction. */
  readonly worst: number | null;
  /** What a flat, uninformative prediction scores, or `null` when that is not one number. */
  readonly chance: number | null;
  readonly inputs: SaliencyMetricInputs;
  /** One sentence on what the number means. */
  readonly summary: string;
  /** One sentence on what a degenerate input does, printable next to a figure. */
  readonly degenerate: string;
}

/**
 * The four descriptors. Frozen, because a report that could rewrite a metric's direction
 * could print a figure upside down.
 */
export const SALIENCY_METRICS: {
  readonly [K in SaliencyMetricId]: SaliencyMetricDescriptor;
} = Object.freeze({
  cc: Object.freeze({
    id: 'cc',
    label: 'CC',
    name: 'Pearson correlation coefficient',
    direction: 'higher-is-better',
    best: 1,
    worst: -1,
    chance: 0,
    inputs: 'two-maps',
    summary:
      'How strongly the two maps vary together, cell for cell: 1 is a perfect linear agreement, 0 none, -1 an exact inversion.',
    degenerate:
      'A prediction or a human map with no variation at all scores 0 — a flat field expresses no preference, so it can share none — and an empty map is refused.',
  }),
  nss: Object.freeze({
    id: 'nss',
    label: 'NSS',
    name: 'Normalised scanpath saliency',
    direction: 'higher-is-better',
    best: null,
    worst: null,
    chance: 0,
    inputs: 'map-and-fixations',
    summary:
      'How many standard deviations above its own mean the prediction sits at the cells the humans fixated: 0 is chance, and there is no upper bound.',
    degenerate:
      'A prediction with no variation scores 0; ground truth with no fixation at all is refused, because there would be nothing to average over.',
  }),
  kld: Object.freeze({
    id: 'kld',
    label: 'KLD',
    name: 'Kullback–Leibler divergence',
    direction: 'lower-is-better',
    best: 0,
    worst: null,
    chance: null,
    inputs: 'two-maps',
    summary:
      'How many nats are lost reading the human distribution as the predicted one: 0 is identity, and it grows without bound as the prediction misses mass the humans put somewhere.',
    degenerate:
      'An all-zero map is refused by name rather than returned as infinity, because it is not a distribution; a flat prediction is a legitimate uniform distribution and scores whatever the human map’s own spread implies.',
  }),
  aucJudd: Object.freeze({
    id: 'aucJudd',
    label: 'AUC-Judd',
    name: 'Area under the ROC curve, Judd variant',
    direction: 'higher-is-better',
    best: 1,
    worst: 0,
    chance: 0.5,
    inputs: 'map-and-fixations',
    summary:
      'The chance that the prediction ranks a cell the humans fixated above one they did not: 1 ranks every fixated cell first, 0.5 is chance.',
    degenerate:
      'A prediction with no variation scores exactly 0.5, because every pair ties; ground truth with no fixation, and a map in which every cell was fixated, are both refused for want of a positive or a negative to rank.',
  }),
});

/** One metric's descriptor by id. */
export const saliencyMetric = (id: SaliencyMetricId): SaliencyMetricDescriptor =>
  SALIENCY_METRICS[id];

/**
 * Every number these metrics are decided by, as committed data with its reason.
 *
 * This is the surface #88 carries as provenance so that no figure is quoted without saying
 * what produced it, and it is deliberately **not** part of any fitting search space: #90
 * fits the engine, never the ruler (the auto-decision on #11 settles that). Frozen for the
 * same reason the descriptors are.
 */
export const SALIENCY_METRIC_PARAMETERS = Object.freeze({
  /**
   * The epsilon in KLD, guarding both the ratio and its logarithm. `Number.EPSILON` is
   * 2.220446049250313e-16, which is exactly MATLAB's `eps` and so exactly the constant the
   * published `KLdiv.m` uses.
   */
  kldEpsilon: Number.EPSILON,
  /**
   * How far two grids' aspect ratios may differ and still be called the same picture.
   * One per cent absorbs the rounding of an integer grid chosen for a given image — over a
   * 4:3 image a 16 × 12 grid is exact and a 37 × 28 one is 0.89% off, so both are the same
   * picture — and refuses a grid that is genuinely a different shape, such as 21 × 16, which
   * is 1.56% off.
   */
  gridAspectTolerance: 0.01,
  /** A prediction at a different resolution is resampled onto the ground truth's grid. */
  resolutionRule: 'resample-prediction-onto-ground-truth',
  /** Resampling is an exact area-weighted mean, then the map's own normalisation again. */
  resampleKernel: 'area-weighted-mean',
  /** Two grids of genuinely different shape are refused rather than squeezed. */
  aspectRule: 'reject',
  /** Two maps describing images of different sizes are refused. */
  imageSizeRule: 'reject',
  /**
   * Fixations are binned on the **ground truth's** grid, which is what `imresize(saliencyMap,
   * size(fixationMap))` at the head of the published `NSS.m` and `AUC_Judd.m` does.
   */
  fixationGrid: 'ground-truth',
  /** A cell counts once however many fixations landed in it: the published binary fixation map. */
  fixationCellRule: 'distinct-cells',
  /** A fixation exactly on the right or bottom edge falls in the last cell rather than failing. */
  fixationEdgeRule: 'inclusive-upper-edge',
  /** AUC-Judd's negatives are exhaustive: every cell without a human fixation, never sampled. */
  aucNegatives: 'every-cell-without-a-human-fixation',
  /** A prediction value shared by a positive and a negative counts as half a win. */
  aucTieRule: 'half-credit',
  /** NSS standardises with the sample standard deviation, as the published `NSS.m` does. */
  nssStandardDeviation: 'sample',
  /** KLD is clamped at zero from below, because the divergence cannot be negative. */
  kldNonNegativeClamp: true,
} as const);

/** A metric handed something it will not guess about. The message names the reason. */
export class SaliencyMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaliencyMetricError';
  }
}

/**
 * Checks that a map is a map: a positive integer grid, a value per cell, every value finite
 * and non-negative, and a positive image size.
 *
 * `SaliencyMap` already says a malformed map is not a special case for a metric to
 * interpret, so this refuses by name at the offending field rather than letting a `NaN`
 * travel into an average. `role` is the word a reader needs — which of the two maps.
 */
const assertMap = (map: SaliencyMap, role: string): void => {
  const grid = `${map.width} × ${map.height}`;
  if (!Number.isInteger(map.width) || !Number.isInteger(map.height)) {
    throw new SaliencyMetricError(`the ${role} map's grid is ${grid}, which is not whole cells`);
  }
  if (map.width <= 0 || map.height <= 0) {
    throw new SaliencyMetricError(`the ${role} map is empty: its grid is ${grid}`);
  }
  if (map.values.length !== map.width * map.height) {
    throw new SaliencyMetricError(
      `the ${role} map holds ${map.values.length} values for a ${grid} grid of ${map.width * map.height} cells`,
    );
  }
  for (let i = 0; i < map.values.length; i += 1) {
    const value = map.values[i];
    if (!Number.isFinite(value)) {
      throw new SaliencyMetricError(
        `the ${role} map's cell ${i} is ${String(value)}, not a finite number`,
      );
    }
    if (value < 0) {
      throw new SaliencyMetricError(
        `the ${role} map's cell ${i} is ${value}, and a saliency value may not be negative`,
      );
    }
  }
  const { width, height } = map.imageSize;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new SaliencyMetricError(
      `the ${role} map describes an image of ${width} × ${height}, which is not an image`,
    );
  }
};

const sumOf = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

/**
 * Whether a map has no variation at all: every cell bit-for-bit the same value.
 *
 * This is the test for the degenerate "flat field" case and not `variance === 0`, because a
 * mean accumulated over many cells need not land exactly on the value they all hold —
 * twelve cells of 0.4 sum to 4.800000000000001, whose twelfth is 0.4000000000000001 — and a
 * variance of a few times 10 to the minus 32 would otherwise be divided by, turning a map
 * that expresses no preference at all into a confident one.
 */
const isConstant = (values: readonly number[]): boolean => {
  const first = values[0];
  for (const value of values) if (value !== first) return false;
  return true;
};

const peakOf = (values: readonly number[]): number => {
  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  return peak;
};

const scaled = (map: SaliencyMap, factor: number): SaliencyMap => ({
  ...map,
  values: map.values.map((value) => value * factor),
});

/**
 * Puts a map back into the normalisation it claims, which a resample disturbs.
 *
 * A map whose mass or peak is zero is left alone: there is nothing to divide by, and the
 * metric that asked for it handles that degenerate case by name.
 */
const renormalised = (map: SaliencyMap): SaliencyMap => {
  switch (map.normalisation) {
    case 'sum-to-one': {
      const total = sumOf(map.values);
      return total > 0 ? scaled(map, 1 / total) : map;
    }
    case 'peak-to-one': {
      const peak = peakOf(map.values);
      return peak > 0 ? scaled(map, 1 / peak) : map;
    }
    case 'none':
      return map;
  }
};

/**
 * Resamples a map onto a `width` × `height` grid by an exact area-weighted mean: a target
 * cell takes the average of the source cells its footprint covers, each weighted by how
 * much of it is covered. The map's own normalisation is then re-applied, so the result
 * still satisfies the rule it names.
 *
 * Averaging rather than summing is a choice that cannot move any figure in this file — CC
 * and NSS are invariant to a positive affine rescaling, AUC-Judd to any monotone one, and
 * KLD renormalises both maps to distributions before it reads them — so it is made for the
 * reason that reads best: a saliency map is a field over the image, and a field resampled
 * coarser is an average, not a total. `docs/metrics-saliency.md` says so too.
 */
export const resampleSaliencyMap = (
  map: SaliencyMap,
  width: number,
  height: number,
): SaliencyMap => {
  assertMap(map, 'resampled');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new SaliencyMetricError(`cannot resample onto a ${width} × ${height} grid`);
  }
  if (map.width === width && map.height === height) return map;

  const values = new Array<number>(width * height).fill(0);
  const cellsPerColumn = map.width / width;
  const cellsPerRow = map.height / height;

  for (let targetY = 0; targetY < height; targetY += 1) {
    const top = targetY * cellsPerRow;
    const bottom = top + cellsPerRow;
    const firstRow = Math.floor(top);
    const lastRow = Math.min(map.height, Math.ceil(bottom));

    for (let targetX = 0; targetX < width; targetX += 1) {
      const left = targetX * cellsPerColumn;
      const right = left + cellsPerColumn;
      const firstColumn = Math.floor(left);
      const lastColumn = Math.min(map.width, Math.ceil(right));

      let weighted = 0;
      let area = 0;
      for (let row = firstRow; row < lastRow; row += 1) {
        const coveredRows = Math.min(bottom, row + 1) - Math.max(top, row);
        if (coveredRows <= 0) continue;
        for (let column = firstColumn; column < lastColumn; column += 1) {
          const coveredColumns = Math.min(right, column + 1) - Math.max(left, column);
          if (coveredColumns <= 0) continue;
          const weight = coveredRows * coveredColumns;
          weighted += weight * map.values[row * map.width + column];
          area += weight;
        }
      }
      values[targetY * width + targetX] = area > 0 ? weighted / area : 0;
    }
  }

  return renormalised({ ...map, width, height, values });
};

/**
 * Brings a prediction onto the ground truth's grid, which is the one documented rule for a
 * resolution or aspect mismatch:
 *
 * - The two maps must describe an image of the **same size**, or they are not about the
 *   same picture and the pair is refused.
 * - Grids of the **same shape** (their aspect ratios within
 *   `SALIENCY_METRIC_PARAMETERS.gridAspectTolerance`) but different resolutions: the
 *   prediction is resampled onto the ground truth's grid. The humans' map is never moved —
 *   it is the reference, and resampling it would change what the figure is about.
 * - Grids of a **different shape**: refused by name, with both grids in the message. A
 *   prediction at 16 × 12 and ground truth at 12 × 16 are two different pictures, and
 *   squeezing one into the other would produce a number about neither.
 */
const alignedToTruth = (prediction: SaliencyMap, truth: SaliencyMap): SaliencyMap => {
  if (
    prediction.imageSize.width !== truth.imageSize.width ||
    prediction.imageSize.height !== truth.imageSize.height
  ) {
    throw new SaliencyMetricError(
      `the prediction describes a ${prediction.imageSize.width} × ${prediction.imageSize.height} image and the ground truth a ${truth.imageSize.width} × ${truth.imageSize.height} one, so the two are not about the same picture`,
    );
  }
  if (prediction.width === truth.width && prediction.height === truth.height) return prediction;

  const predictedAspect = prediction.width / prediction.height;
  const truthAspect = truth.width / truth.height;
  if (
    Math.abs(predictedAspect - truthAspect) / truthAspect >
    SALIENCY_METRIC_PARAMETERS.gridAspectTolerance
  ) {
    throw new SaliencyMetricError(
      `the prediction's ${prediction.width} × ${prediction.height} grid and the ground truth's ${truth.width} × ${truth.height} grid are different shapes, so one cannot be resampled onto the other`,
    );
  }
  return resampleSaliencyMap(prediction, truth.width, truth.height);
};

/**
 * The cell a fixation falls in, by `SaliencyMap`'s own rule:
 * `(floor(x · width / imageWidth), floor(y · height / imageHeight))`, read row-major.
 *
 * The image's right and bottom edges are **inclusive**: a fixation at exactly `imageWidth`
 * falls in the last column rather than failing, because a converter that reports a
 * boundary pixel is not wrong about where the human looked. Anything strictly outside the
 * image is refused by name with its index and its coordinates — a fixation off the image is
 * a conversion defect, and clamping it would hide the defect behind a plausible number.
 */
const cellOfFixation = (map: SaliencyMap, fixation: Fixation): number => {
  const { x, y } = fixation;
  const { width: imageWidth, height: imageHeight } = map.imageSize;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > imageWidth ||
    y > imageHeight
  ) {
    throw new SaliencyMetricError(
      `fixation ${fixation.index} is at (${x}, ${y}), outside the ${imageWidth} × ${imageHeight} image the map describes`,
    );
  }
  const column = Math.min(map.width - 1, Math.floor((x * map.width) / imageWidth));
  const row = Math.min(map.height - 1, Math.floor((y * map.height) / imageHeight));
  return row * map.width + column;
};

/**
 * The distinct cells the humans fixated, ascending.
 *
 * A cell counts **once** however many fixations or participants landed in it. That is the
 * published convention: the MIT benchmark's NSS and AUC-Judd read a *binary* fixation map
 * (`fixationMap > 0`), so a figure from this file is comparable with one from theirs.
 * Dwell is deliberately not weighted here — how long and in what order the humans looked is
 * what the scanpath metrics measure (#84), and smuggling duration into a saliency figure
 * would make it a different quantity under a published name.
 */
const fixatedCells = (map: SaliencyMap, fixations: readonly Fixation[]): readonly number[] => {
  const cells = new Set<number>();
  for (const fixation of fixations) cells.add(cellOfFixation(map, fixation));
  return [...cells].sort((a, b) => a - b);
};

/** What a saliency comparison needs from a ground-truth record: the map and the humans. */
export type SaliencyGroundTruth = Pick<GroundTruthRecord, 'saliencyMap' | 'scanpaths'>;

/**
 * The human fixations of a record, pooled across its participants in the order the dataset
 * lists them.
 *
 * A record has one scanpath per participant who saw the image, and a saliency metric reads
 * all of them together: the human map is an aggregate, so the fixations it is scored
 * against are too.
 */
export const poolFixations = (scanpaths: readonly Scanpath[]): readonly Fixation[] =>
  scanpaths.flatMap((scanpath) => [...scanpath.fixations]);

/** Mean and sample standard deviation of a map's cells. */
const moments = (values: readonly number[]): { readonly mean: number; readonly sd: number } => {
  const mean = sumOf(values) / values.length;
  if (values.length < 2) return { mean, sd: 0 };
  let squares = 0;
  for (const value of values) squares += (value - mean) * (value - mean);
  return { mean, sd: Math.sqrt(squares / (values.length - 1)) };
};

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * A map's values divided by its peak, so that squaring and summing them cannot overflow.
 *
 * CC and NSS square every deviation, which overflows to `Infinity` above about 1e154 and
 * then produces a `NaN` or — worse — a plausible `0`; KLD sums the cells to read them as a
 * distribution, which overflows near 1e307 and silently makes every cell zero. Both metrics
 * are invariant to a positive rescaling, and AUC-Judd to any monotone one, so dividing
 * through by the peak first costs nothing and removes the whole class of overflow for any
 * finite input `assertMap` admits.
 *
 * A peak of 0 means every cell is 0, which the constant check has already handled.
 */
const scaledToPeak = (values: readonly number[]): readonly number[] => {
  const peak = peakOf(values);
  return peak > 0 && peak !== 1 ? values.map((value) => value / peak) : values;
};

/**
 * The last guard before a figure leaves this module: a metric returns a finite number or it
 * refuses by name, with no third outcome.
 *
 * Every path above either returns a documented value or raises, so reaching this is a
 * defect here rather than in the data — which is exactly why it says so instead of letting a
 * `NaN` travel into a report.
 */
const finite = (value: number, metric: string): number => {
  if (!Number.isFinite(value)) {
    throw new SaliencyMetricError(
      `${metric} came out as ${String(value)} on an input its own guards admitted, which is a defect in this module rather than in the data`,
    );
  }
  return value;
};

/**
 * **CC** — the Pearson correlation coefficient of the two maps' cells.
 *
 * Higher is better, in `[-1, 1]`: 1 is a perfect linear agreement, 0 none, -1 an exact
 * inversion. Invariant to any positive affine rescaling of either map, so the maps'
 * declared normalisations need not agree and neither is converted.
 *
 * **Compared at** the ground truth's grid, with the prediction resampled onto it if the
 * two differ — see `alignedToTruth` for the whole rule.
 *
 * **Degenerate inputs.** A map with no variation at all — every cell equal, which includes
 * an all-zero prediction — has no deviation to correlate, so the result is **0** rather
 * than `NaN`: a flat field expresses no preference, and so can share none. That holds even
 * when both maps are the same flat map, where identity is not 1 but 0, because there is
 * nothing there to agree about. An empty or malformed map is refused by name.
 */
export const cc = (prediction: SaliencyMap, truth: SaliencyMap): number => {
  assertMap(prediction, 'prediction');
  assertMap(truth, 'ground truth');
  const predicted = alignedToTruth(prediction, truth).values;
  const human = truth.values;

  if (isConstant(predicted) || isConstant(human)) return 0;

  const predictedScaled = scaledToPeak(predicted);
  const humanScaled = scaledToPeak(human);
  const predictedMean = sumOf(predictedScaled) / predictedScaled.length;
  const humanMean = sumOf(humanScaled) / humanScaled.length;

  let covariance = 0;
  let predictedSquares = 0;
  let humanSquares = 0;
  for (let i = 0; i < humanScaled.length; i += 1) {
    const a = predictedScaled[i] - predictedMean;
    const b = humanScaled[i] - humanMean;
    covariance += a * b;
    predictedSquares += a * a;
    humanSquares += b * b;
  }
  if (predictedSquares === 0 || humanSquares === 0) return 0;
  return finite(clamp(covariance / Math.sqrt(predictedSquares * humanSquares), -1, 1), 'CC');
};

/**
 * **NSS** — normalised scanpath saliency: the prediction standardised over its own cells,
 * averaged at the cells the humans fixated.
 *
 * Higher is better. 0 is chance — the mean of a standardised map is 0 — and there is **no
 * upper bound**: a map that puts everything in one cell of `n` reaches about `sqrt(n - 1)`
 * there. So NSS has no documented maximum for an identical prediction to reach, which is
 * why the identity check in `test/metrics-saliency.test.ts` covers CC, KLD and AUC-Judd and
 * not this one.
 *
 * The prediction is standardised with the **sample** standard deviation (dividing by
 * `n - 1`), which is what the published `NSS.m` does, since MATLAB's `std` is the sample
 * one. A cell counts once however many fixations landed in it (see `fixatedCells`).
 * Invariant to a positive rescaling, so no normalisation is converted.
 *
 * **Compared at** the ground truth's grid. This metric reads the human *fixations* rather
 * than the human map, but it reads them at the resolution the humans' map states, which is
 * what `imresize(saliencyMap, size(fixationMap))` at the head of the published `NSS.m`
 * does: the prediction is brought onto that grid first and standardised there. Binning at
 * the prediction's own grid instead would make the figure a function of whatever resolution
 * a predictor happened to choose, so the engine and the baselines (#87) could not be
 * compared — which is the comparison #88 exists to make.
 *
 * **Degenerate inputs.** A prediction with no variation — every cell equal, an all-zero map
 * among them — gives **0**, which is also what chance gives, because a flat map is exactly
 * as informative as chance. Ground truth with **no fixation** is refused by name: an
 * average over nothing is not a number. A single fixation is ordinary, not degenerate.
 */
export const nss = (prediction: SaliencyMap, truth: SaliencyGroundTruth): number => {
  assertMap(prediction, 'prediction');
  assertMap(truth.saliencyMap, 'ground truth');
  const aligned = alignedToTruth(prediction, truth.saliencyMap);
  const cells = fixatedCells(aligned, poolFixations(truth.scanpaths));
  if (cells.length === 0) {
    throw new SaliencyMetricError(
      'NSS needs at least one human fixation to average the prediction at, and the ground truth has none',
    );
  }
  if (isConstant(aligned.values)) return 0;
  const values = scaledToPeak(aligned.values);
  const { mean, sd } = moments(values);
  if (sd === 0) return 0;
  let total = 0;
  for (const cell of cells) total += (values[cell] - mean) / sd;
  return finite(total / cells.length, 'NSS');
};

/**
 * **KLD** — the Kullback–Leibler divergence of the human distribution from the predicted
 * one, `sum_i P_i · log(eps + P_i / (Q_i + eps))` with `P` the humans' map and `Q` the
 * prediction, both read as distributions. That is the published `KLdiv.m`'s expression
 * exactly, epsilon placement included — not the tidier
 * `sum_i P_i · log((P_i + eps) / (Q_i + eps))`, which differs from it at the epsilon's own
 * scale: indistinguishable in a figure, but not the same arithmetic.
 *
 * **Lower is better**, and this is the only one of the four that reads that way. Its
 * minimum is **0**, reached by an identical prediction, and it is unbounded above: a
 * prediction that puts no mass where the humans put theirs is punished without limit. The
 * direction is on the descriptor as data for exactly this reason.
 *
 * The direction of the divergence is the published one — the humans are the reference
 * distribution and the prediction is scored against them, so mass the prediction misses
 * costs it and mass it adds where the humans put none costs it nothing. It is **not
 * symmetric**: `kld(a, b)` and `kld(b, a)` are different numbers.
 *
 * `eps` is `SALIENCY_METRIC_PARAMETERS.kldEpsilon` = `Number.EPSILON`, exactly the `eps`
 * the published `KLdiv.m` uses, guarding both the ratio and its logarithm so that a cell
 * the prediction left at zero costs a large finite amount rather than an `Infinity`.
 *
 * Unlike the other three this metric is **not** scale-invariant, so both maps are converted
 * to sum to one first whatever normalisation they declare — the auto-decision on #81 names
 * this as the reason a map carries its normalisation at all.
 *
 * **Compared at** the ground truth's grid, as CC is.
 *
 * **Degenerate inputs.** A map whose cells sum to **zero** is not a distribution and
 * cannot be made into one, so it is refused by name rather than returned as an infinity —
 * that is the all-zero prediction case. A flat non-zero prediction is a perfectly good
 * uniform distribution and scores whatever the human map's own spread implies, which is why
 * the descriptor's `chance` is `null` here. The result is clamped at zero from below,
 * because the divergence cannot be negative and the epsilon can carry the sum a few times
 * 10 to the minus 15 beneath it; identity therefore returns exactly 0.
 */
export const kld = (prediction: SaliencyMap, truth: SaliencyMap): number => {
  assertMap(prediction, 'prediction');
  assertMap(truth, 'ground truth');
  const predicted = alignedToTruth(prediction, truth).values;
  const human = truth.values;

  const predictedScaled = scaledToPeak(predicted);
  const humanScaled = scaledToPeak(human);
  const predictedMass = sumOf(predictedScaled);
  const humanMass = sumOf(humanScaled);
  if (predictedMass === 0) {
    throw new SaliencyMetricError(
      'KLD reads both maps as distributions, and the prediction holds no mass at all: every cell is zero',
    );
  }
  if (humanMass === 0) {
    throw new SaliencyMetricError(
      'KLD reads both maps as distributions, and the ground truth holds no mass at all: every cell is zero',
    );
  }

  const epsilon = SALIENCY_METRIC_PARAMETERS.kldEpsilon;
  let total = 0;
  for (let i = 0; i < humanScaled.length; i += 1) {
    const p = humanScaled[i] / humanMass;
    if (p === 0) continue;
    const q = predictedScaled[i] / predictedMass;
    total += p * Math.log(epsilon + p / (q + epsilon));
  }
  return finite(Math.max(0, total), 'KLD');
};

/** The first index of `sorted` holding a value that is not below `value`. */
const lowerBound = (sorted: readonly number[], value: number): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** The first index of `sorted` holding a value above `value`. */
const upperBound = (sorted: readonly number[], value: number): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * **AUC-Judd** — the area under the ROC curve traced by sweeping a threshold down the
 * prediction, with the human fixations as the positives.
 *
 * Higher is better, in `[0, 1]`: **0.5 is chance**, 1 ranks every fixated cell above every
 * unfixated one. Invariant to any monotone transform of the prediction, so no normalisation
 * is converted.
 *
 * **The negative sampling is exhaustive and so needs no seed**: the negatives are *every*
 * cell of the prediction that holds no human fixation, which is the Judd variant's defining
 * choice (AUC-Borji is the one that samples, and is not this metric). Nothing here draws a
 * random number, which is what makes the figure identical across runs.
 *
 * **Ties count as half a win.** Computed as the normalised Mann–Whitney U statistic — the
 * share of (positive, negative) pairs the prediction ranks the right way, counting a pair
 * it scores equally as half — which *is* the area under the ROC curve when the curve is
 * traced through a tie block, and is where this departs from the published `AUC_Judd.m`.
 * That code adds a little random jitter to the prediction when it holds too few distinct
 * values, and without the jitter its trapezoidal sweep returns 0 rather than 0.5 for a flat
 * map. Half credit gets the right answer deterministically, and on an input with no ties
 * the two agree exactly; `docs/metrics-saliency.md` works the example through.
 *
 * **Compared at** the ground truth's grid, as NSS is and for the same reason: the published
 * `AUC_Judd.m` opens with `imresize(saliencyMap, size(fixationMap))`, so the ranking happens
 * at the resolution the humans' map states, and the prediction is brought onto that grid
 * first. Ranking on the prediction's own grid instead would make the figure a function of
 * the resolution a predictor chose — and with a prediction coarser than the ground truth it
 * would bin every cell as fixated and refuse the record outright.
 *
 * **Degenerate inputs.** A prediction with no variation scores exactly **0.5**, because
 * every pair ties. Ground truth with **no fixation** is refused for want of a positive, and
 * a map in which **every** cell holds a fixation is refused for want of a negative — a
 * one-cell map that was fixated is that second case.
 */
export const aucJudd = (prediction: SaliencyMap, truth: SaliencyGroundTruth): number => {
  assertMap(prediction, 'prediction');
  assertMap(truth.saliencyMap, 'ground truth');
  const aligned = alignedToTruth(prediction, truth.saliencyMap);
  const positiveCells = fixatedCells(aligned, poolFixations(truth.scanpaths));
  if (positiveCells.length === 0) {
    throw new SaliencyMetricError(
      'AUC-Judd needs at least one human fixation as a positive, and the ground truth has none',
    );
  }
  if (positiveCells.length === aligned.values.length) {
    throw new SaliencyMetricError(
      `AUC-Judd needs a cell without a human fixation to rank against, and all ${aligned.values.length} cells of the map hold one`,
    );
  }

  const fixated = new Set(positiveCells);
  const positives: number[] = [];
  const negatives: number[] = [];
  for (let cell = 0; cell < aligned.values.length; cell += 1) {
    (fixated.has(cell) ? positives : negatives).push(aligned.values[cell]);
  }
  negatives.sort((a, b) => a - b);

  let wins = 0;
  for (const positive of positives) {
    const below = lowerBound(negatives, positive);
    const equal = upperBound(negatives, positive) - below;
    wins += below + equal / 2;
  }
  return finite(clamp(wins / (positives.length * negatives.length), 0, 1), 'AUC-Judd');
};

/** The four figures for one prediction against one record's ground truth. */
export interface SaliencyScores {
  readonly cc: number;
  readonly nss: number;
  readonly kld: number;
  readonly aucJudd: number;
}

/**
 * All four metrics for one prediction against one record, which is the call #88 makes per
 * record.
 *
 * The prediction is brought onto the ground truth's grid once here rather than four times,
 * which changes no figure — each metric then finds the grid it would have resampled to — and
 * every rule the individual metrics document applies unchanged. So this either returns four
 * numbers or raises one `SaliencyMetricError` naming what was wrong; there is no partial
 * result.
 */
export const scoreSaliency = (
  prediction: SaliencyMap,
  truth: SaliencyGroundTruth,
): SaliencyScores => {
  assertMap(prediction, 'prediction');
  assertMap(truth.saliencyMap, 'ground truth');
  const aligned = alignedToTruth(prediction, truth.saliencyMap);
  return {
    cc: cc(aligned, truth.saliencyMap),
    nss: nss(aligned, truth),
    kld: kld(aligned, truth.saliencyMap),
    aucJudd: aucJudd(aligned, truth),
  };
};
