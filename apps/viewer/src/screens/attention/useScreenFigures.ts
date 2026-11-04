import { useMemo } from 'react';
import type { Aggregate, ScreenSlice } from '@personavision/contract';
import { useAggregate, useCurrentRunId } from '@/shell/useRun';
import type { AggregateState } from '@/shell/useRun';
import { pickScreenSlice, screenFiguresOf } from './screenSlices';
import type { ScreenFigures } from './screenSlices';

/**
 * Every figure the Heatmaps screen prints, for the composition the reader chose: one read of
 * `aggregate.json`, one slice picked out of it, one row read out of the slice.
 *
 * The screen's whole promise is in the `status` below, which is why it has six values rather
 * than three. Each of them is something different about the audience, and the screen says a
 * different sentence for each — because the alternative is drawing an empty frame and
 * letting a reader decide for themselves whether it means *nobody did this* or *we did not
 * measure it*. `docs/FLOW.md` section 8 forbids exactly that confusion.
 *
 * - `loading` — the file is still coming back. No figure is printed, and none is guessed.
 * - `none` — this run computed **no aggregate**. The clicks and scroll-depth overlays are
 *   still offered and say so (decision 74); the attention overlay, which reads the sessions
 *   rather than this file, keeps working.
 * - `unreadable` — there is a file and it is broken. Named, with the problem.
 * - `no-people` — the aggregate holds no slice for this composition, which means **no
 *   session satisfies both filters**: a run can have phone people and failed people and
 *   nobody who is both.
 * - `no-screen` — these people exist, and none of them reached this step on this version.
 * - `ready` — the figures are in hand.
 */
export type ScreenFiguresStatus =
  | 'loading'
  | 'none'
  | 'unreadable'
  | 'no-people'
  | 'no-screen'
  | 'ready';

export interface ScreenFiguresView {
  readonly status: ScreenFiguresStatus;
  /** The slice the two filters name, or `null` when there is none to name. */
  readonly slice: ScreenSlice | null;
  /** This version's step inside that slice, or `null`. Every figure on screen is read here. */
  readonly figures: ScreenFigures | null;
  /** How many people the composition narrows the run to, as the slice states it. */
  readonly sessionCount: number | null;
  /** The whole run's figures, whatever the filters are: the denominator of the strips. */
  readonly scoredSessionCount: number | null;
  /** How many sessions our own harness broke, which no figure here is about. */
  readonly excludedAutomationFailures: number | null;
  /** The aggregate itself, for the filter strips' own options. `null` unless readable. */
  readonly aggregate: Aggregate | null;
  /** What is wrong with the file, when `status` is `unreadable`. */
  readonly problem: string | null;
}

const EMPTY = {
  slice: null,
  figures: null,
  sessionCount: null,
  scoredSessionCount: null,
  excludedAutomationFailures: null,
  aggregate: null,
  problem: null,
} as const;

/**
 * What a caller with no aggregate to read hands the layers: no file, stated as such.
 *
 * The Verdict screen builds the stage to mount the attention layer alone (#125) and has no
 * filters and no aggregate read of its own, and a test of one layer has none either. It is
 * `none` rather than `loading`, because a screen that is never going to read an aggregate is
 * not waiting for one — `loading` would leave the clicks layer saying "still reading this
 * test's figures" for ever.
 */
export const NO_AGGREGATE: ScreenFiguresView = { ...EMPTY, status: 'none' };

/**
 * The view of one aggregate state, for one composition. Pure, so the six statuses can be
 * asserted without a router or a server.
 */
export function screenFiguresFrom(
  state: AggregateState,
  variant: string,
  step: string,
  segment: string | null,
  outcome: string | null,
): ScreenFiguresView {
  switch (state.status) {
    case 'loading':
      return { ...EMPTY, status: 'loading' };
    case 'none':
      return { ...EMPTY, status: 'none' };
    case 'unreadable':
      return { ...EMPTY, status: 'unreadable', problem: state.problem };
    case 'ready': {
      const { aggregate } = state;
      const run = {
        aggregate,
        scoredSessionCount: aggregate.scoredSessionCount,
        excludedAutomationFailures: aggregate.excludedAutomationFailures,
      };
      const slice = pickScreenSlice(aggregate, segment, outcome);
      if (slice === null) {
        return { ...EMPTY, ...run, status: 'no-people' };
      }
      const figures = screenFiguresOf(slice, variant, step);
      return {
        ...run,
        status: figures === null ? 'no-screen' : 'ready',
        slice,
        figures,
        sessionCount: slice.sessionCount,
        problem: null,
      };
    }
  }
}

/**
 * The figures of this version's step, for these filters, from the run the route is about.
 *
 * One read per run while the app is open (`useAggregate`), so moving step, moving version
 * and changing either filter all re-read the same file in memory rather than asking the
 * server again — which is the point of storing it pre-sliced.
 */
export function useScreenFigures(
  variant: string,
  step: string,
  segment: string | null,
  outcome: string | null,
): ScreenFiguresView {
  // The route this hook is mounted on is `/runs/:runId/attention/:variant/:step`, so there
  // is always a run to read: the fallback is what a hook cannot avoid writing, not a case
  // this screen has.
  const state = useAggregate(useCurrentRunId() ?? '');
  return useMemo(
    () => screenFiguresFrom(state, variant, step, segment, outcome),
    [state, variant, step, segment, outcome],
  );
}
