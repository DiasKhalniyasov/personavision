/**
 * The random-fixation baseline: fixations drawn uniformly over the image, with dwells from a
 * stated distribution — the floor any working engine must clear.
 *
 * **What it is evidence of.** Nothing about a predictor except that it is doing *something*.
 * Beating it is a floor, not a result: a predictor that cannot beat uniform noise is broken,
 * and one that beats it has shown only that it found structure of some kind. The number a
 * sceptical reader wants is the margin over the centre-bias prior
 * ([`./centre-bias.ts`](./centre-bias.ts)), which is hard to beat.
 *
 * It is also the measured chance level for metrics that have no analytic one: #84 states that
 * ScanMatch's chance depends on the grid, the two lengths and the human's own spread rather
 * than being one constant, and this baseline is what measures it on the corpus a figure is
 * actually quoted from (#88).
 *
 * Seeded through the contract's `createSeededRandom`, as everything in this project samples:
 * the same seed gives byte-identical fixations in every process and on every platform, which
 * is what lets #88 report a figure twice and #90 replay a fit.
 */

import { createSeededRandom } from '@personavision/contract';
import type { Fixation, Prediction, Predictor, Scanpath } from '../types.js';
import { MAP_RENDERING, renderSaliencyMap } from './render-map.js';

/** The dwell distribution a baseline's fixations are drawn from. */
export interface DwellDistribution {
  /** The log-normal's median in milliseconds. */
  readonly medianMs: number;
  /** Its standard deviation in log space. */
  readonly logSigma: number;
  /** The draw is clamped to this floor. */
  readonly minMs: number;
  /** And to this ceiling. */
  readonly maxMs: number;
}

/** How many fixations a baseline's scanpath holds, how long each dwells, and the gap. */
export interface BaselineScanpathShape {
  readonly fixations: number;
  readonly duration: DwellDistribution;
  /** Milliseconds between one fixation's end and the next one's onset. */
  readonly saccadeMs: number;
}

/**
 * The shape of a scanpath **both** baselines produce, as committed data with its reason.
 *
 * Shared on purpose, and shared from here because the floor is what defines it: neither how
 * long a baseline looked nor how many times it looked explains any part of the margin between
 * the two, so what is left is where each one looked and — on the saliency metrics — how
 * widely each one's map is blurred, which `docs/baselines.md` reports separately rather than
 * folding into the margin. It lives in this module rather than in a module of its own so
 * there is one place to read it, and the doc states the same numbers for a reader who never
 * opens the code.
 *
 * None of it is reachable by #90's fit: a baseline is a fixed reference point, and a
 * reference point that moved with the thing it measures would measure nothing. It is
 * nonetheless a **parameter** of every function below, so #88 and #90 can ask what a figure
 * would have been at another fixation count or dwell without editing this file.
 */
export const BASELINE_SCANPATH: Readonly<BaselineScanpathShape> = Object.freeze({
  /**
   * Ten fixations. At the dwell below plus a saccade that is about three seconds of free
   * viewing — the middle of the three cuts UEyes publishes (1 s, 3 s, 7 s) and the one three
   * of the committed corpus's four records state. The `Predictor` seam is `(image, seed)` and
   * never sees a record's `viewingDurationSeconds`, so the count is committed here with the
   * viewing duration it stands for rather than following the ground truth it is scored
   * against; #88 reports it as provenance beside the figure.
   */
  fixations: 10,
  /**
   * The dwell distribution: log-normal, the family fixation durations are published in,
   * with the numbers `packages/engine`'s `fixationDuration` defaults carry — a 250 ms median
   * inside the published 200–300 ms region, a 0.45 log standard deviation, clamped to the
   * 80–1200 ms a recorded fixation lies in. Shared with the engine so that a margin over a
   * baseline is a difference in where each one looked and not in how long it dwelled there.
   */
  duration: Object.freeze<DwellDistribution>({
    medianMs: 250,
    logSigma: 0.45,
    minMs: 80,
    maxMs: 1200,
  }),
  /**
   * The gap between one fixation's end and the next one's onset: 40 ms, the middle of the
   * 30–50 ms a saccade across a screen-sized image takes. It sets `tMs` and nothing else —
   * neither saliency metric nor scanpath metric reads a fixation's onset, they read its
   * position and its dwell — so it is stated for a reader of a scanpath rather than fitted.
   */
  saccadeMs: 40,
});

/**
 * How uniform the uniform baseline measurably is, over a fixed set of seeds.
 *
 * Stated as data because "uniform" is a claim a test has to be able to fail. The share of
 * fixations in each quadrant of the image is measured over the seeds `firstSeed …
 * firstSeed + seedCount - 1`, and `tolerance` is how far a quadrant may sit from its
 * expected quarter before the draw has stopped being uniform.
 *
 * Measured over the 128 seeds below, 1,280 fixations in all: the four quadrant shares run
 * from 0.2492 to 0.2516, the widest departure from a quarter being 0.0016. That figure is
 * exact rather than noisy — the seed set is committed, so the draw is the same on every run
 * and in every process. The tolerance is nonetheless 0.05, about four standard errors of a
 * quadrant share at this many samples (0.012): the claim is that the draw is uniform, not
 * that these 128 seeds are, so it has to survive a change of seed range, while a genuinely
 * skewed draw — a bad modulus, a forgotten `height` — misses by far more than 0.05.
 */
export const RANDOM_FIXATION_UNIFORMITY = Object.freeze({
  firstSeed: 1,
  seedCount: 128,
  /** What each of the four quadrants is expected to hold. */
  quadrantShare: 0.25,
  tolerance: 0.05,
} as const);

/**
 * One dwell in milliseconds, log-normal and clamped, from two draws of the seeded generator.
 *
 * Box–Muller turns the two uniforms into a standard normal, which the median scales by
 * `exp(logSigma · z)`; `1 - random()` keeps the logarithm's argument off zero, which a
 * generator returning exactly 0 would otherwise send to infinity. The clamp is the published
 * region a recorded fixation lies in, not a guard against a bug: a log-normal has no upper
 * bound and a 4-second fixation is not a fixation.
 */
export const sampleDurationMs = (
  random: () => number,
  duration: DwellDistribution = BASELINE_SCANPATH.duration,
): number => {
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const sampled = duration.medianMs * Math.exp(duration.logSigma * normal);
  return Math.min(duration.maxMs, Math.max(duration.minMs, sampled));
};

/**
 * The points turned into an ordered scanpath: a dwell drawn for each, and onsets that follow.
 *
 * The dwells are drawn **after** every position, one per point in order, so the draw order is
 * one statement a reader can check against a seed. `index` runs 0, 1, 2 … and `tMs` is the
 * onset from the start of viewing: the previous fixation's onset, its dwell, and one saccade.
 * `participantId` is `null`, because a predicted scanpath belongs to no participant.
 */
export const scanpathOf = (
  points: readonly { readonly x: number; readonly y: number }[],
  random: () => number,
  shape: BaselineScanpathShape = BASELINE_SCANPATH,
): Scanpath => {
  const fixations: Fixation[] = [];
  let onsetMs = 0;
  for (const [index, point] of points.entries()) {
    const durationMs = sampleDurationMs(random, shape.duration);
    fixations.push({ index, tMs: onsetMs, durationMs, x: point.x, y: point.y });
    onsetMs += durationMs + shape.saccadeMs;
  }
  return { participantId: null, fixations };
};

/**
 * The baseline: fixations drawn uniformly over the image, rendered into a map by the one
 * map-rendering function, with the display the image was shown at carried through.
 *
 * Uniform means uniform over the image's **pixels**: `x` is `random() · width` and so lies on
 * `[0, width)`, strictly inside the image as the map rendering requires. Every position is
 * drawn before any dwell is, so the two draws are separable in a seed.
 *
 * The map is the fixations spread by `MAP_RENDERING`'s kernel — the engine's own kernel —
 * rather than a flat field: a flat map would be a different baseline (chance for AUC-Judd by
 * construction) and would not answer "what does a predictor that looks in the wrong places
 * score?", which is the question this one exists for.
 */
export const randomFixationBaseline = ((image, seed): Prediction => {
  const random = createSeededRandom(seed);
  const points: { readonly x: number; readonly y: number }[] = [];
  for (let drawn = 0; drawn < BASELINE_SCANPATH.fixations; drawn += 1) {
    points.push({ x: random() * image.size.width, y: random() * image.size.height });
  }
  const scanpath = scanpathOf(points, random);

  return {
    saliencyMap: renderSaliencyMap(scanpath.fixations, image.size, MAP_RENDERING),
    scanpath,
    display: image.display,
  };
  // The `satisfies` is the assertion: this is the seam `src/types.ts` declares, and the
  // concrete return type is kept so a caller does not have to await a synchronous answer.
}) satisfies Predictor;
