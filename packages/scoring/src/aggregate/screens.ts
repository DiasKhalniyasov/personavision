import type { Run, ScreenSlice } from '@personavision/contract';
import type { ScreenSliceSpec } from './sessions.js';

/**
 * The per-screen figures of one heatmaps slice: how many reached each screen, how many it
 * was the last thing they saw, the median time on it, where the clicks landed by area of
 * interest, and how far down the page they got (`docs/FLOW.md` section 14.4, and the
 * *This screen* panel of `#screen-heatmaps`).
 *
 * The attention overlay is unchanged and stays the engine's: nothing here re-derives gaze.
 */

/**
 * What the per-screen figures are given. **#291 settles the rest of this shape in this
 * file**; the barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface ScreenFiguresInput {
  /** The run, read for its steps, its areas of interest and its screenshots' folds. */
  readonly run: Run;
  /** The slice and its sessions, as `screenSliceSpecs` enumerated them. */
  readonly slice: ScreenSliceSpec;
}

/** The signature #291 implements: one row per version and step of a stored slice. */
export type ScreenFiguresBuilder = (input: ScreenFiguresInput) => ScreenSlice['screens'];

/**
 * Not built yet: **#291** fills this in.
 */
export const screenFiguresOfSlice: ScreenFiguresBuilder = () => {
  throw new Error(
    'screenFiguresOfSlice() is not implemented yet: the clicks and the scroll depth per screen are ticket #291',
  );
};
