/**
 * The agent's decisions having effects: a click, a scroll, a text entry and a back
 * navigation, and what each one leaves behind.
 *
 * Everything asserted here is **observable page state**, read back out of the page after
 * the action: the URL the page reports, where it is scrolled to, what a field holds, where
 * a control sits in the viewport. Nothing asserts a Playwright call, and no test counts
 * retries — the retry and cap policy is #50's, and `act` deliberately has none of its own.
 *
 * `ActResult.step` is not asserted. It is filled by the step-detection seam, which #47
 * fills; labelling a screen `cart` or `payment` is that ticket's business and the
 * integration ticket's to check, so a test here that pinned it would only break when #47
 * lands.
 *
 * The pages, the boxes and the fold these tests quote are the fixture site's, recorded in
 * `fixtures/site/LANDMARKS.md`.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: reading a field's value and a
// control's viewport rect needs the DOM types, and the reference travels with the file.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, closeSession, openSession, readSessionState, stableElementId } from '../src/index.js';
import type {
  CaptureContext,
  CaptureElement,
  Device,
  PageHandle,
  TaskDefinition,
} from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** The task these fixture pages are written for, as `LANDMARKS.md` declares it. */
const TASK: TaskDefinition = {
  id: 'checkout',
  prompt: 'Buy the tote bag',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
      primaryAction: { selector: '#cart-checkout' },
    },
    {
      id: 'payment',
      label: 'Payment',
      match: { urlPattern: '/(payment|no-control)\\.html', requiredSelector: '#payment-form' },
      primaryAction: { selector: '#payment-submit' },
    },
    {
      id: 'review',
      label: 'Review',
      match: { urlPattern: '/review\\.html', requiredSelector: '#review-summary' },
      primaryAction: { selector: '#review-place-order' },
    },
  ],
};

const BROWSER_TIMEOUT_MS = 60_000;

/**
 * How long a target that will never resolve is waited for. The default is sized for a real
 * page whose control may still be arriving; a test that has already decided the control is
 * absent only waits long enough to prove it, so that the suite stays quick.
 */
const ABSENT_TARGET_TIMEOUT_MS = 1_000;

/** The cart's checkout link, as `LANDMARKS.md` records it. */
const CHECKOUT_BOX = { x: 16, y: 784, width: 358, height: 44 };

describeWithChromium('acting on a page', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const contextFor = (device: Device): CaptureContext => ({
    variant: `v-${device.name}`,
    device,
    task: TASK,
    // `act` writes nothing: it reads the page and changes it, and the run directory is
    // only in the context because a capture needs one.
    runDir: 'runs/act-writes-nothing',
  });

  /**
   * One session per test. An action changes the page, so a shared session would make the
   * order these tests run in part of what they assert.
   */
  const withSession = async <T>(
    device: Device,
    path: string,
    body: (handle: PageHandle) => Promise<T>,
  ): Promise<T> => {
    const handle = await openSession({ id: `v-${device.name}`, url: `${site.url}${path}` }, device);
    try {
      return await body(handle);
    } finally {
      await closeSession(handle);
    }
  };

  /** What a field holds, read off the page rather than echoed back from the action. */
  const fieldValue = (handle: PageHandle, selector: string): Promise<string> =>
    handle.page.evaluate((target) => {
      const node = document.querySelector(target);
      if (!(node instanceof HTMLInputElement)) {
        throw new Error(`the fixture page has no input at ${target}`);
      }
      return node.value;
    }, selector);

  /** Where a control sits relative to what is on screen: the test of "in view". */
  const viewportRect = (
    handle: PageHandle,
    selector: string,
  ): Promise<{ top: number; bottom: number; viewportHeight: number }> =>
    handle.page.evaluate((target) => {
      const node = document.querySelector(target);
      if (node === null) throw new Error(`the fixture page has no ${target}`);
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
    }, selector);

  it(
    'advances to the next step when the cart page is clicked through',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        const action = { type: 'click', selector: '#cart-checkout' } as const;

        const result = await act(handle, action, contextFor(DESKTOP));

        expect(result.ok).toBe(true);
        expect(result.failure).toBeUndefined();
        expect(result.action).toEqual(action);
        expect(result.url).toBe(`${site.url}/payment.html`);
        expect(result.scrollY).toBe(0);
        // The page it arrived at, as the page itself reports it.
        expect((await readSessionState(handle)).url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'acts on the same control whether it is named by element id or by selector',
    async () => {
      // The id is minted the way an extractor mints it, from the box `LANDMARKS.md`
      // records for the checkout link. The capture it belongs to is built here rather
      // than taken from `capture()`, because extraction is a seam #45 fills: what this
      // holds is that `act` resolves an id against the capture it is handed, to the
      // control the equivalent selector picks.
      const checkout: CaptureElement = {
        id: stableElementId({ source: 'dom', role: 'link', name: 'Checkout', bbox: CHECKOUT_BOX }),
        source: 'dom',
        role: 'link',
        name: 'Checkout',
        text: 'Checkout',
        bbox: CHECKOUT_BOX,
        isPrimaryAction: true,
        belowFold: false,
        selector: '#cart-checkout',
      };

      const byElementId = await withSession(DESKTOP, '/cart.html', (handle) =>
        act(handle, { type: 'click', elementId: checkout.id }, contextFor(DESKTOP), {
          screen: { elements: [checkout] },
        }),
      );
      const bySelector = await withSession(DESKTOP, '/cart.html', (handle) =>
        act(handle, { type: 'click', selector: checkout.selector }, contextFor(DESKTOP)),
      );

      expect(byElementId.ok).toBe(true);
      expect(byElementId.url).toBe(`${site.url}/payment.html`);
      expect(bySelector.ok).toBe(true);
      expect(byElementId.url).toBe(bySelector.url);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'scrolls by a delta and reports the position it reached',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        // The cart is 1400 tall at a 900-tall viewport, so 400 is a position it can reach.
        const result = await act(handle, { type: 'scroll', deltaY: 400 }, contextFor(DESKTOP));

        expect(result.ok).toBe(true);
        expect(result.scrollY).toBe(400);
        expect((await readSessionState(handle)).scrollY).toBe(400);
        expect(result.url).toBe(`${site.url}/cart.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'brings the control below the mobile fold into view when it scrolls to it',
    async () =>
      withSession(MOBILE, '/cart.html', async (handle) => {
        // `cart-promo-apply` starts at y 862: below the fold of a 844-tall viewport.
        const before = await viewportRect(handle, '#cart-promo-apply');
        expect(before.top).toBeGreaterThanOrEqual(before.viewportHeight);

        const result = await act(
          handle,
          { type: 'scroll', selector: '#cart-promo-apply' },
          contextFor(MOBILE),
        );

        expect(result.ok).toBe(true);
        expect(result.scrollY).toBeGreaterThan(0);
        expect((await readSessionState(handle)).scrollY).toBe(result.scrollY);

        const after = await viewportRect(handle, '#cart-promo-apply');
        expect(after.top).toBeGreaterThanOrEqual(0);
        expect(after.bottom).toBeLessThanOrEqual(after.viewportHeight);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'leaves the payment field holding exactly the value typed into it',
    async () =>
      withSession(DESKTOP, '/payment.html', async (handle) => {
        const typed = '4242 4242 4242 4242';

        const result = await act(
          handle,
          { type: 'type', selector: '#payment-card-number', value: typed },
          contextFor(DESKTOP),
        );

        expect(result.ok).toBe(true);
        expect(await fieldValue(handle, '#payment-card-number')).toBe(typed);
        // Typing navigates nothing: the session is still on the payment page.
        expect(result.url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'returns from the review page to the page before it',
    async () =>
      withSession(DESKTOP, '/payment.html', async (handle) => {
        const submitted = await act(
          handle,
          { type: 'click', selector: '#payment-submit' },
          contextFor(DESKTOP),
        );
        // The payment form is a GET submit, so the review page carries a query string.
        expect(submitted.ok).toBe(true);
        expect(submitted.url).toContain('/review.html');

        const back = await act(handle, { type: 'back' }, contextFor(DESKTOP));

        expect(back.ok).toBe(true);
        expect(back.failure).toBeUndefined();
        expect(back.url).toBe(`${site.url}/payment.html`);
        expect((await readSessionState(handle)).url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports a back navigation with nothing behind it, and stays on the page',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        const result = await act(handle, { type: 'back' }, contextFor(DESKTOP));

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('navigation_error');
        // Going back off the first page of a task must not leave the session on the blank
        // page it started from: the product is still in front of it, and still usable.
        expect(result.url).toBe(`${site.url}/cart.html`);
        expect((await readSessionState(handle)).url).toBe(`${site.url}/cart.html`);

        const next = await act(
          handle,
          { type: 'click', selector: '#cart-checkout' },
          contextFor(DESKTOP),
        );
        expect(next.ok).toBe(true);
        expect(next.url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports a selector that resolves to nothing and leaves the page usable',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        const missed = await act(
          handle,
          { type: 'click', selector: '#not-a-control-on-this-page' },
          contextFor(DESKTOP),
          { timeoutMs: ABSENT_TARGET_TIMEOUT_MS },
        );

        expect(missed.ok).toBe(false);
        expect(missed.failure).toBe('selector_not_found');
        expect(missed.url).toBe(`${site.url}/cart.html`);
        expect(missed.scrollY).toBe(0);

        // The page is left as it was, so the next action still works.
        const next = await act(
          handle,
          { type: 'click', selector: '#cart-checkout' },
          contextFor(DESKTOP),
        );
        expect(next.ok).toBe(true);
        expect(next.url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports an element id no capture explains, without reaching the page',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        const result = await act(
          handle,
          { type: 'click', elementId: 'e-000000000000' },
          contextFor(DESKTOP),
          { screen: { elements: [] } },
        );

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('selector_not_found');
        expect(result.url).toBe(`${site.url}/cart.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports a click with nothing to aim at',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        const result = await act(handle, { type: 'click' }, contextFor(DESKTOP));

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('selector_not_found');
        expect(result.url).toBe(`${site.url}/cart.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );
});
