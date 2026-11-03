import { verdictSchema, type Audience, type HoldoutFigures } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { judgeHoldout, verdict, type ChangeUnderTest, type VariantScore } from '../src/index.js';

/**
 * The holdout line, and the verdict that says *not confirmed* (`docs/FLOW.md` section 15,
 * points 4 and 5).
 *
 * The A/B comparison is not rebuilt here and none of it is asserted again; what these
 * tests hold is the one judgement on top of it. Three things matter and are checked in
 * that order: the three answers are the three the contract spells, a holdout too small to
 * separate the two versions is `null` and never `false`, and the judgement is decided by
 * the **same** bands and seed groups as the verdict itself — moving a band moves both.
 */

const AUDIENCE: Audience = {
  id: 'outdoor-gear-shoppers',
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['shopper'],
  regions: ['United Kingdom'],
  goals: ['Buy a tent'],
  devices: [
    {
      name: 'Desktop 1280',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 1,
    },
  ],
  techSavviness: 0.5,
  priceSensitivity: 0.7,
  size: 4,
  generatedFrom: { seed: 1, generatorVersion: 'fixture-1' },
};

/** The change a path-2 run tested: the site as it is, and the pull request's version. */
const CHANGE: ChangeUnderTest = { baselineVariant: 'A', changeVariant: 'B' };

const holdoutOf = (success: number, scored: number): HoldoutFigures => ({
  completionRate: success / scored,
  outcomeCounts: { success, abandoned: scored - success, failed: 0, automationFailure: 0 },
  scoredSessionCount: scored,
});

interface ScoreSpec {
  readonly variant: string;
  readonly median: number;
  readonly sd: number;
  readonly groups: readonly number[];
  readonly success: number;
  readonly scored: number;
  readonly holdout?: HoldoutFigures;
}

const scoreOf = ({
  variant,
  median,
  sd,
  groups,
  success,
  scored,
  holdout,
}: ScoreSpec): VariantScore => ({
  variant,
  taskId: 'buy-a-tent',
  frictionScore: { median, sd },
  completionRate: success / scored,
  components: {
    taskFailureRate: 0,
    abandonment: 0,
    timeToFirstFixationPrimary: { worstStep: 'review', medianSeconds: 2, value: 0.33 },
    deadEndRevisits: 0,
  },
  outcomeCounts: { success, abandoned: scored - success, failed: 0, automationFailure: 0 },
  scoredSessionCount: scored,
  perSeedGroup: groups.map((frictionScore, index) => ({ seed: index + 1, frictionScore })),
  ...(holdout === undefined ? {} : { holdout }),
});

/** The site as it is: harder, and fewer people finish on it. */
const baseline = (holdout?: HoldoutFigures): VariantScore =>
  scoreOf({
    variant: 'A',
    median: 67,
    sd: 4,
    groups: [63, 67, 71],
    success: 3,
    scored: 11,
    ...(holdout === undefined ? {} : { holdout }),
  });

/** The pull request's version: easier, and more people finish on it. */
const change = (holdout?: HoldoutFigures): VariantScore =>
  scoreOf({
    variant: 'B',
    median: 22,
    sd: 3,
    groups: [19, 22, 25],
    success: 9,
    scored: 11,
    ...(holdout === undefined ? {} : { holdout }),
  });

/** A 20-person holdout that moved with them, one that did not, and one that cannot say. */
const MOVED_WITH_THEM = { before: holdoutOf(8, 20), after: holdoutOf(15, 20) };
const DID_NOT_MOVE = { before: holdoutOf(15, 20), after: holdoutOf(8, 20) };
const TOO_CLOSE_TO_CALL = { before: holdoutOf(10, 20), after: holdoutOf(13, 20) };

const write = (sides?: { before: HoldoutFigures; after: HoldoutFigures }) =>
  verdict([baseline(sides?.before), change(sides?.after)], [], AUDIENCE, CHANGE);

describe('the holdout verdict', () => {
  it('is confirmed when the change wins on the original seeds and on the holdout', () => {
    const written = write(MOVED_WITH_THEM);

    expect(written.holdout).toBe('confirmed');
    expect(written.audienceSentence).toContain('Confirmed on the holdout');
    expect(written.audienceSentence).toContain('20 people the change was never chosen against');
    expect(written.reasons).toContain(
      'The holdout moved with them, so the gain is the change and not the swarm agreeing with itself.',
    );
    expect(verdictSchema.parse(written).holdout).toBe('confirmed');
  });

  it('is not confirmed when it wins on the original seeds and not on the holdout', () => {
    const written = write(DID_NOT_MOVE);

    expect(written.holdout).toBe('not_confirmed');
    expect(written.audienceSentence).toContain('this gain is not confirmed');
    expect(written.reasons.at(-1)).toContain('did not move with them');
    expect(verdictSchema.parse(written).holdout).toBe('not_confirmed');
  });

  it('does not let a not-confirmed gain read as a gain with a caveat', () => {
    const sentence = write(DID_NOT_MOVE).audienceSentence;

    // One sentence, and the last thing it says is the verdict rather than the gain.
    expect(sentence.match(/[.]/g)).toHaveLength(1);
    expect(sentence.endsWith('this gain is not confirmed.')).toBe(true);
    // The confirmed wording is never anywhere inside it.
    expect(sentence).not.toContain('Confirmed on the holdout');
  });

  it('is none, and the verdict is otherwise today’s, when no holdout ran', () => {
    const written = write();
    const withoutAChange = verdict([baseline(), change()], [], AUDIENCE);

    expect(written.holdout).toBe('none');
    expect({ ...written, holdout: undefined }).toEqual({ ...withoutAChange, holdout: undefined });
    expect(verdictSchema.parse(written).holdout).toBe('none');
  });

  it('carries no holdout field at all on a path-1 run, which the contract requires', () => {
    const written = verdict([baseline(), change()], [], AUDIENCE);

    expect('holdout' in written).toBe(false);
    expect(verdictSchema.parse(written).holdout).toBeUndefined();
  });
});

describe('a holdout too small to judge', () => {
  it('is null with the reason, never false', () => {
    const written = write(TOO_CLOSE_TO_CALL);
    const judged = judgeHoldout({
      scores: [baseline(TOO_CLOSE_TO_CALL.before), change(TOO_CLOSE_TO_CALL.after)],
      change: CHANGE,
      onTheOriginalSeeds: 'won',
      headline: 'Headline.',
      audience: AUDIENCE,
    });

    expect(judged.confirmed).toBeNull();
    expect(judged.confirmed).not.toBe(false);
    expect(written.holdout).toBe('none');
    expect(written.holdout).not.toBe('not_confirmed');
  });

  it('says in the sentence that it could not judge', () => {
    const written = write(TOO_CLOSE_TO_CALL);

    expect(written.audienceSentence).toContain(
      'The holdout could not judge: the 20 people it ran on cannot tell the two versions apart.',
    );
    expect(written.reasons.at(-1)).toContain('The holdout could not judge');
  });

  it('could not judge when only one of the two versions was measured on it', () => {
    const written = verdict([baseline(), change(holdoutOf(15, 20))], [], AUDIENCE, CHANGE);

    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('only one of the two versions');
  });
});

describe('the same standard as the verdict itself', () => {
  it('moves with the bands: widen one and both the gap and the holdout stop holding', () => {
    const narrow = write(MOVED_WITH_THEM);
    const widened = verdict(
      [
        scoreOf({
          variant: 'A',
          median: 67,
          sd: 50,
          groups: [63, 67, 71],
          success: 3,
          scored: 11,
          holdout: MOVED_WITH_THEM.before,
        }),
        change(MOVED_WITH_THEM.after),
      ],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(narrow.bandsDisjoint).toBe(true);
    expect(narrow.holdout).toBe('confirmed');
    expect(widened.bandsDisjoint).toBe(false);
    expect(widened.holdout).toBe('none');
    expect(widened.audienceSentence).toContain('did not separate the two versions');
  });

  it('moves with the seed groups: one group that disagrees is a gain that did not hold', () => {
    const written = verdict(
      [
        scoreOf({
          variant: 'A',
          median: 67,
          sd: 4,
          groups: [63, 67, 18],
          success: 3,
          scored: 11,
          holdout: MOVED_WITH_THEM.before,
        }),
        change(MOVED_WITH_THEM.after),
      ],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.seedGroupsAgreeing).toBe(2);
    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('no gain for it to confirm');
  });

  it('says the change did not come out ahead, rather than that nothing separated', () => {
    // The two versions came apart cleanly and the change is the harder of them: telling
    // the user this test did not separate them would be untrue.
    const written = verdict(
      [change(MOVED_WITH_THEM.after), baseline(MOVED_WITH_THEM.before)],
      [],
      AUDIENCE,
      { baselineVariant: 'B', changeVariant: 'A' },
    );

    expect(written.bandsDisjoint).toBe(true);
    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('the change did not come out ahead');
    expect(written.audienceSentence).not.toContain('did not separate the two versions');
  });

  it('confirms nothing when the gap is not the baseline against the change', () => {
    // Three variants: the gap the verdict reports is the hardest against the easiest, and
    // neither of those is the pair this change was tested as.
    const third = scoreOf({
      variant: 'C',
      median: 5,
      sd: 1,
      groups: [4, 5, 6],
      success: 10,
      scored: 11,
    });
    const written = verdict(
      [baseline(MOVED_WITH_THEM.before), change(MOVED_WITH_THEM.after), third],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.bandsDisjoint).toBe(true);
    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('the change did not come out ahead');
  });

  it('confirms nothing when the audience completes the baseline more often', () => {
    // The change scored easier and the bands came apart, but fewer of the audience
    // finished on it, so the headline recommends the baseline. A holdout line saying the
    // change is ahead would contradict the field beside it.
    const completedLess = scoreOf({
      variant: 'B',
      median: 22,
      sd: 3,
      groups: [19, 22, 25],
      success: 2,
      scored: 11,
      holdout: MOVED_WITH_THEM.after,
    });
    const written = verdict(
      [baseline(MOVED_WITH_THEM.before), completedLess],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.preferredVariant).toBe('A');
    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('the change did not come out ahead');
  });
});

describe('a holdout everybody or nobody finished on', () => {
  it('does not call one person in twenty a separation', () => {
    const written = verdict(
      [baseline(holdoutOf(20, 20)), change(holdoutOf(19, 20))],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.holdout).toBe('none');
    expect(written.holdout).not.toBe('not_confirmed');
    expect(written.audienceSentence).toContain('cannot tell the two versions apart');
  });

  it('still confirms a holdout that nobody finished the baseline on', () => {
    const written = verdict(
      [baseline(holdoutOf(0, 20)), change(holdoutOf(14, 20))],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.holdout).toBe('confirmed');
  });
});

describe('the holdout over a run of more than one task', () => {
  const taskOf = (score: VariantScore, taskId: string): VariantScore => ({ ...score, taskId });

  it('sums the tasks both versions were measured on', () => {
    const written = verdict(
      [
        taskOf(baseline(holdoutOf(4, 10)), 'buy-a-tent'),
        taskOf(baseline(holdoutOf(4, 10)), 'find-a-store'),
        taskOf(change(holdoutOf(8, 10)), 'buy-a-tent'),
        taskOf(change(holdoutOf(7, 10)), 'find-a-store'),
      ],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.holdout).toBe('confirmed');
    expect(written.audienceSentence).toContain('20 people');
  });

  it('could not judge when the two versions share no measured task', () => {
    const written = verdict(
      [
        taskOf(baseline(holdoutOf(4, 20)), 'buy-a-tent'),
        taskOf(change(holdoutOf(15, 20)), 'find-a-store'),
      ],
      [],
      AUDIENCE,
      CHANGE,
    );

    expect(written.holdout).toBe('none');
    expect(written.audienceSentence).toContain('only one of the two versions');
  });
});

describe('what the verdict carries beside it', () => {
  it('spends the second reason slot on the holdout and never a third', () => {
    const written = write(MOVED_WITH_THEM);

    expect(written.reasons).toHaveLength(2);
    expect(written.reasons.at(-1)).toContain('The holdout moved with them');
    expect(verdictSchema.parse(written).reasons).toHaveLength(2);
  });

  it('reads the holdout and scores nothing differently', () => {
    const scores = [baseline(MOVED_WITH_THEM.before), change(MOVED_WITH_THEM.after)];
    const written = verdict(scores, [], AUDIENCE, CHANGE);
    const withoutHoldout = verdict([baseline(), change()], [], AUDIENCE);

    expect(written.gapPoints).toBe(withoutHoldout.gapPoints);
    expect(written.harderVariant).toBe(withoutHoldout.harderVariant);
    expect(written.bandsDisjoint).toBe(withoutHoldout.bandsDisjoint);
    expect(written.seedGroupsAgreeing).toBe(withoutHoldout.seedGroupsAgreeing);
    expect(written.sentence).toBe(withoutHoldout.sentence);
    expect(scores[0].frictionScore).toEqual({ median: 67, sd: 4 });
  });

  it('is deterministic: the same scores are the same verdict', () => {
    expect(write(MOVED_WITH_THEM)).toEqual(write(MOVED_WITH_THEM));
  });
});
