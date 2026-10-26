/**
 * A thrown error, read as one of our four automation failures.
 *
 * `selector_not_found`, `timeout`, `navigation_error` and `frame_error` are the whole
 * vocabulary (`docs/FLOW.md` section 8). An error this cannot place is **not** ours to
 * classify: it returns `null` and the caller rethrows, because a mystery recorded as a
 * timeout is worse than a mystery that reaches a stack trace.
 *
 * **Neutral seam.** Nothing is recognised yet, so every error is rethrown unchanged. The
 * failure-mapping ticket of this step fills this file and no other.
 */

import type { AutomationFailureReason } from './types.js';

export type MapToAutomationFailure = (error: unknown) => AutomationFailureReason | null;

export const mapToAutomationFailure: MapToAutomationFailure = () => null;
