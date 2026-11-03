/**
 * The holdout's figures on each score (#303).
 *
 * A path-2 run drives people the change was never chosen against through both sides, and the
 * Improve screen prints their completion rate as a third figure beside the baseline's and the
 * change's (`docs/FLOW.md` section 15, point 4). What is asserted here is that the figure has
 * those people behind it: the same arithmetic as the two beside it, the automation failures
 * excluded exactly as they are excluded everywhere else, and the row's own figures left to
 * the main set rather than pooled with the holdout.
 *
 * Whether the holdout *confirmed* the gain is read off these figures by #304. Nothing here
 * judges it.
 */

import { runSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { score } from '../src/index.js';
import { buildSession } from './fixtures/build.js';
import {
  buildFixtureRun,
  fixtureAoiMetrics,
  fixtureAois,
  fixtureSessions,
  fixtureTask,
} from './fixtures/index.js';
import type { Run, Session } from '@personavision/contract';
import type { VariantScore } from '../src/index.js';

/** One of the four people the change was never chosen against, named as the generator names them. */
const HELD_OUT_IDS = ['holdout-P-1', 'holdout-P-2', 'holdout-P-3', 'holdout-P-4'];

interface HoldoutRow {
  readonly variant: string;
  readonly personaId: string;
  readonly status: Session['outcome']['status'];
  readonly seed: number;
}

/**
 * A holdout session, built like any other fixture session and then renamed onto the person
 * it belongs to: `buildSession` knows the fixture's four people, and a holdout person is one
 * of them under the marked id the generator gives them.
 */
const holdoutSession = (row: HoldoutRow, position: number): Session => {
  const built = buildSession(
    {
      sessionId: `H-${String(position + 1).padStart(2, '0')}`,
      variant: row.variant,
      seed: row.seed,
      personaId: 'P-1',
      status: row.status,
      steps: [{ step: 'review', primaryAfterSeconds: 1.5, deadEndReturns: 1 }],
    },
    fixtureAois,
  );
  return {
    ...built,
    persona: built.persona === null ? null : { ...built.persona, id: row.personaId },
  };
};

/**
 * Four holdout people on each side, on seeds the main set's three groups do not contain.
 *
 * Variant A: three completed and one gave up. Variant B: one completed, two failed, and one
 * was our own harness breaking — the figures below are those counts and nothing else.
 */
const HOLDOUT_SESSIONS: readonly Session[] = (
  [
    { variant: 'A', personaId: 'holdout-P-1', status: 'success', seed: 8_117 },
    { variant: 'A', personaId: 'holdout-P-2', status: 'success', seed: 2_399 },
    { variant: 'A', personaId: 'holdout-P-3', status: 'success', seed: 4_041 },
    { variant: 'A', personaId: 'holdout-P-4', status: 'abandoned', seed: 7_777 },
    { variant: 'B', personaId: 'holdout-P-1', status: 'success', seed: 8_117 },
    { variant: 'B', personaId: 'holdout-P-2', status: 'failed', seed: 2_399 },
    { variant: 'B', personaId: 'holdout-P-3', status: 'failed', seed: 4_041 },
    { variant: 'B', personaId: 'holdout-P-4', status: 'automation_failure', seed: 7_777 },
  ] satisfies readonly HoldoutRow[]
).map(holdoutSession);

const withHoldout = (): VariantScore[] =>
  score(
    [...fixtureSessions, ...HOLDOUT_SESSIONS],
    fixtureAois,
    fixtureAoiMetrics,
    fixtureTask,
    HELD_OUT_IDS,
  );

const rowFor = (scores: readonly VariantScore[], variant: string): VariantScore => {
  const row = scores.find((one) => one.variant === variant);
  if (row === undefined) throw new Error(`no score row for variant "${variant}"`);
  return row;
};

describe('the holdout’s figures on a score', () => {
  it('carries the completion rate, the scored count and the four outcomes, for the holdout alone', () => {
    const scores = withHoldout();

    expect(rowFor(scores, 'A').holdout).toEqual({
      completionRate: 3 / 4,
      outcomeCounts: { success: 3, abandoned: 1, failed: 0, automationFailure: 0 },
      scoredSessionCount: 4,
    });
    // The automation failure is excluded from the holdout exactly as it is excluded
    // everywhere else: three scored sessions, and the failure counted beside them.
    expect(rowFor(scores, 'B').holdout).toEqual({
      completionRate: 1 / 3,
      outcomeCounts: { success: 1, abandoned: 0, failed: 2, automationFailure: 1 },
      scoredSessionCount: 3,
    });
  });

  it('leaves the row’s own figures to the main set, untouched by the holdout', () => {
    const before = score(fixtureSessions, fixtureAois, fixtureAoiMetrics, fixtureTask);

    const after = withHoldout().map((row) => {
      const pooled: Record<string, unknown> = { ...row };
      delete pooled.holdout;
      return pooled;
    });

    // Byte for byte: the friction score, its components, its bands and its seed groups are
    // the people the change was chosen on, and a holdout read beside them changes none of
    // them. A row that pooled the two would compare a set with a superset of itself.
    expect(after).toEqual(before);
    expect(rowFor(withHoldout(), 'A').perSeedGroup.map((group) => group.seed)).toEqual([1, 2, 3]);
  });

  it('leaves a run that ran no holdout exactly as it was scored before', () => {
    const scores = score(fixtureSessions, fixtureAois, fixtureAoiMetrics, fixtureTask);

    expect(scores).toEqual(score(fixtureSessions, fixtureAois, fixtureAoiMetrics, fixtureTask, []));
    for (const row of scores) expect('holdout' in row).toBe(false);
  });

  it('leaves the holdout’s automation-failure share readable from its own two counters', () => {
    const figures = rowFor(withHoldout(), 'B').holdout;

    // A quarter of the holdout's sessions on this side were our harness, not the site. What
    // the threshold is, and what a run says above its summary when it crosses it, belong to
    // `@personavision/contract` and to its own ticket; what is asserted here is that the
    // share is computable from the figures stored beside the people.
    const failures = figures?.outcomeCounts.automationFailure ?? 0;
    const sessions = failures + (figures?.scoredSessionCount ?? 0);
    expect(failures / sessions).toBe(0.25);
    expect(failures / sessions).toBeGreaterThan(0.2);
  });

  it('reads back through the contract beside the holdout the run recorded', () => {
    const base = buildFixtureRun(withHoldout(), {
      ...buildFixtureRun([]).verdict,
      holdout: 'confirmed',
    });
    const run: Run = {
      ...base,
      // "A holdout is people the run generated": the four held-out people are the run's own
      // personas, marked, beside the four the change was chosen on.
      audience: { ...base.audience, size: base.personas.length + HELD_OUT_IDS.length },
      personas: [
        ...base.personas,
        ...HELD_OUT_IDS.map((id, index) => ({
          ...(base.personas[index] as Run['personas'][number]),
          id,
          name: `${String(base.personas[index]?.name)} (holdout)`,
        })),
      ],
      sessionIds: [...base.sessionIds, ...HOLDOUT_SESSIONS.map((session) => session.sessionId)],
      improve: {
        recommendationId: 'R-1',
        changedFile: 'src/checkout/Review.tsx',
        pullRequest: {
          repository: 'northwind/shop',
          number: 41,
          url: 'https://github.test/northwind/shop/pull/41',
          title: 'Move Place order above the fold',
        },
        preview: { url: 'https://preview.test/pr-41' },
        baselineVariant: 'A',
        changeVariant: 'B',
        holdout: { personaIds: HELD_OUT_IDS, confirmed: true },
      },
    };

    const parsed = runSchema.safeParse(run);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('is refused by the contract when the figures are about nobody', () => {
    // The mirror of the test above, and the reason the figures are produced here rather
    // than anywhere a holdout list is not: a run with holdout figures and no holdout is a
    // third figure about nobody.
    const parsed = runSchema.safeParse(buildFixtureRun(withHoldout()));

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toContain(
      'this run ran no holdout',
    );
  });
});
