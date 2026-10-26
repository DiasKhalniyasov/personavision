/**
 * Doing something to the page: a click, a scroll, a text entry or a back navigation.
 *
 * An action targets either an `elementId` from a capture — what the swarm uses — or a raw
 * `selector`, which this step's own tests use, and resolving whichever is given is this
 * module's job. Every failure of ours comes back as an `ActResult` with `ok: false` and a
 * typed reason, so a broken selector is never attributed to the product.
 *
 * **Neutral seam.** No action can be executed yet; this throws rather than reporting a
 * success that did not happen or a product failure that is ours. The actions ticket of this
 * step fills this file and no other.
 */

import { NotImplementedError } from './errors.js';
import type { ActResult, Action, CaptureContext, PageHandle } from './types.js';

export type Act = (page: PageHandle, action: Action, ctx: CaptureContext) => Promise<ActResult>;

export const act: Act = async () => {
  throw new NotImplementedError('act');
};
