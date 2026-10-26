import type { Run, Session } from '@personavision/contract';

/**
 * What the run calls the things a session refers to by id.
 *
 * A session stores ids — `"B"`, `"review"` — and the run artifact holds the words for them.
 * Both the header and the frame need those words, so the lookups live here rather than
 * twice, and each one falls back to the id itself: a run that does not name a step is a
 * screen that prints `review` rather than one that prints nothing.
 */

/** One captured page, as `run.json`'s `screenshots[]` records it. */
export type Capture = Run['screenshots'][number];

/**
 * The capture a session's screen was taken from: the one for this session's variant and
 * that screen's step. `null` when the run records no such capture, which leaves the frame
 * saying so rather than drawing a page at a guessed size.
 */
export function captureFor(run: Run, variant: string, step: string): Capture | null {
  return run.screenshots.find((shot) => shot.variant === variant && shot.step === step) ?? null;
}

/** What this version is called on screen — `Redesign candidate`, not `B`. */
export function variantName(run: Run, variant: Session['variant']): string {
  return run.variants.find((candidate) => candidate.id === variant)?.name ?? variant;
}

/** What this step is called on screen — `Review`, not `review`. */
export function stepLabel(run: Run, step: string): string {
  return run.steps.find((candidate) => candidate.id === step)?.label ?? step;
}
