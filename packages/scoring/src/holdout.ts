import type { Audience, HoldoutFigures, HoldoutVerdict } from '@personavision/contract';
import { goalPhrase } from './audienceSentence.js';
import { bandsDisjoint, type Band } from './bands.js';
import type { VariantScore } from './score.js';

/**
 * The holdout line: did the people the change was never chosen against move with the rest?
 *
 * Path 2 runs the baseline and the pull request's version on the same audience and the
 * same seeds, **plus a holdout generated from that audience on seeds the change was never
 * chosen against** (`docs/FLOW.md` section 15, points 4 and 5). Nothing about the A/B
 * comparison changes; what is added here is one judgement on top of it, and the sentence
 * that states it.
 *
 * **The same standard, not a second weaker one.** A gain is real when the ± 1σ bands came
 * apart and the seed groups agreed, and that is exactly what is asked of both halves of
 * this judgement: the original seeds' half is the verdict's own `bandsDisjoint` and seed
 * group agreement, passed in rather than recomputed, and the holdout's half is the same
 * `bandsDisjoint` applied to the holdout's own figures. The holdout is one set of seeds
 * and so has no seed groups to agree among themselves — it is the second opinion, not a
 * second run — which is why the group half of the rule is the run's and the band half is
 * the holdout's.
 *
 * **The holdout is small** — a share of the participants today (`HOLDOUT_SHARE` in
 * `@personavision/personas`), a fixed 20 under #318 — so bands that overlap are the common
 * case rather than a rarity, and more so the smaller it gets. A holdout that cannot
 * separate the two versions has not found against the change: it is `null` — *the holdout
 * could not judge* — and never `false`, because reporting "not confirmed" on too few
 * people is a false accusation against a change that may be fine. Nothing here reads the
 * size: the judgement is made from the people the figures were measured on, whatever that
 * number turns out to be.
 *
 * Pure: contract types only, no disk, no network, no browser.
 */

/** Which variant is the site as it is and which is the pull request's, by their run ids. */
export interface ChangeUnderTest {
  readonly baselineVariant: string;
  readonly changeVariant: string;
}

/** What the verdict needs from the holdout, and what the Improve screen renders from it. */
export interface HoldoutLine {
  /** The contract's three spellings. `none` covers both "no holdout" and "could not judge". */
  readonly verdict: HoldoutVerdict;
  /** `true`, `false`, or `null` when no holdout ran or it could not judge. */
  readonly confirmed: boolean | null;
  /** The reason line about the holdout, or `null` when no holdout ran and there is none. */
  readonly reason: string | null;
  /** The verdict's audience-facing sentence, holdout and all. */
  readonly audienceSentence: string;
}

/**
 * What the change did on the seeds it was chosen on, by the verdict's own bands and
 * seed-group agreement — the half of the standard this function does not recompute.
 *
 * The two ways of not winning are kept apart because they are different sentences: a run
 * whose bands overlapped did not separate the two versions, and a run that separated them
 * and left the change behind is a change that did not come out ahead. Telling the second
 * one that nothing separated would be untrue.
 */
export type OnTheOriginalSeeds = 'won' | 'did-not-separate' | 'not-ahead';

export interface HoldoutInput {
  /** One row per variant × task, as `score()` returns them; the holdout figures are on them. */
  readonly scores: readonly VariantScore[];
  readonly change: ChangeUnderTest;
  /**
   * What the change did on the original seeds. The holdout confirms a gain or fails to;
   * with no gain of its own this run has nothing for it to confirm.
   */
  readonly onTheOriginalSeeds: OnTheOriginalSeeds;
  /** The headline the verdict would carry if no holdout had run. */
  readonly headline: string;
  readonly audience: Audience;
}

/** The holdout's people on one side of the comparison, summed over the run's tasks. */
interface HoldoutSide {
  readonly success: number;
  readonly scored: number;
}

const people = (count: number): string => `${count} ${count === 1 ? 'person' : 'people'}`;

/** A friction score is points out of 100, and so is a completion rate read as a band. */
const onScale = (value: number): number => Math.min(Math.max(value, 0), 100);

/**
 * A completion rate's ± 1σ band, in points, so the holdout is judged by `bandsDisjoint` —
 * the same function, the same strictness — rather than by a threshold invented here.
 *
 * σ is the spread of a share over the people behind it, `sqrt(p(1-p)/n)`: on 20 people a
 * few points apart the bands overlap and the holdout has not judged anything, which is the
 * honest reading of a holdout that size and the reason `null` is a main path.
 *
 * **The share is counted with one more success and one more failure than were seen**, so a
 * holdout everybody or nobody finished on has a band and not a point. Taken literally,
 * `sqrt(p(1-p)/n)` is exactly zero at 0 and at 1, and `bandsDisjoint` is strict: 20 of 20
 * against 19 of 20 would come apart and the product would report *not confirmed* over one
 * person — the false accusation this function exists to avoid. The two added observations
 * say what twenty people cannot: that the next one could go either way. They move the band
 * and nothing else; no figure printed anywhere is this number.
 */
const completionBand = ({ success, scored }: HoldoutSide): Band => {
  const people = scored + 2;
  const rate = (success + 1) / people;
  const sd = Math.sqrt((rate * (1 - rate)) / people) * 100;
  return { low: onScale(rate * 100 - sd), high: onScale(rate * 100 + sd) };
};

/** One variant's holdout figures, by the task they were measured on. */
const holdoutByTask = (
  scores: readonly VariantScore[],
  variant: string,
): Map<string, HoldoutFigures> => {
  const byTask = new Map<string, HoldoutFigures>();
  for (const score of scores) {
    if (score.variant === variant && score.holdout !== undefined) {
      byTask.set(score.taskId, score.holdout);
    }
  }
  return byTask;
};

/** The holdout's two sides, when there is a pair of them to compare. */
interface HoldoutPair {
  readonly before: HoldoutSide;
  readonly after: HoldoutSide;
}

/**
 * The holdout's figures on the two versions, summed over the tasks **both** of them were
 * measured on.
 *
 * A run has one row per variant × task and the holdout is one set of people, so the line
 * the Improve screen prints is their figures over the run. Only tasks measured on both
 * sides are summed — the rule `seedGroupAgreement` already applies to seeds — because a
 * baseline figure from one task against a change figure from another is not a before and
 * after of anything. `null` when the two sides share no task, which is a holdout with
 * nothing to compare.
 */
const holdoutPairOf = (
  scores: readonly VariantScore[],
  { baselineVariant, changeVariant }: ChangeUnderTest,
): HoldoutPair | null => {
  const before = holdoutByTask(scores, baselineVariant);
  const after = holdoutByTask(scores, changeVariant);
  const sides = { before: { success: 0, scored: 0 }, after: { success: 0, scored: 0 } };
  for (const [taskId, beforeFigures] of before) {
    const afterFigures = after.get(taskId);
    if (afterFigures === undefined) continue;
    for (const [side, figures] of [
      ['before', beforeFigures],
      ['after', afterFigures],
    ] as const) {
      sides[side].success += figures.outcomeCounts.success;
      sides[side].scored += figures.scoredSessionCount;
    }
  }
  return sides.before.scored > 0 && sides.after.scored > 0 ? sides : null;
};

/** Whether this run measured a holdout at all, on either of the two versions. */
const ranAHoldout = (scores: readonly VariantScore[], change: ChangeUnderTest): boolean =>
  scores.some(
    (score) =>
      score.holdout !== undefined &&
      (score.variant === change.baselineVariant || score.variant === change.changeVariant),
  );

/** The prototype's words for a holdout that moved with the rest of the audience. */
const CONFIRMED_REASON =
  'The holdout moved with them, so the gain is the change and not the swarm agreeing with itself.';

/**
 * The headline when the holdout did not move with them.
 *
 * It **replaces** the headline rather than being appended to it: a sentence that states
 * the gain and then takes it back in a second sentence reads as a gain with a caveat, and
 * the one thing a not-confirmed result must not read as is a gain. The shape is the one
 * the verdict already uses for a result that did not separate — the finding, then the
 * `but`, then what that leaves — so the two non-results read alike.
 */
const notConfirmedHeadline = (
  audience: Audience,
  { baselineVariant, changeVariant }: ChangeUnderTest,
  held: number,
): string =>
  `${audience.name} ${goalPhrase(audience)} more easily on ${changeVariant} than on ${baselineVariant}, but the ${people(held)} the change was never chosen against did not move with them: this gain is not confirmed.`;

/** A holdout that judged nothing, in the user's words and as a `null` confirmation. */
const couldNotJudge = (headline: string, because: string): HoldoutLine => ({
  verdict: 'none',
  confirmed: null,
  reason: `The holdout could not judge: ${because}.`,
  audienceSentence: `${headline} The holdout could not judge: ${because}.`,
});

/**
 * The holdout's judgement on this run, and the sentence that states it.
 *
 * Three answers and no fourth: **confirmed** when the change wins on the original seeds
 * and on the holdout, **not confirmed** when it wins on the original seeds and the holdout
 * went the other way, and **none** when no holdout ran — the path-1 case, which is the
 * normal one. A holdout that ran and could not separate the two versions is `confirmed:
 * null` and reads as `none` as well: it reported no verdict, and the sentence says why.
 *
 * The friction score is not touched here. The holdout's figures are read and nothing about
 * them is scored differently.
 */
export const judgeHoldout = ({
  scores,
  change,
  onTheOriginalSeeds,
  headline,
  audience,
}: HoldoutInput): HoldoutLine => {
  if (!ranAHoldout(scores, change)) {
    return { verdict: 'none', confirmed: null, reason: null, audienceSentence: headline };
  }
  const pair = holdoutPairOf(scores, change);
  if (pair === null) {
    return couldNotJudge(
      headline,
      'it was measured on only one of the two versions, so there is nothing to compare',
    );
  }
  if (onTheOriginalSeeds === 'did-not-separate') {
    return couldNotJudge(
      headline,
      'this test did not separate the two versions, so there is no gain for it to confirm',
    );
  }
  if (onTheOriginalSeeds === 'not-ahead') {
    return couldNotJudge(
      headline,
      'the change did not come out ahead on the seeds it was chosen on, so there is no gain for it to confirm',
    );
  }

  const { before, after } = pair;
  const bandBefore = completionBand(before);
  const bandAfter = completionBand(after);
  if (!bandsDisjoint(bandBefore, bandAfter)) {
    return couldNotJudge(
      headline,
      `the ${people(after.scored)} it ran on cannot tell the two versions apart`,
    );
  }

  // The bands came apart, so which of them is higher is the whole of the direction:
  // reading it off them keeps the answer and the test of it the same comparison.
  const movedWithThem = bandAfter.low > bandBefore.high;
  return movedWithThem
    ? {
        verdict: 'confirmed',
        confirmed: true,
        reason: CONFIRMED_REASON,
        audienceSentence: `${headline} Confirmed on the holdout: the ${people(after.scored)} the change was never chosen against did the same.`,
      }
    : {
        verdict: 'not_confirmed',
        confirmed: false,
        reason:
          'The holdout did not move with them, so the gain may be the swarm agreeing with itself rather than the change.',
        audienceSentence: notConfirmedHeadline(audience, change, after.scored),
      };
};
