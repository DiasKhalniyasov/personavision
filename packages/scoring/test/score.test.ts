import { runSchema, sessionSchema, type Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  FINDING_RULE_IDS,
  score,
  scoringConfig,
  verdict,
  type AoiMetric,
  type VariantScore,
} from '../src/index.js';
import { buildAoiMetrics, buildSession, type SessionSpec } from './fixtures/build.js';
import {
  buildFixtureRun,
  cleanVariantSessions,
  defectiveVariantSessions,
  fixtureAoiMetrics,
  fixtureAois,
  fixtureSessions,
  fixtureTask,
  plantedDefects,
} from './fixtures/index.js';

/**
 * The band thresholds `docs/FLOW.md` section 5's acceptance table states. They are
 * presentation — the viewer reads them from `--score-threshold-*` in the tokens — and the
 * one shared constant lives with the verdict and its gate (#27). They are written out here
 * because this is the test that measures them, not a part of the formula.
 */
const CLEAN_AT_MOST = 25;
const DEFECTIVE_AT_LEAST = 60;
const SEPARATED_BY_AT_LEAST = 30;

/** One session of a one-step scenario, written as the two readings a component needs. */
interface MiniRow {
  readonly status: SessionSpec['status'];
  /** Seconds before the primary action was first looked at; `null` when it never was. */
  readonly seconds: number | null;
  readonly returns: number;
  readonly seed?: number;
  readonly attribution?: SessionSpec['attribution'];
  readonly excludedFromScores?: boolean;
}

const miniSessions = (rows: readonly MiniRow[]): Session[] =>
  rows.map((row, index) =>
    buildSession(
      {
        sessionId: `S-${String(index + 1).padStart(2, '0')}`,
        variant: 'A',
        seed: row.seed ?? null,
        personaId: 'P-1',
        status: row.status,
        attribution: row.attribution,
        excludedFromScores: row.excludedFromScores,
        steps: [{ step: 'review', primaryAfterSeconds: row.seconds, deadEndReturns: row.returns }],
      },
      fixtureAois,
    ),
  );

/** One variant's score over a set of sessions, with the metrics those sessions imply. */
const scoreOf = (sessions: readonly Session[]): VariantScore => {
  const [only, ...rest] = score(
    sessions,
    fixtureAois,
    buildAoiMetrics(sessions, fixtureAois),
    fixtureTask,
  );
  if (only === undefined) throw new Error('the sessions produced no score');
  if (rest.length > 0) throw new Error('the sessions produced more than one score');
  return only;
};

const scoreMini = (rows: readonly MiniRow[]): VariantScore => scoreOf(miniSessions(rows));

/** The whole fixture run, both variants, as the pipeline would score it. */
const fixtureScores = (): VariantScore[] =>
  score(fixtureSessions, fixtureAois, fixtureAoiMetrics, fixtureTask);

const forVariant = (scores: readonly VariantScore[], variant: string): VariantScore => {
  const found = scores.find((candidate) => candidate.variant === variant);
  if (found === undefined) throw new Error(`no score for variant ${variant}`);
  return found;
};

describe('the configuration object', () => {
  it('holds the weights section 5 states, and nothing else holds them', () => {
    expect(scoringConfig.weights).toEqual({
      taskFailureRate: 0.3,
      abandonment: 0.2,
      timeToFirstFixationPrimary: 0.35,
      deadEndRevisits: 0.15,
    });
  });

  it('weights a whole unit, so the 0-100 scale is reachable and reachable once', () => {
    const total = Object.values(scoringConfig.weights).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(total * scoringConfig.pointsPerUnit).toBeCloseTo(100, 10);
  });

  it('holds the two normalisation constants: six seconds and five returns', () => {
    expect(scoringConfig.normalisation).toEqual({
      timeToFirstFixationSeconds: 6,
      deadEndRevisitsPerSession: 5,
    });
  });

  it('gives every findings rule a severity from the contract vocabulary', () => {
    expect(Object.keys(scoringConfig.severityByRule).sort()).toEqual([...FINDING_RULE_IDS].sort());
    expect(scoringConfig.severityByRule['never-fixated-primary-action']).toBe('critical');
  });
});

describe('the task failure rate component', () => {
  it('is 0 when nothing failed', () => {
    expect(
      scoreMini([{ status: 'success', seconds: 0, returns: 0 }]).components.taskFailureRate,
    ).toBe(0);
  });

  it('is the share of scored sessions that failed, at the middle', () => {
    const scored = scoreMini([
      { status: 'success', seconds: 0, returns: 0 },
      { status: 'failed', seconds: 0, returns: 0 },
    ]);
    expect(scored.components.taskFailureRate).toBe(0.5);
    expect(scored.frictionScore.median).toBeCloseTo(15, 10);
  });

  it('is 1 when every scored session failed with the product at fault', () => {
    expect(
      scoreMini([
        { status: 'failed', seconds: 0, returns: 0 },
        { status: 'failed', seconds: 0, returns: 0 },
      ]).components.taskFailureRate,
    ).toBe(1);
  });

  it('counts a failure attributed to our own automation in the outcomes, not in the rate', () => {
    const scored = scoreMini([
      { status: 'failed', seconds: 0, returns: 0, attribution: 'automation' },
      { status: 'failed', seconds: 0, returns: 0 },
    ]);
    expect(scored.components.taskFailureRate).toBe(0.5);
    expect(scored.outcomeCounts.failed).toBe(2);
  });
});

describe('the abandonment component', () => {
  it('is 0, a half and 1 as the share of scored sessions that gave up', () => {
    expect(scoreMini([{ status: 'success', seconds: 0, returns: 0 }]).components.abandonment).toBe(
      0,
    );
    expect(
      scoreMini([
        { status: 'success', seconds: 0, returns: 0 },
        { status: 'abandoned', seconds: 0, returns: 0 },
      ]).components.abandonment,
    ).toBe(0.5);
    expect(
      scoreMini([{ status: 'abandoned', seconds: 0, returns: 0 }]).components.abandonment,
    ).toBe(1);
  });
});

describe('the time to first fixation on the primary action', () => {
  it('is 0 when the primary action took the first look', () => {
    const { timeToFirstFixationPrimary } = scoreMini([
      { status: 'success', seconds: 0, returns: 0 },
    ]).components;
    expect(timeToFirstFixationPrimary.medianSeconds).toBe(0);
    expect(timeToFirstFixationPrimary.value).toBe(0);
  });

  it('is the median seconds over six at the middle', () => {
    const { timeToFirstFixationPrimary } = scoreMini([
      { status: 'success', seconds: 3, returns: 0 },
    ]).components;
    expect(timeToFirstFixationPrimary.medianSeconds).toBeCloseTo(3, 10);
    expect(timeToFirstFixationPrimary.value).toBeCloseTo(0.5, 10);
  });

  it('is a full 1 at six seconds, and stays capped at 1 beyond it', () => {
    expect(
      scoreMini([{ status: 'success', seconds: 6, returns: 0 }]).components
        .timeToFirstFixationPrimary,
    ).toEqual({ worstStep: 'review', medianSeconds: 6, value: 1 });
    const beyond = scoreMini([{ status: 'success', seconds: 9, returns: 0 }]).components
      .timeToFirstFixationPrimary;
    expect(beyond.medianSeconds).toBeCloseTo(9, 10);
    expect(beyond.value).toBe(1);
  });

  it('is exactly 1.0 with a null reading when the primary action was never fixated', () => {
    expect(
      scoreMini([{ status: 'abandoned', seconds: null, returns: 0 }]).components
        .timeToFirstFixationPrimary,
    ).toEqual({ worstStep: 'review', medianSeconds: null, value: 1 });
  });

  it('is the median over the sessions that looked, not over all of them', () => {
    // Two looked, at two and four seconds; one never did. A zero or a 6 for the third
    // would move the median, and neither is a time anybody was measured at.
    const { timeToFirstFixationPrimary } = scoreMini([
      { status: 'success', seconds: 2, returns: 0 },
      { status: 'success', seconds: 4, returns: 0 },
      { status: 'abandoned', seconds: null, returns: 0 },
    ]).components;
    expect(timeToFirstFixationPrimary.medianSeconds).toBeCloseTo(3, 10);
  });

  it('names the worst of the steps the sessions reached', () => {
    const sessions = [
      buildSession(
        {
          sessionId: 'S-01',
          variant: 'A',
          seed: null,
          personaId: 'P-1',
          status: 'success',
          steps: [
            { step: 'cart', primaryAfterSeconds: 1, deadEndReturns: 0 },
            { step: 'payment', primaryAfterSeconds: 4.5, deadEndReturns: 0 },
            { step: 'review', primaryAfterSeconds: 2, deadEndReturns: 0 },
          ],
        },
        fixtureAois,
      ),
    ];
    const { timeToFirstFixationPrimary } = scoreOf(sessions).components;
    expect(timeToFirstFixationPrimary.worstStep).toBe('payment');
    expect(timeToFirstFixationPrimary.medianSeconds).toBeCloseTo(4.5, 10);
  });

  it('names the same worst step whatever order the sessions arrive in', () => {
    // Two sessions that each reached one step, both reading the same seconds: the step
    // that comes first in the journey wins the tie, and which session was listed first
    // must not decide it.
    const oneStep = (sessionId: string, step: string): Session =>
      buildSession(
        {
          sessionId,
          variant: 'A',
          seed: null,
          personaId: 'P-1',
          status: 'success',
          steps: [{ step, primaryAfterSeconds: 2, deadEndReturns: 0 }],
        },
        fixtureAois,
      );
    const cart = oneStep('S-01', 'cart');
    const payment = oneStep('S-02', 'payment');
    expect(scoreOf([cart, payment]).components.timeToFirstFixationPrimary).toEqual(
      scoreOf([payment, cart]).components.timeToFirstFixationPrimary,
    );
    expect(scoreOf([payment, cart]).components.timeToFirstFixationPrimary.worstStep).toBe('cart');
  });

  it('measures from the arrival of the visit the control was found on, not across a detour', () => {
    // Basket, payment, then back to the basket, where Checkout is found 0.9s after the
    // step reappears. Pooling the two visits would measure from the first arrival and
    // report the whole payment detour as time before the control was seen.
    const wentBack = buildSession(
      {
        sessionId: 'S-01',
        variant: 'A',
        seed: null,
        personaId: 'P-1',
        status: 'success',
        steps: [
          { step: 'cart', primaryAfterSeconds: null, deadEndReturns: 0 },
          { step: 'payment', primaryAfterSeconds: 0.7, deadEndReturns: 0 },
          { step: 'cart', primaryAfterSeconds: 0.9, deadEndReturns: 0 },
        ],
      },
      fixtureAois,
    );
    const { components } = scoreOf([wentBack]);
    expect(components.timeToFirstFixationPrimary.worstStep).toBe('cart');
    expect(components.timeToFirstFixationPrimary.medianSeconds).toBeCloseTo(0.9, 10);
  });

  it('reports the never-fixated 1.0 even where a session did look, when the run says nobody did', () => {
    // The engine's row is what the heatmaps and the findings are built on, so the score
    // reads "was it ever looked at" from there rather than deciding it again.
    const sessions = miniSessions([{ status: 'success', seconds: 2, returns: 0 }]);
    const rows: AoiMetric[] = buildAoiMetrics(sessions, fixtureAois).map((row) =>
      row.aoiId === 'a-review-place-order' ? { ...row, timeToFirstFixationMs: null } : row,
    );
    const [only] = score(sessions, fixtureAois, rows, fixtureTask);
    expect(only?.components.timeToFirstFixationPrimary).toEqual({
      worstStep: 'review',
      medianSeconds: null,
      value: 1,
    });
  });
});

describe('the dead-end revisits component', () => {
  it('is 0 when nobody went back to anything', () => {
    expect(
      scoreMini([{ status: 'success', seconds: 0, returns: 0 }]).components.deadEndRevisits,
    ).toBe(0);
  });

  it('is the median returns per session over five, at the middle', () => {
    expect(
      scoreMini([
        { status: 'success', seconds: 0, returns: 2 },
        { status: 'success', seconds: 0, returns: 3 },
      ]).components.deadEndRevisits,
    ).toBeCloseTo(0.5, 10);
  });

  it('is a full 1 at five returns, and stays capped beyond it', () => {
    expect(
      scoreMini([{ status: 'success', seconds: 0, returns: 5 }]).components.deadEndRevisits,
    ).toBe(1);
    expect(
      scoreMini([{ status: 'success', seconds: 0, returns: 9 }]).components.deadEndRevisits,
    ).toBe(1);
  });

  it('counts a return to an area, not a run of looks inside one', () => {
    // The builder writes two returns as four fixations alternating between two dead ends;
    // a session that simply stared at one of them has gone back to nothing.
    expect(
      scoreMini([{ status: 'success', seconds: 0, returns: 2 }]).components.deadEndRevisits,
    ).toBeCloseTo(0.4, 10);
  });
});

describe('the whole formula', () => {
  it('scores a clean run at 0', () => {
    const clean = scoreMini([
      { status: 'success', seconds: 0, returns: 0 },
      { status: 'success', seconds: 0, returns: 0 },
    ]);
    expect(clean.frictionScore.median).toBe(0);
    expect(clean.completionRate).toBe(1);
  });

  /**
   * The worst a run can read is 80, not 100: a session either failed or was abandoned, so
   * the 30% and the 20% cannot both be a full share of the same sessions. The four
   * components do each reach 1 — the weights add to a whole unit, which the configuration
   * test asserts — and this is the worst any real set of sessions can be.
   */
  it('scores the worst a run can be at 80, every component at its maximum', () => {
    const worst = scoreMini([
      { status: 'failed', seconds: null, returns: 6 },
      { status: 'failed', seconds: null, returns: 6 },
    ]);
    expect(worst.components.taskFailureRate).toBe(1);
    expect(worst.components.timeToFirstFixationPrimary.value).toBe(1);
    expect(worst.components.deadEndRevisits).toBe(1);
    expect(worst.frictionScore.median).toBeCloseTo(80, 10);
    expect(worst.completionRate).toBe(0);
  });

  it('puts the components, the counts and the scored count in the contract shape', () => {
    const scored = scoreMini([
      { status: 'success', seconds: 1.2, returns: 1 },
      { status: 'abandoned', seconds: 2.4, returns: 3 },
    ]);
    expect(Object.keys(scored).sort()).toEqual([
      'completionRate',
      'components',
      'frictionScore',
      'outcomeCounts',
      'perSeedGroup',
      'scoredSessionCount',
      'taskId',
      'variant',
    ]);
    expect(scored.taskId).toBe(fixtureTask.id);
    expect(scored.scoredSessionCount).toBe(2);
    expect(scored.outcomeCounts).toEqual({
      success: 1,
      abandoned: 1,
      failed: 0,
      automationFailure: 0,
    });
    expect(scored.completionRate).toBe(0.5);
  });

  it('scores one entry per variant and ignores the sessions of another task', () => {
    const otherTask = fixtureSessions.map((session) => ({ ...session, taskId: 'something-else' }));
    const scores = score(
      [...fixtureSessions, ...otherTask],
      fixtureAois,
      fixtureAoiMetrics,
      fixtureTask,
    );
    expect(scores.map((entry) => entry.variant)).toEqual(['A', 'B']);
    expect(scores.map((entry) => entry.scoredSessionCount)).toEqual([11, 11]);
  });

  it('never leaves the 0-100 scale the contract types it on', () => {
    for (const rows of [
      [{ status: 'success' as const, seconds: 0, returns: 0 }],
      [{ status: 'failed' as const, seconds: null, returns: 40 }],
      [
        { status: 'abandoned' as const, seconds: 5.9, returns: 4 },
        { status: 'failed' as const, seconds: null, returns: 5 },
      ],
    ]) {
      const scored = scoreMini(rows);
      expect(scored.frictionScore.median).toBeGreaterThanOrEqual(0);
      expect(scored.frictionScore.median).toBeLessThanOrEqual(100);
    }
  });

  it('writes rows the artifact contract accepts, counts and completion rate included', () => {
    // The contract holds `completionRate` to the outcome counts and the counts to
    // `scoredSessionCount`, so parsing a run built on these scores is what proves the
    // three agree — not a type, which cannot see a number.
    const parsed = runSchema.safeParse(buildFixtureRun(fixtureScores()));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('changes none of its inputs', () => {
    const before = structuredClone({ fixtureSessions, fixtureAois, fixtureAoiMetrics });
    fixtureScores();
    expect({ fixtureSessions, fixtureAois, fixtureAoiMetrics }).toEqual(before);
  });
});

describe('automation failures', () => {
  const clean: readonly MiniRow[] = [
    { status: 'success', seconds: 1.5, returns: 1, seed: 7 },
    { status: 'abandoned', seconds: 2.5, returns: 3, seed: 7 },
  ];

  it('change no score and no component, and appear only in the outcome counts', () => {
    const without = scoreMini(clean);
    const withOne = scoreMini([
      ...clean,
      { status: 'automation_failure', seconds: null, returns: 4, seed: 7 },
    ]);

    expect(withOne.components).toEqual(without.components);
    expect(withOne.frictionScore).toEqual(without.frictionScore);
    expect(withOne.completionRate).toBe(without.completionRate);
    expect(withOne.scoredSessionCount).toBe(without.scoredSessionCount);
    expect(withOne.perSeedGroup).toEqual(without.perSeedGroup);
    expect(withOne.outcomeCounts).toEqual({ ...without.outcomeCounts, automationFailure: 1 });
  });

  it('leave a variant out of the scores entirely when they are all it has', () => {
    expect(
      score(
        miniSessions([{ status: 'automation_failure', seconds: null, returns: 0 }]),
        fixtureAois,
        fixtureAoiMetrics,
        fixtureTask,
      ),
    ).toEqual([]);
  });

  it('are refused when the session says it was scored anyway', () => {
    expect(() =>
      scoreMini([
        { status: 'automation_failure', seconds: null, returns: 0, excludedFromScores: false },
      ]),
    ).toThrow(/excludedFromScores: false/);
  });

  it('are refused the other way round too: an excluded session with a product outcome', () => {
    // `outcomeCounts` has one field for an excluded session, and it is named after the
    // automation. A session excluded while reporting that somebody gave up would be
    // published as our failure and dropped from the share that gave up.
    expect(() =>
      scoreMini([
        { status: 'success', seconds: 0, returns: 0 },
        { status: 'abandoned', seconds: 0, returns: 0, excludedFromScores: true },
      ]),
    ).toThrow(/only an automation failure is excluded/);
  });
});

describe('a variant that mixes simulated and real sessions', () => {
  it('is refused, because a session in no seed group cannot be in the median', () => {
    expect(() =>
      scoreMini([
        { status: 'success', seconds: 0, returns: 0, seed: 1 },
        { status: 'success', seconds: 6, returns: 0 },
      ]),
    ).toThrow(/carries no seed while others of the same variant do/);
  });
});

describe('the spread across seed groups', () => {
  it('reports the median of the group scores with their sample standard deviation', () => {
    // Three groups of one session each, differing only in how long the button took to
    // find: 1.8s, 3s and 4.2s, which are 0.105, 0.175 and 0.245 of the score.
    const scored = scoreMini([
      { status: 'success', seconds: 1.8, returns: 0, seed: 11 },
      { status: 'success', seconds: 3, returns: 0, seed: 12 },
      { status: 'success', seconds: 4.2, returns: 0, seed: 13 },
    ]);
    expect(scored.perSeedGroup).toEqual([
      { seed: 11, frictionScore: 10.5 },
      { seed: 12, frictionScore: 17.5 },
      { seed: 13, frictionScore: 24.5 },
    ]);
    expect(scored.frictionScore.median).toBeCloseTo(17.5, 10);
    expect(scored.frictionScore.sd).toBeCloseTo(7, 10);
  });

  it('carries one entry per seed group, in seed order, whatever order the sessions arrived in', () => {
    const scored = scoreMini([
      { status: 'success', seconds: 3, returns: 0, seed: 3 },
      { status: 'success', seconds: 3, returns: 0, seed: 1 },
      { status: 'abandoned', seconds: 3, returns: 0, seed: 2 },
      { status: 'success', seconds: 3, returns: 0, seed: 1 },
    ]);
    expect(scored.perSeedGroup.map((group) => group.seed)).toEqual([1, 2, 3]);
  });

  it('reports no spread for a single seed group', () => {
    const scored = scoreMini([{ status: 'success', seconds: 3, returns: 0, seed: 4 }]);
    expect(scored.perSeedGroup).toHaveLength(1);
    expect(scored.frictionScore.sd).toBe(0);
  });

  it('names no group for sessions that carry no seed, and scores them as one set', () => {
    const scored = scoreMini([
      { status: 'success', seconds: 3, returns: 0 },
      { status: 'abandoned', seconds: 3, returns: 0 },
    ]);
    expect(scored.perSeedGroup).toEqual([]);
    expect(scored.frictionScore.median).toBeCloseTo(100 * (0.2 * 0.5 + 0.35 * 0.5), 10);
    expect(scored.frictionScore.sd).toBe(0);
  });
});

describe('the committed fixture sets', () => {
  it('are valid against the artifact contract session schema, every one of them', () => {
    for (const session of fixtureSessions) {
      expect(() => sessionSchema.parse(session)).not.toThrow();
    }
    expect(fixtureSessions).toHaveLength(24);
  });

  it('carry the planted defect the whole demo turns on: a control nobody ever saw', () => {
    const row = fixtureAoiMetrics.find((metric) => metric.aoiId === 'b-review-place-order');
    expect(row?.timeToFirstFixationMs).toBeNull();
    expect(row?.lookedAtShare).toBe(0);
    // Every other variant's control was found, or the fixture would not be testing a
    // difference between the two checkouts.
    const found = fixtureAoiMetrics.find((metric) => metric.aoiId === 'a-review-place-order');
    expect(found?.timeToFirstFixationMs).not.toBeNull();
  });

  it('declare the three planted defects against the areas that carry them', () => {
    expect(plantedDefects.map((defect) => defect.aoiId)).toEqual([
      'b-review-place-order',
      'b-review-fee-row',
      'b-cart-promo',
    ]);
    for (const defect of plantedDefects) {
      expect(fixtureAois.some((aoi) => aoi.id === defect.aoiId)).toBe(true);
      expect(FINDING_RULE_IDS).toContain(defect.ruleId);
    }
  });

  it('read the outcome counts the score breakdown screen shows', () => {
    const scores = fixtureScores();
    expect(forVariant(scores, 'A').outcomeCounts).toEqual({
      success: 9,
      abandoned: 2,
      failed: 0,
      automationFailure: 1,
    });
    expect(forVariant(scores, 'B').outcomeCounts).toEqual({
      success: 2,
      abandoned: 6,
      failed: 3,
      automationFailure: 1,
    });
  });

  it('read the review step as the worst, with a null where nobody looked', () => {
    const scores = fixtureScores();
    expect(forVariant(scores, 'A').components.timeToFirstFixationPrimary).toEqual({
      worstStep: 'review',
      medianSeconds: 2.4,
      value: expect.closeTo(0.4, 10),
    });
    // The card reads "never" with a full bar here, which is this null together with a
    // component of exactly 1.0: a zero, or no field at all, would make it read wrong.
    expect(forVariant(scores, 'B').components.timeToFirstFixationPrimary).toEqual({
      worstStep: 'review',
      medianSeconds: null,
      value: 1,
    });
  });

  it('keep one group score per seed group, so the spread is auditable', () => {
    const scores = fixtureScores();
    expect(forVariant(scores, 'A').perSeedGroup).toEqual([
      { seed: 1, frictionScore: 22 },
      { seed: 2, frictionScore: 23.5 },
      { seed: 3, frictionScore: 18.5 },
    ]);
    const defective = forVariant(scores, 'B').perSeedGroup;
    expect(defective.map((group) => group.seed)).toEqual([1, 2, 3]);
    expect(defective.map((group) => group.frictionScore)).toEqual([
      expect.closeTo(64.5, 10),
      expect.closeTo(63.333333, 5),
      expect.closeTo(72, 10),
    ]);
  });
});

describe("section 5's acceptance table, over the committed fixtures", () => {
  const scores = fixtureScores();
  const clean = forVariant(scores, 'A');
  const defective = forVariant(scores, 'B');

  it('scores the clean checkout at or under 25', () => {
    expect(clean.frictionScore.median).toBeLessThanOrEqual(CLEAN_AT_MOST);
    expect(clean.frictionScore.median).toBeCloseTo(22, 10);
  });

  it('scores the defective checkout at or over 60', () => {
    expect(defective.frictionScore.median).toBeGreaterThanOrEqual(DEFECTIVE_AT_LEAST);
    expect(defective.frictionScore.median).toBeCloseTo(64.5, 10);
  });

  it('separates the two by at least 30 points, with bands that do not overlap', () => {
    const gap = defective.frictionScore.median - clean.frictionScore.median;
    expect(gap).toBeGreaterThanOrEqual(SEPARATED_BY_AT_LEAST);
    const cleanTop = clean.frictionScore.median + clean.frictionScore.sd;
    const defectiveFloor = defective.frictionScore.median - defective.frictionScore.sd;
    expect(cleanTop).toBeLessThan(defectiveFloor);
  });

  it('holds in all three seed groups, not only in the medians', () => {
    expect(clean.perSeedGroup).toHaveLength(3);
    expect(defective.perSeedGroup).toHaveLength(3);
    const worstClean = Math.max(...clean.perSeedGroup.map((group) => group.frictionScore));
    const bestDefective = Math.min(...defective.perSeedGroup.map((group) => group.frictionScore));
    expect(worstClean).toBeLessThanOrEqual(CLEAN_AT_MOST);
    expect(bestDefective).toBeGreaterThanOrEqual(DEFECTIVE_AT_LEAST);
  });

  it('completes on the clean checkout and not on the defective one', () => {
    expect(clean.completionRate).toBeGreaterThanOrEqual(0.6);
    expect(defective.completionRate).toBeLessThanOrEqual(0.3);
    expect(clean.completionRate).toBeCloseTo(9 / 11, 12);
    expect(defective.completionRate).toBeCloseTo(2 / 11, 12);
  });

  it('is measured on the sessions this ticket commits, both variants', () => {
    expect(cleanVariantSessions).toHaveLength(12);
    expect(defectiveVariantSessions).toHaveLength(12);
  });
});

describe('the functions this package has agreed to export but has not built', () => {
  // The findings generator was one of these until #28 built it, and the planted-defect
  // evaluation until #29; `test/findings.test.ts` and `test/evaluate.test.ts` now hold
  // those two to the contract instead of to an error message.

  it('names the ticket that fills the verdict', () => {
    expect(() => verdict([], [], {} as never)).toThrow(/#27/);
  });
});
