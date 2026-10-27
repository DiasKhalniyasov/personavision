/**
 * The one place in this package where fixations become a saliency map: fixations in, map
 * out, with every convention a metric is sensitive to stated as committed data.
 *
 * Both baselines (#87) render their maps through this function, and #88 reports the kernel
 * each predictor used beside the figure it produced. The defaults **mirror the engine's own
 * map** (#68) so that a margin between the engine and a baseline is a difference in where
 * each one looked and not a difference in how the two maps were drawn.
 *
 * ## The correspondence with the engine's map (#68)
 *
 * This package may not import `packages/engine` — the dependency runs one way and
 * `test/dependency-direction.test.ts` asserts it — so the two sides are tied together here,
 * in the doc, and in [`../../docs/baselines.md`](../../docs/baselines.md). Every value of
 * `MAP_RENDERING` below is the value `packages/engine`'s `prediction.map` carries on its
 * defaults, as `packages/engine/README.md` documents them:
 *
 * | Convention      | Here and in the engine                                                     |
 * | --------------- | -------------------------------------------------------------------------- |
 * | Resolution      | `round(imageWidth / cellPx)` × `round(imageHeight / cellPx)`, `cellPx` 10   |
 * | Coordinates     | Row-major image space, cell `(x, y)` is `values[y * width + x]`             |
 * | Kernel          | An isotropic 2-D Gaussian, σ a share of the map's longer side, truncated    |
 * | Fixation weight | The dwell raised to `dwellWeightExponent` — 1 is dwell-weighted             |
 * | Normalisation   | `sum-to-one`                                                               |
 *
 * Nothing in the engine's documented map diverges from this, so #87's "report the divergence
 * on #11 and #87" clause has nothing to report. A later change to either side is a change to
 * both: the engine's values are leaves of `EngineConfig.prediction.map`, and the ones here
 * are frozen data a fit may not reach, because #90 fits the engine and never the ruler.
 */

import type { ImageSize, SaliencyMap, SaliencyNormalisation } from '../types.js';

/** Raised when a baseline is handed something it cannot draw a map over. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

/**
 * A point source of attention: where it landed in image space and how long it was held.
 *
 * Narrower than a `Fixation` on purpose — no `index` and no `tMs`, because the map does not
 * read them — and a `Fixation` satisfies it, so a scanpath renders without being reshaped.
 */
export interface MapPoint {
  /** Image pixels from the left edge, `0 … imageSize.width`. */
  readonly x: number;
  /** Image pixels from the top edge, `0 … imageSize.height`. */
  readonly y: number;
  /** The dwell in milliseconds, which `dwellWeightExponent` turns into a weight. */
  readonly durationMs: number;
}

/** The kernel, the resolution and the weighting one call renders with. */
export interface MapRenderingParameters {
  /** Image pixels a map cell covers on each side. */
  readonly cellPx: number;
  /** The Gaussian's standard deviation, as a share of the map's longer side in cells. */
  readonly kernelSigmaShare: number;
  /**
   * How many standard deviations are summed before the kernel is truncated.
   * `Number.POSITIVE_INFINITY` sums the whole map, which is what a position prior asks for.
   */
  readonly kernelRadiusSigmas: number;
  /** The exponent the dwell is raised to: 1 is dwell-weighted, 0 counts fixations. */
  readonly dwellWeightExponent: number;
}

/**
 * Every number and rule this function renders by, as committed data with its reason.
 *
 * This is the surface #88 carries as provenance, so no figure can be quoted without saying
 * what drew the map behind it. Frozen: a baseline is a fixed reference point, and a
 * reference point that moved with a fit would measure nothing.
 */
export const MAP_RENDERING = Object.freeze({
  /**
   * Ten image pixels a cell, as `packages/engine`'s `prediction.map.cellPx` is. #68 chose it
   * over twenty so that an ordinary phone, poster or desktop size stays inside #83's
   * one-per-cent grid-shape tolerance; the baselines are scored by those same metrics
   * against those same records, so they are rendered at the same cell.
   */
  cellPx: 10,
  /**
   * Three per cent of the map's longer side: the blur the saliency-benchmark literature
   * compares maps at, and the engine's `kernelSigmaShare`. A figure here is therefore
   * comparable both with a published one and with the engine's.
   */
  kernelSigmaShare: 0.03,
  /**
   * Past three standard deviations a Gaussian contributes about two parts in a thousand, and
   * the normalisation absorbs what the truncation drops. The engine's `kernelRadiusSigmas`.
   */
  kernelRadiusSigmas: 3,
  /**
   * Dwell-weighted, as the engine's `dwellWeightExponent` is: a long look counts for more
   * than a glance, which is what a human fixation map aggregated over dwell does.
   */
  dwellWeightExponent: 1,
  /** `sum-to-one`, this package's rule: the map is a distribution over the image's cells. */
  normalisation: 'sum-to-one',
  /** Row-major image space: cell `(x, y)` is `values[y * width + x]`, origin top-left. */
  coordinates: 'row-major-image-space',
  /** The resolution is the image downscaled by `cellPx`, rounded per side, at least 1 × 1. */
  resolutionRule: 'image-downscaled-by-cell-px',
  /** The kernel is placed from each cell's centre, which is half a cell from its corner. */
  cellCentre: 0.5,
  /** What these defaults mirror, named because the engine cannot be imported from here. */
  mirrors: 'packages/engine prediction.map defaults, as #68 documents them',
} as const);

/** The normalisation every map this function returns carries. */
const SUM_TO_ONE: SaliencyNormalisation = 'sum-to-one';

/** A finite number rounded to at least one, so a one-pixel image still has a cell. */
const atLeastOneWhole = (value: number): number => Math.max(1, Math.round(value));

/**
 * An image size a map can be drawn over, or a named error.
 *
 * Refused rather than clamped: a zero, a fraction or a `NaN` side is a malformed record or a
 * caller's bug, and a silently invented 1 × 1 map would turn it into a figure.
 */
const assertImageSize = (imageSize: ImageSize): void => {
  for (const [side, value] of [
    ['width', imageSize.width],
    ['height', imageSize.height],
  ] as const) {
    if (!Number.isFinite(value) || value < 1) {
      throw new BaselineError(`an image ${side} of ${String(value)} is not a size to render over`);
    }
  }
};

/**
 * The map's resolution: the image downscaled by `cellPx`, never below one cell a side.
 *
 * Rounded per side rather than derived from one side and an aspect ratio, so the
 * relationship to the input size is one division a reader can check — and so the map's shape
 * agrees with the image's to within one cell, which is what keeps a comparison inside #83's
 * grid-shape tolerance.
 */
export const mapResolution = (
  imageSize: ImageSize,
  cellPx: number = MAP_RENDERING.cellPx,
): { readonly width: number; readonly height: number } => {
  assertImageSize(imageSize);
  if (!Number.isFinite(cellPx) || cellPx <= 0) {
    throw new BaselineError(`a cell of ${String(cellPx)} image pixels is not a resolution`);
  }
  const cell = atLeastOneWhole(cellPx);
  return {
    width: atLeastOneWhole(imageSize.width / cell),
    height: atLeastOneWhole(imageSize.height / cell),
  };
};

/**
 * A point's weight in the map: its dwell raised to the configured exponent.
 *
 * The two settings that mean something are written out so they are exact as well as
 * documented — 1 is dwell-weighted and 0 counts points — because `**` is
 * implementation-approximated and these two should not depend on that. The engine states it
 * the same way, for the same reason.
 */
const weightOf = (durationMs: number, exponent: number): number => {
  if (exponent === 0) return 1;
  if (exponent === 1) return durationMs;
  return durationMs ** exponent;
};

/**
 * The values divided by their own total, so they sum to 1 and the map is a distribution.
 *
 * A map with no mass at all — no points, or every weight zero — comes back **uniform**: still
 * a distribution, and still honest about having found no structure. The engine answers the
 * same way, and a metric reading a `NaN` would instead read a malformed map.
 */
const normalisedToSum = (values: readonly number[]): number[] => {
  let total = 0;
  for (const value of values) if (Number.isFinite(value) && value > 0) total += value;
  if (!Number.isFinite(total) || total <= 0) return values.map(() => 1 / values.length);
  return values.map((value) => (Number.isFinite(value) && value > 0 ? value / total : 0));
};

/**
 * The points spread into a continuous, `sum-to-one` saliency map over one image.
 *
 * Accumulated in row-major order over the cells within the truncation radius of each point,
 * in the order the points are given, so the sum is formed the same way on every run and in
 * every process. A kernel with no width puts a point's whole weight in the cell it landed
 * in, which is the Gaussian's limit rather than a special case.
 *
 * A point strictly outside the image is **refused by name**, as this package's metrics refuse
 * one: a baseline that drew a fixation off the image would be reporting attention paid to
 * nothing. A point exactly on the right or bottom edge falls in the last cell, the inclusive
 * upper edge `SaliencyMap` documents.
 */
export const renderSaliencyMap = (
  points: readonly MapPoint[],
  imageSize: ImageSize,
  parameters: MapRenderingParameters = MAP_RENDERING,
): SaliencyMap => {
  const { width, height } = mapResolution(imageSize, parameters.cellPx);
  const { kernelSigmaShare, kernelRadiusSigmas, dwellWeightExponent } = parameters;
  const values = new Array<number>(width * height).fill(0);

  /**
   * A width or a truncation a caller left unusable collapses the kernel to a point rather
   * than to a `NaN` comparison that would quietly accumulate nothing. An **infinite**
   * truncation is not unusable: it sums every cell of the map, which is how the centre-bias
   * prior asks for a field with no zero in it, and the loops below stop at the map's edge.
   */
  const sigma = Number.isFinite(kernelSigmaShare)
    ? Math.max(0, kernelSigmaShare) * Math.max(width, height)
    : 0;
  const radiusSigmas = Number.isNaN(kernelRadiusSigmas) ? 0 : Math.max(0, kernelRadiusSigmas);
  const radius = sigma > 0 ? Math.ceil(radiusSigmas * sigma) : 0;
  const twoSigmaSquared = 2 * sigma * sigma;

  for (const point of points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > imageSize.width ||
      point.y > imageSize.height
    ) {
      throw new BaselineError(
        `a point at (${String(point.x)}, ${String(point.y)}) is outside the ` +
          `${imageSize.width} × ${imageSize.height} image it was drawn over`,
      );
    }

    const weight = weightOf(point.durationMs, dwellWeightExponent);
    if (!Number.isFinite(weight) || weight <= 0) continue;

    /** The point in cell coordinates: `x` image pixels is `x * width / imageWidth` cells. */
    const centreX = (point.x * width) / imageSize.width;
    const centreY = (point.y * height) / imageSize.height;
    const column = Math.min(width - 1, Math.floor(centreX));
    const row = Math.min(height - 1, Math.floor(centreY));

    if (radius === 0) {
      values[row * width + column] += weight;
      continue;
    }
    for (let y = Math.max(0, row - radius); y <= Math.min(height - 1, row + radius); y += 1) {
      for (
        let x = Math.max(0, column - radius);
        x <= Math.min(width - 1, column + radius);
        x += 1
      ) {
        const offsetX = x + MAP_RENDERING.cellCentre - centreX;
        const offsetY = y + MAP_RENDERING.cellCentre - centreY;
        values[y * width + x] +=
          weight * Math.exp(-(offsetX * offsetX + offsetY * offsetY) / twoSigmaSquared);
      }
    }
  }

  return {
    width,
    height,
    values: normalisedToSum(values),
    imageSize: { width: imageSize.width, height: imageSize.height },
    normalisation: SUM_TO_ONE,
  };
};
