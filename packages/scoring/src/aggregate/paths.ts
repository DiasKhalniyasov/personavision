import type { FunnelSlice } from '@personavision/contract';
import type { FunnelSliceSpec } from './sessions.js';

/**
 * The common paths of one slice: the sequence of step ids each session actually walked, in
 * screen order and with its repeats — a revisit is part of the route, which is the point of
 * the figure — counted, and kept only where more than one session walked it, so *common
 * paths* is common paths and not a hundred unique ones.
 *
 * Declared here before it is built, beside the funnel that reads the same walk.
 */

/**
 * What the paths figure is given. **#289 settles the rest of this shape in this file**; the
 * barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface PathsInput {
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #289 implements: the routes of a stored slice, ordered as they are stored. */
export type PathsBuilder = (input: PathsInput) => FunnelSlice['paths'];

/**
 * Not built yet: **#289** fills this in.
 */
export const pathsOfSlice: PathsBuilder = () => {
  throw new Error(
    'pathsOfSlice() is not implemented yet: the common paths through the steps are ticket #289',
  );
};
