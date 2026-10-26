import { describe, expect, it } from 'vitest';
import {
  aucJudd,
  cc,
  kld,
  loadCorpus,
  loadCorpusRecord,
  nss,
  poolFixations,
  resampleSaliencyMap,
  SALIENCY_METRIC_IDS,
  SALIENCY_METRIC_PARAMETERS,
  SALIENCY_METRICS,
  SaliencyMetricError,
  saliencyMetric,
  scoreSaliency,
} from '../src/index.js';
import type {
  Fixation,
  GroundTruthRecord,
  SaliencyGroundTruth,
  SaliencyMap,
  SaliencyMetricId,
  SaliencyNormalisation,
} from '../src/index.js';

/**
 * The four saliency metrics, each asserted against a value computed by hand with the
 * arithmetic written out, and against the published formulation it follows.
 *
 * Every input here is built in this file — small grids with values chosen so the arithmetic
 * can be read — so this ticket never waited for the corpus. The corpus is used at the end,
 * for the two properties it was generated to hold.
 *
 * The published definitions are the MIT saliency benchmark's: Bylinskii, Judd, Oliva,
 * Torralba and Durand, *What do different evaluation metrics tell us about saliency
 * models?*, IEEE TPAMI 41(3):740–757, 2019 (arXiv:1604.03605), with the reference
 * implementations the same group publishes as `code_forMetrics`
 * (<https://github.com/cvzoya/saliency>): `CC.m`, `NSS.m`, `KLdiv.m` and `AUC_Judd.m`.
 * `describe('the published formulations')` re-derives each of those four expressions here,
 * independently of `src/metrics/saliency.ts`, and asserts the implementation agrees.
 */

/** A map over a `width` × `height` grid of a 20-pixel-per-cell image. */
const map = (
  width: number,
  height: number,
  values: readonly number[],
  normalisation: SaliencyNormalisation = 'none',
): SaliencyMap => ({
  width,
  height,
  values,
  imageSize: { width: width * 20, height: height * 20 },
  normalisation,
});

/** A fixation at an image pixel, with the dwell and onset a free-viewing record carries. */
const fix = (index: number, x: number, y: number): Fixation => ({
  index,
  tMs: index * 280,
  durationMs: 240,
  x,
  y,
});

/** The centre pixel of cell `(column, row)` of a map built by `map` above. */
const centreOf = (column: number, row: number): { x: number; y: number } => ({
  x: column * 20 + 10,
  y: row * 20 + 10,
});

/** A fixation on the centre of cell `(column, row)`. */
const fixCell = (index: number, column: number, row: number): Fixation =>
  fix(index, centreOf(column, row).x, centreOf(column, row).y);

/**
 * A 4 × 3 map with twelve distinct values and a peak at cell `(3, 0)`, used wherever a test
 * needs an ordinary non-degenerate map rather than a special one.
 */
const peaked = map(
  4,
  3,
  [0.02, 0.05, 0.09, 0.3, 0.01, 0.04, 0.08, 0.15, 0.003, 0.006, 0.02, 0.07],
  'none',
);

/** Fixations on the two heaviest cells of `peaked`: `(3, 0)` at 0.30 and `(3, 1)` at 0.15. */
const peakedFixations: readonly Fixation[] = [fixCell(0, 3, 0), fixCell(1, 3, 1)];

/**
 * Ground truth: the map whose grid the fixations are binned on, and the humans who made
 * them. One participant is enough wherever the test is not about pooling.
 */
const truthOf = (
  saliencyMap: SaliencyMap,
  fixations: readonly Fixation[],
): SaliencyGroundTruth => ({
  saliencyMap,
  scanpaths: [{ participantId: 'P-01', fixations }],
});

/**
 * NSS and AUC-Judd bin the fixations on the **ground truth's** grid. Most cases below are
 * about one map, where the ground truth's grid and the prediction's are the same one, so
 * these two wrappers say that once instead of at every call.
 * `describe('the ground truth\u2019s grid is the reference')` is where the two grids differ.
 */
const nssAt = (prediction: SaliencyMap, fixations: readonly Fixation[]): number =>
  nss(prediction, truthOf(prediction, fixations));

const aucJuddAt = (prediction: SaliencyMap, fixations: readonly Fixation[]): number =>
  aucJudd(prediction, truthOf(prediction, fixations));

/** A descriptor field that has to be a number here, so a `null` fails loudly rather than quietly. */
const required = (value: number | null, what: string): number => {
  if (value === null) throw new Error(`${what} should be a number, and is null`);
  return value;
};

const flatLike = (model: SaliencyMap, value: number): SaliencyMap => ({
  ...model,
  values: Array.from({ length: model.values.length }, () => value),
  normalisation: 'none',
});

describe('CC — the Pearson correlation of the two maps', () => {
  it('matches a value computed by hand', () => {
    // A 2 × 2 prediction and ground truth, with the deviations written out:
    //   prediction  1 2 3 4   mean 2.5   deviations -1.5 -0.5 +0.5 +1.5
    //   humans      2 3 5 6   mean 4.0   deviations -2.0 -1.0 +1.0 +2.0
    //   covariance  (-1.5)(-2) + (-0.5)(-1) + (0.5)(1) + (1.5)(2) = 3 + 0.5 + 0.5 + 3 = 7
    //   sum of squares  prediction 2.25 + 0.25 + 0.25 + 2.25 = 5     humans 4 + 1 + 1 + 4 = 10
    //   CC = 7 / sqrt(5 · 10) = 7 / (5·sqrt 2) = 0.7·sqrt 2 = 0.98994949366…
    const prediction = map(2, 2, [1, 2, 3, 4]);
    const humans = map(2, 2, [2, 3, 5, 6]);

    expect(cc(prediction, humans)).toBeCloseTo(0.7 * Math.sqrt(2), 12);
    expect(cc(prediction, humans)).toBeCloseTo(0.98994949366116653, 12);
  });

  it('is invariant to a positive affine rescaling of either map, so no normalisation is converted', () => {
    const prediction = map(2, 2, [1, 2, 3, 4]);
    const humans = map(2, 2, [2, 3, 5, 6]);
    const rescaled = map(2, 2, [1 * 7 + 3, 2 * 7 + 3, 3 * 7 + 3, 4 * 7 + 3], 'peak-to-one');

    expect(cc(rescaled, humans)).toBeCloseTo(cc(prediction, humans), 12);
  });

  it('scores the documented maximum of 1 on an identical prediction', () => {
    expect(cc(peaked, peaked)).toBe(1);
    expect(cc(peaked, peaked)).toBe(SALIENCY_METRICS.cc.best);
  });

  it('scores −1, its documented minimum, on an exactly inverted prediction', () => {
    const inverted = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => 0.3 - value),
    );

    expect(cc(inverted, peaked)).toBe(-1);
    expect(cc(inverted, peaked)).toBe(SALIENCY_METRICS.cc.worst);
  });

  it('scores exactly 0 for a uniform prediction against a peaked human map — the tolerance here is zero, because the flat branch is exact rather than numerical', () => {
    expect(cc(flatLike(peaked, 1 / peaked.values.length), peaked)).toBe(0);
    expect(cc(flatLike(peaked, 0), peaked)).toBe(0);
    expect(cc(flatLike(peaked, 1), peaked)).toBe(SALIENCY_METRICS.cc.chance);
  });

  it('scores 0 on two non-degenerate maps whose deviations are orthogonal', () => {
    // Humans 1 2 3 4 deviate by -1.5 -0.5 +0.5 +1.5; a prediction of 3 1 1 3 deviates by
    // +1 -1 -1 +1, and (-1.5)(1) + (-0.5)(-1) + (0.5)(-1) + (1.5)(1) = 0. Neither map is
    // flat, so this is chance rather than the degenerate branch.
    expect(cc(map(2, 2, [3, 1, 1, 3]), map(2, 2, [1, 2, 3, 4]))).toBe(0);
  });

  it('scores two identical flat maps 0 and not 1, because flatness carries nothing to agree about', () => {
    const flat = flatLike(peaked, 0.25);

    expect(cc(flat, flat)).toBe(0);
  });
});

describe('NSS — the prediction standardised, read at the human fixations', () => {
  it('matches a value computed by hand', () => {
    // A 2 × 2 prediction of 1 2 3 4 over a 40 × 40 image, so each cell is 20 × 20 pixels.
    //   mean 2.5; sample standard deviation sqrt((2.25+0.25+0.25+2.25)/3) = sqrt(5/3)
    //   a fixation at (30, 10) falls in cell (1, 0), value 2; at (30, 30) in cell (1, 1), value 4
    //   standardised: (2 − 2.5)/sd = −0.5/sd and (4 − 2.5)/sd = +1.5/sd
    //   NSS = mean of the two = (1.0/sd)/2 = 0.5·sqrt(3/5) = 0.38729833462…
    const prediction = map(2, 2, [1, 2, 3, 4]);
    const fixations = [fix(0, 30, 10), fix(1, 30, 30)];

    expect(nssAt(prediction, fixations)).toBeCloseTo(0.5 * Math.sqrt(0.6), 12);
    expect(nssAt(prediction, fixations)).toBeCloseTo(0.3872983346207417, 12);
  });

  it('counts a cell once however many fixations landed in it', () => {
    const prediction = map(2, 2, [1, 2, 3, 4]);
    const once = [fix(0, 30, 10), fix(1, 30, 30)];
    const twice = [...once, fix(2, 35, 35), fix(3, 25, 25)];

    expect(nssAt(prediction, twice)).toBe(nssAt(prediction, once));
  });

  it('scores 0 — chance — for a prediction with no variation, including an all-zero one', () => {
    expect(nssAt(flatLike(peaked, 0.5), peakedFixations)).toBe(0);
    expect(nssAt(flatLike(peaked, 0), peakedFixations)).toBe(0);
    expect(nssAt(flatLike(peaked, 0.5), peakedFixations)).toBe(SALIENCY_METRICS.nss.chance);
  });

  it('is positive when the prediction is heaviest where the humans looked and negative when it is lightest there', () => {
    const inverted = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => 0.3 - value),
    );

    expect(nssAt(peaked, peakedFixations)).toBeGreaterThan(0);
    expect(nssAt(inverted, peakedFixations)).toBeLessThan(0);
  });

  it('has no upper bound, so there is no maximum an identical prediction could reach', () => {
    expect(SALIENCY_METRICS.nss.best).toBeNull();
    // One cell of n holding everything reaches about sqrt(n − 1) at that cell, and a finer
    // grid reaches further: the figure grows with the resolution, so it is not a maximum.
    const spike = (cells: number): number => {
      const values = Array.from({ length: cells }, (_, index) => (index === 0 ? 1 : 0));
      return nssAt(map(cells, 1, values), [fix(0, 10, 10)]);
    };

    // One cell of n at 1 and the rest at 0: the mean is 1/n and the sample standard
    // deviation 1/sqrt(n), so the spike stands (1 − 1/n)·sqrt(n) = (n − 1)/sqrt(n) above the
    // mean — 3.75 over sixteen cells and 7.875 over sixty-four.
    expect(spike(16)).toBeCloseTo(15 / 4, 12);
    expect(spike(64)).toBeCloseTo(63 / 8, 12);
    expect(spike(64)).toBeGreaterThan(spike(16));
  });
});

describe('KLD — the human distribution read as the predicted one', () => {
  it('matches a value computed by hand', () => {
    // Humans uniform at 0.25 a cell; the prediction 0.1 0.2 0.3 0.4. With P the humans,
    //   KLD = sum P·log(P/Q) = 0.25·[ln(0.25/0.1) + ln(0.25/0.2) + ln(0.25/0.3) + ln(0.25/0.4)]
    //       = 0.25·ln( 0.25^4 / (0.1 · 0.2 · 0.3 · 0.4) )
    //       = 0.25·ln( 0.00390625 / 0.0024 ) = 0.25·ln 1.627604166… = 0.12178…
    // The epsilon moves this by about 1e-15, far inside the twelve places asserted.
    const prediction = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');
    const humans = map(2, 2, [0.25, 0.25, 0.25, 0.25], 'sum-to-one');
    const byHand = 0.25 * Math.log(0.25 ** 4 / (0.1 * 0.2 * 0.3 * 0.4));

    expect(kld(prediction, humans)).toBeCloseTo(byHand, 12);
    expect(kld(prediction, humans)).toBeCloseTo(0.121777, 6);
  });

  it('scores the documented minimum of exactly 0 on an identical prediction', () => {
    expect(kld(peaked, peaked)).toBe(0);
    expect(kld(peaked, peaked)).toBe(SALIENCY_METRICS.kld.best);
    // Also with a map whose cells are a distribution already, where the epsilon's pull is
    // largest relative to the cell values.
    const distribution = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');
    expect(kld(distribution, distribution)).toBe(0);
  });

  it('converts both maps to distributions first, so a declared normalisation does not change the figure', () => {
    const asGiven = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');
    const scaledUp = map(2, 2, [1, 2, 3, 4], 'none');
    const humans = map(2, 2, [0.25, 0.25, 0.25, 0.25], 'sum-to-one');

    expect(kld(scaledUp, humans)).toBeCloseTo(kld(asGiven, humans), 12);
  });

  it('is not symmetric: the humans are the reference and the prediction is what is scored', () => {
    const prediction = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');
    const humans = map(2, 2, [0.25, 0.25, 0.25, 0.25], 'sum-to-one');

    expect(kld(prediction, humans)).not.toBeCloseTo(kld(humans, prediction), 6);
    // Reading the humans as the prediction instead: sum Q·log(Q/P) over the same two maps,
    // = 0.1·ln0.4 + 0.2·ln0.8 + 0.3·ln1.2 + 0.4·ln1.6 = 0.0860728…
    const reversedByHand =
      0.1 * Math.log(0.4) + 0.2 * Math.log(0.8) + 0.3 * Math.log(1.2) + 0.4 * Math.log(1.6);
    expect(kld(humans, prediction)).toBeCloseTo(reversedByHand, 12);
  });

  it('punishes mass the prediction missed without ever returning Infinity', () => {
    // The prediction puts nothing in the cell holding half the humans' mass. The epsilon
    // bounds the term at about 0.5·ln(0.5/eps) ≈ 17.8 nats rather than letting it diverge.
    const prediction = map(2, 2, [0, 1 / 3, 1 / 3, 1 / 3], 'sum-to-one');
    const humans = map(2, 2, [0.5, 1 / 6, 1 / 6, 1 / 6], 'sum-to-one');
    const score = kld(prediction, humans);

    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(10);
    expect(score).toBeCloseTo(
      0.5 * Math.log(0.5 / SALIENCY_METRIC_PARAMETERS.kldEpsilon) + 3 * ((1 / 6) * Math.log(0.5)),
      6,
    );
  });

  it('grows as the prediction moves away from the humans, which is why lower is better', () => {
    const humans = map(2, 2, [0.4, 0.3, 0.2, 0.1], 'sum-to-one');
    const close = map(2, 2, [0.35, 0.3, 0.2, 0.15], 'sum-to-one');
    const far = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');

    expect(kld(close, humans)).toBeGreaterThan(0);
    expect(kld(far, humans)).toBeGreaterThan(kld(close, humans));
    expect(SALIENCY_METRICS.kld.direction).toBe('lower-is-better');
  });
});

describe('AUC-Judd — how the prediction ranks the fixated cells against the rest', () => {
  it('matches a value computed by hand, ties included', () => {
    // A 2 × 2 prediction of 0.5 0.5 0.2 0.9 over a 40 × 40 image, with fixations in cell
    // (0, 0) — value 0.5 — and cell (1, 1) — value 0.9.
    //   positives 0.5, 0.9     negatives 0.5 (cell 1) and 0.2 (cell 2)     4 pairs
    //   positive 0.5: one negative below (0.2), one tied (0.5) → 1 + 0.5 = 1.5
    //   positive 0.9: both negatives below                     → 2
    //   AUC = (1.5 + 2) / 4 = 0.875
    const prediction = map(2, 2, [0.5, 0.5, 0.2, 0.9]);
    const fixations = [fixCell(0, 0, 0), fixCell(1, 1, 1)];

    expect(aucJuddAt(prediction, fixations)).toBe(0.875);
  });

  it('scores exactly 0.5 — chance — when the fixated cell sits in the middle of a tie-free ranking', () => {
    // Nine cells with nine distinct values, one fixation on the median cell: four negatives
    // rank below it and four above, so 4 / 8 = 0.5 with no tie anywhere.
    const prediction = map(3, 3, [0, 1, 2, 3, 4, 5, 6, 7, 8]);

    expect(aucJuddAt(prediction, [fixCell(0, 1, 1)])).toBe(0.5);
    expect(aucJuddAt(prediction, [fixCell(0, 1, 1)])).toBe(SALIENCY_METRICS.aucJudd.chance);
  });

  it('scores exactly 0.5 for a uniform prediction, where every pair ties — the tolerance here is zero', () => {
    expect(aucJuddAt(flatLike(peaked, 0.5), peakedFixations)).toBe(0.5);
    expect(aucJuddAt(flatLike(peaked, 0), peakedFixations)).toBe(0.5);
  });

  it('scores the documented maximum of 1 when every fixated cell outranks every other', () => {
    // The identity case for this metric: a human map whose heaviest cells are the ones the
    // humans fixated, scored against those fixations. `peaked`'s two heaviest cells, 0.30
    // and 0.15, are exactly where `peakedFixations` land.
    expect(aucJuddAt(peaked, peakedFixations)).toBe(1);
    expect(aucJuddAt(peaked, peakedFixations)).toBe(SALIENCY_METRICS.aucJudd.best);
  });

  it('scores its documented minimum of 0 when every fixated cell ranks below every other', () => {
    const inverted = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => 0.3 - value),
    );

    expect(aucJuddAt(inverted, peakedFixations)).toBe(0);
    expect(aucJuddAt(inverted, peakedFixations)).toBe(SALIENCY_METRICS.aucJudd.worst);
  });

  it('is invariant to any monotone transform of the prediction', () => {
    const squared = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => value * value),
      'peak-to-one',
    );

    expect(aucJuddAt(squared, peakedFixations)).toBe(aucJuddAt(peaked, peakedFixations));
  });

  it('counts a cell once however many fixations landed in it', () => {
    const extra = [...peakedFixations, fixCell(2, 3, 0), fixCell(3, 3, 1)];

    expect(aucJuddAt(peaked, extra)).toBe(aucJuddAt(peaked, peakedFixations));
  });
});

describe('the published formulations', () => {
  /**
   * The four expressions as the MIT benchmark's `code_forMetrics` publishes them,
   * re-derived here from the published definitions and deliberately not calling
   * `src/metrics/saliency.ts`, so that this file compares an implementation with a
   * reference rather than with itself.
   *
   * Three of the four are transcribed exactly and agree to the last place. AUC-Judd is
   * checked against the textbook area under the ROC curve — the quantity `AUC_Judd.m` sets
   * out to compute, and the one the implementation computes exactly — and then against
   * that file's own threshold sweep, which only samples the curve where a fixation lies and
   * so over-estimates the area on a coarse grid. Both of those are asserted below, bounds
   * and all.
   */
  const reference = map(
    4,
    3,
    [0.01, 0.04, 0.11, 0.21, 0.02, 0.07, 0.16, 0.13, 0.03, 0.06, 0.09, 0.07],
    'none',
  );
  const humans = map(
    4,
    3,
    [0.012, 0.03, 0.1, 0.25, 0.018, 0.08, 0.14, 0.11, 0.025, 0.05, 0.11, 0.075],
    'none',
  );
  /** Three fixations, on cells (3, 0), (2, 1) and (1, 2): distinct values, no tie. */
  const fixations = [fixCell(0, 3, 0), fixCell(1, 2, 1), fixCell(2, 1, 2)];
  const fixatedCells = [3, 6, 9];

  const mean = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;

  /** `CC.m`: `corr2` of the two maps, each first centred and scaled. */
  it('reproduces CC.m', () => {
    const a = reference.values;
    const b = humans.values;
    const [ma, mb] = [mean(a), mean(b)];
    const numerator = a.reduce((total, value, i) => total + (value - ma) * (b[i] - mb), 0);
    const denominator = Math.sqrt(
      a.reduce((total, value) => total + (value - ma) ** 2, 0) *
        b.reduce((total, value) => total + (value - mb) ** 2, 0),
    );

    expect(cc(reference, humans)).toBeCloseTo(numerator / denominator, 12);
  });

  /** `NSS.m`: `map = (map - mean(map))/std(map); score = mean(map(fixationMap>0))`. */
  it('reproduces NSS.m', () => {
    const values = reference.values;
    const m = mean(values);
    const sd = Math.sqrt(
      values.reduce((total, value) => total + (value - m) ** 2, 0) / (values.length - 1),
    );
    const standardised = values.map((value) => (value - m) / sd);

    expect(nssAt(reference, fixations)).toBeCloseTo(
      mean(fixatedCells.map((c) => standardised[c])),
      12,
    );
  });

  /** `KLdiv.m`: both maps normalised to sum to one, then `sum(P .* log(eps + P ./ (Q + eps)))`. */
  it('reproduces KLdiv.m', () => {
    const eps = SALIENCY_METRIC_PARAMETERS.kldEpsilon;
    const qMass = reference.values.reduce((total, value) => total + value, 0);
    const pMass = humans.values.reduce((total, value) => total + value, 0);
    const published = humans.values.reduce((total, value, i) => {
      const p = value / pMass;
      const q = reference.values[i] / qMass;
      return total + p * Math.log(eps + p / (q + eps));
    }, 0);

    expect(kld(reference, humans)).toBeCloseTo(published, 12);
  });

  /** The trapezoidal area under a curve given as points, as MATLAB's `trapz` computes it. */
  const trapz = (x: readonly number[], y: readonly number[]): number => {
    let area = 0;
    for (let i = 1; i < x.length; i += 1) area += ((x[i] - x[i - 1]) * (y[i] + y[i - 1])) / 2;
    return area;
  };

  /**
   * The area under the ROC curve as it is defined: sweep a threshold down **every** distinct
   * value of the prediction, plot the share of positives against the share of negatives
   * reached, and take the trapezoidal area, with (0, 0) and (1, 1) at the ends. A tie block
   * is then crossed diagonally, which is where half credit comes from.
   *
   * This is the quantity `AUC_Judd.m` sets out to compute and the quantity the
   * implementation computes exactly, so the two agree to the last place — including on a
   * flat map, where this returns 0.5. Its equivalence with the Mann–Whitney U statistic the
   * implementation uses is Hanley and McNeil, *The meaning and use of the area under a
   * receiver operating characteristic (ROC) curve*, Radiology 143(1):29–36, 1982.
   */
  const rocArea = (values: readonly number[], fixated: readonly number[]): number => {
    const positive = new Set(fixated);
    const positives = fixated.length;
    const negatives = values.length - positives;
    const thresholds = [...new Set(values)].sort((a, b) => b - a);

    const truePositive = [0];
    const falsePositive = [0];
    for (const threshold of thresholds) {
      let reachedPositives = 0;
      let reachedNegatives = 0;
      values.forEach((value, cell) => {
        if (value < threshold) return;
        if (positive.has(cell)) reachedPositives += 1;
        else reachedNegatives += 1;
      });
      truePositive.push(reachedPositives / positives);
      falsePositive.push(reachedNegatives / negatives);
    }
    truePositive.push(1);
    falsePositive.push(1);

    return trapz(falsePositive, truePositive);
  };

  /**
   * `AUC_Judd.m` itself: the thresholds are the prediction's values **at the fixated cells**
   * only, descending, and the curve is interpolated straight across whatever lies between
   * two of them.
   */
  const aucJuddPublishedSweep = (values: readonly number[], fixated: readonly number[]): number => {
    const positives = fixated.length;
    const cells = values.length;
    const thresholds = fixated.map((cell) => values[cell]).sort((a, b) => b - a);

    const truePositive = [0];
    const falsePositive = [0];
    thresholds.forEach((threshold, i) => {
      const above = values.filter((value) => value >= threshold).length;
      truePositive.push((i + 1) / positives);
      falsePositive.push((above - (i + 1)) / (cells - positives));
    });
    truePositive.push(1);
    falsePositive.push(1);

    return trapz(falsePositive, truePositive);
  };

  it('computes exactly the area under the ROC curve', () => {
    expect(aucJuddAt(reference, fixations)).toBeCloseTo(
      rocArea(reference.values, fixatedCells),
      12,
    );
    // 22 of the 3 × 9 = 27 (fixated, unfixated) pairs are ranked the right way: the three
    // fixated cells hold 0.21, 0.16 and 0.06, and of the nine others all nine are below the
    // first two and four are below the third. 22 / 27 = 0.8148148…
    expect(aucJuddAt(reference, fixations)).toBeCloseTo(22 / 27, 12);
  });

  it('agrees with the exact area on a tie-free input, on a tied one, and on a flat one', () => {
    const cases: readonly {
      readonly name: string;
      readonly map: SaliencyMap;
      readonly cells: readonly number[];
    }[] = [
      { name: 'tie-free', map: reference, cells: fixatedCells },
      { name: 'tied', map: map(2, 2, [0.5, 0.5, 0.2, 0.9]), cells: [0, 3] },
      { name: 'flat', map: flatLike(reference, 0.4), cells: fixatedCells },
    ];

    for (const { name, map: prediction, cells } of cases) {
      const fixationsHere = cells.map((cell) =>
        fixCell(cell, cell % prediction.width, Math.floor(cell / prediction.width)),
      );
      expect(aucJuddAt(prediction, fixationsHere), name).toBeCloseTo(
        rocArea(prediction.values, cells),
        12,
      );
    }
  });

  it('sits below AUC_Judd.m’s own sweep by no more than the bound that sweep’s coarseness allows', () => {
    // That sweep plants a vertex only where a fixation lies and interpolates straight across
    // the negatives in between, so it reads the area of a trapezoid where the curve is a
    // step: it over-estimates by sum over the gaps of Δfp·Δtp/2, which with k positives is
    // at most 1/(2k). On this 12-cell map with three fixations the bound is 1/6, and the
    // sweep is 0.0926 high. The excess is the published code's coarseness, not a
    // disagreement about the quantity — which is why `src/metrics/saliency.ts` computes the
    // area exactly instead.
    const coarse = aucJuddPublishedSweep(reference.values, fixatedCells);
    const exact = aucJuddAt(reference, fixations);

    expect(coarse).toBeGreaterThan(exact);
    expect(coarse - exact).toBeLessThanOrEqual(1 / (2 * fixatedCells.length) + 1e-12);
    expect(coarse - exact).toBeCloseTo(0.0925925925925926, 12);
  });

  it('converges on AUC_Judd.m’s sweep as the fixations grow dense, which is how that code is used', () => {
    // A 40 × 30 grid with a smooth centred peak and sixty fixations along a diagonal: the
    // bound above falls to 1/120, and the two figures agree to within it.
    const width = 40;
    const height = 30;
    const values = Array.from({ length: width * height }, (_, cell) => {
      const x = (cell % width) - (width - 1) / 2;
      const y = Math.floor(cell / width) - (height - 1) / 2;
      return Math.exp(-(x * x + y * y) / 200) + cell * 1e-9;
    });
    const dense = map(width, height, values);
    // Sixty distinct cells: the row steps by 7 of 30 and the column by 13 of 40, so the
    // pair does not repeat inside sixty steps.
    const cells = Array.from(
      { length: 60 },
      (_, i) => ((i * 7 + 3) % height) * width + ((i * 13 + 5) % width),
    );
    const fixationsHere = cells.map((cell) =>
      fixCell(cell, cell % width, Math.floor(cell / width)),
    );

    const coarse = aucJuddPublishedSweep(values, cells);
    const exact = aucJuddAt(dense, fixationsHere);

    expect(new Set(cells).size).toBe(60);
    expect(Math.abs(coarse - exact)).toBeLessThanOrEqual(1 / (2 * cells.length) + 1e-12);
    expect(exact).toBeCloseTo(rocArea(values, cells), 12);
  });

  it('agrees with the published chance level and bounds', () => {
    // Bylinskii et al. (2019) state the levels this asserts: AUC is 0.5 at chance and 1 at
    // best; CC is 1 at identity and 0 for an uninformative prediction; KLD is 0 at identity
    // and unbounded above; NSS is 0 at chance and has no upper bound.
    expect(aucJuddAt(flatLike(reference, 0.4), fixations)).toBe(0.5);
    expect(
      aucJuddAt(humans, poolFixations([{ participantId: 'P-01', fixations }])),
    ).toBeLessThanOrEqual(1);
    expect(cc(humans, humans)).toBe(1);
    expect(cc(flatLike(humans, 0.4), humans)).toBe(0);
    expect(kld(humans, humans)).toBe(0);
    expect(nssAt(flatLike(reference, 0.4), fixations)).toBe(0);
  });

  it('departs from AUC_Judd.m only where that code needs random jitter, and says which way', () => {
    // On a flat prediction the published sweep puts a false-positive rate above 1 at the
    // first threshold and its trapezoidal area collapses to 0, which is why that code
    // jitters the map before sweeping. Half credit returns 0.5 with no randomness at all.
    const flat = flatLike(reference, 0.4);
    const values = flat.values;
    const positives = fixatedCells.length;
    const thresholds = fixatedCells.map((cell) => values[cell]);
    const firstFalsePositiveRate = (values.length - 1) / (values.length - positives);

    expect(new Set(thresholds).size).toBe(1);
    expect(firstFalsePositiveRate).toBeGreaterThan(1);
    expect(aucJuddAt(flat, fixations)).toBe(0.5);
  });
});

describe('the resolution and aspect rule', () => {
  const humans = map(2, 2, [0.1, 0.2, 0.3, 0.4], 'sum-to-one');

  /** The same distribution on a 4 × 4 grid: each human cell split evenly into four. */
  const finer: SaliencyMap = {
    width: 4,
    height: 4,
    values: [
      0.025, 0.025, 0.05, 0.05, 0.025, 0.025, 0.05, 0.05, 0.075, 0.075, 0.1, 0.1, 0.075, 0.075, 0.1,
      0.1,
    ],
    imageSize: humans.imageSize,
    normalisation: 'sum-to-one',
  };

  it('resamples the prediction onto the ground truth’s grid, recovering an exactly equivalent map', () => {
    expect(cc(finer, humans)).toBe(1);
    expect(kld(finer, humans)).toBe(0);
    expect(resampleSaliencyMap(finer, 2, 2).values).toEqual(humans.values);
  });

  it('never moves the ground truth: a coarser prediction is brought up to the humans’ grid', () => {
    expect(cc(humans, finer)).toBeCloseTo(1, 12);
    expect(kld(humans, finer)).toBeCloseTo(0, 12);
  });

  it('preserves a declared normalisation across a resample', () => {
    const resampled = resampleSaliencyMap(finer, 2, 2);
    const total = resampled.values.reduce((sum, value) => sum + value, 0);

    expect(resampled.normalisation).toBe('sum-to-one');
    expect(total).toBeCloseTo(1, 12);
    expect(resampleSaliencyMap(flatLike(finer, 0.0625), 2, 2).values).toEqual([
      0.0625, 0.0625, 0.0625, 0.0625,
    ]);
  });

  it('rejects two grids of a different shape, naming both', () => {
    const portrait: SaliencyMap = {
      width: 2,
      height: 8,
      values: Array.from({ length: 16 }, () => 1 / 16),
      imageSize: humans.imageSize,
      normalisation: 'sum-to-one',
    };

    expect(() => cc(portrait, humans)).toThrow(SaliencyMetricError);
    expect(() => cc(portrait, humans)).toThrow(
      /2 × 8 grid and the ground truth's 2 × 2 grid are different shapes/,
    );
    expect(() => kld(portrait, humans)).toThrow(SaliencyMetricError);
  });

  it('accepts a grid whose aspect ratio differs by less than the stated tolerance', () => {
    // A 4:3 image carries a 16 × 12 grid exactly and a 37 × 28 one to within 0.89%, which is
    // inside `gridAspectTolerance` of 1%. A 21 × 16 grid is 1.56% off and is refused.
    const image = { width: 320, height: 240 };
    const truth: SaliencyMap = {
      width: 16,
      height: 12,
      values: Array.from({ length: 192 }, (_, i) => i + 1),
      imageSize: image,
      normalisation: 'none',
    };
    const prediction: SaliencyMap = {
      width: 37,
      height: 28,
      values: Array.from({ length: 37 * 28 }, (_, i) => i + 1),
      imageSize: image,
      normalisation: 'none',
    };

    expect(SALIENCY_METRIC_PARAMETERS.gridAspectTolerance).toBe(0.01);
    expect(Math.abs(37 / 28 - 16 / 12) / (16 / 12)).toBeLessThan(0.01);
    expect(cc(prediction, truth)).toBeGreaterThan(0.99);
    expect(() =>
      cc(
        {
          ...prediction,
          width: 21,
          height: 16,
          values: Array.from({ length: 336 }, (_, i) => i + 1),
        },
        truth,
      ),
    ).toThrow(/different shapes/);
  });

  it('rejects two maps that describe images of different sizes', () => {
    const otherImage: SaliencyMap = { ...humans, imageSize: { width: 640, height: 480 } };

    expect(() => cc(otherImage, humans)).toThrow(SaliencyMetricError);
    expect(() => cc(otherImage, humans)).toThrow(/not about the same picture/);
    expect(() => kld(otherImage, humans)).toThrow(/not about the same picture/);
  });
});

describe('the ground truth’s grid is the reference', () => {
  /**
   * The published `NSS.m` and `AUC_Judd.m` open with
   * `imresize(saliencyMap, size(fixationMap))`, so the fixations are binned at the ground
   * truth's resolution and the prediction is brought onto that grid. These cases are the
   * ones where the two grids differ, which is where that choice is visible.
   */
  const image = { width: 320, height: 240 };

  /** One smooth peak at 70% across and 30% down, in normalised image coordinates. */
  const field = (x: number, y: number): number =>
    Math.exp(-(((x - 0.7) ** 2 + (y - 0.3) ** 2) / 0.03));

  /** That same field sampled at a cell-centre on a `width` × `height` grid. */
  const sampled = (width: number, height: number): SaliencyMap => ({
    width,
    height,
    values: Array.from({ length: width * height }, (_, cell) =>
      field(((cell % width) + 0.5) / width, (Math.floor(cell / width) + 0.5) / height),
    ),
    imageSize: image,
    normalisation: 'none',
  });

  const truthMap = sampled(40, 30);

  /** A fixation on the centre of a cell of a `width` × `height` grid, in image pixels. */
  const atCell = (index: number, cell: number, width: number, height: number): Fixation =>
    fix(
      index,
      (((cell % width) + 0.5) * image.width) / width,
      ((Math.floor(cell / width) + 0.5) * image.height) / height,
    );

  /** One fixation in each cell of a 4 × 3 grid: spread over the whole image. */
  const spread = Array.from({ length: 12 }, (_, i) => atCell(i, i, 4, 3));
  /** Six fixations on the ground truth's six heaviest cells: the field's own peak. */
  const onPeak = truthMap.values
    .map((value, cell) => ({ value, cell }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)
    .map(({ cell }, i) => atCell(i, cell, 40, 30));

  const truthSpread: SaliencyGroundTruth = {
    saliencyMap: truthMap,
    scanpaths: [{ participantId: 'P-01', fixations: spread }],
  };
  const truthOnPeak: SaliencyGroundTruth = {
    saliencyMap: truthMap,
    scanpaths: [{ participantId: 'P-01', fixations: onPeak }],
  };

  it('scores a prediction coarser than the ground truth, where binning on the prediction would refuse the record', () => {
    const coarse = sampled(4, 3);
    const scores = scoreSaliency(coarse, truthSpread);

    expect(Number.isFinite(scores.cc)).toBe(true);
    expect(Number.isFinite(scores.nss)).toBe(true);
    expect(Number.isFinite(scores.kld)).toBe(true);
    expect(Number.isFinite(scores.aucJudd)).toBe(true);

    // Binned on the prediction's own 4 × 3 grid instead, these twelve fixations fill all
    // twelve cells and there is no negative left to rank against — so the record would be
    // refused outright, and with `scoreSaliency` evaluating all four, CC and KLD would be
    // lost with it.
    expect(() => aucJuddAt(coarse, spread)).toThrow(/all 12 cells of the map hold one/);
  });

  it('gives the same figure for one field expressed at two resolutions', () => {
    const atTruthGrid = scoreSaliency(sampled(40, 30), truthOnPeak);
    const finer = scoreSaliency(sampled(80, 60), truthOnPeak);
    const coarser = scoreSaliency(sampled(20, 15), truthOnPeak);

    // The same picture at three resolutions is the same prediction, so the figures agree to
    // within the sampling difference rather than being three different numbers. NSS is
    // unbounded, so its agreement is stated relatively; AUC-Judd lives in [0, 1], so its
    // agreement is stated absolutely.
    const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

    expect(relative(finer.nss, atTruthGrid.nss)).toBeLessThan(0.01);
    expect(relative(coarser.nss, atTruthGrid.nss)).toBeLessThan(0.05);
    expect(Math.abs(finer.aucJudd - atTruthGrid.aucJudd)).toBeLessThan(0.01);
    expect(Math.abs(coarser.aucJudd - atTruthGrid.aucJudd)).toBeLessThan(0.05);
    // And it is a real figure, not chance: the fixations are on the field's own peak.
    expect(atTruthGrid.nss).toBeGreaterThan(2);
    expect(atTruthGrid.aucJudd).toBeGreaterThan(0.95);
  });

  it('refuses a prediction whose image or grid shape disagrees, from all four metrics', () => {
    const wrongImage: SaliencyMap = { ...sampled(40, 30), imageSize: { width: 640, height: 480 } };
    const wrongShape: SaliencyMap = { ...sampled(30, 40), imageSize: image };

    for (const bad of [wrongImage, wrongShape]) {
      expect(() => scoreSaliency(bad, truthOnPeak)).toThrow(SaliencyMetricError);
      expect(() => nss(bad, truthOnPeak)).toThrow(SaliencyMetricError);
      expect(() => aucJudd(bad, truthOnPeak)).toThrow(SaliencyMetricError);
    }
  });
});

describe('degenerate inputs: a documented value or a named error, and never a NaN', () => {
  it('scores an all-zero prediction 0, 0 and 0.5, and refuses it for KLD by name', () => {
    const zero = flatLike(peaked, 0);

    expect(cc(zero, peaked)).toBe(0);
    expect(nssAt(zero, peakedFixations)).toBe(0);
    expect(aucJuddAt(zero, peakedFixations)).toBe(0.5);
    expect(() => kld(zero, peaked)).toThrow(SaliencyMetricError);
    expect(() => kld(zero, peaked)).toThrow(/the prediction holds no mass at all/);
  });

  it('refuses KLD against a human map that holds no mass, by a different name', () => {
    expect(() => kld(peaked, flatLike(peaked, 0))).toThrow(/the ground truth holds no mass at all/);
    expect(cc(peaked, flatLike(peaked, 0))).toBe(0);
  });

  it('refuses an empty map from every metric', () => {
    const empty: SaliencyMap = {
      width: 0,
      height: 0,
      values: [],
      imageSize: { width: 40, height: 40 },
      normalisation: 'none',
    };

    expect(() => cc(empty, peaked)).toThrow(/the prediction map is empty/);
    expect(() => cc(peaked, empty)).toThrow(/the ground truth map is empty/);
    expect(() => nssAt(empty, peakedFixations)).toThrow(/the prediction map is empty/);
    expect(() => kld(empty, peaked)).toThrow(/the prediction map is empty/);
    expect(() => aucJuddAt(empty, peakedFixations)).toThrow(/the prediction map is empty/);
  });

  it('refuses a malformed map at the offending field', () => {
    expect(() => cc({ ...peaked, values: [1, 2, 3] }, peaked)).toThrow(
      /holds 3 values for a 4 × 3 grid of 12 cells/,
    );
    expect(() =>
      cc(
        {
          ...peaked,
          values: [...peaked.values.slice(0, 5), Number.NaN, ...peaked.values.slice(6)],
        },
        peaked,
      ),
    ).toThrow(/cell 5 is NaN, not a finite number/);
    expect(() =>
      cc(
        { ...peaked, values: [...peaked.values.slice(0, 2), -0.5, ...peaked.values.slice(3)] },
        peaked,
      ),
    ).toThrow(/cell 2 is -0.5, and a saliency value may not be negative/);
    expect(() => cc({ ...peaked, width: 2.5 }, peaked)).toThrow(/not whole cells/);
    expect(() => cc({ ...peaked, imageSize: { width: 0, height: 60 } }, peaked)).toThrow(
      /which is not an image/,
    );
  });

  it('treats a single human fixation as ordinary, not degenerate', () => {
    const single = [fixCell(0, 3, 0)];

    expect(nssAt(peaked, single)).toBeGreaterThan(0);
    expect(aucJuddAt(peaked, single)).toBe(1);
    expect(Number.isFinite(nssAt(peaked, single))).toBe(true);
  });

  it('refuses ground truth with no fixation at all, by name, for the two metrics that read them', () => {
    expect(() => nssAt(peaked, [])).toThrow(SaliencyMetricError);
    expect(() => nssAt(peaked, [])).toThrow(/at least one human fixation/);
    expect(() => aucJuddAt(peaked, [])).toThrow(/at least one human fixation as a positive/);
    expect(() => scoreSaliency(peaked, { saliencyMap: peaked, scanpaths: [] })).toThrow(
      SaliencyMetricError,
    );
    // The two map-to-map metrics do not read fixations, so they are unaffected.
    expect(cc(peaked, peaked)).toBe(1);
    expect(kld(peaked, peaked)).toBe(0);
  });

  it('refuses AUC-Judd when every cell of the map holds a fixation, for want of a negative', () => {
    const everyCell = peaked.values.map((_, cell) =>
      fixCell(cell, cell % peaked.width, Math.floor(cell / peaked.width)),
    );

    expect(() => aucJuddAt(peaked, everyCell)).toThrow(/all 12 cells of the map hold one/);
    // NSS still has a mean to take, so it is unaffected and lands at about 0.
    expect(nssAt(peaked, everyCell)).toBeCloseTo(0, 12);
  });

  it('refuses a fixation outside the image, naming its index and coordinates', () => {
    expect(() => nssAt(peaked, [fix(0, 81, 10)])).toThrow(
      /fixation 0 is at \(81, 10\), outside the 80 × 60 image/,
    );
    expect(() => aucJuddAt(peaked, [fix(4, 10, -1)])).toThrow(/fixation 4 is at \(10, -1\)/);
    expect(() => nssAt(peaked, [fix(0, Number.NaN, 10)])).toThrow(/fixation 0 is at \(NaN, 10\)/);
  });

  it('puts a fixation exactly on the right or bottom edge in the last cell rather than failing', () => {
    const corner = nssAt(peaked, [fix(0, 80, 60)]);

    expect(corner).toBe(nssAt(peaked, [fixCell(0, 3, 2)]));
    expect(Number.isFinite(corner)).toBe(true);
  });

  it('stays invariant to a rescaling large enough to overflow a squared sum', () => {
    // Squaring a cell of 1e200 overflows to Infinity, which used to make CC return `NaN` on
    // one map and a plausible `0` on a mismatched pair — a flat answer about a sharply
    // peaked map. Scaling each map by its own peak first removes the whole class, so these
    // are the same figures as at ordinary magnitudes.
    const huge = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => value * 1e200),
    );
    const alsoHuge = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => value * 3e180),
    );

    expect((1e200 * 0.3) ** 2).toBe(Number.POSITIVE_INFINITY);
    expect(cc(huge, huge)).toBe(1);
    expect(cc(huge, peaked)).toBe(1);
    expect(cc(alsoHuge, huge)).toBe(1);
    expect(nssAt(huge, peakedFixations)).toBeCloseTo(nssAt(peaked, peakedFixations), 12);
    expect(aucJuddAt(huge, peakedFixations)).toBe(aucJuddAt(peaked, peakedFixations));
    expect(kld(huge, peaked)).toBe(0);
    // And near the top of the range, where summing the cells overflows rather than squaring
    // them: KLD reads both maps as distributions, so an infinite mass would make every cell
    // zero and report a perfect 0 for a prediction that is nothing of the sort.
    const enormous = map(2, 2, [1e308, 1e307, 1e308, 1e307]);
    const ordinary = map(2, 2, [1, 0.1, 1, 0.1]);
    const humansHere = map(2, 2, [0.4, 0.1, 0.3, 0.2], 'sum-to-one');

    expect(enormous.values.reduce((sum, value) => sum + value, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(kld(enormous, humansHere)).toBeGreaterThan(0);
    expect(kld(enormous, humansHere)).toBeCloseTo(kld(ordinary, humansHere), 12);
    expect(cc(enormous, humansHere)).toBeCloseTo(cc(ordinary, humansHere), 12);
  });

  it('lets no NaN and no Infinity out of any metric, over every degenerate input above', () => {
    const maps: readonly SaliencyMap[] = [
      peaked,
      flatLike(peaked, 0),
      flatLike(peaked, 1),
      flatLike(peaked, Number.MAX_VALUE / 16),
      // Not constant, so `isConstant` does not short-circuit: squaring these overflows
      // unless the metric scales by the peak first, which is what makes the sweep below a
      // real check rather than a vacuous one.
      map(
        peaked.width,
        peaked.height,
        peaked.values.map((v) => v * 1e200),
      ),
      map(
        peaked.width,
        peaked.height,
        peaked.values.map((v) => v * 1e306),
      ),
      map(1, 1, [0.5]),
      map(1, 1, [0]),
      map(
        peaked.width,
        peaked.height,
        peaked.values.map((v) => v * 1e-300),
      ),
    ];
    const fixationSets: readonly (readonly Fixation[])[] = [
      peakedFixations,
      [fixCell(0, 0, 0)],
      [],
      [fix(0, 0, 0)],
    ];

    const finiteOrNamed = (compute: () => number): void => {
      try {
        const value = compute();
        expect(Number.isFinite(value)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(SaliencyMetricError);
        expect((error as SaliencyMetricError).message).not.toBe('');
      }
    };

    for (const prediction of maps) {
      for (const truth of maps) {
        finiteOrNamed(() => cc(prediction, truth));
        finiteOrNamed(() => kld(prediction, truth));
      }
      for (const fixations of fixationSets) {
        finiteOrNamed(() => nssAt(prediction, fixations));
        finiteOrNamed(() => aucJuddAt(prediction, fixations));
      }
    }
  });
});

describe('each metric reports its direction as data', () => {
  it('covers every metric exactly once, with a complete descriptor', () => {
    expect([...SALIENCY_METRIC_IDS].sort()).toEqual(Object.keys(SALIENCY_METRICS).sort());
    for (const id of SALIENCY_METRIC_IDS) {
      const descriptor = saliencyMetric(id);
      expect(descriptor.id).toBe(id);
      expect(
        descriptor.direction === 'higher-is-better' || descriptor.direction === 'lower-is-better',
      ).toBe(true);
      expect(descriptor.label.length).toBeGreaterThan(1);
      expect(descriptor.name.length).toBeGreaterThan(descriptor.label.length);
      expect(descriptor.summary).toMatch(/\S/);
      expect(descriptor.degenerate).toMatch(/\S/);
    }
  });

  it('names KLD as the one metric that reads the other way', () => {
    const lower = SALIENCY_METRIC_IDS.filter(
      (id) => SALIENCY_METRICS[id].direction === 'lower-is-better',
    );

    expect(lower).toEqual(['kld']);
  });

  it('moves in the direction each descriptor claims when the prediction improves', () => {
    const good = peaked;
    const poor = map(
      peaked.width,
      peaked.height,
      peaked.values.map((value) => 0.3 - value),
    );
    const fixations = peakedFixations;
    const compute: { readonly [K in SaliencyMetricId]: (prediction: SaliencyMap) => number } = {
      cc: (prediction) => cc(prediction, peaked),
      nss: (prediction) => nssAt(prediction, fixations),
      kld: (prediction) => kld(prediction, peaked),
      aucJudd: (prediction) => aucJuddAt(prediction, fixations),
    };

    for (const id of SALIENCY_METRIC_IDS) {
      const better = compute[id](good);
      const worse = compute[id](poor);
      const expectation = SALIENCY_METRICS[id].direction === 'higher-is-better' ? better : worse;
      const other = SALIENCY_METRICS[id].direction === 'higher-is-better' ? worse : better;

      expect(expectation, `${id} reads ${SALIENCY_METRICS[id].direction}`).toBeGreaterThan(other);
    }
  });

  it('reaches the best and chance values its descriptors publish', () => {
    expect(cc(peaked, peaked)).toBe(SALIENCY_METRICS.cc.best);
    expect(kld(peaked, peaked)).toBe(SALIENCY_METRICS.kld.best);
    expect(aucJuddAt(peaked, peakedFixations)).toBe(SALIENCY_METRICS.aucJudd.best);
    expect(cc(flatLike(peaked, 1), peaked)).toBe(SALIENCY_METRICS.cc.chance);
    expect(nssAt(flatLike(peaked, 1), peakedFixations)).toBe(SALIENCY_METRICS.nss.chance);
    expect(aucJuddAt(flatLike(peaked, 1), peakedFixations)).toBe(SALIENCY_METRICS.aucJudd.chance);
    // NSS is unbounded above and KLD's value against a flat prediction is not one number.
    expect(SALIENCY_METRICS.nss.best).toBeNull();
    expect(SALIENCY_METRICS.kld.chance).toBeNull();
  });

  it('publishes its parameters as frozen committed data, not as inline constants', () => {
    expect(Object.isFrozen(SALIENCY_METRIC_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(SALIENCY_METRICS)).toBe(true);
    expect(Object.isFrozen(SALIENCY_METRICS.cc)).toBe(true);
    expect(SALIENCY_METRIC_PARAMETERS.kldEpsilon).toBe(Number.EPSILON);
    expect(SALIENCY_METRIC_PARAMETERS.aucNegatives).toBe('every-cell-without-a-human-fixation');
    expect(() => {
      (SALIENCY_METRICS.kld as { direction: string }).direction = 'higher-is-better';
    }).toThrow(TypeError);
  });
});

describe('pure and deterministic', () => {
  const truth: Pick<GroundTruthRecord, 'saliencyMap' | 'scanpaths'> = {
    saliencyMap: peaked,
    // The three heaviest cells of `peaked`: (3, 0) at 0.30, (3, 1) at 0.15 and (2, 0) at
    // 0.09, so an identical prediction ranks every fixated cell first and AUC-Judd is 1.
    scanpaths: [
      { participantId: 'P-01', fixations: [fixCell(0, 3, 0), fixCell(1, 3, 1)] },
      { participantId: 'P-02', fixations: [fixCell(0, 2, 0)] },
    ],
  };

  it('gives the identical number twice, to the last bit', () => {
    const first = scoreSaliency(peaked, truth);
    const second = scoreSaliency(peaked, truth);

    expect(second.cc).toBe(first.cc);
    expect(second.nss).toBe(first.nss);
    expect(second.kld).toBe(first.kld);
    expect(second.aucJudd).toBe(first.aucJudd);
  });

  it('does not touch its inputs', () => {
    const prediction = map(4, 3, [...peaked.values].reverse(), 'none');
    const before = JSON.stringify({ prediction, truth });

    scoreSaliency(prediction, truth);
    cc(prediction, peaked);
    resampleSaliencyMap(prediction, 8, 6);

    expect(JSON.stringify({ prediction, truth })).toBe(before);
  });

  it('pools the humans of a record in the order the dataset lists them', () => {
    expect(poolFixations(truth.scanpaths).map((fixation) => fixation.x)).toEqual([70, 70, 50]);
    expect(poolFixations([])).toEqual([]);
  });

  it('scores all four metrics of a record in one call', () => {
    const scores = scoreSaliency(peaked, truth);

    expect(Object.keys(scores).sort()).toEqual([...SALIENCY_METRIC_IDS].sort());
    expect(scores.cc).toBe(1);
    expect(scores.kld).toBe(0);
    expect(scores.aucJudd).toBe(1);
    expect(scores.nss).toBeGreaterThan(0);
  });
});

describe('against the committed corpus', () => {
  it('scores every record’s own map against itself at the identity values', () => {
    for (const record of loadCorpus()) {
      const scores = scoreSaliency(record.saliencyMap, record);

      expect(scores.cc, record.id).toBeCloseTo(1, 12);
      expect(scores.kld, record.id).toBe(0);
      expect(Number.isFinite(scores.nss), record.id).toBe(true);
      expect(Number.isFinite(scores.aucJudd), record.id).toBe(true);
    }
  });

  it('finds the humans’ fixations in the three peaked records and, honestly, not in the flat one', () => {
    // CC and KLD compare two maps, so identity is identity on every record. NSS and
    // AUC-Judd read the human *fixations*, and a record with nothing to find has nothing to
    // find even for a perfect prediction: `poster-uniform-field` is deliberately the
    // flattest of the four — `test/corpus.test.ts` measures its heaviest cell at 1.27 times
    // the mean — so its own map scores about chance at its own fixations (NSS -0.011,
    // AUC-Judd 0.489). That is the record doing its job, and it is why #88 must report the
    // number of records behind a figure rather than one average.
    const peakedRecords = [
      'webpage-bright-hero',
      'desktop-two-panels',
      'mobile-single-fixation',
    ] as const;

    for (const name of peakedRecords) {
      const record = loadCorpusRecord(name);
      const scores = scoreSaliency(record.saliencyMap, record);

      expect(scores.nss, name).toBeGreaterThan(2.9);
      expect(scores.aucJudd, name).toBeGreaterThan(0.97);
    }

    const flat = loadCorpusRecord('poster-uniform-field');
    const flatScores = scoreSaliency(flat.saliencyMap, flat);

    expect(Math.abs(flatScores.nss)).toBeLessThan(0.05);
    expect(
      Math.abs(flatScores.aucJudd - required(SALIENCY_METRICS.aucJudd.chance, 'AUC-Judd chance')),
    ).toBeLessThan(0.05);
  });

  it('cannot see the order a scanpath was walked in, which is what #84 is for', () => {
    // `desktop-two-panels` exists so that an order-sensitive metric can see something a
    // location-only one cannot. Reversing every participant's scanpath leaves all four
    // saliency figures untouched, which is the documented blindness rather than a defect.
    const record = loadCorpusRecord('desktop-two-panels');
    const reversed: typeof record = {
      ...record,
      scanpaths: record.scanpaths.map((scanpath) => ({
        ...scanpath,
        fixations: [...scanpath.fixations].reverse(),
      })),
    };

    expect(scoreSaliency(record.saliencyMap, reversed)).toEqual(
      scoreSaliency(record.saliencyMap, record),
    );
  });

  it('punishes an over-confident prediction on the flattest record', () => {
    // `poster-uniform-field` is the flattest of the four by both of the measures
    // `test/corpus.test.ts` asserts, so a prediction that puts everything in one cell has
    // to score worse there than an honest flat one — on KLD, where lower is better.
    const record = loadCorpusRecord('poster-uniform-field');
    const cells = record.saliencyMap.values.length;
    const confident: SaliencyMap = {
      ...record.saliencyMap,
      values: Array.from({ length: cells }, (_, index) => (index === 0 ? 1 : 0)),
    };
    const flat: SaliencyMap = {
      ...record.saliencyMap,
      values: Array.from({ length: cells }, () => 1 / cells),
    };

    expect(kld(confident, record.saliencyMap)).toBeGreaterThan(kld(flat, record.saliencyMap));
    expect(cc(confident, record.saliencyMap)).toBeLessThan(
      cc(record.saliencyMap, record.saliencyMap),
    );
  });
});
