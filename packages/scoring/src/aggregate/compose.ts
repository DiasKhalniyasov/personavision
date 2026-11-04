import { SCHEMA_VERSION, type Aggregate, type Run, type Session } from '@personavision/contract';
import { funnelOfSlice } from './funnel.js';
import { pathsOfSlice } from './paths.js';
import { screenFiguresOfSlice } from './screens.js';
import { funnelSliceSpecs, scoredSessions, screenSliceSpecs } from './sessions.js';
import { timingOfSlice } from './timing.js';

/**
 * The aggregate itself: the function the pipeline calls when a run is aggregated, which
 * composes the figure modules into the one `aggregate.json` the two filtered screens of the
 * results page read.
 *
 * It adds nothing of its own except the file's own fields and the properties that only
 * exist across figures — that the completion rate it implies agrees with the one already in
 * `run.json`'s `scores[]`, that the slices sum to the whole, and that composing twice over
 * the same sessions gives the same bytes.
 */

/**
 * What the composer is given. **#292 settles the rest of this shape in this file**; the
 * barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface AggregateInput {
  /** The run: its id, its status, its steps, its people and its areas of interest. */
  readonly run: Run;
  /** The sessions on disk at this moment, automation failures among them. */
  readonly sessions: readonly Session[];
  /** When it was computed, passed in rather than read from a clock: this package is pure. */
  readonly computedAt: string;
}

/** The signature #292 implements. */
export type AggregateComposer = (input: AggregateInput) => Aggregate;

/**
 * The aggregate of a run, over the sessions that exist at this moment.
 *
 * Four properties are held by how this is written, rather than by anything it computes:
 *
 * - **Agreement with the summary.** Every figure is of `scoredSessions`, which is the same
 *   exclusion the scoring step applies when it writes `run.json`'s `scores[]`, so the
 *   completion rate the funnel of a version implies is the `completionRate` already stored
 *   in that version's row. Nothing is recounted here, which is what makes the two agree.
 * - **The slices sum to the whole.** The enumerations own that: a session falls in exactly
 *   one segment and exactly one outcome, and a slice's figures are the figures of its own
 *   sessions because the builders are handed nothing else.
 * - **Determinism.** Key order is the order of these literals, slices are in the order the
 *   enumerations declare, and every number is rounded by the module that produced it — so
 *   composing twice over the same sessions serialises to the same bytes.
 * - **An open run.** `runStatus` is the run's own status, so a reader is never told a
 *   partial figure is final, and the counts are of the sessions it was handed.
 *
 * A run with nothing scored yet — no sessions at all, or every one of them an automation
 * failure — composes into zero counts, the failures reported, and no slices: a filter
 * button over nobody is not a button, and a figure nobody measured is never a zero.
 */
export const composeAggregate: AggregateComposer = ({ run, sessions, computedAt }) => {
  const { sessions: scored, excludedAutomationFailures } = scoredSessions(sessions);

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: run.runId,
    computedAt,
    // `run.json`'s own status is optional — a run written before that step recorded none —
    // and this field is required, because a reader of the file must never be told a partial
    // figure is final. A run that records no status reads as `open` for exactly that
    // reason: of the three, it is the one that claims nothing is finished.
    runStatus: run.status ?? 'open',
    scoredSessionCount: scored.length,
    excludedAutomationFailures,
    // Every key written out in order rather than spread from a builder, so that the bytes
    // of the file are fixed here and not by the shape of whatever a figure module returns.
    funnelSlices: funnelSliceSpecs(run, sessions).map((slice) => {
      const { funnel, biggestDrop } = funnelOfSlice({ run, slice });
      return {
        key: slice.key,
        variant: slice.variant,
        segment: slice.segment,
        label: slice.label,
        sessionCount: slice.sessions.length,
        funnel,
        biggestDrop,
        timing: timingOfSlice({ run, slice }),
        paths: pathsOfSlice({ slice }),
      };
    }),
    screenSlices: screenSliceSpecs(run, sessions).map((slice) => ({
      key: slice.key,
      segment: slice.segment,
      outcome: slice.outcome,
      label: slice.label,
      sessionCount: slice.sessions.length,
      screens: screenFiguresOfSlice({ run, slice }),
    })),
  };
};
