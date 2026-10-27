import type { Run, Session } from '@personavision/contract';
import { reachedStep } from './useAttentionStepSessions';

/**
 * How many of the audience got as far as each step of the run — the one derivation the step
 * filmstrip is made of.
 *
 * The funnel's thinning is the first thing this screen says, before a single heatmap is
 * read, so the counting has to be done once and in a place a test can hold still. Two rules
 * are in it, and both are the screen's rules everywhere else:
 *
 * - **A session reached a step when it stood on one of that step's screens.** `screens[]` is
 *   the record of where somebody actually was; a step named in the plan that no screen of
 *   the session carries was never reached.
 * - **Scored sessions only.** A session our own automation broke is not evidence about
 *   anybody's checkout, so it is excluded here exactly as it is excluded from every figure
 *   in the run (`docs/FLOW.md` section 3) — and exactly as `useAttentionStepSessions`
 *   excludes it for the overlays. The pipeline decided exclusion once and wrote
 *   `outcome.excludedFromScores`; this never re-decides it.
 *
 * Every step of the artifact gets a row, in the artifact's own order, including a step
 * nobody reached: zero is a finding — nobody got this far — and a row quietly left out
 * would read as a step the test never ran.
 *
 * Nothing here is the denominator. How many people the version's figures are an aggregate
 * of is the run's own `scores[].scoredSessionCount`, which the screen prints beside these
 * counts rather than counting for itself.
 */

export interface StepReach {
  /** The step, as `run.json` records it: the id the URL carries and the label a reader sees. */
  readonly step: Run['steps'][number];
  /** How many scored sessions of the version asked for stood on one of its screens. */
  readonly reached: number;
}

export function reachCounts(
  steps: Run['steps'],
  sessions: readonly Session[],
  variant: string,
): readonly StepReach[] {
  const scored = sessions.filter(
    (session) => session.variant === variant && !session.outcome.excludedFromScores,
  );

  return steps.map((step) => ({
    step,
    reached: scored.filter((session) => reachedStep(session, step.id)).length,
  }));
}
