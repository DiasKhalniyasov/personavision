/**
 * The agent's viewing history, and the inhibition of return the sampler reads off it.
 *
 * Salience and relevance are static terms: an area has them before anyone looks at the
 * screen. The history term is not — it is a property of the *sequence*, which is why it
 * lives beside the sampler (#67) rather than in a term module of its own. An area the
 * agent has just fixated carries a decaying penalty, so a scanpath does not sit on one
 * element; an area it is returning to deliberately — because the goal still points at it
 * and enough fixations have passed — is raised rather than suppressed.
 *
 * Two mechanisms, both parameterised in the engine's one configuration object under
 * `inhibitionOfReturn`, so the calibration step (#11) fits them as data:
 *
 * - **The run cap**, `immediateRepeatAllowance`: how many consecutive fixations one area
 *   may hold. An area that has just held that many is not a candidate for the next
 *   fixation at all, as long as the screen offers another one. It is a cap rather than a
 *   steep penalty because "the sampler does not fixate the same area twice in a row
 *   beyond the configured allowance" is a property of the output that #67's acceptance
 *   criteria assert, and a soft penalty only makes a long run unlikely.
 * - **The decaying penalty**, `penalty` and `decayPerFixation`: subtracted from the
 *   history term of an area with a fixation behind it, and worth half as much again with
 *   every further fixation on the default configuration, so the suppression wears off and
 *   a later return is possible. A deliberate return is the same magnitude with the sign
 *   turned around: the condition decides the direction, not a second number.
 *
 * `gamma` in `exp(alpha·salience + beta·relevance + gamma·history)` scales the whole
 * term, so raising it suppresses revisits harder and makes the deliberate ones stand out
 * more; it does not change which areas the cap holds.
 */

import type { EngineConfig } from '../config.js';
import { defaultEngineConfig } from '../config.js';

/**
 * One fixation the agent has already made this session.
 *
 * Declared as the least the history needs, and field-for-field a subset of the contract's
 * fixation, so the run loop (#44) hands over `session.fixations` as it stands with no
 * adapter and no copy. `aoiId` is `null` for a fixation that landed outside every area,
 * which breaks a run rather than extending one.
 */
export interface HistoryFixation {
  /** The session's ordering key: continuous across its screens, not restarted per screen. */
  readonly index: number;
  readonly tMs: number;
  readonly durationMs: number;
  readonly aoiId: string | null;
}

/** The fixations the agent has already made, in any order: `index` is what orders them. */
export type ViewingHistory = readonly HistoryFixation[];

/** What the sampler knows about one area's past when it draws the next fixation. */
export interface AreaHistory {
  /** Fixations on this area so far this session — a revisit count, once it is above one. */
  readonly fixationCount: number;
  /** How many fixations ago the last one on this area was: the previous fixation is 1. */
  readonly fixationsSince: number;
  /** Consecutive fixations on this area, ending at the last one on it. */
  readonly consecutive: number;
}

/** By `index`, the ordering key, so a caller's array order never reaches the sampler. */
export const inHistoryOrder = (history: ViewingHistory): HistoryFixation[] =>
  [...history].sort((left, right) => left.index - right.index);

/**
 * The history, read as what each area has behind it, keyed on the area's id.
 *
 * Only areas with a fixation behind them appear: an area no one has looked at has no
 * history, and `undefined` says so without a zero that would read like a measurement.
 */
export const historyByArea = (history: ViewingHistory): ReadonlyMap<string, AreaHistory> => {
  const inOrder = inHistoryOrder(history);
  const lastPosition = new Map<string, number>();
  const counts = new Map<string, number>();
  const runs = new Map<string, number>();

  inOrder.forEach((fixation, position) => {
    const { aoiId } = fixation;
    if (aoiId === null) return;
    const previous = lastPosition.get(aoiId);
    counts.set(aoiId, (counts.get(aoiId) ?? 0) + 1);
    runs.set(aoiId, previous === position - 1 ? (runs.get(aoiId) ?? 0) + 1 : 1);
    lastPosition.set(aoiId, position);
  });

  /**
   * Iterating `lastPosition` is iterating a `Map`, which JavaScript keeps in insertion
   * order: the answer is the same object every time for the same history. Each entry is
   * computed from that area's own numbers alone, so even the order it is built in cannot
   * reach the sampler, which only ever looks an id up.
   */
  const byArea = new Map<string, AreaHistory>();
  for (const [aoiId, position] of lastPosition) {
    byArea.set(aoiId, {
      fixationCount: counts.get(aoiId) ?? 0,
      fixationsSince: inOrder.length - position,
      consecutive: runs.get(aoiId) ?? 0,
    });
  }
  return byArea;
};

/**
 * Is this area in the middle of a run the allowance has used up?
 *
 * Only the area of the most recent fixation can be, so at most one area on a screen is
 * ever held — which is why the sampler can honour the cap and still always have a
 * candidate, as long as the screen has more than one area.
 */
export const heldByInhibition = (
  area: AreaHistory | undefined,
  config: EngineConfig = defaultEngineConfig,
): boolean =>
  area !== undefined &&
  area.fixationsSince === 1 &&
  area.consecutive >= config.inhibitionOfReturn.immediateRepeatAllowance;

/**
 * Is a look at this area now a deliberate return rather than an accident?
 *
 * Both halves of the condition have to hold: the goal still points at the area
 * (`deliberateReturnRelevance` against the relevance term, so "still points at it" is the
 * same number the sampler weighs with `beta`) and enough fixations have passed
 * (`deliberateReturnAfterFixations`). An area the agent keeps falling back onto because it
 * is big and bright is not returning to anything.
 */
export const isDeliberateReturn = (
  area: AreaHistory | undefined,
  relevance: number,
  config: EngineConfig = defaultEngineConfig,
): boolean =>
  area !== undefined &&
  area.fixationsSince >= config.inhibitionOfReturn.deliberateReturnAfterFixations &&
  relevance >= config.inhibitionOfReturn.deliberateReturnRelevance;

/**
 * The history term for one area: `0` with nothing behind it, negative while the
 * suppression lasts, positive when the return is deliberate.
 *
 * The magnitude is the configured penalty decayed by the distance since the last look, so
 * an area fixated two fixations ago is suppressed half as hard as one fixated last (on the
 * default decay), and a deliberate return — which by its condition is at least three
 * fixations later — is raised by what is left of it. The sampler multiplies this by
 * `gamma`.
 */
export const historyTermFor = (
  area: AreaHistory | undefined,
  relevance: number,
  config: EngineConfig = defaultEngineConfig,
): number => {
  if (area === undefined) return 0;
  const { penalty, decayPerFixation } = config.inhibitionOfReturn;
  const magnitude = penalty * decayPerFixation ** (area.fixationsSince - 1);
  return isDeliberateReturn(area, relevance, config) ? magnitude : -magnitude;
};
