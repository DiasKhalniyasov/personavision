import type { Session } from '@personavision/contract';
import type { Aoi } from './aggregate.js';
import { aoiId, buildAois, heuristicSegmenter } from './aois/index.js';
import type { Segmenter } from './aois/index.js';
import type { EngineConfig, EngineConfigOverrides } from './config.js';
import { resolveEngineConfig } from './config.js';
import type { PersonaTraits } from './persona.js';
import { readScreenshotPixels, salienceByArea } from './salience.js';
import type { PageBox } from './salience.js';
import { sampleFixations } from './sampling/index.js';
import type { SampledFixation } from './sampling/index.js';
import type { Capture, Goal, Viewport } from './types.js';

/**
 * `predict` — a saliency map and a scanpath for a bare screenshot, with no DOM.
 *
 * This is the path the calibration step (#11) scores the engine against UEyes through.
 * UEyes gives images and human gaze, not web pages: there is no DOM, no accessibility
 * tree, no goal and no persona, and a prediction still has to come out. So `predict`
 * composes the engine that already exists rather than being a second engine beside it:
 *
 * 1. the offline heuristic segmenter (#66) partitions the image into regions, with nothing
 *    explained by elements because there are no elements;
 * 2. the salience terms (#65) score those regions from the pixels;
 * 3. the seeded sampler (#67) draws a scanpath over them with the goal empty, so relevance
 *    is flat at its floor and the result rests on salience, the position priors inside it,
 *    and the sequence dynamics;
 * 4. the fixations are spread into a continuous map by a Gaussian kernel and normalised.
 *
 * **Nothing stands out and nothing is found is still an answer.** An image the segmenter
 * finds no structure in — a flat field, a photograph of fog — is partitioned into a grid
 * of cells instead, which the same salience terms score. Their contrast is nil, so the
 * centre and top priors decide, and the result is a valid map and a non-empty scanpath
 * rather than an empty one. That is the honest prediction for an image with nothing in it,
 * not a degenerate case to special-case away.
 *
 * ## What a reviewer of a reported score has to know
 *
 * CC, NSS, KLD and AUC-Judd are each sensitive to some of the following, so all of it is
 * stated here and in `packages/engine/README.md`, and every number is in
 * `EngineConfig.prediction` where #11 can fit it.
 *
 * - **Resolution.** `round(imageWidth / cellPx)` x `round(imageHeight / cellPx)` cells, at
 *   least one of each: the map is a downscale of the image by `prediction.map.cellPx`,
 *   which is 20 on the defaults. The two sides are rounded independently, so the map's
 *   aspect ratio agrees with the image's to within one cell. The map carries the
 *   `imageSize` it describes, which is the size of the bytes as they decoded — not a
 *   declared size that disagrees with them.
 * - **Coordinate convention.** Row-major image space: cell `(x, y)` is
 *   `values[y * width + x]`, cell `(0, 0)` covers the image's top-left corner, `x` runs
 *   right and `y` runs down. A fixation's `x` and `y` are image pixels in that same space,
 *   and a point on the far edge falls in the last cell.
 * - **Kernel.** An isotropic 2-D Gaussian per fixation, with a standard deviation of
 *   `prediction.map.kernelSigmaShare` of the map's longer side and truncated at
 *   `prediction.map.kernelRadiusSigmas` standard deviations. Each fixation is weighted by
 *   its dwell raised to `prediction.map.dwellWeightExponent` — 1 is dwell-weighted, 0
 *   counts fixations.
 * - **Normalisation.** `sum-to-one`: the values sum to 1, so the map is a distribution
 *   over the image's cells. That is the rule the calibration package's own maps use, so a
 *   metric compares like with like and KLD — the one metric that is not invariant to a
 *   rescaling — needs no conversion on either side. Mass the truncation or the image's
 *   edge drops is absorbed by the normalisation.
 *
 * ## The seam with the calibration package
 *
 * `predict` satisfies `Predictor` from `@personavision/calibration` — `(image, seed) =>
 * Prediction` — and the types below are declared **field-for-field** as that package
 * publishes them, exactly as `./types.ts` declares the browser step's `Capture`. The
 * engine does not import the calibration package and cannot: `@personavision/engine` is
 * specified as depending on `@personavision/contract` and `sharp` only (#7), the engine's
 * own `tests/config.test.ts` asserts that dependency list, and the calibration package's
 * `test/dependency-direction.test.ts` asserts that no file in `packages/engine` imports it.
 * TypeScript's structural typing joins the two sides without either knowing the other.
 *
 * A field renamed on either side stops satisfying the other with no compile error in
 * either package, so the names below are binding on both; the auto-decision on #68 records
 * which of the two options the owner offered was taken, and why the other one is not
 * available. The fixation's own fields are not restated at all — they are taken from
 * `packages/contract`, which is the one place in this repository where an artifact field
 * name is declared, and which both packages already read.
 *
 * ## Purity and determinism
 *
 * The engine reads no file and opens no socket: the image arrives as bytes the caller
 * read, and the one decode is `readScreenshotPixels`, which hands those bytes to `sharp`.
 * The default segmenter is given the pixels that decode produced, so it opens nothing
 * either, and no path is resolved anywhere on this path.
 *
 * The same image and the same seed produce the same map and the same scanpath: one seeded
 * generator inside the sampler, no draw anywhere else, and a row-major accumulation into
 * the map. The scanpath is byte-identical on any machine, as the sampler's is. The map's
 * cells are accumulated with `Math.exp`, which IEEE-754 does not pin the way it pins
 * addition and square root, so two *different JavaScript engines* could differ in a cell's
 * last bits; within the Node range this repository supports they do not, and no metric in
 * #11 is sensitive at that scale.
 */

/** An image's own size in pixels, which a map's resolution is stated relative to. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The display an image was shown at: the visible area in CSS pixels, and image pixels per
 * CSS pixel. A prediction is made at the resolution the humans saw rather than at a
 * default, which is why a bare image's assumed display is reported back in the answer.
 */
export interface Display {
  readonly viewport: Viewport;
  /** Image pixels per CSS pixel — the contract's `device.deviceScaleFactor`. */
  readonly scale: number;
}

/**
 * How a saliency map's values are scaled. `predict` answers `sum-to-one`; the other two
 * are here because the seam names them and a metric has to be able to say which it got.
 */
export type SaliencyNormalisation = 'sum-to-one' | 'peak-to-one' | 'none';

/** A saliency map: a continuous, non-negative field over one image, row-major. */
export interface SaliencyMap {
  /** Cells across. */
  readonly width: number;
  /** Cells down. */
  readonly height: number;
  /** `width * height` finite, non-negative cells, row-major. */
  readonly values: readonly number[];
  /** The image this map describes, so a comparison can state what it compared. */
  readonly imageSize: ImageSize;
  readonly normalisation: SaliencyNormalisation;
}

/**
 * One fixation of a prediction, in image space.
 *
 * The contract's own session fixation fields, narrowed to the ones a free-viewing record
 * has: a bare image is a single screen, so there is no `screenIndex`, and it has no areas
 * of interest a designer would recognise, so there is no `aoiId`. Naming one would be a
 * claim about where attention landed that a bare image cannot support.
 *
 * Named for the engine's own namespace, where `SampledFixation` is already the sampler's
 * page-space fixation; the calibration package spells this same type `Fixation`.
 */
export type PredictedFixation = Pick<
  Session['fixations'][number],
  'index' | 'tMs' | 'durationMs' | 'x' | 'y'
>;

/**
 * One predicted scanpath: ordered fixations over one image. `participantId` is `null`,
 * because a prediction belongs to no participant — a predicted scanpath that claimed one
 * would be scored against the human it named.
 */
export interface PredictedScanpath {
  readonly participantId: string | null;
  readonly fixations: readonly PredictedFixation[];
}

/** The image handed to `predict`: pixels, the size, and the display if one is known. */
export interface PredictorImage {
  /** The image file's bytes, as they sit on disk. The engine does not go and read them. */
  readonly bytes: Uint8Array;
  /** The image's pixel size. A size that disagrees with the bytes does not win. */
  readonly size: ImageSize;
  /**
   * The display the image was shown at. Omitted — or carrying a number that is not a
   * usable one — is a bare image, and `predict` defaults from the image's own dimensions
   * and reports what it assumed.
   */
  readonly display?: Display;
}

/** What `predict` answers: the two fields the seam promises, plus the display it used. */
export interface Prediction {
  readonly saliencyMap: SaliencyMap;
  readonly scanpath: PredictedScanpath;
  /** Given or assumed, always reported: the viewport and scale this prediction was made at. */
  readonly display: Display;
}

export interface PredictOptions {
  /**
   * Layered over the engine defaults, so the fit (#11) varies the configuration without a
   * code change. A caller holding the resolved configuration passes the same overrides it
   * resolved from, since the segmenter and the sampler resolve it again for themselves.
   */
  readonly weights?: EngineConfigOverrides;
  /**
   * Replaces the offline heuristic segmenter, which is the default. The capture it is
   * handed is synthetic and names no screenshot file — `predict` holds the pixels — so an
   * implementation that wants to look at the image brings its own copy of it.
   */
  readonly segmenter?: Segmenter;
}

/**
 * The variant and step a bare image's regions are named under.
 *
 * An area's id carries both (`aoiId`), because a run holds every variant's areas in one
 * array. A bare image is not part of a run and has neither, so these two words stand in
 * for them and make the ids stable and readable — `image-view-region-top-banner-0-0-480x72`
 * — rather than empty segments. They are structure, not a quantity, so they are not in
 * `EngineConfig`.
 */
const PREDICTION_VARIANT = 'image';
const PREDICTION_STEP = 'view';

/**
 * The screenshot path on the synthetic capture: none. The default segmenter is constructed
 * with a reader that answers the pixels `predict` already decoded, so nothing resolves
 * this or opens it.
 */
const NO_SCREENSHOT = '';

/**
 * A bare image's scale: its pixels *are* CSS pixels until something says otherwise. This
 * is the definition of "default from the image's own dimensions" rather than a number to
 * fit — a fitted scale would be a claim about a display nobody recorded.
 */
const BARE_IMAGE_SCALE = 1;

/**
 * No goal. An empty goal matches no word and expresses no intent, so `relevanceByArea`
 * leaves every area at `relevance.floor` — flat, which is what "relevance is neutral"
 * means in the sampler's softmax. UEyes is free viewing: there is no task to be relevant
 * to, and inventing one would predict a scanpath nobody performed.
 */
const NO_GOAL: Goal = { text: '' };

/** A prediction belongs to no participant. */
const NO_PARTICIPANT = null;

/** The map's own rule, as the seam spells it. */
const SUM_TO_ONE: SaliencyNormalisation = 'sum-to-one';

/** A cell's centre, in cells: where the kernel is measured from. */
const CELL_CENTRE = 0.5;

/**
 * The only `ElementSource` the contract has for an area the DOM does not explain. Every
 * area on this path is one, whether the segmenter found it or the position-prior grid laid
 * it out; none of them reaches a run artifact, since a prediction is not a session.
 */
const UNEXPLAINED: Aoi['source'] = 'sam';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** A viewport is a positive whole number of CSS pixels, as the contract's schema requires. */
const atLeastOneWhole = (value: number): number => Math.max(1, Math.round(value));

const isUsable = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/**
 * The display this prediction is made at: the caller's, or defaulted from the image's own
 * dimensions and reported back.
 *
 * A number that is not usable — zero, negative, `NaN`, absent — is defaulted rather than
 * carried, because every later step divides by the scale or lays out a page in the
 * viewport, and one `NaN` here would reach the sampler's softmax as an empty answer.
 */
const displayFor = (size: ImageSize, given: Display | undefined): Display => {
  const scale = isUsable(given?.scale) ? given.scale : BARE_IMAGE_SCALE;
  return {
    scale,
    viewport: {
      width: isUsable(given?.viewport?.width)
        ? atLeastOneWhole(given.viewport.width)
        : atLeastOneWhole(size.width / scale),
      height: isUsable(given?.viewport?.height)
        ? atLeastOneWhole(given.viewport.height)
        : atLeastOneWhole(size.height / scale),
    },
  };
};

/**
 * The capture a bare image makes: one screen, no elements, and no fold.
 *
 * `elements` is empty because there is no DOM — which is the whole point of this path, and
 * what leaves the segmenter the entire image to partition. `foldY` is the page's own
 * height, so nothing is below the fold: the image was shown whole, and a fold line is a
 * property of a scrolled page rather than of a picture.
 */
const captureFor = (viewport: Viewport): Capture => ({
  step: PREDICTION_STEP,
  screenshot: NO_SCREENSHOT,
  viewport,
  pageHeight: viewport.height,
  foldY: viewport.height,
  elements: [],
});

/** Every trait at the configured neutral value: a bare image has no persona. */
const neutralTraits = (config: EngineConfig): PersonaTraits => {
  const trait = config.prediction.neutralTrait;
  return {
    persistence: trait,
    scanningVsReading: trait,
    detailOrientation: trait,
    interfaceFamiliarity: trait,
    patience: trait,
    riskTolerance: trait,
  };
};

/**
 * The position-prior grid: the areas an image with no segmentable structure is looked at
 * through.
 *
 * A regular partition of the page, scored by the same salience terms as a segmented region.
 * On a flat field their contrast terms are nil and their relative areas are equal, so what
 * is left is the centre bias and the top bias — the position priors — and the sampler draws
 * a scanpath led by them. That is a weaker claim than a found region, and it is the claim
 * the image supports.
 *
 * The rows follow from the aspect ratio rather than being configured separately, so a cell
 * is about square whatever shape the image is.
 */
const priorGrid = (page: PageBox, config: EngineConfig): Aoi[] => {
  const columns = atLeastOneWhole(config.prediction.priorGridCellsAcross);
  const rows = atLeastOneWhole((columns * page.height) / page.width);
  const cellWidth = page.width / columns;
  const cellHeight = page.height / rows;

  const areas: Aoi[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const bbox = {
        x: column * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      };
      const label = `image cell ${column + 1},${row + 1}`;
      areas.push({
        id: aoiId({
          variant: PREDICTION_VARIANT,
          step: PREDICTION_STEP,
          role: null,
          label,
          bbox,
        }),
        variant: PREDICTION_VARIANT,
        step: PREDICTION_STEP,
        label,
        source: UNEXPLAINED,
        role: null,
        bbox,
        isPrimaryAction: false,
        belowFold: false,
      });
    }
  }
  return areas;
};

/**
 * The scanpath in image space: the sampler's page-space landing points times the scale.
 *
 * The sampler works in page space, which for a bare image is the image in CSS pixels, and
 * the seam's fixations are in image pixels. `index` is re-stated as the position along the
 * scanpath, which is what the seam promises it is.
 */
const scanpathOf = (
  fixations: readonly SampledFixation[],
  size: ImageSize,
  display: Display,
): PredictedScanpath => ({
  participantId: NO_PARTICIPANT,
  fixations: fixations.map((fixation, position) => ({
    index: position,
    tMs: fixation.tMs,
    durationMs: fixation.durationMs,
    x: clamp(fixation.pageX * display.scale, 0, size.width),
    y: clamp(fixation.pageY * display.scale, 0, size.height),
  })),
});

/**
 * The map's resolution: the image downscaled by `cellPx`, never below one cell a side.
 *
 * Rounded per side rather than derived from one side and an aspect ratio, so the
 * relationship to the input size is the same statement in both directions and a reader can
 * check it with one division.
 */
const resolutionOf = (
  size: ImageSize,
  config: EngineConfig,
): { readonly width: number; readonly height: number } => {
  const cellPx = atLeastOneWhole(config.prediction.map.cellPx);
  return {
    width: atLeastOneWhole(size.width / cellPx),
    height: atLeastOneWhole(size.height / cellPx),
  };
};

/**
 * A fixation's weight in the map: its dwell raised to the configured exponent.
 *
 * The two settings that mean something are written out so they are exact as well as
 * documented — an exponent of 1 is dwell-weighted and an exponent of 0 counts fixations —
 * because `**` is implementation-approximated and these two should not depend on that.
 */
const dwellWeightOf = (durationMs: number, exponent: number): number => {
  if (exponent === 0) return 1;
  if (exponent === 1) return durationMs;
  return durationMs ** exponent;
};

/**
 * Divided by its own total, so the values sum to 1 and the map is a distribution over the
 * image's cells.
 *
 * A cell that is not a finite positive number contributes nothing and comes back as 0,
 * rather than as the `NaN` a metric would read as a malformed map. A map with no mass at
 * all — which no non-empty scanpath produces, but a configuration fitted to weight every
 * fixation at zero would — comes back uniform: still a distribution, and still honest
 * about having found no structure.
 */
const normalisedToSum = (values: readonly number[]): number[] => {
  let total = 0;
  for (const value of values) if (Number.isFinite(value) && value > 0) total += value;
  if (!Number.isFinite(total) || total <= 0) return values.map(() => 1 / values.length);
  return values.map((value) => (Number.isFinite(value) && value > 0 ? value / total : 0));
};

/**
 * The fixations spread into a continuous map by the configured Gaussian kernel.
 *
 * Accumulated in row-major order over the cells within the truncation radius of each
 * fixation, in scanpath order, so the sum is formed the same way every time. A kernel with
 * no width at all puts a fixation's whole weight in the cell it landed in, which is the
 * limit of the Gaussian rather than a special case.
 */
const saliencyMapOf = (
  fixations: readonly PredictedFixation[],
  size: ImageSize,
  config: EngineConfig,
): SaliencyMap => {
  const { width, height } = resolutionOf(size, config);
  const { kernelSigmaShare, kernelRadiusSigmas, dwellWeightExponent } = config.prediction.map;
  const values = new Array<number>(width * height).fill(0);

  /**
   * A width or a truncation a configuration left unusable collapses the kernel to a point
   * rather than to a `NaN` comparison that would quietly accumulate nothing: the limit of
   * the Gaussian is the fixation's own cell, and the map stays a distribution either way.
   */
  const sigma = Number.isFinite(kernelSigmaShare)
    ? Math.max(0, kernelSigmaShare) * Math.max(width, height)
    : 0;
  const radiusSigmas = Number.isFinite(kernelRadiusSigmas) ? Math.max(0, kernelRadiusSigmas) : 0;
  const radius = sigma > 0 ? Math.ceil(radiusSigmas * sigma) : 0;
  const twoSigmaSquared = 2 * sigma * sigma;

  for (const fixation of fixations) {
    const weight = dwellWeightOf(fixation.durationMs, dwellWeightExponent);
    if (!Number.isFinite(weight) || weight <= 0) continue;

    /** The fixation in cell coordinates: `x` image pixels is `x * width / imageWidth` cells. */
    const centreX = (fixation.x * width) / size.width;
    const centreY = (fixation.y * height) / size.height;
    const column = clamp(Math.floor(centreX), 0, width - 1);
    const row = clamp(Math.floor(centreY), 0, height - 1);

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
        const offsetX = x + CELL_CENTRE - centreX;
        const offsetY = y + CELL_CENTRE - centreY;
        values[y * width + x] +=
          weight * Math.exp(-(offsetX * offsetX + offsetY * offsetY) / twoSigmaSquared);
      }
    }
  }

  return {
    width,
    height,
    values: normalisedToSum(values),
    imageSize: size,
    normalisation: SUM_TO_ONE,
  };
};

/**
 * Predict a saliency map and a scanpath for one image.
 *
 * No DOM, no goal and no persona: a screenshot's bytes, its size, the display it was shown
 * at if that is known, and a seed. The same image and seed answer the same map and the same
 * scanpath; a different seed answers a different scanpath, which is how a reported score is
 * reproducible and how the fit (#11) repeats a run exactly.
 *
 * `options` is the third parameter rather than part of the image, so the two-parameter seam
 * the calibration package scores through is satisfied as it stands.
 */
export const predict = async (
  image: PredictorImage,
  seed: number,
  options: PredictOptions = {},
): Promise<Prediction> => {
  const { config } = resolveEngineConfig(options.weights);
  /**
   * The one decode, and the only thing on this path that looks at the bytes. The size is
   * taken from it rather than from `image.size`: a declared size that disagrees with the
   * pixels would make the map describe an image that was never measured.
   */
  const pixels = await readScreenshotPixels(image.bytes);
  const size: ImageSize = { width: pixels.width, height: pixels.height };

  const display = displayFor(size, image.display);
  const page: PageBox = { width: display.viewport.width, height: display.viewport.height };
  const traits = neutralTraits(config);

  const segmented = await buildAois({
    capture: captureFor(display.viewport),
    variant: PREDICTION_VARIANT,
    segmenter:
      options.segmenter ?? heuristicSegmenter({ config: options.weights, readImage: () => pixels }),
  });
  const aois = segmented.length > 0 ? segmented : priorGrid(page, config);

  const salience = await salienceByArea({ screenshot: pixels, page, aois, traits, config });
  const { fixations } = sampleFixations({
    aois,
    goal: NO_GOAL,
    persona: traits,
    seed,
    weights: options.weights,
    salience,
  });

  const scanpath = scanpathOf(fixations, size, display);
  return { saliencyMap: saliencyMapOf(scanpath.fixations, size, config), scanpath, display };
};
