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

  const onDisk = runPaths(runDir).screenshot(variant, step);
  // The variant's directory need not exist: this is often the first screen of the first
  // session of a fresh run.
  await mkdir(dirname(onDisk), { recursive: true });
  await page.page.screenshot({ path: onDisk, fullPage: true, type: 'png', scale: 'device' });

  return runPaths('').screenshot(variant, step);
};
