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
 * hash and a real step label, a `null` screenshot and no elements. It raises one thing: a
 * page on one of the task's steps whose declared primary action cannot be resolved is an
 * automation failure, which excludes the session rather than scoring it as a zero.
 *
 * **A navigation under the read is waited out here, below the budget.** The composition is
 * five reads that each run `page.evaluate`, and a site that navigates between any two of them
 * — a redirect, a locale bounce, a framework taking over the first paint, a consent flow
 * replacing the document — destroys the execution context the next one runs in. That is an
 * ordinary event on the real web and not a fault of ours, so the new document is waited for
 * and the screen is composed **once more**, and the screen that is written is the page the
 * session actually ended on: its content hash, its cache entry, its screenshot and its step
 * label all describe the destination.
 *
 * It happens inside the capture rather than in `SessionBudget` or around the capture in
 * `walkSession` because the budget's retry cap is two attempts per operation and its counters
 * are session-wide: a single-page app that navigates on every screen would spend a retry per
 * screen and end the session, which is exactly how six sessions over `www.canva.com` were
 * lost (#419). So a navigation costs the session no retry, and the budget sees everything
 * else exactly as it did. The re-read is **once per capture**: a second destroyed context in
 * one capture is raised, and is the budget's to retry and to end the session on.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: this module needs the DOM
// types, and the reference travels with the file (see `geometry.ts`).
import { createHash } from 'node:crypto';
import { SessionBudget } from './budget.js';
import { withCache } from './cache.js';
import { extractElements } from './extract/elements.js';
import { isDestroyedContext } from './failure-mapping.js';
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
 * One composition of the screen the page is on: the five reads, in the order the cache key
 * needs them. Named rather than inline so that a navigation under it can run it again.
 */
const composeScreen = async (page: PageHandle, ctx: CaptureContext): Promise<Capture> => {
  const geometry = await readGeometry(page);
  const contentHash = await readContentHash(page);
  const step = await detectStep(page, ctx.task);

  const key = captureCacheKey({
    variantUrl: page.variant.url,
    step,
    device: ctx.device,
    contentHash,
  });

  // The work a cache hit skips: everything that produces bytes. Named rather than
  // inline so that what it is cached under reads beside it.
  const work = async (): Promise<Capture> => {
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
  };

  // One cache entry per screen rather than per key: a screen is one image file, and a
  // hit must not answer with a capture whose image another device or another render has
  // since overwritten (`cache.ts`). A page on no step writes no image.
  const screen = step === null ? ctx.variant : `${ctx.variant}|${step}`;

  return withCache(key, work, { runDir: ctx.runDir, screen });
};

/**
 * How long the document a navigation landed on is waited for.
 *
 * Generous for a document that is coming — a page heavy with media parses in about five
 * seconds (`session.ts`) — and a cap rather than the rest of the session, because the
 * caller's budget is not always the session's: `live-source.ts` gives a capture a budget of
 * one attempt and a wall clock of twenty-five days, so what is "left" of it is no bound at
 * all. A destination that never parses therefore costs this and is then the navigation
 * error it is, rather than the whole session's wall clock spent waiting and recorded as a
 * timeout.
 */
const SETTLE_MS = 10_000;

/**
 * Waits for the document a navigation under the read landed on, so that the second
 * composition reads a parsed page rather than one still unloading.
 *
 * The same settle an action does (`act.ts`), with the document asked directly as well — the
 * opening navigation does that too (`session.ts`) — under whichever is smaller of the settle's
 * own cap and what is left of the caller's budget, so waiting out a redirect can outlive
 * neither.
 */
const settle = async (page: PageHandle, remainingMs: number): Promise<void> => {
  const withinMs = Math.min(remainingMs, SETTLE_MS);
  await page.page.waitForLoadState('domcontentloaded', { timeout: withinMs });
  await page.page.waitForFunction(() => document.readyState !== 'loading', undefined, {
    timeout: withinMs,
  });
};

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
  budget.attempt(async (remainingMs) => {
    try {
      return await composeScreen(page, ctx);
    } catch (error) {
      // Anything else — a selector the step declared and the page does not have, a read that
      // timed out — is the budget's, untouched.
      if (!isDestroyedContext(error)) throw error;
      await settle(page, remainingMs);
      // Once. A destroyed context here is raised, and the budget's caps end the session,
      // which is what stops a redirect loop from re-reading for ever.
      return await composeScreen(page, ctx);
    }
  });
