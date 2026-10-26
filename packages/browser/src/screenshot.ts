/**
 * Full-page screenshots, written where the screens look for them.
 *
 * `screenshots/<variant>/<step>.png` inside the run directory, as
 * `runPaths('').screenshot()` spells it — the path is the contract's to declare, not this
 * module's, and what is returned is the run-directory-relative path `run.json` records.
 *
 * **Neutral seam.** This writes nothing and returns `null`, so a capture carries no image
 * yet. The screenshot ticket of this step fills this file and no other.
 */

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

export const writeScreenshot: WriteScreenshot = async () => null;
