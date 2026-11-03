import type { Aggregate, Run, Session } from '@personavision/contract';

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
 * Not built yet: **#292** fills this in, over the three figure modules beside it.
 */
export const composeAggregate: AggregateComposer = () => {
  throw new Error(
    'composeAggregate() is not implemented yet: composing the aggregate from the figures is ticket #292',
  );
};
