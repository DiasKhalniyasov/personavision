/**
 * The centre-bias prior: a documented, parameterised distribution over the image, and a
 * scanpath drawn from it.
 *
 * **Why this one is the baseline that matters.** Human gaze on a user interface is strongly
 * centre- and top-biased whatever the interface shows, so a predictor that knows only "look
 * near the middle, a little above it" already scores well on every saliency metric. That is
 * exactly why it is hard to beat and worth reporting: the margin over this prior is the
 * number a sceptical reader will ask for, and a predictor that cannot beat it has not shown
 * that it read the image at all.
 *
 * **What it is evidence of.** A margin over it is evidence that a predictor found structure
 * in the picture beyond where pictures usually get looked at. It is *not* evidence about the
 * order attention was paid in — the prior's scanpath is drawn independently per fixation and
 * so has no sequence logic at all — and a scanpath figure above it says little more than that
 * the predicted fixations were in better places. It is also not a ceiling: the human-to-human
 * agreement #84 reports is (#88 prints the two beside each other).
 *
 * The prior is the same distribution whatever the seed; only the scanpath drawn from it moves
 * with the seed. A baseline whose map wandered with the seed would be a worse reference point
 * than one that does not, and nothing about a position prior depends on a random draw.
 */

import { createSeededRandom } from '@personavision/contract';
import type { ImageSize, Prediction, Predictor, SaliencyMap } from '../types.js';
import { BASELINE_SCANPATH, scanpathOf } from './random-fixations.js';
import { MAP_RENDERING, mapResolution, renderSaliencyMap } from './render-map.js';

/**
 * The prior's shape: where it peaks, how far it spreads, and where it stops.
 *
 * A structural interface rather than the constant's own literal types, so that a sensitivity
 * check — what would the figure have been at a wider spread? — is a call and not an edit to
 * this file. #90 may not fit these: this is the ruler, and #11 settled that the fit moves the
 * engine and never the ruler.
 */
export interface CentreBiasPrior {
  /** Where the peak sits across the image, as a share of its width. */
  readonly centreXShare: number;
  /** And down the image, as a share of its height. */
  readonly centreYShare: number;
  /** The standard deviation, as a share of the image's shorter side. */
  readonly spreadShare: number;
  /** Where the kernel stops: a number of standard deviations, or the whole map. */
  readonly truncation: number | 'whole-map';
  /** The exponent a point's dwell is raised to. The prior is one point, so 0. */
  readonly dwellWeightExponent: number;
}

/**
 * The prior's shape, as committed data with the reason each number is what it is.
 */
export const CENTRE_BIAS_PRIOR: Readonly<CentreBiasPrior> = Object.freeze({
  /**
   * Horizontally centred. A user interface is laid out about its vertical axis — a centred
   * column, a centred hero, a symmetric pair of panels — so there is no evidence for a left
   * or a right bias that would hold across the four categories UEyes covers.
   */
  centreXShare: 0.5,
  /**
   * The peak sits at 42% of the height: a twelfth of the image above the geometric middle.
   * Gaze on a screen is top-biased — reading order starts at the top, a page's navigation,
   * headline and hero live there, and the lower part of a tall screenshot is often below what
   * a viewer ever reaches. 0.42 is enough of a shift to carry that, and small enough that the
   * prior stays a *centre* prior rather than quietly becoming a top prior whose peak sits in
   * a banner. It is a documented choice from the layout literature, not a value fitted to
   * UEyes: fitting a baseline to the dataset it is a baseline for would make the margin over
   * it meaningless.
   */
  centreYShare: 0.42,
  /**
   * The standard deviation: a quarter of the image's **shorter** side, the spread the
   * centre-prior baselines of the saliency benchmarks are published at. At a quarter, about
   * 39% of the mass lies within one standard deviation of the peak and 99% within three: a
   * prior that concentrates on the middle without going blind to the edges.
   *
   * Isotropic in image pixels, not in normalised coordinates, because the spread of human
   * gaze is a span of visual angle and does not stretch with a screenshot's aspect ratio —
   * and measured against the shorter side so that it stays a *blob* on any aspect ratio. A
   * quarter of the longer side would be two thirds of the width of a tall phone screenshot,
   * which is a horizontal band rather than a centre prior, and a weaker baseline on a
   * quarter of the records UEyes publishes.
   */
  spreadShare: 0.25,
  /**
   * The kernel is **not truncated**: every cell of the map gets summed, however far from the
   * peak it sits. A zero cell under a human fixation is a hole in a distribution rather than
   * a low score — KLD reads it as one — and a baseline should lose a comparison on where it
   * put its mass, never on having none to put. The map rendering reads an infinite truncation
   * radius as the whole map.
   *
   * The arithmetic has a ceiling the summing cannot lift: past about seventeen to one in
   * aspect ratio, `Math.exp` underflows to exactly 0 in the far cells of the long side, and a
   * map with a zero cell is what this setting exists to avoid. Measured: no zero cell at
   * 390 × 4000 or 1440 × 20000, twenty of them at 100 × 1700. No UI screenshot is that
   * elongated; a record that was would need a floor under the kernel rather than a wider one.
   */
  truncation: 'whole-map',
  /** Dwell plays no part in the prior: it is one point, and the map is its kernel. */
  dwellWeightExponent: 0,
});

/**
 * The prior rendered on the map grid: the one map-rendering function, one point at the
 * prior's centre, and the prior's own spread as that point's kernel.
 *
 * So a centre prior is not a second way of drawing a map — it is the same Gaussian machinery
 * at a wider setting, which is why `kernel`, resolution, coordinate convention and
 * normalisation are the ones [`./render-map.ts`](./render-map.ts) documents and the engine
 * mirrors. The peak cell is the one the prior's centre falls in, and the values sum to 1.
 */
export const centreBiasPrior = (
  imageSize: ImageSize,
  prior: CentreBiasPrior = CENTRE_BIAS_PRIOR,
): SaliencyMap => {
  const { width, height } = mapResolution(imageSize, MAP_RENDERING.cellPx);
  /**
   * The map rendering states a kernel's width as a share of the map's **longer** side, which
   * is the engine's convention and is mirrored rather than diverged from. The prior's spread
   * is a share of the shorter side, so what is handed over is that share scaled by the
   * aspect ratio: the two statements describe the same number of cells.
   */
  const kernelSigmaShare = (prior.spreadShare * Math.min(width, height)) / Math.max(width, height);

  return renderSaliencyMap(
    [
      {
        x: prior.centreXShare * imageSize.width,
        y: prior.centreYShare * imageSize.height,
        /** Any positive dwell: the exponent below is 0, so it is not read. */
        durationMs: 1,
      },
    ],
    imageSize,
    {
      cellPx: MAP_RENDERING.cellPx,
      kernelSigmaShare,
      kernelRadiusSigmas:
        prior.truncation === 'whole-map' ? Number.POSITIVE_INFINITY : prior.truncation,
      dwellWeightExponent: prior.dwellWeightExponent,
    },
  );
};

/**
 * One fixation drawn from the prior: a cell by its own probability, then a position uniformly
 * inside that cell.
 *
 * Inverse transform over the cells in row-major order — the map sums to 1, so a single
 * uniform draw walked against the running total picks a cell with exactly the prior's
 * probability. The two further draws spread the fixation inside the cell it picked rather
 * than pinning it to the cell's centre, so a drawn scanpath is not a lattice: a metric that
 * bins fixations would otherwise see the grid instead of the prior.
 *
 * Three draws per fixation, in that order. The last cell catches any rounding shortfall in
 * the running total, which is why a draw of exactly 1 cannot fall off the end.
 */
const sampleFixationPoint = (
  prior: SaliencyMap,
  random: () => number,
): { readonly x: number; readonly y: number } => {
  const target = random();
  let cumulative = 0;
  let cell = prior.values.length - 1;
  for (let index = 0; index < prior.values.length; index += 1) {
    cumulative += prior.values[index] ?? 0;
    if (target < cumulative) {
      cell = index;
      break;
    }
  }
  const column = cell % prior.width;
  const row = Math.floor(cell / prior.width);
  return {
    x: ((column + random()) * prior.imageSize.width) / prior.width,
    y: ((row + random()) * prior.imageSize.height) / prior.height,
  };
};

/**
 * The baseline: the prior as the saliency map, and a scanpath of fixations drawn from it.
 *
 * Every position is drawn before any dwell is, as the random baseline does it, so the two
 * baselines differ in where their fixations land and in nothing else — which is what makes
 * the margin between them a spatial result. The fixation count, the dwell distribution and
 * the saccade gap are `BASELINE_SCANPATH`, shared from
 * [`./random-fixations.ts`](./random-fixations.ts).
 *
 * Every drawn fixation lies strictly inside the image: a cell of the map covers image pixels
 * `[cell · imageWidth / mapWidth, (cell + 1) · imageWidth / mapWidth)`, and the draw inside
 * the cell is on `[0, 1)`.
 */
export const centreBiasBaseline = ((image, seed): Prediction => {
  const random = createSeededRandom(seed);
  const saliencyMap = centreBiasPrior(image.size);
  const points: { readonly x: number; readonly y: number }[] = [];
  for (let drawn = 0; drawn < BASELINE_SCANPATH.fixations; drawn += 1) {
    points.push(sampleFixationPoint(saliencyMap, random));
  }

  return { saliencyMap, scanpath: scanpathOf(points, random), display: image.display };
  // The `satisfies` is the assertion: this is the seam `src/types.ts` declares, and the
  // concrete return type is kept so a caller does not have to await a synchronous answer.
}) satisfies Predictor;

/**
 * Where the prior peaks on a given image, in cells: the cell its centre falls in.
 *
 * Exported because it is what a test and a reader of a figure check the map against, and
 * computing it from the shares twice is how the two drift apart.
 *
 * The nearest cell centre to the prior's centre, which is the floor of the centre in cells.
 * On a map with an even number of columns the prior's centre falls exactly on the boundary
 * between two of them, and the two hold the same value: this names the right-hand one, and
 * the cell it names holds the map's greatest value either way.
 */
export const centreBiasPeakCell = (
  imageSize: ImageSize,
  prior: CentreBiasPrior = CENTRE_BIAS_PRIOR,
): { readonly x: number; readonly y: number } => {
  const { width, height } = mapResolution(imageSize, MAP_RENDERING.cellPx);
  return {
    x: Math.min(width - 1, Math.floor(prior.centreXShare * width)),
    y: Math.min(height - 1, Math.floor(prior.centreYShare * height)),
  };
};
