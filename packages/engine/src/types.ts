/**
 * The shapes the engine reads a screen in.
 *
 * These are the engine's **own** structural types, declared field-for-field as
 * `packages/browser` publishes its `Capture` (step spec #6). The engine does not import
 * `packages/browser`: #7 specifies this package as depending on `packages/contract` and
 * `sharp` only, and TypeScript's structural typing joins the two sides without either
 * knowing the other. A capture from the browser step therefore satisfies these types with
 * no adapter and no import — and a field renamed on either side stops satisfying them with
 * no compile error, which is why the auto-decision on #7 is binding on both: the names
 * below are #6's and are not this package's to change.
 *
 * Geometry is in **page space**, the same space `run.json`'s `aois[].bbox` uses: the
 * origin is the top-left of the full page, not of the viewport, so a box below the fold
 * has a `y` above `foldY`.
 */

/** The emulated device's visible area, in CSS pixels. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** A box in page space. `x`/`y` may be negative for an element off the left or top edge. */
export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where an element came from. `"sam"` is a segmented region the DOM does not explain. */
export type ElementSource = 'dom' | 'a11y' | 'sam';

/** One candidate element on a captured screen. */
export interface CaptureElement {
  /** Stable across sessions on the same variant and step, so aggregates can be joined. */
  readonly id: string;
  readonly source: ElementSource;
  /** The ARIA or DOM role, `null` when the element has none. */
  readonly role: string | null;
  /** The accessible name. */
  readonly name: string;
  /** The visible text, which is not always the accessible name. */
  readonly text: string;
  readonly bbox: BoundingBox;
  /** The control that advances the task on this step, as the task declares it. */
  readonly isPrimaryAction: boolean;
  readonly belowFold: boolean;
  readonly selector: string;
}

/** One step of one variant, as the browser step captured it. */
export interface Capture {
  /** The step id, as `run.json`'s `steps[].id` spells it. */
  readonly step: string;
  /** Run-directory-relative path to the full-page screenshot. */
  readonly screenshot: string;
  readonly viewport: Viewport;
  readonly pageHeight: number;
  /** The fold line in page space: content below it needed a scroll to be seen. */
  readonly foldY: number;
  readonly elements: readonly CaptureElement[];
}

/**
 * The agent's current goal, as the swarm step hands it over.
 *
 * Only the text: relevance is lexical and role-based against it (#62), and the engine
 * never calls a model, so there is nothing else for it to read.
 */
export interface Goal {
  readonly text: string;
}
