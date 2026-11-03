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
// The callbacks below run inside the page, not in Node: this module needs the DOM
// types, and the reference travels with the file (see `geometry.ts`).
import { chromium, devices, errors } from 'playwright';
import type { Device, PageHandle, Variant, Viewport } from './types.js';

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

/**
 * The browser a touch device runs. Sites choose their phone layout by the user agent as well
 * as by the width (higgsfield.ai serves phones an app-style home page), so a phone given only
 * a phone's viewport is shown the desktop site squeezed to fit.
 */
// ponytail: two phone browsers told apart by the device's name; a device that needs another
// can carry its own user agent when one does.
const mobileUserAgent = (device: Device): string =>
  (/iphone|ipad/i.test(device.name) ? devices['iPhone 13'] : devices['Pixel 7']).userAgent;

/** What a page says about the device it is being shown on, read out of the page itself. */
export interface SessionState {
  readonly url: string;
  readonly viewport: Viewport;
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
  variant: Variant,
  device: Device,
  options: OpenSessionOptions = {},
): Promise<PageHandle> => {
  const headless = options.headless ?? process.env.PV_HEADED !== '1'; // local only: PV_HEADED=1 shows the window
  const browser = await chromium.launch({ headless });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: device.viewport.width, height: device.viewport.height },
      deviceScaleFactor: device.deviceScaleFactor,
      hasTouch: device.touch,
      // A touch device is a phone or a tablet, and the site is told so.
      ...(device.touch ? { isMobile: true, userAgent: mobileUserAgent(device) } : {}),
      // Every session is a first visit, so a site's service worker installs every time, and a
      // site that reloads once its worker takes over (higgsfield.ai, ~16 s in) pulls the page
      // out from under whatever is reading it.
      serviceWorkers: 'block',
    });
  } catch (error) {
    await browser.close();
    throw error;
  }

  try {
    const page = await context.newPage();
    // A string, not a function: a bundler's helpers would not exist inside the page.
    await page.addInitScript(
      "document.addEventListener('click', (e) => { const a = e.target instanceof Element && e.target.closest('a[target]'); if (a) a.target = '_self'; }, true);",
    );
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS);
    await page.goto(variant.url, { waitUntil: options.waitUntil ?? 'load' }).catch(async (error: unknown) => {
      // A page heavy with media can take longer than the cap to fire `load` while it has long
      // been usable (higgsfield.ai: parsed in 5 s, `load` at 38 s): a parsed one is taken as it is.
      // (A navigation that never got an answer is still on about:blank: that one is a timeout.)
      const parsed =
        page.url() !== 'about:blank' &&
        (await page.evaluate(() => document.readyState !== 'loading').catch(() => false));
      if (!(error instanceof errors.TimeoutError) || !parsed) throw error;
    });
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
