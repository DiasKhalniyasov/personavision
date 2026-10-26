import sharp from 'sharp';
import type { Aoi } from './aggregate.js';
import type { EngineConfig } from './config.js';
import { defaultEngineConfig } from './config.js';
import { rolePriorFor } from './persona.js';
import type { PersonaTraits } from './persona.js';
import type { BoundingBox } from './types.js';

/**
 * Bottom-up visual salience per area of interest, from explainable image statistics.
 *
 * How much an area stands out *before* anything is known about the agent's goal: the
 * bottom-up half of `P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)`. Six
 * terms, each on 0..1, each weighted separately through the configuration object:
 *
 * | Term                | What it reads                                                         |
 * | ------------------- | --------------------------------------------------------------------- |
 * | `luminanceContrast` | the area's mean luminance against the ring of pixels around it         |
 * | `colourContrast`    | the same ring in opponent colour, so hue counts apart from lightness   |
 * | `relativeArea`      | how much of the page the area occupies                                 |
 * | `centreBias`        | how near the page's centre it sits                                     |
 * | `topBias`           | how near the top of the page it sits                                   |
 * | `rolePrior`         | that a button is not a paragraph, scaled by interface familiarity      |
 *
 * **Deliberately simple statistics, not a pretrained saliency network.** #7 settled that:
 * SAM's role in this project is segmentation, not salience, and the calibration step (#11)
 * has to be able to fit these terms. A number written down here is a number calibration
 * cannot reach, so every weight, the role priors and the thickness of the surrounding ring
 * come from `EngineConfig`; `tests/salience.test.ts` reads this file and fails on any
 * literal that is not a definition.
 *
 * **Bounded and comparable.** The value is the weighted mean of the six terms — the
 * weighted sum over the total weight — so it is on 0..1 inclusive whatever the weights are,
 * including a negative one, and it does not grow with the number of terms switched on. That
 * matters because the sampler weighs it against relevance: a salience that quietly
 * rescaled itself would quietly rescale `alpha`.
 *
 * **Decoded once per capture.** `readScreenshotPixels` is the only decode, and every area
 * is measured from that one buffer. The engine is run thousands of times, so re-decoding
 * per area is a defect; a caller scoring several personas over one capture passes the
 * `ScreenshotPixels` back in rather than the bytes.
 *
 * **Pure, and determinate.** The screenshot arrives as bytes the caller read: this module
 * resolves no path, reads no file and opens no socket. Pixels are summed in row-major
 * order, and a distance is `Math.sqrt` of a sum of squares rather than `Math.hypot` or
 * `**`: the first is the hardware's square root, which every engine rounds the same way,
 * while the other two are implementation-approximated and do differ between engines. So
 * the same screenshot and the same areas give identical values on every machine.
 */

/** The six bottom-up terms, named exactly as `config.salience.weights` names them. */
export type SalienceTerm = keyof EngineConfig['salience']['weights'];

/**
 * The terms in a fixed order, so the weighted mean is accumulated the same way every time.
 * `tests/salience.test.ts` holds this tuple against the configuration's own keys, so a
 * seventh term added to the configuration cannot be left silently unweighted here.
 */
export const SALIENCE_TERMS = [
  'luminanceContrast',
  'colourContrast',
  'relativeArea',
  'centreBias',
  'topBias',
  'rolePrior',
] as const satisfies readonly SalienceTerm[];

/** Each term on 0..1: what the area is, before the weights decide how much each counts. */
export type SalienceTerms = { readonly [Term in SalienceTerm]: number };

/** One area's salience and the terms it came from — the *explainable* of the title. */
export interface AreaSalience {
  /** 0..1 inclusive. */
  readonly salience: number;
  readonly terms: SalienceTerms;
}

/**
 * The page box in page space: `{ width: capture.viewport.width, height: capture.pageHeight }`.
 *
 * Page space is the space an area's `bbox` is in — the origin is the top-left of the full
 * page — so the position and size terms are read against the whole page and not against the
 * viewport. The screenshot's own pixel dimensions carry the device pixel ratio.
 *
 * Not `Viewport`, which it is shaped like: a viewport is the device's visible area and a
 * page is taller than one. And not in `types.ts`, which holds the shapes `packages/browser`
 * publishes field-for-field and is not this package's to add to.
 */
export interface PageBox {
  readonly width: number;
  readonly height: number;
}

/** A screenshot decoded once: its raw samples, their geometry, and how many channels. */
export interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  /** 1 (grey), 2 (grey and alpha), 3 (RGB) or 4 (RGBA); alpha is ignored. */
  readonly channels: number;
  /** Row-major, `channels` samples per pixel. */
  readonly data: Uint8Array;
}

export interface SalienceInput {
  /**
   * The full-page screenshot: the bytes of the file `capture.screenshot` names, which the
   * caller read, or the `ScreenshotPixels` from an earlier `readScreenshotPixels` over the
   * same capture. This module never resolves that path and never opens that file.
   */
  readonly screenshot: Uint8Array | ScreenshotPixels;
  readonly page: PageBox;
  /** The areas to score, as `buildAois` built them. The answer is keyed on their ids. */
  readonly aois: readonly Aoi[];
  /** The persona whose eyes these are: interface familiarity scales the role prior. */
  readonly traits: PersonaTraits;
  /** Omitted means `defaultEngineConfig`; a run passes `resolveEngineConfig(…).config`. */
  readonly config?: EngineConfig;
}

/** A decoded `uchar` sample's maximum. The scale of the buffer, not a tunable. */
const CHANNEL_MAX = 255;

/**
 * Rec. 709 luma coefficients: the published definition of luminance from sRGB samples,
 * which is why they are written here rather than put in front of calibration. Fitting them
 * would not fit salience, it would redefine brightness.
 */
const LUMA = { red: 0.2126, green: 0.7152, blue: 0.0722 } as const;

/**
 * Three samples or more and a decoded pixel carries colour; fewer, and its single grey
 * sample stands in for all three channels.
 */
const RGB_CHANNELS = 3;

/** Where red, green and blue sit in a decoded RGB pixel. The buffer's layout. */
const RGB_OFFSETS = { red: 0, green: 1, blue: 2 } as const;

/**
 * An opponent channel runs from -1 to 1, so the difference between two means of it spans
 * -2..2, and the furthest two opponent pairs can be apart is the diagonal of that square.
 */
const OPPONENT_SPAN = 2;
const MAX_OPPONENT_DISTANCE = OPPONENT_SPAN * Math.SQRT2;

/** Everything this module answers is on 0..1, and a non-finite input is a 0, not a `NaN`. */
const clampUnit = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** A rectangle in the screenshot's pixel space; `right` and `bottom` are exclusive. */
interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const isEmpty = (rect: PixelRect): boolean => !(rect.right > rect.left && rect.bottom > rect.top);

const clippedTo = (pixels: ScreenshotPixels, rect: PixelRect): PixelRect => ({
  left: Math.min(Math.max(rect.left, 0), pixels.width),
  top: Math.min(Math.max(rect.top, 0), pixels.height),
  right: Math.min(Math.max(rect.right, 0), pixels.width),
  bottom: Math.min(Math.max(rect.bottom, 0), pixels.height),
});

const hasExtent = (page: PageBox): boolean =>
  Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0;

/**
 * An area's box in the screenshot's pixel space, clipped to the image.
 *
 * The scale is the screenshot's own: a device pixel ratio of 2 makes a 200-CSS-pixel-wide
 * page a 400-pixel-wide screenshot, and an area's box is in page space, so the ratio is
 * read from the image rather than passed in and trusted.
 */
const boxInPixels = (bbox: BoundingBox, page: PageBox, pixels: ScreenshotPixels): PixelRect => {
  const scaleX = pixels.width / page.width;
  const scaleY = pixels.height / page.height;
  return clippedTo(pixels, {
    left: Math.round(bbox.x * scaleX),
    top: Math.round(bbox.y * scaleY),
    right: Math.round((bbox.x + bbox.width) * scaleX),
    bottom: Math.round((bbox.y + bbox.height) * scaleY),
  });
};

/**
 * The box grown by the configured ring thickness and clipped to the image: what *local*
 * means. The ring itself is this rectangle minus the box, so an area at the page's edge
 * keeps whatever ring is left on its other sides.
 */
const surroundOf = (box: PixelRect, pixels: ScreenshotPixels, config: EngineConfig): PixelRect => {
  const { ringShare, minRingPx } = config.salience.surround;
  const shorterSide = Math.min(box.right - box.left, box.bottom - box.top);
  const asked = Math.max(Math.round(ringShare * shorterSide), Math.round(minRingPx), 0);
  const thickness = Number.isFinite(asked) ? asked : 0;
  return clippedTo(pixels, {
    left: box.left - thickness,
    top: box.top - thickness,
    right: box.right + thickness,
    bottom: box.bottom + thickness,
  });
};

/** Running totals over a set of pixels. Mutable on purpose: one object per side, per area. */
interface Sums {
  luminance: number;
  redGreen: number;
  yellowBlue: number;
  count: number;
}

const emptySums = (): Sums => ({ luminance: 0, redGreen: 0, yellowBlue: 0, count: 0 });

/**
 * One pixel's luminance and its two opponent-colour channels, added to `sums`.
 *
 * Opponent colour — red against green, yellow against blue — is how colour is separated
 * from brightness, so a colourful patch on an equally bright field reads as colour contrast
 * rather than as nothing at all. Alpha is ignored, because a page screenshot is opaque, and
 * a greyscale screenshot's single sample stands in for all three channels.
 */
const addPixel = (sums: Sums, pixels: ScreenshotPixels, x: number, y: number): void => {
  const at = (y * pixels.width + x) * pixels.channels;
  const inColour = pixels.channels >= RGB_CHANNELS;
  const red = pixels.data[at + RGB_OFFSETS.red] / CHANNEL_MAX;
  const green = inColour ? pixels.data[at + RGB_OFFSETS.green] / CHANNEL_MAX : red;
  const blue = inColour ? pixels.data[at + RGB_OFFSETS.blue] / CHANNEL_MAX : red;

  sums.luminance += LUMA.red * red + LUMA.green * green + LUMA.blue * blue;
  sums.redGreen += red - green;
  /** Yellow is the mean of red and green, as the opponent pair is usually written. */
  sums.yellowBlue += (red + green) / 2 - blue;
  sums.count += 1;
};

interface Contrast {
  readonly luminance: number;
  readonly colour: number;
}

const NO_CONTRAST: Contrast = { luminance: 0, colour: 0 };

/**
 * The area against the ring of pixels around it, in one pass over the surrounding
 * rectangle: a pixel inside the area's box counts toward the area, one outside it counts
 * toward the ring.
 *
 * No contrast when either side has no pixels at all. A zero-width or zero-height area has
 * no interior to measure, and an area that fills the screenshot has no ring left once the
 * ring is clipped to the image — both are answered with zero rather than with an invented
 * number, because there is nothing in the image to compare.
 */
const contrastOf = (pixels: ScreenshotPixels, box: PixelRect, surround: PixelRect): Contrast => {
  if (isEmpty(box) || isEmpty(surround)) return NO_CONTRAST;

  const inside = emptySums();
  const around = emptySums();
  for (let y = surround.top; y < surround.bottom; y += 1) {
    const insideRows = y >= box.top && y < box.bottom;
    for (let x = surround.left; x < surround.right; x += 1) {
      addPixel(insideRows && x >= box.left && x < box.right ? inside : around, pixels, x, y);
    }
  }
  if (inside.count === 0 || around.count === 0) return NO_CONTRAST;

  const deltaLuminance = inside.luminance / inside.count - around.luminance / around.count;
  const deltaRedGreen = inside.redGreen / inside.count - around.redGreen / around.count;
  const deltaYellowBlue = inside.yellowBlue / inside.count - around.yellowBlue / around.count;
  const opponentDistance = Math.sqrt(
    deltaRedGreen * deltaRedGreen + deltaYellowBlue * deltaYellowBlue,
  );

  return {
    luminance: clampUnit(Math.abs(deltaLuminance)),
    colour: clampUnit(opponentDistance / MAX_OPPONENT_DISTANCE),
  };
};

/**
 * How much of the page the area occupies, read as the area's side rather than as its area:
 * the square root of the share.
 *
 * A button is a thousandth of a long page, and a term that answered 0.001 where its five
 * neighbours answer tenths would be a term with its weight already set to nearly zero. The
 * square root puts it on the same scale as the others and keeps the order — bigger is still
 * bigger — which is all the term is asked for.
 */
const relativeAreaOf = (bbox: BoundingBox, page: PageBox): number =>
  clampUnit(
    Math.sqrt((Math.max(bbox.width, 0) * Math.max(bbox.height, 0)) / (page.width * page.height)),
  );

/** The area's centre as a 0..1 share of the page, clamped: a box may hang off an edge. */
const centreShareOf = (bbox: BoundingBox, page: PageBox): { x: number; y: number } => ({
  x: clampUnit((bbox.x + bbox.width / 2) / page.width),
  y: clampUnit((bbox.y + bbox.height / 2) / page.height),
});

/**
 * 1 at the page's centre, 0 at a corner: the distance from the centre as a share of the
 * distance from the centre to a corner.
 *
 * Stated apart from the top bias on purpose. The two priors disagree — a page's centre is
 * below its top — and #7 wants them fitted separately rather than rolled into one position
 * term whose shape calibration could not change.
 */
const centreBiasOf = (centre: { x: number; y: number }): number => {
  const offsetX = centre.x * 2 - 1;
  const offsetY = centre.y * 2 - 1;
  return clampUnit(1 - Math.sqrt(offsetX * offsetX + offsetY * offsetY) / Math.SQRT2);
};

/**
 * The highest role prior any role and any persona could reach, so the term can be stated as
 * a share of it.
 *
 * `rolePriorFor` answers a relative weight rather than a 0..1 share — a button's prior
 * scaled by a familiar persona's `rolePriorScale` is above 1 with the default configuration
 * — and the terms have to be comparable with each other for the weighted mean to mean
 * anything. Dividing by the reachable maximum keeps the term on 0..1 *and* keeps it
 * monotonic in familiarity, which clamping at 1 would not: a clamped button prior would
 * stop widening its gap over a paragraph exactly where familiarity starts to matter.
 *
 * The two factors are the two branches of `rolePriorFor`, not numbers chosen here: a prior
 * is either multiplied by the persona's scale (a conventional control) or left exactly as
 * it is (everything else), so the highest prior in the table times the larger of those two
 * is reachable and nothing above it is. Were the scale fitted below 1 at both ends, the
 * unscaled branch would still be the maximum, which is why it cannot be dropped.
 */
const maxRolePriorOf = (config: EngineConfig): number => {
  const ends = [config.persona.rolePriorScale.atZero, config.persona.rolePriorScale.atOne].filter(
    (end) => Number.isFinite(end),
  );
  const priors = Object.values(config.salience.rolePriors).filter((prior) =>
    Number.isFinite(prior),
  );
  return Math.max(0, ...priors) * Math.max(1, ...ends);
};

const rolePriorTermOf = (
  role: string | null,
  traits: PersonaTraits,
  config: EngineConfig,
): number => {
  const highest = maxRolePriorOf(config);
  return highest > 0 ? clampUnit(rolePriorFor(role, traits, config) / highest) : 0;
};

/**
 * The weighted mean of the terms: the weighted sum over the total weight.
 *
 * Normalising is what makes the value comparable rather than merely ordered — the sampler
 * reads it in `exp(alpha·salience + …)`, and a salience that grew with the number of terms
 * switched on would quietly rescale `alpha`. The divisor is the total *magnitude*, so the
 * range survives a negative weight if calibration ever fits one, and zeroing a weight takes
 * its term out of both the sum and the divisor: the remaining terms keep the values they
 * had.
 *
 * Every weight zero is 0 rather than a division by zero — a caller that switched off every
 * term asked for no bottom-up salience at all, which is a legitimate thing to ask for and is
 * how `tests/salience.test.ts` reads one term at a time.
 *
 * Two things calibration (#11) should know about the divisor. Scaling every weight by the
 * same factor changes nothing here, by design: the overall scale of bottom-up salience is
 * `alpha`'s to carry, so that one direction is not this object's to fit. And weights that
 * are *all* negative leave every area at 0, because the value is clamped at the bottom of
 * its range — an all-negative fit is a sign that belongs on `alpha`, not on six terms.
 */
const combine = (terms: SalienceTerms, config: EngineConfig): number => {
  const weights = config.salience.weights;
  let weighted = 0;
  let total = 0;
  for (const term of SALIENCE_TERMS) {
    const weight = weights[term];
    if (!Number.isFinite(weight)) continue;
    weighted += weight * terms[term];
    total += Math.abs(weight);
  }
  return total > 0 ? clampUnit(weighted / total) : 0;
};

const areaSalienceOf = (
  aoi: Aoi,
  pixels: ScreenshotPixels,
  page: PageBox,
  traits: PersonaTraits,
  config: EngineConfig,
): AreaSalience => {
  /**
   * A page with no extent is a capture that cannot be measured, so the geometry terms are
   * zero and the role prior still stands. The alternative is a `NaN` reaching the sampler's
   * softmax, where it would take every area's probability down with it.
   */
  const measurable = hasExtent(page);
  const centre = measurable ? centreShareOf(aoi.bbox, page) : null;
  const box = measurable ? boxInPixels(aoi.bbox, page, pixels) : null;
  const contrast =
    box === null ? NO_CONTRAST : contrastOf(pixels, box, surroundOf(box, pixels, config));

  const terms: SalienceTerms = {
    luminanceContrast: contrast.luminance,
    colourContrast: contrast.colour,
    relativeArea: measurable ? relativeAreaOf(aoi.bbox, page) : 0,
    centreBias: centre === null ? 0 : centreBiasOf(centre),
    topBias: centre === null ? 0 : clampUnit(1 - centre.y),
    rolePrior: rolePriorTermOf(aoi.role, traits, config),
  };

  return { salience: combine(terms, config), terms };
};

/**
 * The screenshot, decoded once.
 *
 * The one place this package hands bytes to `sharp`. A caller that scores several personas
 * over one capture calls this once and passes the result back in through
 * `SalienceInput.screenshot`, so a run of twenty-four sessions decodes each capture once.
 */
export const readScreenshotPixels = async (screenshot: Uint8Array): Promise<ScreenshotPixels> => {
  const { data, info } = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
};

/**
 * Bottom-up salience per area, with the terms each value came from, keyed on the area's id.
 *
 * Areas are scored independently, so the answer does not depend on the order they arrive in;
 * two areas sharing an id are one entry, which `buildAois` does not produce.
 */
export const salienceTermsByArea = async (
  input: SalienceInput,
): Promise<Map<string, AreaSalience>> => {
  const config = input.config ?? defaultEngineConfig;
  const pixels =
    input.screenshot instanceof Uint8Array
      ? await readScreenshotPixels(input.screenshot)
      : input.screenshot;

  const byArea = new Map<string, AreaSalience>();
  for (const aoi of input.aois) {
    byArea.set(aoi.id, areaSalienceOf(aoi, pixels, input.page, input.traits, config));
  }
  return byArea;
};

/** The same, as the one bounded 0..1 value per area the sampler weighs against relevance. */
export const salienceByArea = async (input: SalienceInput): Promise<Map<string, number>> => {
  const byArea = await salienceTermsByArea(input);
  return new Map([...byArea].map(([id, area]) => [id, area.salience]));
};
