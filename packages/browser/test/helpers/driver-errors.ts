/**
 * The errors Chromium's driver raises, hand-built.
 *
 * `failure-mapping.ts` reads the four automation-failure reasons off an error's own text,
 * because Playwright raises one `TimeoutError` for a selector that never resolved and for a
 * navigation that never completed: what tells them apart is the call that raised it and the
 * call log underneath. That makes the exact message shape load-bearing, so it is written
 * **here, once** — two suites assert against it, and a copy in each would let them drift to
 * testing different wording.
 *
 * Every shape below was read out of Playwright 1.64 driving Chromium against
 * `fixtures/site/`. `failures.test.ts` is what keeps them honest: it drives the same four
 * failures out of a real browser, so a release that rewords them fails that suite rather
 * than silently turning our breakage into the product's.
 */

/** A `TimeoutError`, which is what the driver names a timeout whatever timed out. */
const timeoutError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
};

/** A selector that never resolved: `locator.waitFor` gave up still waiting for it. */
export const selectorTimeout = (selector: string, afterMs = 300): Error =>
  timeoutError(
    `locator.waitFor: Timeout ${afterMs}ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible\n`,
  );

/**
 * A locator that **found** its element and then ran out of time — a click on a button
 * something covers. The operation timed out; the selector resolved, and the call log says so.
 */
export const resolvedLocatorTimeout = (selector: string, afterMs = 300): Error =>
  timeoutError(
    `locator.click: Timeout ${afterMs}ms exceeded.\nCall log:\n  - waiting for locator('${selector}')\n  -   locator resolved to <button id="btn">…</button>\n  - attempting click action\n  -   element is not visible\n`,
  );

/** A navigation that never completed: the fixture site's `/slow` answers nothing. */
export const navigationTimeout = (url: string, afterMs = 300): Error =>
  timeoutError(
    `page.goto: Timeout ${afterMs}ms exceeded.\nCall log:\n  - navigating to "${url}", waiting until "load"\n`,
  );

/** A navigation that failed outright: nothing listens on the port. */
export const navigationRefused = (url: string): Error =>
  new Error(
    `page.goto: net::ERR_CONNECTION_REFUSED at ${url}\nCall log:\n  - navigating to "${url}", waiting until "load"\n`,
  );

/** A frame's own call that timed out: the frame of `broken-frame.html` that never answers. */
export const frameLoadTimeout = (afterMs = 300): Error =>
  timeoutError(`frame.waitForLoadState: Timeout ${afterMs}ms exceeded.\n`);
