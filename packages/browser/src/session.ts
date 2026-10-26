/**
 * Opening and closing a Chromium session under an emulated device.
 *
 * One browser per session. A swarm runs twenty-four of these, and a shared browser would
 * make one session's crash another's: the isolation is worth the launches.
 *
 * Headless is the default and the only mode CI uses. Headed is for watching a session when
 * something looks wrong, and on a machine with no display it will fail to launch — which is
 * the honest outcome, not something to paper over.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node, so this module needs the DOM
// types. The reference travels with the file: a program that pulls `src/` in — the
// package's build, its test project, a consumer — gets them without restating a `lib`.
import { chromium } from 'playwright';
import type { Device, PageHandle } from './types.js';

export interface OpenSessionOptions {
  /** `false` opens a visible window. Defaults to `true`. */
  readonly headless?: boolean;
  /** How long a navigation may take, in milliseconds. Defaults to 30 000. */
  readonly navigationTimeoutMs?: number;
  /**
   * The load state to wait for. `load` by default; a page with a frame that never arrives
   * never fires it, so such a page is opened with `domcontentloaded`.
   */
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'commit';
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/** What a page says about the device it is being shown on, read out of the page itself. */
export interface SessionState {
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly touch: boolean;
  readonly scrollY: number;
  /** What the session was opened as, not something the page could know. */
  readonly headless: boolean;
}

/**
 * Launches Chromium with the device applied and navigates to the variant's URL.
 *
 * The viewport, device scale factor and touch emulation are the browser context's, so they
 * are in force before the first byte of the page is parsed — a media query that depends on
 * the viewport therefore matches the device rather than a default and then a resize.
 */
export const openSession = async (
  variant: { id: string; url: string },
  device: Device,
  options: OpenSessionOptions = {},
): Promise<PageHandle> => {
  const headless = options.headless ?? true;
  const browser = await chromium.launch({ headless });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: device.viewport.width, height: device.viewport.height },
      deviceScaleFactor: device.deviceScaleFactor,
      hasTouch: device.touch,
      isMobile: device.touch,
    });
  } catch (error) {
    await browser.close();
    throw error;
  }

  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS);
    await page.goto(variant.url, { waitUntil: options.waitUntil ?? 'load' });
    return { variant, device, headless, browser, context, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
};

/**
 * What the page reports about itself: the emulated viewport in CSS pixels, the device pixel
 * ratio, whether touch is available, and where the page is scrolled to.
 *
 * Read out of the page rather than echoed back from the handle, so that a caller checking
 * emulation is checking the browser and not this module's own bookkeeping.
 */
export const readSessionState = async (handle: PageHandle): Promise<SessionState> => {
  const observed = await handle.page.evaluate(() => ({
    url: window.location.href,
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    touch: navigator.maxTouchPoints > 0 || 'ontouchstart' in window,
    scrollY: window.scrollY,
  }));

  return {
    url: observed.url,
    viewport: { width: observed.width, height: observed.height },
    deviceScaleFactor: observed.deviceScaleFactor,
    touch: observed.touch,
    scrollY: observed.scrollY,
    headless: handle.headless,
  };
};

/** Closes the browser the session owns. Closing twice is not an error. */
export const closeSession = async (handle: PageHandle): Promise<void> => {
  await handle.browser.close();
};
