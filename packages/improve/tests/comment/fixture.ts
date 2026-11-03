import type { HoldoutFigures, Improve, Run } from '@personavision/contract';
import { validRun } from '../../../contract/tests/fixtures.js';

/**
 * A path-2 run to write a comment from: the contract's own valid run, plus the `improve`
 * block, the holdout and the before/after figures `docs/design/prototype.html`'s
 * `#screen-improve` prints — 41% against 58%, with the holdout at 55%.
 *
 * The figures are the prototype's so that a reader can hold the comment this package
 * writes against the screen the same run draws. They are also the figures the tests assert
 * field by field, which is why the counts under each rate are spelled out rather than
 * derived: a rate and the population behind it are one claim, and `runSchema` refuses them
 * when they disagree.
 */

export const RUN_URL = 'https://app.personavision.example/runs/2026-10-24-1402-northwind-demo';

export const PULL_REQUEST = {
  repository: 'clipforge/web',
  number: 482,
  url: 'https://github.com/clipforge/web/pull/482',
  title: 'Show the expected wait before Generate',
} as const;

/** 38 of 93 finished: 0.41 to the two decimal places the contract holds a rate to. */
export const BASELINE_FIGURES = {
  completionRate: 0.41,
  outcomeCounts: { success: 38, abandoned: 33, failed: 22, automationFailure: 1 },
  scoredSessionCount: 93,
} as const;

/** 55 of 95 finished on the pull request's version. */
export const CHANGE_FIGURES = {
  completionRate: 0.58,
  outcomeCounts: { success: 55, abandoned: 25, failed: 15, automationFailure: 1 },
  scoredSessionCount: 95,
} as const;

/** 22 of 40 of the people the change was never chosen against. */
export const HOLDOUT_FIGURES: HoldoutFigures = {
  completionRate: 0.55,
  outcomeCounts: { success: 22, abandoned: 12, failed: 6, automationFailure: 0 },
  scoredSessionCount: 40,
};

/**
 * The person held out, who is a person **beside** the participant the run fixture's
 * audience generates: `audience.size` is the participants and the holdout is people the run
 * generated as well as them, which is the count the contract holds a path-2 run to (#306).
 */
const HELD_OUT_ID = 'held-out-1';

const IMPROVE: Improve = {
  recommendationId: 'R-01',
  changedFile: 'app/waiting/page.tsx',
  pullRequest: { ...PULL_REQUEST },
  preview: { url: 'https://clipforge-web-git-pv-wait.preview.example/upload' },
  baselineVariant: 'A',
  changeVariant: 'B',
  holdout: { personaIds: [HELD_OUT_ID], confirmed: true },
};

/** The fixture run as a path-2 test, with the holdout's verdict the caller asks for. */
export const runWithChange = (
  options: { readonly holdout?: 'confirmed' | 'not_confirmed' | 'none' } = {},
): Run => {
  const holdout = options.holdout ?? 'confirmed';
  const run = validRun();
  run.improve = structuredClone({
    ...IMPROVE,
    holdout: {
      personaIds: holdout === 'none' ? [] : [HELD_OUT_ID],
      confirmed: holdout === 'none' ? null : holdout === 'confirmed',
    },
  });
  if (holdout !== 'none') {
    const [first] = run.personas;
    if (first === undefined) throw new Error('the run fixture generates nobody');
    run.personas = [
      ...run.personas,
      { ...structuredClone(first), id: HELD_OUT_ID, name: `${first.name} (holdout)` },
    ];
  }
  run.verdict.holdout = holdout;
  Object.assign(run.scores[0], structuredClone(BASELINE_FIGURES));
  Object.assign(run.scores[1], structuredClone(CHANGE_FIGURES));
  if (holdout !== 'none') run.scores[1].holdout = { ...HOLDOUT_FIGURES };
  return run;
};
