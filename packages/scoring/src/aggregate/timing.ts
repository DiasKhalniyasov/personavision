import type { FunnelSlice, Run } from '@personavision/contract';
import type { FunnelSliceSpec } from './sessions.js';

/**
 * The timing of one slice: the whole session end to end, the time per step, and the slowest
 * sessions with the step the time went on — all of it as a distribution rather than a mean,
 * so a slow tail is not hidden by an average (`docs/FLOW.md` section 14.5).
 *
 * The quantiles, the bins and the rounding are `sessions.ts`'s and are not redefined in the
 * body that fills this: the median the timing table prints and the median the heatmaps
 * panel prints are one function called twice. The per-step spans are its step walk, so this
 * figure cannot disagree with the funnel about which step a second belonged to.
 */

/**
 * What the timing is given. **#290 settles the rest of this shape in this file**; the barrel
 * re-exports it by name, so adding to it costs that file no edit.
 */
export interface TimingInput {
  /** The run, read for `steps` and their declared order. */
  readonly run: Run;
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #290 implements: the whole `timing` block of a stored slice. */
export type TimingBuilder = (input: TimingInput) => FunnelSlice['timing'];

/**
 * Not built yet: **#290** fills this in.
 */
export const timingOfSlice: TimingBuilder = () => {
  throw new Error(
    'timingOfSlice() is not implemented yet: the time-per-step distribution and the slowest sessions are ticket #290',
  );
};
