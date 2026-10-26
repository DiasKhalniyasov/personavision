/**
 * The capture source that drives a real browser, and the walk that uses it.
 *
 * `createLiveSource()` is the `CaptureSource` over Chromium — the one a run launched
 * against a URL uses. `walkTask` is the loop above it: open the variant, capture the screen,
 * act on the step's primary action, capture the next one, until the task's steps run out.
 *
 * **Neutral seam.** Neither exists yet, and both throw rather than returning an empty walk
 * that would look like a session where nothing happened. The live-source ticket of this
 * step fills this file and no other.
 */

import { notImplemented } from './errors.js';
import type { Capture, CaptureSource, Device, TaskDefinition } from './types.js';

/** One variant, under one device, against one task, writing into one run directory. */
export interface TaskWalk {
  readonly variant: { readonly id: string; readonly url: string };
  readonly device: Device;
  readonly task: TaskDefinition;
  readonly runDir: string;
}

export type WalkTask = (source: CaptureSource, walk: TaskWalk) => Promise<Capture[]>;

export const createLiveSource = (): CaptureSource => {
  throw notImplemented('live source');
};

export const walkTask: WalkTask = async () => {
  throw notImplemented('live source');
};
