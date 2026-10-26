import type { SessionRow } from '@/session';

/**
 * How one row of the Sessions screen is worded. Nothing here computes a reading: the
 * outcome, the attribution, the duration, the fixation count and `excludedFromScores` all
 * arrive from the session module exactly as the pipeline wrote them, and these are the
 * three rules for putting them on screen.
 */

/**
 * The chip class carrying a vocabulary token's colour.
 *
 * `src/styles/base.css` publishes one class per outcome, attribution and version, each
 * declaring nothing but the matching `--outcome-*`, `--attr-*` or `--variant-*` pair. The
 * class is therefore derived from the token name the vocabulary hands over rather than
 * from a second list of four statuses here — an automation failure borrows the attribution
 * token, and `tag-automation` is the class that carries it, with no special case.
 */
export function tagClass(token: string): string {
  return `tag-${token.replace(/^--(?:outcome|attr|variant)-/, '')}`;
}

/** Version A and version B keep one identity everywhere the two appear. */
export function variantTagClass(variant: string): string {
  return tagClass(`--variant-${variant.toLowerCase()}`);
}

/** Seconds to one decimal, as every duration in the product reads. */
export function durationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

/**
 * Where the session ended, and why, in one line.
 *
 * The step is the run's own label for it, and the reason is the pipeline's sentence. That
 * sentence already opens with the step on every session that ended somewhere it did not
 * mean to — "Payment — selector timeout on the card iframe" — so the step is not printed
 * twice; a session that ended where it was meant to reads "Confirmation — Order placed".
 * A step the run never planned has no label, and then its id is the best name there is.
 */
export function whereItEnded(endedOn: SessionRow['endedOn'], reason: string): string {
  const step = endedOn.label ?? endedOn.step;
  return reason.startsWith(step) ? reason : `${step} — ${reason}`;
}
