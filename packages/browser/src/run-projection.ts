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
 * **One screen is one row, and one area is one row.** A swarm sends a dozen sessions over
 * the same variant, and each of them captures the same screens: the captures arriving here
 * are therefore repetitive, while `run.json` records each screen and each area once — that
 * is what makes an area's metrics aggregable across sessions. A repeat is dropped rather
 * than merged, because a screen is one image file and an area is one box.
 *
 * **The last capture of a screen is the one recorded**, because it is the one on disk:
 * `writeScreenshot` overwrites `screenshots/<variant>/<step>.png` in place, so a screen
 * captured twice with different content — a cart with one item, then with three — leaves
 * the second image. A row describing the first would state a page height the image does not
 * have and put every area's box on the wrong layout. The order of the rows is still the
 * order the screens were first captured in.
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

/** What addresses one screen, and what addresses one area on it, as `run.json` does. */
const screenKey = (variant: string, step: string): string => `${variant}\u0000${step}`;
const areaKey = (variant: string, step: string, id: string): string =>
  `${screenKey(variant, step)}\u0000${id}`;

/**
 * One entry per key: the last one given, in the order the keys first appeared.
 *
 * A `Map` is both halves of that at once — assigning an existing key replaces the value and
 * keeps its place — so the rows read in capture order while each one describes the latest
 * capture of its screen.
 */
const lastOfEach = <T>(rows: readonly T[], keyOf: (row: T) => string): T[] => {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyOf(row), row);
  return [...byKey.values()];
};

/** `run.json`'s `screenshots`: one row per captured screen, with its geometry. */
export const toScreenshotEntries: ToScreenshotEntries = (captures) =>
  lastOfEach(
    captures.filter(onAStep).flatMap((capture) =>
      // A row is a pointer at an image. A capture that wrote none — a source that measured
      // a page without picturing it — is a row the screens could not draw, so it is left
      // out rather than recorded against a file that is not there.
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
    ),
    (row) => screenKey(row.variant, row.step),
  );

/** `run.json`'s `aois`: the DOM- and accessibility-sourced areas of interest. */
export const toAoiEntries: ToAoiEntries = (captures) =>
  lastOfEach(
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
    ),
    // An element id is minted from what the element is and not from which screen it is on
    // (`extract/stable-id.ts`), so the screen is part of the key here: the same control at
    // the same box on two steps is two areas, and the same control seen by two sessions on
    // one step is one.
    (row) => areaKey(row.variant, row.step, row.id),
  );
