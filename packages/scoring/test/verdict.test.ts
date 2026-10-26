import { verdictSchema, type Audience } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { verdict, type Finding, type VariantScore } from '../src/index.js';

/**
 * The verdict sentence: what a run closes on.
 *
 * Every test here asserts the sentence a designer would read, not the shape of an object —
 * the fields exist so that the screen does not compose one, so the words are the result.
 * The cases the prototype does not show are the ones that matter most: a pair whose bands
 * overlap, two variants that scored the same, one seed group and one variant. A verdict
 * that read as a clean win in any of them would be shown as one.
 *
 * `test/audience-verdict.test.ts` covers what the Verdict screen leads with — the preferred
 * variant, the headline sentence, the reasons and the hero evidence — and
 * `test/acceptance.test.ts` is the gate over the committed fixtures.
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

/** How a test writes down one variant's score: the readings the verdict actually reads. */
interface ScoreSpec {
  readonly variant: string;
  readonly median: number;
  readonly sd: number;
  /** One entry per seed group, as `score()` stores them. Empty for a run of real sessions. */
  readonly groups?: readonly number[];
  readonly success?: number;
  readonly scored?: number;
  readonly worstStep?: string;
}

const scoreOf = ({
  variant,
  median,
  sd,
  groups = [],
  success = 5,
  scored = 10,
  worstStep = 'review',
}: ScoreSpec): VariantScore => ({
  variant,
  taskId: 'buy-a-tent',
  frictionScore: { median, sd },
  completionRate: success / scored,
  components: {
    taskFailureRate: 0,
    abandonment: 0,
    timeToFirstFixationPrimary: { worstStep, medianSeconds: 2, value: 0.33 },
    deadEndRevisits: 0,
  },
  outcomeCounts: { success, abandoned: scored - success, failed: 0, automationFailure: 0 },
  scoredSessionCount: scored,
  perSeedGroup: groups.map((frictionScore, index) => ({ seed: index + 1, frictionScore })),
});

/** How a test writes down one finding: an id, a rank and whatever the case turns on. */
const findingOf = (spec: {
  readonly id: string;
  readonly rank: number;
  readonly severity?: Finding['severity'];
  readonly claim?: string;
  readonly variant?: string | null;
  readonly step?: string;
  readonly aoiId?: string | null;
  readonly attribution?: Finding['attribution'];
}): Finding => ({
  id: spec.id,
  rank: spec.rank,
  severity: spec.severity ?? 'high',
  claim: spec.claim ?? `Something is wrong, and ${spec.id} is the finding that says so.`,
  evidence: `The numbers behind ${spec.id}.`,
  variant: spec.variant === undefined ? 'B' : spec.variant,
  step: spec.step ?? 'review',
  aoiId: spec.aoiId === undefined ? 'b-review-place-order' : spec.aoiId,
  sessionIds: ['S-13'],
  sessionCount: 1,
  attribution: spec.attribution ?? 'product',
  evidence_link: { screen: 'attention', params: { variant: 'B', step: 'review' } },
});

/**
 * The prototype's own run: the clean checkout at 22 ± 3 over seed groups 19–25, the
 * redesign at 67 ± 4 over 63–71, a gap of 45 and bands that do not overlap.
 */
const PROTOTYPE_CLEAN = scoreOf({
  variant: 'A',
  median: 22,
  sd: 3,
  groups: [19, 22, 25],
  success: 9,
  scored: 11,
});
const PROTOTYPE_DEFECTIVE = scoreOf({
  variant: 'B',
  median: 67,
  sd: 4,
  groups: [63, 67, 71],
  success: 2,
  scored: 11,
});

const write = (scores: readonly VariantScore[], findings: readonly Finding[] = []) =>
  verdict(scores, findings, AUDIENCE);

describe('the verdict the artifact contract asks for', () => {
  it('returns the five fields of the verdict shape, and parses as one', () => {
    const written = write(
      [PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE],
      [findingOf({ id: 'F-1', rank: 1 })],
    );

    expect(written.harderVariant).toBe('B');
    expect(written.gapPoints).toBe(45);
    expect(written.bandsDisjoint).toBe(true);
    expect(written.seedGroupsAgreeing).toBe(3);
    expect(written.sentence).toContain('Variant B is harder');
    expect(verdictSchema.parse(written)).toEqual(written);
  });

  it('is not written at all for a run with no scored variant', () => {
    expect(() => write([])).toThrow(/at least one scored variant/);
  });
});

describe('the sentence, in the voice of the prototype’s verdict line', () => {
  it('names the harder variant, the gap, the seed groups and the bands', () => {
    expect(write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE]).sentence).toBe(
      'Variant B is harder by 45 points. The gap held in all 3 seed groups (A 19–25, B 63–71 — the bands do not overlap).',
    );
  });

  it('prints a gap that is not whole as it is, rather than rounding it away', () => {
    const clean = scoreOf({ variant: 'A', median: 22, sd: 2.5, groups: [20, 22, 24] });
    const defective = scoreOf({ variant: 'B', median: 64.5, sd: 4, groups: [61, 64.5, 69] });
    expect(write([clean, defective]).sentence).toContain('harder by 42.5 points');
  });

  it('does not depend on the order the scores arrived in', () => {
    expect(write([PROTOTYPE_DEFECTIVE, PROTOTYPE_CLEAN]).sentence).toBe(
      write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE]).sentence,
    );
  });
});

describe('a pair whose ± 1σ bands overlap', () => {
  // 30 ± 6 is 24–36 and 34 ± 6 is 28–40: a four-point gap inside a twelve-point spread.
  const closeClean = scoreOf({ variant: 'A', median: 30, sd: 6, groups: [24, 30, 36] });
  const closeDefective = scoreOf({ variant: 'B', median: 34, sd: 6, groups: [28, 40, 34] });

  it('reports bandsDisjoint: false', () => {
    expect(write([closeClean, closeDefective]).bandsDisjoint).toBe(false);
  });

  it('says the gap did not hold', () => {
    expect(write([closeClean, closeDefective]).sentence).toBe(
      'Variant B is harder by 4 points, but the gap did not hold: the gap held in 2 of 3 seed groups and the bands overlap (A 24–36, B 28–40).',
    );
  });

  it('never reads as a clean win', () => {
    const { sentence } = write([closeClean, closeDefective]);
    expect(sentence).toContain('did not hold');
    expect(sentence).not.toContain('do not overlap');
  });

  it('counts bands that meet at one point as overlapping', () => {
    // A tops out at exactly 25 and B starts at exactly 25: both contain 25, and a result
    // that cannot tell them apart at that value has not separated them.
    const a = scoreOf({ variant: 'A', median: 20, sd: 5, groups: [15, 20, 25] });
    const b = scoreOf({ variant: 'B', median: 30, sd: 5, groups: [25, 30, 35] });
    expect(write([a, b]).bandsDisjoint).toBe(false);
  });
});

describe('seedGroupsAgreeing counts the groups that agreed, not the groups in the run', () => {
  it('counts two of three when one group scored the other variant worse', () => {
    const clean = scoreOf({ variant: 'A', median: 22, sd: 3, groups: [19, 22, 68] });
    const defective = scoreOf({ variant: 'B', median: 67, sd: 4, groups: [63, 67, 66] });
    const written = write([clean, defective]);

    expect(written.seedGroupsAgreeing).toBe(2);
    expect(written.sentence).toContain('The gap held in 2 of 3 seed groups');
  });

  it('does not count a group the two variants tied in: equal is not higher', () => {
    const clean = scoreOf({ variant: 'A', median: 22, sd: 3, groups: [19, 22, 40] });
    const defective = scoreOf({ variant: 'B', median: 67, sd: 4, groups: [63, 67, 40] });
    expect(write([clean, defective]).seedGroupsAgreeing).toBe(2);
  });

  it('compares only the seeds both variants were run under', () => {
    const clean = scoreOf({ variant: 'A', median: 22, sd: 3, groups: [19, 22, 25] });
    // Seeds 1 and 2 only: the third group of A has nothing to be compared with.
    const defective: VariantScore = {
      ...scoreOf({ variant: 'B', median: 67, sd: 4 }),
      perSeedGroup: [
        { seed: 1, frictionScore: 63 },
        { seed: 2, frictionScore: 71 },
      ],
    };
    const written = write([clean, defective]);

    expect(written.seedGroupsAgreeing).toBe(2);
    expect(written.sentence).toContain('The gap held in all 2 seed groups');
  });

  it('says a run of real sessions has no seed groups, rather than reporting a zero', () => {
    const a = scoreOf({ variant: 'A', median: 22, sd: 0 });
    const b = scoreOf({ variant: 'B', median: 67, sd: 0 });
    const written = write([a, b]);

    expect(written.seedGroupsAgreeing).toBe(0);
    expect(written.sentence).toContain('This run has no seed groups to agree');
    expect(written.sentence).toContain('harder by 45 points');
  });
});

describe('a single seed group', () => {
  const a = scoreOf({ variant: 'A', median: 22, sd: 0, groups: [22] });
  const b = scoreOf({ variant: 'B', median: 67, sd: 0, groups: [67] });

  it('names the one group it has, and does not claim three', () => {
    const written = write([a, b]);
    expect(written.seedGroupsAgreeing).toBe(1);
    expect(written.sentence).toBe(
      'Variant B is harder by 45 points. The gap held in the single seed group this run has (A 22–22, B 67–67 — the bands do not overlap).',
    );
  });

  it('reports a point band as disjoint only when the two medians differ', () => {
    const same = scoreOf({ variant: 'B', median: 22, sd: 0, groups: [22] });
    expect(write([a, b]).bandsDisjoint).toBe(true);
    expect(write([a, same]).bandsDisjoint).toBe(false);
  });

  it('counts a group the harder variant did not win as a group that did not agree', () => {
    const easier = scoreOf({ variant: 'B', median: 10, sd: 0, groups: [10] });
    const written = write([a, easier]);
    expect(written.harderVariant).toBe('A');
    expect(written.seedGroupsAgreeing).toBe(1);
  });
});

describe('two variants that scored the same', () => {
  const a = scoreOf({ variant: 'A', median: 22, sd: 3, groups: [19, 22, 25] });
  const b = scoreOf({ variant: 'B', median: 22, sd: 3, groups: [25, 22, 19] });

  it('reports no gap and bands that overlap', () => {
    const written = write([a, b]);
    expect(written.gapPoints).toBe(0);
    expect(written.bandsDisjoint).toBe(false);
  });

  it('says neither variant is harder, rather than naming one', () => {
    expect(write([a, b]).sentence).toBe(
      'Neither variant is harder: A and B both scored 22 points. The gap held in 1 of 3 seed groups and the bands overlap (A 19–25, B 19–25), so the gap did not hold.',
    );
  });

  it('still names a harder variant and a preferred one, and never the same one', () => {
    const written = write([a, b]);
    expect(written.harderVariant).toBe('B');
    expect(written.preferredVariant).toBe('A');
    expect(verdictSchema.parse(written)).toEqual(written);
  });

  it('breaks the tie on completion first: the one fewer people finish is the harder', () => {
    const fewerFinish = scoreOf({
      variant: 'A',
      median: 22,
      sd: 3,
      groups: [19, 22, 25],
      success: 2,
      scored: 10,
    });
    const written = write([fewerFinish, b]);
    expect(written.harderVariant).toBe('A');
    expect(written.preferredVariant).toBe('B');
  });
});

describe('a run of one variant', () => {
  const only = scoreOf({ variant: 'A', median: 22, sd: 3, groups: [19, 22, 25] });

  it('measures no gap and overlaps no bands', () => {
    const written = write([only]);
    expect(written.harderVariant).toBe('A');
    expect(written.gapPoints).toBe(0);
    expect(written.bandsDisjoint).toBe(false);
    expect(written.seedGroupsAgreeing).toBe(0);
  });

  it('says there was nothing to compare it with', () => {
    expect(write([only]).sentence).toBe(
      'Only variant A was scored, so there was no gap to measure: it scored 22 points and has no second band to be compared with.',
    );
  });
});

describe('the headline findings, as ids in the pipeline’s own rank order', () => {
  const ranked = [
    findingOf({ id: 'F-3', rank: 3 }),
    findingOf({ id: 'F-1', rank: 1 }),
    findingOf({ id: 'F-4', rank: 4 }),
    findingOf({ id: 'F-2', rank: 2 }),
  ];

  it('names at most three, in rank order', () => {
    expect(write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE], ranked).headlineFindingIds).toEqual([
      'F-1',
      'F-2',
      'F-3',
    ]);
  });

  it('names every finding there is when there are fewer than three', () => {
    expect(
      write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE], ranked.slice(1, 3)).headlineFindingIds,
    ).toEqual(['F-1', 'F-4']);
  });

  it('names none when the run produced none, which the contract allows', () => {
    const written = write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE]);
    expect(written.headlineFindingIds).toEqual([]);
    expect(verdictSchema.parse(written)).toEqual(written);
  });

  it('names only findings that exist', () => {
    const written = write([PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE], ranked);
    const ids = new Set(ranked.map((finding) => finding.id));
    for (const id of written.headlineFindingIds) expect(ids.has(id)).toBe(true);
  });
});

describe('the hero evidence: the one heatmap the Verdict screen embeds', () => {
  it('is the area of the highest-severity finding that has one', () => {
    const written = write(
      [PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE],
      [
        findingOf({ id: 'F-1', rank: 1, severity: 'critical', aoiId: 'b-review-place-order' }),
        findingOf({ id: 'F-2', rank: 2, aoiId: 'b-review-fee-row' }),
      ],
    );
    expect(written.heroEvidence).toEqual({
      variant: 'B',
      step: 'review',
      aoiId: 'b-review-place-order',
    });
  });

  it('skips a finding about the run itself, which has no variant and no heatmap', () => {
    const written = write(
      [PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE],
      [
        findingOf({ id: 'F-1', rank: 1, severity: 'info', variant: null, aoiId: 'b-payment-card' }),
        findingOf({ id: 'F-2', rank: 2, step: 'cart', aoiId: 'b-cart-promo' }),
      ],
    );
    expect(written.heroEvidence).toEqual({ variant: 'B', step: 'cart', aoiId: 'b-cart-promo' });
  });

  it('prefers the harder variant, which is the variant the verdict turns on', () => {
    const written = write(
      [PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE],
      [
        findingOf({ id: 'F-1', rank: 1, variant: 'A', step: 'cart', aoiId: 'a-cart-summary' }),
        findingOf({ id: 'F-2', rank: 2, variant: 'B', aoiId: 'b-review-fee-row' }),
      ],
    );
    expect(written.heroEvidence).toEqual({
      variant: 'B',
      step: 'review',
      aoiId: 'b-review-fee-row',
    });
  });

  it('falls back to the worst step for the primary action, with no area guessed at', () => {
    const written = write([
      PROTOTYPE_CLEAN,
      scoreOf({ variant: 'B', median: 67, sd: 4, groups: [63, 67, 71], worstStep: 'payment' }),
    ]);
    expect(written.heroEvidence).toEqual({ variant: 'B', step: 'payment', aoiId: null });
  });

  it('falls back when every finding names a step but no area', () => {
    const written = write(
      [PROTOTYPE_CLEAN, PROTOTYPE_DEFECTIVE],
      [findingOf({ id: 'F-1', rank: 1, aoiId: null })],
    );
    expect(written.heroEvidence).toEqual({ variant: 'B', step: 'review', aoiId: null });
  });
});
