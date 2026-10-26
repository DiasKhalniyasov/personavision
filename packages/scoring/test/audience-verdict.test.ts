import { verdictSchema, type Audience } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { goalPhrase, reasonFrom } from '../src/audienceSentence.js';
import { verdict, type Finding, type VariantScore } from '../src/index.js';

/**
 * What the Verdict screen leads with: the variant to ship, the headline sentence and the
 * one or two reasons under it (`docs/FLOW.md` section 5).
 *
 * The screen formats these and composes nothing, so these tests are the only place the
 * words are checked. Two of them are the whole point of the step: the headline carries
 * **no jargon**, because it is about their customers and not about our instrument; and a
 * reason is **cut from a headline finding's own claim**, so the lead screen and the
 * findings list can never disagree about what happened.
 */

const audienceWith = (overrides: Partial<Audience> = {}): Audience => ({
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
  ...overrides,
});

const AUDIENCE = audienceWith();

interface ScoreSpec {
  readonly variant: string;
  readonly median: number;
  readonly sd: number;
  readonly groups?: readonly number[];
  readonly success?: number;
  readonly scored?: number;
}

const scoreOf = ({
  variant,
  median,
  sd,
  groups = [],
  success = 5,
  scored = 10,
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
});

const findingOf = (spec: {
  readonly id: string;
  readonly rank: number;
  readonly claim: string;
  readonly severity?: Finding['severity'];
  readonly attribution?: Finding['attribution'];
  readonly variant?: string | null;
}): Finding => ({
  id: spec.id,
  rank: spec.rank,
  severity: spec.severity ?? 'critical',
  claim: spec.claim,
  evidence: `The numbers behind ${spec.id}.`,
  variant: spec.variant === undefined ? 'B' : spec.variant,
  step: 'review',
  aoiId: 'b-review-place-order',
  sessionIds: ['S-13'],
  sessionCount: 9,
  attribution: spec.attribution ?? 'product',
  evidence_link: { screen: 'attention', params: { variant: 'B', step: 'review' } },
});

/** The clean checkout 9 of 11 people finish on, and the redesign 2 of 11 finish on. */
const CLEAN = scoreOf({
  variant: 'A',
  median: 22,
  sd: 3,
  groups: [19, 22, 25],
  success: 9,
  scored: 11,
});
const DEFECTIVE = scoreOf({
  variant: 'B',
  median: 67,
  sd: 4,
  groups: [63, 67, 71],
  success: 2,
  scored: 11,
});

/** The run the demo ends on: the two headline findings the prototype shows. */
const PROTOTYPE_FINDINGS = [
  findingOf({
    id: 'F-1',
    rank: 1,
    claim:
      'Nobody in your audience ever looked at the button that completes the order on the redesign.',
  }),
  findingOf({
    id: 'F-2',
    rank: 2,
    claim:
      'A $9.95 service fee only appears after the card is entered, and 4 of 9 people left within 5 seconds of seeing it.',
  }),
];

const write = (
  scores: readonly VariantScore[],
  findings: readonly Finding[] = [],
  audience: Audience = AUDIENCE,
) => verdict(scores, findings, audience);

describe('preferredVariant: the variant to ship', () => {
  it('is the variant with the higher completion rate', () => {
    expect(write([CLEAN, DEFECTIVE]).preferredVariant).toBe('A');
    expect(write([DEFECTIVE, CLEAN]).preferredVariant).toBe('A');
  });

  it('is not the variant with the lower friction score when completion disagrees', () => {
    // B scores better on friction but fewer people finish on it: completion decides.
    const harderButCompleted = scoreOf({ variant: 'A', median: 40, sd: 2, success: 8, scored: 10 });
    const easierButAbandoned = scoreOf({ variant: 'B', median: 20, sd: 2, success: 3, scored: 10 });
    const written = write([harderButCompleted, easierButAbandoned]);

    expect(written.preferredVariant).toBe('A');
    expect(written.harderVariant).toBe('A');
  });

  it('breaks a tie on completion to the lower friction score', () => {
    const tiedHarder = scoreOf({ variant: 'A', median: 40, sd: 2, success: 5, scored: 10 });
    const tiedEasier = scoreOf({ variant: 'B', median: 20, sd: 2, success: 5, scored: 10 });
    expect(write([tiedHarder, tiedEasier]).preferredVariant).toBe('B');
  });

  it('is stated even for a result that did not separate', () => {
    const a = scoreOf({ variant: 'A', median: 30, sd: 8, success: 6, scored: 10 });
    const b = scoreOf({ variant: 'B', median: 34, sd: 8, success: 5, scored: 10 });
    const written = write([a, b]);

    expect(written.bandsDisjoint).toBe(false);
    expect(written.preferredVariant).toBe('A');
  });
});

describe('audienceSentence: the headline, in the user’s words', () => {
  it('names the variant the audience completes, and the audience', () => {
    expect(write([CLEAN, DEFECTIVE], PROTOTYPE_FINDINGS).audienceSentence).toBe(
      'Outdoor-gear shoppers buy a tent on A, not on B.',
    );
  });

  it('is one sentence', () => {
    const { audienceSentence } = write([CLEAN, DEFECTIVE], PROTOTYPE_FINDINGS);
    expect(audienceSentence.match(/[.!?]/g)).toHaveLength(1);
    expect(audienceSentence.endsWith('.')).toBe(true);
  });

  it('carries no jargon', () => {
    const headlines = [
      write([CLEAN, DEFECTIVE], PROTOTYPE_FINDINGS).audienceSentence,
      write([CLEAN, scoreOf({ variant: 'B', median: 24, sd: 6, groups: [20, 24, 28] })])
        .audienceSentence,
      write([CLEAN]).audienceSentence,
    ];
    for (const headline of headlines) {
      for (const word of ['fixation', 'dwell', 'saccade', 'AOI', 'friction score']) {
        expect(headline.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it('does not read as a clean win when the bands overlap', () => {
    const close = scoreOf({
      variant: 'B',
      median: 26,
      sd: 6,
      groups: [22, 26, 30],
      success: 7,
      scored: 11,
    });
    const written = write([CLEAN, close], PROTOTYPE_FINDINGS);

    expect(written.bandsDisjoint).toBe(false);
    expect(written.audienceSentence).toBe(
      'Outdoor-gear shoppers buy a tent on A more often than on B, but this test did not separate the two versions.',
    );
    expect(written.audienceSentence).not.toContain('not on B');
  });

  it('says so plainly when the two versions are completed about as often', () => {
    const tied = scoreOf({
      variant: 'B',
      median: 26,
      sd: 6,
      groups: [22, 26, 30],
      success: 9,
      scored: 11,
    });
    expect(write([CLEAN, tied]).audienceSentence).toBe(
      'Outdoor-gear shoppers buy a tent about as often on A as on B: this test did not separate the two versions.',
    );
  });

  it('says there was no second version for a run of one variant', () => {
    expect(write([CLEAN]).audienceSentence).toBe(
      'Outdoor-gear shoppers buy a tent on A; there was no second version to compare it with.',
    );
  });

  it('lowers a goal written as a heading, and leaves an acronym alone', () => {
    expect(goalPhrase(audienceWith({ goals: ['Buy a tent'] }))).toBe('buy a tent');
    expect(goalPhrase(audienceWith({ goals: ['VAT receipts for a purchase'] }))).toBe(
      'VAT receipts for a purchase',
    );
    expect(goalPhrase(audienceWith({ goals: ['Buy a tent.'] }))).toBe('buy a tent');
  });

  it('falls back to the task for an audience that declares no goal', () => {
    expect(write([CLEAN, DEFECTIVE], [], audienceWith({ goals: [] })).audienceSentence).toBe(
      'Outdoor-gear shoppers complete the task on A, not on B.',
    );
  });
});

describe('reasons: one or two, each cut from a headline finding’s own claim', () => {
  it('leads with two, in the order the pipeline ranked the findings', () => {
    expect(write([CLEAN, DEFECTIVE], PROTOTYPE_FINDINGS).reasons).toEqual([
      'Nobody in your audience ever looked at the button that completes the order on the redesign.',
      'A $9.95 service fee only appears after the card is entered.',
    ]);
  });

  it('never writes three, however many findings the run produced', () => {
    const many = [
      ...PROTOTYPE_FINDINGS,
      findingOf({ id: 'F-3', rank: 3, claim: 'The sale banner takes the first look.' }),
      findingOf({ id: 'F-4', rank: 4, claim: 'Two people gave up at the basket.' }),
    ];
    expect(write([CLEAN, DEFECTIVE], many).reasons).toHaveLength(2);
  });

  it('is never empty, and every fixture reads as one or two', () => {
    for (const findings of [[], PROTOTYPE_FINDINGS, PROTOTYPE_FINDINGS.slice(0, 1)]) {
      const { reasons } = write([CLEAN, DEFECTIVE], findings);
      expect(reasons.length).toBeGreaterThanOrEqual(1);
      expect(reasons.length).toBeLessThanOrEqual(2);
    }
  });

  it('derives each reason from one of the headline findings, not beside them', () => {
    const written = write([CLEAN, DEFECTIVE], PROTOTYPE_FINDINGS);
    const headline = PROTOTYPE_FINDINGS.filter((finding) =>
      written.headlineFindingIds.includes(finding.id),
    );

    for (const reason of written.reasons) {
      const source = headline.find((finding) => reason === reasonFrom(finding));
      expect(source, `no headline finding produced "${reason}"`).toBeDefined();
      // The reason is the claim's own leading clause, so the claim still starts with it.
      expect(source?.claim.startsWith(reason.replace(/\.$/, ''))).toBe(true);
    }
  });

  it('leads with the version it is not shipping, not with a note about the one it is', () => {
    // The real demo run ranks a finding about the current checkout second, between two
    // about the redesign. A "Why ship A" list that led with a complaint about A would read
    // as an argument against the headline above it.
    const aboutPreferred = findingOf({
      id: 'F-A',
      rank: 2,
      variant: 'A',
      severity: 'high',
      claim: '“Order total” takes the first look on the current checkout.',
    });
    const alsoAboutB = findingOf({
      id: 'F-3',
      rank: 3,
      severity: 'high',
      claim: 'The sale banner takes the first look on the redesign.',
    });
    const written = write([CLEAN, DEFECTIVE], [PROTOTYPE_FINDINGS[0], aboutPreferred, alsoAboutB]);

    expect(written.headlineFindingIds).toEqual(['F-1', 'F-A', 'F-3']);
    expect(written.reasons).toEqual([
      'Nobody in your audience ever looked at the button that completes the order on the redesign.',
      'The sale banner takes the first look on the redesign.',
    ]);
  });

  it('takes a reason about the preferred version when it is the only one left', () => {
    const onlyAboutPreferred = findingOf({
      id: 'F-A',
      rank: 1,
      variant: 'A',
      claim: 'Two people gave up at the basket on the current checkout.',
    });
    expect(write([CLEAN, DEFECTIVE], [onlyAboutPreferred]).reasons).toEqual([
      'Two people gave up at the basket on the current checkout.',
    ]);
  });

  it('does not offer our own automation failure as a reason to ship anything', () => {
    const ours = findingOf({
      id: 'F-0',
      rank: 1,
      severity: 'info',
      attribution: 'automation',
      claim:
        '2 of 24 people could not be simulated to the end, and are excluded from both figures.',
    });
    const written = write([CLEAN, DEFECTIVE], [ours, ...PROTOTYPE_FINDINGS]);

    expect(written.headlineFindingIds).toContain('F-0');
    expect(written.reasons).toEqual([
      'Nobody in your audience ever looked at the button that completes the order on the redesign.',
      'A $9.95 service fee only appears after the card is entered.',
    ]);
  });

  it('states the completion figures when no finding can supply a reason', () => {
    const written = write([CLEAN, DEFECTIVE]);
    expect(written.reasons).toEqual([
      '9 of 11 people finished the task on A, against 2 of 11 on B.',
    ]);
    expect(verdictSchema.parse(written)).toEqual(written);
  });

  it('states one variant’s figure for a run of one variant', () => {
    expect(write([CLEAN]).reasons).toEqual(['9 of 11 people finished the task on A.']);
  });

  it('cuts a claim at its first clause and nowhere else', () => {
    expect(
      reasonFrom(
        findingOf({
          id: 'F-9',
          rank: 1,
          claim: 'The total changes between two steps; 4 of 9 people went back to check it.',
        }),
      ),
    ).toBe('The total changes between two steps.');
  });
});
