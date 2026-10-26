/**
 * Captures, projected into the two arrays of `run.json` they become.
 *
 * `screenshots` and `aois` are the contract's field names and the contract's shapes; this
 * module maps onto them and declares nothing of its own, so a change to the artifact is a
 * change in `@personavision/contract` and a type error here.
 *
 * **Neutral seam.** Both return nothing yet, so a run written from captures has no
 * screenshot rows and no areas of interest. The projection ticket of this step fills this
 * file and no other.
 */

import type { Run } from '@personavision/contract';
import type { Capture } from './types.js';

export type ToScreenshotEntries = (captures: readonly Capture[]) => Run['screenshots'];
export type ToAoiEntries = (captures: readonly Capture[]) => Run['aois'];

/** `run.json`'s `screenshots`: one row per captured screen, with its geometry. */
export const toScreenshotEntries: ToScreenshotEntries = () => [];

/** `run.json`'s `aois`: the DOM- and accessibility-sourced areas of interest. */
export const toAoiEntries: ToAoiEntries = () => [];
