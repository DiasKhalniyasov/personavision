/**
 * A page's geometry: the viewport, the full page height and the fold.
 *
 * All three are CSS pixels in page space, which is the space every box in a `Capture` is
 * expressed in and the space the Attention screen registers its overlays to.
 *
 * `foldY` is the viewport's bottom edge **at scroll 0** (`docs/FLOW.md` section 8), so it
 * does not move when a session scrolls: a control at `y >= foldY` was below the fold when
 * the page opened, which is the finding. Reading geometry therefore scrolls nothing and
 * changes nothing about the page.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node, so this module needs the DOM
// types. The reference travels with the file: a program that pulls `src/` in — the
// package's build, its test project, a consumer — gets them without restating a `lib`.
import type { Geometry, PageHandle } from './types.js';

/**
 * Measures the open page.
 *
 * `innerWidth`/`innerHeight` are the layout viewport and include the scrollbar gutter, so
 * they are the device's viewport exactly; `documentElement.clientWidth` would be narrower
 * by a scrollbar and would make a box's `x` disagree with the screenshot it is drawn on.
 *
 * `scrollHeight` is the taller of the content and the viewport, so a page shorter than the
 * viewport reports the viewport's height — that is a browser fact, and the fixture site's
 * `LANDMARKS.md` records page heights that hold at both viewports because of it.
 */
export const readGeometry = async (handle: PageHandle): Promise<Geometry> => {
  const measured = await handle.page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    pageHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
      window.innerHeight,
    ),
  }));

  return {
    viewport: { width: measured.width, height: measured.height },
    pageHeight: measured.pageHeight,
    foldY: measured.height,
  };
};

/** The fold rule, in one place: an element is below the fold when its top is at or past it. */
export const isBelowFold = (box: { y: number }, geometry: Geometry): boolean =>
  box.y >= geometry.foldY;
