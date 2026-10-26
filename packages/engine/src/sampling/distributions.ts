/**
 * The seeded draws that make a sequence of chosen areas look like a human looking.
 *
 * Choosing *which* area is fixated is the sampler's job (#67); this module answers how
 * long a fixation lasts, how far and how long the jump between two of them is, when the
 * next one starts, and where inside an area the gaze actually lands. Dwell-based metrics
 * mean nothing unless these are human-like rather than uniform, and a heatmap looks fake
 * unless a fixation lands at a point inside its area rather than at the area's centre.
 *
 * Every number these draws use comes from the engine's one configuration object
 * (`packages/engine/src/config.ts`), so the calibration step (#11) fits them as data: a
 * tunable constant written inline here would be a number calibration cannot reach.
 *
 * **Determinism.** Each draw is a pure function of its inputs, the persona's sampling
 * parameters and the generator it is handed — `createSeededRandom` from
 * `packages/contract`. Nothing here reaches for the platform's unseeded generator and
 * nothing holds a generator at module level; the purity suite in
 * `packages/engine/tests/config.test.ts` fails the build if either appears. Each draw
 * consumes a documented, fixed number of values from the generator, so two runs on the
 * same seed produce byte-identical sequences.
 */

import type { EngineConfig } from '../config.js';
import { defaultEngineConfig } from '../config.js';
import type { PersonaSamplingParams } from '../persona.js';
import type { BoundingBox } from '../types.js';

/** A point in the same space as the box it was drawn in — page space for an area. */
export interface LandingPoint {
  readonly x: number;
  readonly y: number;
}

/** The part of a fixation the clock needs: the session-relative fields of the artifact. */
export interface FixationClock {
  readonly tMs: number;
  readonly durationMs: number;
}

/** When the next fixation starts, and the gap the saccade crossed to get there. */
export interface NextFixationStart {
  readonly tMs: number;
  /** End of the previous fixation to the start of this one. Always above the saccade. */
  readonly gapMs: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * `mulberry32` returns a multiple of 2⁻³², so this is its smallest non-zero value: the
 * floor that keeps `Math.log` finite when a draw happens to return exactly zero.
 */
const RNG_GRANULARITY = 2 ** -32;

/**
 * One standard normal value, Box–Muller, consuming **exactly two** values from the
 * generator and discarding the second of the pair it could produce.
 *
 * Discarding half the pair costs a draw and buys determinism that survives refactoring:
 * caching the spare would make a draw's result depend on how many normals the *caller*
 * asked for earlier, which is exactly the kind of hidden state that breaks a seeded
 * sequence when the sampler is reordered.
 */
const standardNormal = (rng: () => number): number => {
  const u1 = Math.max(rng(), RNG_GRANULARITY);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

/** A log-normal with the stated median: `exp(ln(median) + sigma·z)`. Two rng values. */
const logNormal = (medianValue: number, logSigma: number, rng: () => number): number =>
  medianValue * Math.exp(logSigma * standardNormal(rng));

/**
 * How long one fixation lasts, in milliseconds. Two rng values.
 *
 * Log-normal — the shape fixation durations have in the literature: positive and
 * right-skewed, with a long tail of a few long looks rather than a symmetric spread.
 * `config.fixationDuration.medianMs` is the median before persona scaling and sits in the
 * published 200–300 ms region; `logSigma` is the spread in log space.
 *
 * The persona scales the draw by `fixationDurationScale`, which is the same thing as
 * scaling the median (a log-normal scaled by *s* is a log-normal with median *s*·median),
 * so a scanning persona's median duration is the reading persona's times the ratio the
 * persona-trait table states — 0.75/1.25 on the default configuration. `dwellScale` is
 * deliberately not applied: it is how long the gaze stays *within an area*, which the
 * sampler applies where dwell accumulates, and multiplying it in here would count
 * `detailOrientation` and `patience` twice (see `packages/engine/src/persona.ts`).
 *
 * Clamped to `[minMs, maxMs]`, so no seed and no trait combination yields a fixation of
 * zero length or one that lasts a second and a half. The clamp bites in the tails only,
 * well beyond two sigma on the defaults, and therefore does not move the median.
 */
export const drawFixationDurationMs = (
  persona: PersonaSamplingParams,
  rng: () => number,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { medianMs, logSigma, minMs, maxMs } = config.fixationDuration;
  const drawn = logNormal(medianMs, logSigma, rng) * persona.fixationDurationScale;
  return clamp(drawn, minMs, maxMs);
};

/**
 * How far one saccade jumps, in pixels. Two rng values.
 *
 * Log-normal again, and for the same reason: most jumps are short, a few cross the page.
 * The value is always positive, and over many seeds stays inside
 * `medianPx · exp(±5·logSigma)` — the five-sigma band, which on the defaults is 9 px to
 * 3615 px.
 *
 * The sampler does not need this to time a saccade between two fixations it has already
 * placed: there the amplitude is the distance between the two landing points, geometry
 * rather than a draw, and `saccadeDurationMsFor` turns it into a duration. This draw is
 * for the paths that have no geometry to measure — `predict()` on a bare screenshot
 * (#68) and the calibration step fitting the amplitude distribution itself.
 */
export const drawSaccadeAmplitudePx = (
  rng: () => number,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { medianPx, logSigma } = config.saccade.amplitude;
  return logNormal(medianPx, logSigma, rng);
};

/**
 * How long a saccade of this amplitude takes, in milliseconds. No rng: the relationship
 * between amplitude and duration is a deterministic one, not a draw.
 *
 * A longer jump takes longer — the main sequence, which is roughly affine over the range
 * a screen offers: `baseMs + msPerPixel · amplitude`, clamped to `[minMs, maxMs]`. Both
 * the slope and the bounds are configuration, so calibration fits the relationship
 * without a code change. On the defaults a duration is 20 ms to 120 ms and rises with
 * amplitude up to 4000 px, beyond which the upper clamp holds it; a negative amplitude
 * cannot lower it below `minMs`.
 */
export const saccadeDurationMsFor = (
  amplitudePx: number,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { baseMs, msPerPixel, minMs, maxMs } = config.saccade.duration;
  return clamp(baseMs + msPerPixel * amplitudePx, minMs, maxMs);
};

/**
 * When the fixation after this one starts, on the session clock. Two rng values.
 *
 * The gap between the end of one fixation and the start of the next is drawn from a
 * normal around `config.interFixation.gapMs`, and the saccade accounts for part of it:
 * the gap is never shorter than the saccade's own duration plus `minGapMs`, the
 * non-saccadic remainder (the time the eye is neither in flight nor yet settled). So
 * `saccadeDurationMs / gapMs` is always a share strictly between zero and one, and
 * because the gap and the fixation's duration are both positive, `tMs` is strictly
 * increasing along a session.
 */
export const nextFixationStart = (
  previous: FixationClock,
  saccadeDurationMs: number,
  rng: () => number,
  config: EngineConfig = defaultEngineConfig,
): NextFixationStart => {
  const { gapMs, gapSigmaMs, minGapMs } = config.interFixation;
  const drawn = gapMs + gapSigmaMs * standardNormal(rng);
  const gap = Math.max(drawn, saccadeDurationMs + minGapMs);
  return { tMs: previous.tMs + previous.durationMs + gap, gapMs: gap };
};

/**
 * Where inside an area the gaze lands. Four rng values (two per axis, x first).
 *
 * Centre-weighted but never the centre itself: an independent normal per axis, with a
 * standard deviation of `config.landing.spreadShare` of the box's half-extent, so the
 * spread scales with the box and a page-sized area spreads across the page while a
 * 20 px button does not. On the default share of 0.25 the box's edge is four sigma out,
 * which is why the result looks like a blob rather than a clipped square.
 *
 * The point is always **strictly inside** the box: each axis is clamped to stay
 * `minInsetPx` from the edges, and for a box narrower than four times that inset — a
 * 1×1 box, where a 1 px inset would leave no room at all — the inset shrinks to a quarter
 * of the extent, which still leaves the point strictly inside. A box with a zero extent
 * on an axis has no interior to land in, and the box's own coordinate is returned on that
 * axis.
 *
 * No persona scaling: nothing in the persona-trait table says where within an element a
 * given agent looks, and inventing a row here would be a number calibration has no data
 * to fit.
 */
export const drawLandingPoint = (
  box: BoundingBox,
  rng: () => number,
  config: EngineConfig = defaultEngineConfig,
): LandingPoint => {
  const { spreadShare, minInsetPx } = config.landing;

  const onAxis = (origin: number, extent: number, z: number): number => {
    if (extent <= 0) return origin;
    const inset = Math.min(minInsetPx, extent / 4);
    const centre = origin + extent / 2;
    return clamp(centre + z * (extent / 2) * spreadShare, origin + inset, origin + extent - inset);
  };

  /**
   * Both normals are drawn before either is placed, so the order in which the generator
   * is consumed is x then y and does not depend on a box's shape.
   */
  const zx = standardNormal(rng);
  const zy = standardNormal(rng);
  return { x: onAxis(box.x, box.width, zx), y: onAxis(box.y, box.height, zy) };
};
