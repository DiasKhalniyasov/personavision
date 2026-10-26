/**
 * The module's own failures.
 *
 * Two kinds. An `AutomationFailure` is *our* browsing breaking — a selector that never
 * resolved, a navigation that never completed — and carries the typed reason the session
 * artifact records, so that it is never attributed to the product: `docs/FLOW.md`
 * section 8 keeps *abandoned*, *failed* and *automation failure* apart, and
 * `@personavision/contract`'s session schema is where the three are spelt.
 * A `NotImplementedError` is a seam of this step that has not landed yet: the
 * module ships every function of its interface, and the ones a later ticket fills say so
 * in one place rather than each inventing a message.
 */

import type { AutomationFailureReason } from './types.js';

/** A failure of our own browsing, with the reason the artifact records. */
export class AutomationFailure extends Error {
  readonly reason: AutomationFailureReason;

  constructor(reason: AutomationFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AutomationFailure';
    this.reason = reason;
  }
}

/**
 * A seam that exists, is typed and does not pretend to work:
 * `throw new NotImplementedError('act')` reads `act: not implemented`.
 */
export class NotImplementedError extends Error {
  constructor(seam: string) {
    super(`${seam}: not implemented`);
    this.name = 'NotImplementedError';
  }
}
