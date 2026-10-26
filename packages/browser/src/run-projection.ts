/**
 * Captures, projected into the two arrays of `run.json` they become.
 *
 * `screenshots` and `aois` are the contract's field names and the contract's shapes; this
 * module maps onto them and declares nothing of its own, so a change to the artifact is a
 * change in `@personavision/contract` and a type error here.
 *
 * It is a projection and not an interpretation: one row per captured screen, one area per
 * captured element, in the order the capture reported them, with the ids, boxes and flags
 * carried through untouched. Nothing is merged, re-ordered or re-numbered here — the
 * engine's `buildAois` is what merges a control reported by both trees, sorts into reading
 * order and adds the regions a segmenter explains, and it needs the elements as the browser
 * found them to do it.
 *
 * **A capture with no step is projected nowhere.** A screenshot row and an area of interest
 * are both addressed by variant *and* step: that is how the Attention screen finds the
 * image it draws on and how metrics are aggregated across sessions. A screen the task does
 * not recognise has no address, so it contributes to neither list rather than to a row
 * nothing can ask for.
 */

import type { Run } from '@personavision/contract';
import type { Capture, CaptureElement } from './types.js';

export type ToScreenshotEntries = (captures: readonly Capture[]) => Run['screenshots'];
export type ToAoiEntries = (captures: readonly Capture[]) => Run['aois'];

/** A capture of a recognised screen, which is the only kind either list records. */
type OnAStep = Capture & { step: string };

const onAStep = (capture: Capture): capture is OnAStep => capture.step !== null;

const firstNonBlank = (...values: readonly (string | null)[]): string | null =>
  values
    .filter((value): value is string => value !== null)
    .map((value) => value.trim())
    .find((value) => value !== '') ?? null;

/**
 * What the areas-of-interest table calls this element.
 *
 * The accessible name first — it is the text a screen reader would say, the closest thing a
 * capture has to what a designer calls the control — then its visible text, then its role.
 * The element id is the last resort rather than a word like "unnamed", because the contract
 * types a label as a non-empty string and several unnamed areas on one screen have to stay
 * distinguishable in the table.
 */
const labelFor = (element: CaptureElement): string =>
  firstNonBlank(element.name, element.text, element.role) ?? element.id;

/** `run.json`'s `screenshots`: one row per captured screen, with its geometry. */
export const toScreenshotEntries: ToScreenshotEntries = (captures) =>
  captures.filter(onAStep).flatMap((capture) =>
    // A row is a pointer at an image. A capture that wrote none — an unknown step, or a
    // source that measured a page without picturing it — is a row the screens could not
    // draw, so it is left out rather than recorded against a file that is not there.
    capture.screenshot === null
      ? []
      : [
          {
            variant: capture.variant,
            step: capture.step,
            path: capture.screenshot,
            viewport: { width: capture.viewport.width, height: capture.viewport.height },
            pageHeight: capture.pageHeight,
            foldY: capture.foldY,
          },
        ],
  );

/** `run.json`'s `aois`: the DOM- and accessibility-sourced areas of interest. */
export const toAoiEntries: ToAoiEntries = (captures) =>
  captures.filter(onAStep).flatMap((capture) =>
    capture.elements.map((element) => ({
      id: element.id,
      variant: capture.variant,
      step: capture.step,
      label: labelFor(element),
      source: element.source,
      role: element.role,
      // Copied field by field: the box in the artifact is the four numbers the contract
      // declares, and nothing an extractor hung on its own box travels with it.
      bbox: {
        x: element.bbox.x,
        y: element.bbox.y,
        width: element.bbox.width,
        height: element.bbox.height,
      },
      isPrimaryAction: element.isPrimaryAction,
      belowFold: element.belowFold,
    })),
  );
