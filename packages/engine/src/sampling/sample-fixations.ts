/**
 * `sampleFixations` — where the engine's terms become a scanpath.
 *
 * Everything before this module is a term: salience is what stands out (#65), relevance is
 * what the goal points at (#62), the distributions are what a human fixation looks like
 * (#63), and the persona-trait table is who is looking (#56). Here they are sampled into
 * the sequence a session stores: fixations with a point inside their area, a duration, a
 * time on the session clock and the id of the area they landed in, and the saccades that
 * join them.
 *
 * **The sampling rule, as #7 states it.** A fixation's area is drawn from
 * `P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)`, with `alpha`, `beta`
 * and `gamma` read from the resolved configuration — a run's `engine.weights` over the
 * defaults. Calibration (#11) changes behaviour by changing those weights, never by
 * changing this file: there is no tunable number written down here.
 *
 * **Inhibition of return** is in `./history.js`, because it is a property of the sequence
 * rather than a static term, and it is the only term this module recomputes as it goes.
 *
 * **The persona drives the sequence, not just the durations.** How many fixations the
 * screen gets is `fixationCountFor` (the `scanningVsReading` row) scaled by
 * `screenPersistenceScale` (the `persistence` row) — the count row says how many looks
 * this persona takes, and the persistence row is how long it keeps looking before it is
 * done with the screen, which on a screen with no clock of its own is measured in
 * fixations. Each duration is `drawFixationDurationMs`, and `dwellScale` scales a look at
 * an area the agent has already fixated this session, which is where an area's dwell
 * accumulates. So two personas on the same page with the same seed produce visibly
 * different scanpaths — the claim the product makes.
 *
 * **Determinism is the hard requirement.** One `createSeededRandom` from the contract,
 * threaded through every draw, consumed in a fixed order: for each fixation the area
 * (one value), its duration (two), its landing point (four), and then the gap to the next
 * fixation (two). Nothing here reaches for the platform's unseeded generator, nothing
 * decides anything by iterating a map's keys, and the areas are sorted by id before any of
 * it, so the order they arrive in cannot change a scanpath — the purity suite in
 * `packages/engine/tests/config.test.ts` fails the build if the first of those appears. The same
 * `{ aois, goal, persona, history, seed, weights }` therefore produces byte-identical
 * fixations and saccades, in this process and in any other.
 */

import type { Session } from '@personavision/contract';
import { createSeededRandom } from '@personavision/contract';
import type { EngineConfig, EngineConfigOverrides } from '../config.js';
import { defaultEngineConfig, resolveEngineConfig } from '../config.js';
import type { PersonaSamplingParams, PersonaTraits } from '../persona.js';
import { fixationCountFor, personaSamplingParams } from '../persona.js';
import type { RelevanceArea, RelevanceHints } from '../relevance.js';
import { relevanceByArea } from '../relevance.js';
import type { BoundingBox, Goal } from '../types.js';
import {
  drawFixationDurationMs,
  drawLandingPoint,
  saccadeDurationMsFor,
  nextFixationStart,
} from './distributions.js';
import type { AreaHistory, HistoryFixation, ViewingHistory } from './history.js';
import { heldByInhibition, historyByArea, historyTermFor, inHistoryOrder } from './history.js';

/**
 * An area the sampler can fixate: an id, a box to land in, and whatever words relevance
 * reads. Declared as the least this module needs, so both an `Aoi` as `buildAois` built it
 * (`label`, no text) and a `CaptureElement` (`name` and `text`) satisfy it structurally.
 */
export interface SamplerArea extends RelevanceArea {
  /** In page space, the space `run.json`'s `aois[].bbox` is in. */
  readonly bbox: BoundingBox;
}

/** A fixation, exactly as the contract's session records one. No field is this module's. */
export type SampledFixation = Session['fixations'][number];

/** A saccade, exactly as the contract's session records one. */
export type SampledSaccade = Session['saccades'][number];

/** What one screen's sampling answers: the two lists a session stores. */
export interface SampledScanpath {
  readonly fixations: readonly SampledFixation[];
  readonly saccades: readonly SampledSaccade[];
}

export interface SampleFixationsInput {
  /** The areas on this screen, as `buildAois` built them. An empty screen is allowed. */
  readonly aois: readonly SamplerArea[];
  /** The agent's current goal: relevance is lexical and role-based against its text. */
  readonly goal: Goal;
  /** The six traits as `run.json` records them; the trait table is read here, not there. */
  readonly persona: PersonaTraits;
  /**
   * The fixations the agent has already made this session, which is both what inhibition
   * of return reads and where this screen's `index` and clock continue from. Omitted means
   * the first screen of a session.
   */
  readonly history?: ViewingHistory;
  readonly seed: number;
  /**
   * The run's `engine.weights` — `alpha`, `beta` and `gamma` — over the engine's defaults.
   * An in-process caller may override deeper, which is what the tests and #11 do.
   */
  readonly weights?: EngineConfigOverrides;
  /**
   * Salience per area id, 0..1, as #65 computed it from the screenshot. The engine is pure
   * and this module takes no image: an area the salience module did not score contributes
   * nothing through `alpha`, rather than a guessed value, and omitting the map altogether
   * is the honest way to sample a screen whose screenshot was never read.
   */
  readonly salience?: ReadonlyMap<string, number>;
  /** A model's per-area relevance hints in model mode (#33); absent offline, which is the default. */
  readonly relevanceHints?: RelevanceHints;
  /** This screen's position in the session, for the fixation's `screenIndex`. Default 0. */
  readonly screenIndex?: number;
  /**
   * The screen's scroll offset, as the session's `screens[].scrollY` records it, so a
   * fixation's viewport coordinates are the page point seen through the scrolled viewport.
   * Default 0, which is a screen that was never scrolled.
   */
  readonly scrollY?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * How many fixations this screen gets for this persona.
 *
 * Two rows of the persona-trait table, and the only place they are composed: the count row
 * through `fixationCountFor`, then the persistence row, re-clamped to the configured
 * bounds so no trait combination asks for a screen with no fixations on it. The run loop
 * (#44) therefore does not spend `screenPersistenceScale` again on its own decision to
 * leave — the budget is here, where the looks are drawn.
 *
 * The count is the persona's and not a draw, so a persona's screens are all the same
 * length and `fixationsPerScreen.logSigma` — the spread the configuration advertises — is
 * consumed by nobody yet. Spending it needs a normal draw that `./distributions.js` does
 * not publish, which is #63's module and not this ticket's to widen; it is noted on #67
 * so calibration (#11) is not left fitting a number nothing reads.
 */
export const screenFixationCount = (
  traits: PersonaTraits,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { screenPersistenceScale } = personaSamplingParams(traits, config);
  const { min, max } = config.fixationsPerScreen;
  return Math.round(clamp(fixationCountFor(traits, config) * screenPersistenceScale, min, max));
};

/**
 * One draw over the areas: the softmax above, as a cumulative walk in the order the areas
 * were given. Consumes exactly one value from the generator.
 *
 * The largest exponent is subtracted before `exp`, so a weight this screen's terms make
 * large cannot overflow to `Infinity` and leave the walk with a `NaN` to compare against;
 * subtracting a constant is the one operation a softmax is invariant under.
 */
const drawArea = (
  candidates: readonly SamplerArea[],
  logits: readonly number[],
  rng: () => number,
): SamplerArea => {
  const highest = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - highest));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const threshold = rng() * total;

  let walked = 0;
  for (const [position, weight] of weights.entries()) {
    walked += weight;
    if (threshold < walked) return candidates[position];
  }
  /** Reached only by floating-point accumulation falling a hair short of the total. */
  return candidates[candidates.length - 1];
};

/** The duration of one look, with the dwell row applied where dwell accumulates. */
const drawDuration = (
  area: AreaHistory | undefined,
  persona: PersonaSamplingParams,
  rng: () => number,
  config: EngineConfig,
): number => {
  const drawn = drawFixationDurationMs(persona, rng, config);
  if (area === undefined) return drawn;
  const { minMs, maxMs } = config.fixationDuration;
  return clamp(drawn * persona.dwellScale, minMs, maxMs);
};

/**
 * Sample one screen's fixations and saccades.
 *
 * Pure: the same input always answers the same scanpath, and nothing here reads a file,
 * opens a socket or calls a model. A screen with no areas answers no fixations and no
 * saccades — a fixation with no area it landed in would be a number no one measured — and
 * a screen with one area gives every fixation to it, the run cap having nowhere else to
 * send them. An area the sampler never selected simply does not appear.
 */
export const sampleFixations = (input: SampleFixationsInput): SampledScanpath => {
  const { config } = resolveEngineConfig(input.weights);
  const { goal, persona: traits } = input;
  if (input.aois.length === 0) return { fixations: [], saccades: [] };

  /**
   * By id, so that the order the areas arrive in cannot reach the sampling: the draw
   * below walks the areas in order, and a caller handing over DOM order where another
   * handed over reading order would otherwise get a different scanpath from the same
   * seed. Sorting on the ids is what makes "the same seed, persona, page and goal" a
   * statement about the page rather than about the array.
   */
  const aois = [...input.aois].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  const persona = personaSamplingParams(traits, config);
  const relevance = relevanceByArea({ areas: aois, goal, hints: input.relevanceHints, config });
  const relevanceOf = (area: SamplerArea): number =>
    relevance.get(area.id) ?? config.relevance.floor;
  /**
   * A salience value is another module's output, and an area with no interior or no
   * variance is an easy source of a `NaN`: one of those reaching `exp` would make every
   * weight on the screen `NaN` and the walk below would stop choosing anything at all.
   * So it is brought into range here rather than trusted, exactly as `relevance.ts` does
   * with a model's hints — the softmax is no place to find out.
   */
  const salienceOf = (area: SamplerArea): number => {
    const value = input.salience?.get(area.id);
    return value === undefined || !Number.isFinite(value) ? 0 : clamp(value, 0, 1);
  };

  const rng = createSeededRandom(input.seed);
  const screenIndex = input.screenIndex ?? 0;
  const scrollY = input.scrollY ?? 0;
  const count = screenFixationCount(traits, config);

  /**
   * The session's fixations so far, this screen's included as they are drawn: inhibition
   * of return reads the sequence and not the screen, so an area fixated at the end of the
   * previous screen is still suppressed at the start of this one.
   */
  const seen: HistoryFixation[] = inHistoryOrder(input.history ?? []);
  const last = seen.at(-1);
  const firstIndex = last === undefined ? 0 : last.index + 1;

  const fixations: SampledFixation[] = [];
  const saccades: SampledSaccade[] = [];

  for (let drawn = 0; drawn < count; drawn += 1) {
    /**
     * Recomputed per fixation rather than carried as state: a session is hundreds of
     * fixations, so the scan is cheaper than a running total would be to keep right, and
     * it cannot drift from the history the sampler was handed.
     */
    const byArea = historyByArea(seen);
    const free = aois.filter((area) => !heldByInhibition(byArea.get(area.id), config));
    /**
     * The cap only ever holds the area of the most recent fixation, so a screen with more
     * than one area always has a candidate left. A screen with exactly one area has
     * nowhere else to send the look, and the area holds every fixation.
     */
    const candidates = free.length > 0 ? free : aois;

    const logits = candidates.map(
      (area) =>
        config.alpha * salienceOf(area) +
        config.beta * relevanceOf(area) +
        config.gamma * historyTermFor(byArea.get(area.id), relevanceOf(area), config),
    );

    const area = drawArea(candidates, logits, rng);
    const durationMs = drawDuration(byArea.get(area.id), persona, rng, config);
    const point = drawLandingPoint(area.bbox, rng, config);

    const previous = fixations.at(-1);
    const amplitudePx =
      previous === undefined
        ? null
        : Math.hypot(point.x - previous.pageX, point.y - previous.pageY);
    const saccadeDurationMs = amplitudePx === null ? 0 : saccadeDurationMsFor(amplitudePx, config);

    /**
     * The first fixation of a session starts the clock at zero. Every later one is a gap
     * after the fixation before it, including the first of a new screen: there the gap is
     * drawn with no saccade to account for, because the two landing points are on
     * different screens and the jump between them is not this screen's to measure.
     */
    const previousClock = seen.at(-1);
    const tMs =
      previousClock === undefined
        ? 0
        : nextFixationStart(previousClock, saccadeDurationMs, rng, config).tMs;

    const index = firstIndex + drawn;
    const fixation: SampledFixation = {
      index,
      screenIndex,
      tMs,
      durationMs,
      /**
       * Viewport space is page space seen through the scroll offset. The contract's
       * coordinates are pixels and never negative, so a point above the scroll position —
       * which a caller passing an area the screen had scrolled past would be asking for —
       * reads as the top edge rather than as a negative number.
       */
      x: Math.max(point.x, 0),
      y: Math.max(point.y - scrollY, 0),
      pageX: Math.max(point.x, 0),
      pageY: Math.max(point.y, 0),
      aoiId: area.id,
    };

    fixations.push(fixation);
    seen.push(fixation);
    if (previous !== undefined && amplitudePx !== null) {
      saccades.push({
        fromFixation: previous.index,
        toFixation: index,
        amplitudePx,
        durationMs: saccadeDurationMs,
      });
    }
  }

  return { fixations, saccades };
};
