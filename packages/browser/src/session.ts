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
import { prepareRecording, videoFrame } from './video.js';
import type { Device, PageHandle, Variant, Viewport } from './types.js';
import type { VideoRequest } from './video.js';

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
  /**
   * Record the session into the run directory, as `videos/S-NN.webm`. Omitted, nothing is
   * recorded and the handle carries no recording — which is how every suite that is not
   * about video opens a session.
   *
   * A recording that cannot start does not stop the session: it opens without one, and
   * `handle.video.finish()` reports in words why there is none (`video.ts`).
   */
  readonly video?: VideoRequest;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * esbuild's `keepNames` helper, declared inside every document the session loads.
 *
 * Playwright serialises the function handed to `page.evaluate` and evaluates **its source**
 * in the page, so a transpiler that rewrites that source sends its own helpers into the page
 * along with it — and the page has never heard of them. Run from source under `tsx`, which
 * is how `pnpm open`, `pnpm dev` and every `tsx --conditions=development …` invocation run,
 * esbuild's `keepNames` wraps each named function in `__name(fn, "fn")` and declares `__name`
 * at the top of the **module**: the call travels into the page, the declaration does not, and
 * every one of this package's six `page.evaluate` call sites — `act.ts`, `geometry.ts`,
 * `session.ts`, `capture.ts`, `steps.ts`, `extract/elements.ts` — failed with
 * `ReferenceError: __name is not defined`. The built CLI never did: `tsc` emits no helper.
 *
 * Declaring the helper here, where the page is created, fixes all six at once. Nothing in the
 * evaluated code is rewritten and every document the session ever loads can evaluate
 * transpiled source, whatever transpiled it. The real helper gives the function a `name` and
 * returns it; the names are for stack traces and nothing in this package reads one, so
 * returning the function unchanged is the whole of it. A page that already has a global
 * `__name` keeps its own.
 *
 * **The ceiling: this covers esbuild's `keepNames` helper and nothing else.** Another
 * injected helper — a spread helper, a decorator helper, a coverage counter — would fail in
 * exactly the same way and is not declared here. `test/tsx-session.test.ts` drives a real
 * session through `tsx` so that such a helper is a failing test rather than a product that is
 * unusable from source.
 */
const KEEP_NAMES_HELPER_SCRIPT =
  'if (typeof globalThis.__name === "undefined") { globalThis.__name = (target) => target; }';

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
  // Before the launch: a videos directory that cannot be made is then a session that opens
  // without a recording rather than a browser nobody closes (`video.ts`).
  const recording = options.video === undefined ? null : await prepareRecording(options.video);
  const browser = await chromium.launch({ headless });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: device.viewport.width, height: device.viewport.height },
      deviceScaleFactor: device.deviceScaleFactor,
      hasTouch: device.touch,
      // Recording is declared on the context and flushed when it closes; the frame is the
      // device's viewport inside 720p, which is the cap the project records at.
      ...(recording?.dir === null || recording?.dir === undefined
        ? {}
        : { recordVideo: { dir: recording.dir, size: videoFrame(device.viewport) } }),
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

  // Kept out of the try so that a session which never opened can still throw away the
  // recording it started.
  let opened;
  try {
    const page = await context.newPage();
    opened = page;
    // The recording's clock starts with the page, which is when the browser starts recording
    // it — before the opening navigation, so the first screen's offset is inside the video.
    const video = recording?.start(page);
    // A string, not a function: a bundler's helpers would not exist inside the page — which
    // is the same thing the helper above is there to survive.
    await page.addInitScript(KEEP_NAMES_HELPER_SCRIPT);
    await page.addInitScript(
      "document.addEventListener('click', (e) => { const a = e.target instanceof Element && e.target.closest('a[target]'); if (a) a.target = '_self'; }, true);",
    );
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS);
    await page
      .goto(variant.url, { waitUntil: options.waitUntil ?? 'load' })
      .catch(async (error: unknown) => {
        // A page heavy with media can take longer than the cap to fire `load` while it has long
        // been usable (higgsfield.ai: parsed in 5 s, `load` at 38 s): a parsed one is taken as it is.
        // (A navigation that never got an answer is still on about:blank: that one is a timeout.)
        const parsed =
          page.url() !== 'about:blank' &&
          (await page.evaluate(() => document.readyState !== 'loading').catch(() => false));
        if (!(error instanceof errors.TimeoutError) || !parsed) throw error;
      });
    return { variant, device, headless, browser, context, page, ...(video ? { video } : {}) };
  } catch (error) {
    // A session that never opened has no recording to keep, and the partial file Playwright
    // flushes when the context closes belongs to nothing: it is deleted rather than left in
    // the run directory under the name Playwright chose, which nothing would ever ask for.
    // The context is closed first because that is what finishes the file `delete()` removes.
    if (opened !== undefined) {
      await context.close().catch(() => undefined);
      await opened
        .video()
        ?.delete()
        .catch(() => undefined);
    }
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

/**
 * Closes the browser the session owns. Closing twice is not an error.
 *
 * A recorded session finishes its recording **first** — `await handle.video?.finish()` —
 * because that is what closes the context, saves the file at the contract's path and reports
 * what is on disk. `walkTask` does it in that order; a caller driving sessions itself does
 * the same, and closing the browser on an unfinished recording leaves the file where
 * Playwright chose to put it.
 */
export const closeSession = async (handle: PageHandle): Promise<void> => {
  await handle.browser.close();
};
