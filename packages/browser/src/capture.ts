/**
 * One captured screen, composed from the module's parts.
 *
 * This composition is written **once, here**, and no later ticket of the browser-driving
 * step edits it: each of them fills one of the functions called below. Geometry and the
 * content hash are read first because the cache key is built from them; the step is
 * detected next because it is part of that key and is the name a screenshot is written
 * under; and the work that produces bytes — the screenshot, the elements, the primary
 * action — happens inside the cache, so a screen already captured is not captured again.
 * The whole of it runs under the session's budget, so a page that will not answer cannot
 * hold a swarm up.
 *
 * With only the remaining neutral seams in place a capture is real geometry, a real content
 * hash and a real step label, a `null` screenshot and no elements — and it does not throw.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: this module needs the DOM
// types, and the reference travels with the file (see `geometry.ts`).
import { createHash } from 'node:crypto';
import { SessionBudget } from './budget.js';
import { withCache } from './cache.js';
import { extractElements } from './extract/elements.js';
import { readGeometry } from './geometry.js';
import { writeScreenshot } from './screenshot.js';
import { detectStep, resolvePrimaryAction, taskStep } from './steps.js';
import type { Capture, CaptureContext, Device, PageHandle } from './types.js';

/** How much of the content digest a hash carries: 16 hex characters, 64 bits. */
const CONTENT_HASH_LENGTH = 16;

/**
 * A hash of what the page currently is.
 *
 * The serialised document is the cheapest thing that changes whenever the screen changes
 * and does not change when it does not: two visits to a static page hash alike, so the
 * cache hits, and a page that rendered differently hashes differently, so it does not.
 */
export const readContentHash = async (handle: PageHandle): Promise<string> => {
  const html = await handle.page.evaluate(() => document.documentElement.outerHTML);
  return createHash('sha256').update(html, 'utf8').digest('hex').slice(0, CONTENT_HASH_LENGTH);
};

export interface CaptureCacheKeyParts {
  readonly variantUrl: string;
  readonly step: string | null;
  readonly device: Device;
  readonly contentHash: string;
}

/**
 * The cache key: the variant URL, the step, the device and the content hash. The device is
 * in it because the same markup at two viewports is two screenshots and two folds.
 */
export const captureCacheKey = (parts: CaptureCacheKeyParts): string =>
  [
    parts.variantUrl,
    parts.step ?? '-',
    `${parts.device.name}@${parts.device.viewport.width}x${parts.device.viewport.height}x${parts.device.deviceScaleFactor}${parts.device.touch ? 't' : ''}`,
    parts.contentHash,
  ].join('|');

/**
 * Captures the screen the session is currently on.
 *
 * The budget is the session's, so that a session's attempts are capped across all of its
 * captures rather than per capture; a caller that has none gets a fresh one.
 */
export const capture = async (
  page: PageHandle,
  ctx: CaptureContext,
  budget: SessionBudget = new SessionBudget(),
): Promise<Capture> =>
  budget.attempt(async () => {
    const geometry = await readGeometry(page);
    const contentHash = await readContentHash(page);
    const step = await detectStep(page, ctx.task);

    const key = captureCacheKey({
      variantUrl: page.variant.url,
      step,
      device: ctx.device,
      contentHash,
    });

    return withCache(key, async () => {
      const screenshot = await writeScreenshot(page, {
        runDir: ctx.runDir,
        variant: ctx.variant,
        step,
      });
      const extracted = await extractElements(page, geometry, step);
      // The detected step as the task declares it: resolution needs the selector of the
      // control the step names, which the id alone does not carry.
      const elements = await resolvePrimaryAction(page, extracted, taskStep(ctx.task, step));

      return {
        variant: ctx.variant,
        step,
        screenshot,
        viewport: geometry.viewport,
        pageHeight: geometry.pageHeight,
        foldY: geometry.foldY,
        elements,
        contentHash,
      };
    });
  });
