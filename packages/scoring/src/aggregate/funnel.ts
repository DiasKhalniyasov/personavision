import type { FunnelSlice, Run } from '@personavision/contract';
import type { FunnelSliceSpec } from './sessions.js';

/**
 * The funnel of one slice: one row per step in the order `run.json` declares them — how
 * many reached it, how many completed it, how many abandoned there and how many failed
 * there — with the step that lost the most people and the commonest stored reason among
 * them (`docs/FLOW.md` section 14, and the funnel rows of `#screen-funnel`).
 *
 * Declared here before it is built, so that the three figure tickets of this step run at
 * the same time: each replaces one body in its own file and none of them edits `index.ts`
 * or the package barrel.
 */

/**
 * What the funnel is given: the run, for the steps and their order, and one slice with the
 * sessions left after its filter. **#289 settles the rest of this shape in this file** —
 * `index.ts` re-exports it by name, so adding a field costs that file no edit.
 */
export interface FunnelInput {
  /** The run, read for `steps` and their declared order and for nothing else. */
  readonly run: Run;
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #289 implements: the two funnel fields of a stored slice. */
export type FunnelBuilder = (input: FunnelInput) => Pick<FunnelSlice, 'funnel' | 'biggestDrop'>;

/**
 * Not built yet: **#289** fills this in, beside the paths that read the same walk.
 */
export const funnelOfSlice: FunnelBuilder = () => {
  throw new Error(
    'funnelOfSlice() is not implemented yet: the funnel by step and its biggest drop are ticket #289',
  );
};
