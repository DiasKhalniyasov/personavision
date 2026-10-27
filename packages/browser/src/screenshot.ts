/**
 * Full-page screenshots, written where the screens look for them.
 *
 * `screenshots/<variant>/<step>.png` inside the run directory, as
 * `runPaths('').screenshot()` spells it — the path is the contract's to declare, not this
 * module's, and what is returned is the run-directory-relative path `run.json` records.
 *
 * Two things this file is careful about, because every overlay in the project is drawn
 * against what it writes:
 *
 * **The whole page, at the device's pixels.** `fullPage` makes the image the document
 * rather than the viewport — a control below the fold is in the picture, which is what
 * makes the fold drawable — and `scale: 'device'` keeps one image pixel per device pixel,
 * so a mobile capture at a device scale factor of three is three times the size of the CSS
 * box it is registered to. Both are passed explicitly: they are the acceptance of this
 * seam, not a default to inherit.
 *
 * **The same page twice is the same image.** `animations: 'disabled'` finishes CSS
 * animations and transitions and freezes infinite ones at their first frame. Without it a
 * carousel or a skeleton shimmer is captured at whatever moment the call lands, so one
 * page would produce a different image on every run — and the content hash that keys the
 * capture cache would not change with it. Every fixation the engine computes is computed
 * from this image, so a run has to be able to produce it twice.
 *
 * **One file per screen.** The name is a function of the variant and the step, so a second
 * capture of the same screen overwrites the first in place rather than minting
 * `cart-2.png`. Not re-taking it at all is the cache's job (`cache.ts`), and the cache can
 * only be correct if a repeated capture is a repeated write to one path.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runPaths } from '@personavision/contract';
import type { PageHandle } from './types.js';

export interface ScreenshotTarget {
  readonly runDir: string;
  readonly variant: string;
  /** `null` when the page matched no step: there is then no name to write the image under. */
  readonly step: string | null;
}

export type WriteScreenshot = (
  page: PageHandle,
  target: ScreenshotTarget,
) => Promise<string | null>;

/**
 * One path segment: no separator, no NUL, and not a relative step.
 *
 * A variant id and a step id are a task's to choose and arrive from configuration, and the
 * contract's `runPaths` joins them into a path without reaching a file system — by design,
 * because the same strings address a run over HTTP. This is the first code in the project
 * that turns them into a write, so it is where an id that is not a name gets refused: a
 * step called `../../etc` would otherwise take `mkdir -p` and the image outside the run
 * directory, and be recorded in `run.json` as a path the viewer would resolve.
 *
 * Exported because `fixture-source.ts` reads a variant and a step out of a file on disk and
 * writes a screenshot under them, which is the same write and so is the same rule.
 */
export const isOneSegment = (value: string): boolean =>
  /^[^/\\\0]+$/.test(value) && value !== '.' && value !== '..';

/**
 * Captures the open page and returns the path `run.json` records, or `null` when there is
 * no step to name the file after.
 *
 * An unknown step writes nothing at all. A screenshot is addressed by variant and step —
 * that is how every screen finds it — so an image with no step has no address, and
 * inventing one would put a file in the run directory that nothing can ever ask for.
 */
export const writeScreenshot: WriteScreenshot = async (page, target) => {
  const { runDir, variant, step } = target;
  if (step === null) return null;

  for (const [field, value] of [
    ['variant', variant],
    ['step', step],
  ] as const) {
    if (!isOneSegment(value)) {
      // Thrown rather than skipped: a screenshot nobody can address is a run that is
      // misconfigured, and a silent `null` here would be read as "this page had no step".
      throw new Error(
        `a screenshot is written to screenshots/<variant>/<step>.png, so the ${field} has to be one path segment, and ${JSON.stringify(value)} is not`,
      );
    }
  }

  const onDisk = runPaths(runDir).screenshot(variant, step);
  // The variant's directory need not exist: this is often the first screen of the first
  // session of a fresh run.
  await mkdir(dirname(onDisk), { recursive: true });
  await page.page.screenshot({
    path: onDisk,
    fullPage: true,
    type: 'png',
    scale: 'device',
    animations: 'disabled',
  });

  return runPaths('').screenshot(variant, step);
};
