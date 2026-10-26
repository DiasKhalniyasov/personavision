/**
 * The vocabulary of the calibration step: human ground truth, a prediction, and the seam
 * the two meet at.
 *
 * Every later ticket of step #11 — the corpus, the four saliency metrics, the two scanpath
 * metrics, the download, the conversion, the baselines, the scoring and the fit — is
 * written against the names below, so a name changed here is a change to all of them.
 *
 * `docs/FLOW.md` section 8 fixes the words: *fixation*, *saccade*, *dwell*, *scanpath*,
 * *participant*, *session*, *seed*. A fixation's dwell is its `durationMs`; the ordered
 * fixations of one participant over one image are a *scanpath*.
 *
 * Geometry here is **image space**: the origin is the top-left pixel of the image the
 * humans were shown, `x` runs right and `y` runs down. That is not the run artifact's page
 * space — a UEyes record is one image and has no page, no fold and no areas of interest —
 * and the two are never mixed. `packages/calibration/README.md` says so once more, because
 * every metric in this package depends on it.
 */

import type { Session } from '@personavision/contract';

/**
 * The display's visible area in CSS pixels, taken from `packages/contract` rather than
 * restated: the contract is the only place in this repository where an artifact field name
 * is declared, and a converted record (#86) carries these very fields onto a session.
 */
export type Viewport = NonNullable<Session['persona']>['device']['viewport'];

/** An image's own size in pixels, which a map's resolution is stated relative to. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The display the humans were shown an image at.
 *
 * A prediction is made at the resolution the humans saw and never at a default (#11, user
 * story 4), which is why this travels with the ground truth and into the predictor.
 */
export interface Display {
  readonly viewport: Viewport;
  /** Image pixels per CSS pixel — the contract's `device.deviceScaleFactor`. */
  readonly scale: number;
}

/** The four UI types UEyes covers. A score is reported per category and overall (#11). */
export type RecordCategory = 'webpage' | 'desktop' | 'mobile' | 'poster';

/** Every category, in the order a report lists them. `webpage` is what this product is for. */
export const RECORD_CATEGORIES: readonly RecordCategory[] = [
  'webpage',
  'desktop',
  'mobile',
  'poster',
];

/**
 * The viewing duration a piece of UEyes ground truth was cut at.
 *
 * UEyes publishes its saliency maps and scanpaths at one, three and seven seconds of free
 * viewing (`saliency_maps/fixmaps_{1,3,7}s`, `scanpaths/paths_{1,3,7}s` — see the layout in
 * `src/dataset/manifest.json`). Which one a figure was measured against changes the figure,
 * so ground truth names it rather than leaving it to a reader to assume.
 */
export type ViewingDurationSeconds = 1 | 3 | 7;

/** Every published viewing duration. */
export const VIEWING_DURATIONS_SECONDS: readonly ViewingDurationSeconds[] = [1, 3, 7];

/**
 * How a saliency map's values are scaled.
 *
 * CC and NSS are invariant to an affine rescaling and AUC-Judd to any monotone one, but KLD
 * is not: it reads both maps as distributions. So the rule is named on the map rather than
 * assumed by the metric, and a metric that needs a particular rule converts or refuses
 * explicitly (#83).
 *
 * This package's own maps are `sum-to-one`; `packages/calibration/README.md` records that
 * choice and the correspondence with the engine's map (#68).
 */
export type SaliencyNormalisation =
  /** The values sum to 1: the map is a distribution over its cells. */
  | 'sum-to-one'
  /** The greatest value is 1 and the least is 0 or more. */
  | 'peak-to-one'
  /** Finite and non-negative, with no further rule. Say why before using it. */
  | 'none';

/**
 * A saliency map: a continuous, non-negative field over one image.
 *
 * **Resolution.** `width` × `height` cells, which is normally coarser than the image:
 * ground truth and predictions are compared cell for cell, so a map carries the
 * `imageSize` it describes and the aspect ratio of the two agrees. A metric handed two maps
 * at different resolutions follows one documented rule and never resamples silently (#83).
 *
 * **Coordinate convention.** Row-major in image space: the cell at column `x`, row `y` is
 * `values[y * width + x]`, cell `(0, 0)` covers the image's top-left corner, `x` runs right
 * and `y` runs down. A fixation at image pixel `(px, py)` falls in the cell
 * `(floor(px * width / imageSize.width), floor(py * height / imageSize.height))`.
 *
 * **Normalisation.** `normalisation` names the rule that holds over `values`. Whichever it
 * is, every value is finite and non-negative — a `NaN`, an `Infinity` or a negative cell is
 * a malformed map, not a special case for a metric to interpret.
 */
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
 * One fixation, in image space.
 *
 * The fields are `packages/contract`'s session fixation fields, narrowed to the ones a
 * free-viewing record has: a UEyes image is a single screen, so there is no `screenIndex`,
 * and it has no areas of interest, so there is no `aoiId` — #86 fills those in when it
 * converts a scanpath into a session, and fabricating one here would be a claim about where
 * attention landed that the dataset does not make.
 *
 * `index` runs 0, 1, 2 … in order along the scanpath; `tMs` is the fixation's onset from the
 * start of viewing and `durationMs` its dwell.
 */
export type Fixation = Pick<
  Session['fixations'][number],
  'index' | 'tMs' | 'durationMs' | 'x' | 'y'
>;

/**
 * One scanpath: ordered fixations over one image.
 *
 * `participantId` names the human whose gaze this is and is `null` for a predicted
 * scanpath, which belongs to no participant. A record has one scanpath per participant who
 * saw the image, so a prediction is scored against several humans and the human-to-human
 * agreement is reported next to it as the ceiling (#84).
 */
export interface Scanpath {
  readonly participantId: string | null;
  readonly fixations: readonly Fixation[];
}

/**
 * One image of the benchmark with the human ground truth for it.
 *
 * The real records come from the dataset in the cache (#85) by way of the converter (#86);
 * the committed corpus (#82) is synthetic and in exactly this shape, so pointing the same
 * code at the real dataset changes the data and not a line of the code.
 */
export interface GroundTruthRecord {
  /** The dataset's own image name without its extension, stable across runs. */
  readonly id: string;
  readonly category: RecordCategory;
  /** Absolute path to the image's bytes — in the cache, or in the committed corpus. */
  readonly imagePath: string;
  readonly imageSize: ImageSize;
  readonly display: Display;
  /** Which viewing duration the ground truth below was cut at. */
  readonly viewingDurationSeconds: ViewingDurationSeconds;
  /** The humans' aggregated saliency map. */
  readonly saliencyMap: SaliencyMap;
  /** One scanpath per participant, in the order the dataset lists them. */
  readonly scanpaths: readonly Scanpath[];
}

/**
 * The image handed to a predictor: pixels, the size, and the display the humans saw.
 *
 * A predictor may read no more than this — no DOM, no accessibility tree, no goal and no
 * persona — because UEyes gives images and human gaze, not web pages (#68).
 */
export interface PredictorImage {
  /** The image file's bytes, as they sit on disk. */
  readonly bytes: Uint8Array;
  /** The image's pixel size, so a predictor need not decode the bytes to learn it. */
  readonly size: ImageSize;
  /**
   * The display the humans were shown this image at. A predictor given a bare image with no
   * display of its own defaults from the image's dimensions and records what it assumed.
   */
  readonly display: Display;
}

/**
 * What a predictor returns: a saliency map and a scanpath for one image.
 *
 * These are the two fields `predict` promises (#68). `display` is optional because that
 * signature promises only the two maps above, while the engine's `predict` additionally
 * records the display it assumed for a bare image — a predictor satisfies this seam either
 * way, and #88 reports the display when there is one.
 */
export interface Prediction {
  readonly saliencyMap: SaliencyMap;
  readonly scanpath: Scanpath;
  readonly display?: Display;
}

/**
 * The seam every scored predictor is reached through: an image and a seed in, a saliency map
 * and a scanpath out.
 *
 * The engine's `predict` (#68), the centre-bias prior and the random-fixation baseline
 * (#87) all satisfy it, so one piece of code scores all three and a reported margin is a
 * margin between comparable numbers (#88).
 *
 * The seed makes a reported score reproducible: the same image and seed give the same
 * prediction, which is what lets the fit (#90) repeat a run exactly.
 *
 * **This package does not import `packages/engine`.** The engine's `predict` satisfies this
 * type structurally, and `test/types.test.ts` holds a value shaped as its return to prove
 * it. The dependency runs one way — calibration may read the engine, never the reverse —
 * and `test/dependency-direction.test.ts` asserts that too.
 */
export type Predictor = (image: PredictorImage, seed: number) => Prediction | Promise<Prediction>;
