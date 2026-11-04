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
import type { Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  act,
  closeSession,
  detectStep,
  extractElements,
  openSession,
  readGeometry,
  readSessionState,
} from '../src/index.js';
import type {
  CaptureContext,
  CaptureElement,
  Device,
  PageHandle,
  TaskDefinition,
} from '../src/index.js';
import { destroyedContext, detachedTarget } from './helpers/driver-errors.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';
import { fileURLToPath } from 'node:url';

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

/** The cart's primary action, as `LANDMARKS.md` records it. */
const CHECKOUT_SELECTOR = '#cart-checkout';

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
  /**
   * The checkout link as the extractor itself describes it: the id `act` is asked to
   * resolve is the one a capture of this page would carry, not one written out by hand.
   */
  const extractCheckout = async (
    handle: PageHandle,
  ): Promise<{ elements: readonly CaptureElement[]; checkout: CaptureElement }> => {
    const elements = await extractElements(
      handle,
      await readGeometry(handle),
      await detectStep(handle, TASK),
    );
    const checkout = elements.find((element) => element.selector === CHECKOUT_SELECTOR);
    if (checkout === undefined) {
      throw new Error(
        `no extracted element selects ${CHECKOUT_SELECTOR}: ${elements
          .map((element) => element.selector)
          .join(', ')}`,
      );
    }
    return { elements, checkout };
  };

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
        const action = { type: 'click', selector: CHECKOUT_SELECTOR } as const;

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
    'taps where a control is when it never holds still long enough for Playwright to click it',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        // A playing video or a carousel: its box moves every frame, so Playwright's wait for a
        // stable element runs out.
        await handle.page.evaluate((selector) => {
          document
            .querySelector(selector)
            ?.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(4px)' }], {
              duration: 200,
              iterations: Infinity,
              direction: 'alternate',
            });
        }, CHECKOUT_SELECTOR);

        const result = await act(
          handle,
          { type: 'click', selector: CHECKOUT_SELECTOR },
          contextFor(DESKTOP),
          { timeoutMs: 1000 },
        );

        expect(result.ok).toBe(true);
        expect(result.url).toBe(`${site.url}/payment.html`);
      }),
    BROWSER_TIMEOUT_MS,
  );

  it(
    'acts on the same control whether it is named by element id or by selector',
    async () => {
      // The capture is the extractor's own reading of the page, so the id handed to `act`
      // is the id an agent would have decided against. What this holds is that resolving
      // it lands on the control the equivalent selector picks.
      const byElementId = await withSession(DESKTOP, '/cart.html', async (handle) => {
        const { elements, checkout } = await extractCheckout(handle);
        return act(handle, { type: 'click', elementId: checkout.id }, contextFor(DESKTOP), {
          screen: { elements },
        });
      });
      const bySelector = await withSession(DESKTOP, '/cart.html', (handle) =>
        act(handle, { type: 'click', selector: CHECKOUT_SELECTOR }, contextFor(DESKTOP)),
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
    'clears the field when the action carries no value',
    async () =>
      withSession(DESKTOP, '/payment.html', async (handle) => {
        await act(
          handle,
          { type: 'type', selector: '#payment-card-number', value: '4242' },
          contextFor(DESKTOP),
        );

        // Typing nothing into a field is what an action with no value asks for. It is
        // stated here so that it is a decision and not an accident of `value ?? ''`.
        const result = await act(
          handle,
          { type: 'type', selector: '#payment-card-number' },
          contextFor(DESKTOP),
        );

        expect(result.ok).toBe(true);
        expect(await fieldValue(handle, '#payment-card-number')).toBe('');
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
    'resolves an element id off the live page when it is handed no capture',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        // `CaptureSource.act` takes three parameters, so the walk and the swarm above it
        // cannot hand their capture over: every `elementId` they decide on is resolved by
        // reading the page again. That reading has to mint the same id the capture did.
        const { checkout } = await extractCheckout(handle);

        const result = await act(
          handle,
          { type: 'click', elementId: checkout.id },
          contextFor(DESKTOP),
        );

        expect(result.ok).toBe(true);
        expect(result.failure).toBeUndefined();
        expect(result.url).toBe(`${site.url}/payment.html`);
        expect((await readSessionState(handle)).url).toBe(`${site.url}/payment.html`);
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
    'looks an element id up on the page when it is handed no capture',
    async () =>
      withSession(DESKTOP, '/cart.html', async (handle) => {
        // The same reading, for an id nothing on the cart carries: a page read in full
        // still resolves no element, and that is `selector_not_found` rather than a throw.
        const result = await act(
          handle,
          { type: 'click', elementId: 'e-000000000000' },
          contextFor(DESKTOP),
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

/**
 * A click that moves the page **within one document** (#441).
 *
 * `following` waited for a navigation request and gave up when there was none, and a
 * same-document navigation makes no request: a framework's link pushes its history entry
 * once the route has resolved, which can be after the click's own promise has settled. So
 * the position the result reported was the page the click left, and on a one-URL run nothing
 * ever contradicted it — the step matched both views and the scroll position did not move.
 * Two of the owner's sessions were recorded as `abandoned` on the sign-up view they had
 * reached, and a third identical one was a success.
 *
 * The fixture is `fixtures/spa/`, whose push is deferred to the frame after the handler for
 * exactly this reason.
 *
 * **And a click that moved the page is a success even when its target went with the move**
 * (#442). A framework resolves the route, renders the next view and removes the one the link
 * was in, so a check still running against that node finds it gone — for an action that did
 * exactly what the agent asked. Reported as a failure, it put the one action of the owner's
 * session which worked into the artifact as a failure, and spent a give-up budget on it. The
 * same words on a click that left the page where it was are the failure they have always
 * been: the address the click started from is what separates the two.
 */
describeWithChromium('a click that moves the address with no document load', () => {
  /** The single-page application of #441: see `fixtures/spa/README.md`. */
  const SPA_DIR = fileURLToPath(new URL('./fixtures/spa', import.meta.url));

  /** One step for the whole application, as a one-URL run derives it (see `taskFor`). */
  const ONE_STEP: TaskDefinition = {
    id: 'signing-up',
    prompt: 'Sign up.',
    steps: [
      { id: 'page', label: 'The page', match: { urlPattern: '/', requiredSelector: '#app' } },
    ],
  };

  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite({ root: SPA_DIR });
  });

  afterAll(async () => {
    await site.close();
  });

  const context = (): CaptureContext => ({
    variant: 'A',
    device: DESKTOP,
    task: ONE_STEP,
    runDir: 'runs/act-writes-nothing',
  });

  /**
   * `act.ts`'s `NAVIGATION_START_MS`: the cap a click's move is waited for under. Written out
   * here rather than exported, because what this suite needs it for is a bound — a click that
   * moved the page answers as soon as the move committed, and never by waiting the cap out.
   */
  const MOVE_CAP_MS = 1_000;

  it(
    'reports the address the click reached, and not the page it left',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        // A mark in the document the click starts on: a document that was loaded again
        // would not carry it, so this is what says the move was a same-document one.
        await handle.page.evaluate(() => {
          (window as unknown as { pvMark?: number }).pvMark = 441;
        });

        const startedAt = Date.now();
        const result = await act(handle, { type: 'click', selector: '#start-signup' }, context());
        const tookMs = Date.now() - startedAt;

        expect(result.ok).toBe(true);
        // Waited for, and no longer: the move is what the action answers on. Waiting the cap
        // out instead would be waiting for a request a `pushState` never makes.
        expect(tookMs).toBeLessThan(MOVE_CAP_MS);
        expect(result.url).toBe(`${site.url}/signup`);
        expect(result.step).toBe('page');
        // The page agrees, and nothing was loaded to get there.
        expect((await readSessionState(handle)).url).toBe(`${site.url}/signup`);
        expect(
          await handle.page.evaluate(() => (window as unknown as { pvMark?: number }).pvMark),
        ).toBe(441);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports the page it is on when the click moves nothing at all',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        // The heading is no link, so this click asks for nothing: no request, no address
        // change, and the one bounded wait both cases share ends without either.
        const result = await act(handle, { type: 'click', selector: '#view-heading' }, context());

        expect(result.ok).toBe(true);
        expect(result.url).toBe(`${site.url}/app.html`);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  /**
   * A handle whose click raises a driver error of our choosing, **after the click itself has
   * happened** (#442).
   *
   * Playwright's own locator turns a node that went away under an action into a retry, and
   * then into a timeout, so the detached-target and destroyed-context sentences a real site
   * raises arrive from calls this module does not make and cannot be provoked through a
   * fixture. What *can* be reproduced exactly is the situation they describe — a click that
   * worked, whose target and whose execution context went with the navigation it caused — so
   * the click is performed for real and the driver's own sentence, recorded from a real
   * browser in `helpers/driver-errors.ts` and kept honest by `failures.test.ts`, is raised
   * after it.
   *
   * Nothing else is stood in for. Every other call on the page and on the locator reaches the
   * real thing, bound to it: a driver object's own methods read fields of their own, and
   * `this` has to be the page rather than this proxy (see `capture.test.ts`).
   */
  const clickRaising = (handle: PageHandle, error: Error): PageHandle => {
    const poison = (locator: Locator): Locator =>
      new Proxy(locator, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (property !== 'click') return value.bind(target);
          return async (...args: unknown[]): Promise<never> => {
            await (value as (...given: unknown[]) => Promise<void>).apply(target, args);
            throw error;
          };
        },
      });

    const page = new Proxy(handle.page, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'locator') return value.bind(target);
        return (...args: unknown[]): Locator =>
          poison((value as (...given: unknown[]) => Locator).apply(target, args));
      },
    });

    return { ...handle, page };
  };

  it(
    'is a success when its own node went with the navigation, with the address it reached',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        // This link resolves its route **inside** the click: the address is pushed and the
        // view redrawn while the click is still being dispatched, so the node the driver
        // aimed at is out of the DOM before the click is done with it.
        const result = await act(
          handle,
          { type: 'click', selector: '#start-detaching' },
          context(),
        );

        expect(result.ok).toBe(true);
        expect(result.failure).toBeUndefined();
        expect(result.url).toBe(`${site.url}/joined`);
        // The node really is gone, and no document was loaded to take it away.
        expect(await handle.page.locator('#start-detaching').count()).toBe(0);
        expect(await handle.page.locator('#joined-back').count()).toBe(1);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  for (const { what, error } of [
    { what: 'a detached target', error: detachedTarget('locator.click') },
    { what: 'a destroyed execution context', error: destroyedContext('locator.click') },
  ]) {
    it(
      `reports ${what} on a click that moved the page as the success it is`,
      async () => {
        const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
        try {
          const result = await act(
            clickRaising(handle, error),
            { type: 'click', selector: '#start-signup' },
            context(),
          );

          // The click did exactly what the agent asked. Recording it a failure put the one
          // action of the owner's session that worked in the artifact as a failure, and spent
          // a give-up budget on it.
          expect(result.ok).toBe(true);
          expect(result.failure).toBeUndefined();
          // And the position it reports is the one it reached, not the page it left — which
          // this link pushes 50 ms after the click, so the answer is waited for.
          expect(result.url).toBe(`${site.url}/signup`);
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  }

  it(
    'leaves a detached target on a page that went nowhere the mystery it is today',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        // The heading is no link: this click moves neither the address nor the document, so
        // the same sentence is a target that went away for a reason we cannot account for.
        // `failure-mapping.ts` places it under none of the four reasons, and the caller
        // rethrows it — exactly as it does on `main`.
        await expect(
          act(
            clickRaising(handle, detachedTarget('locator.click')),
            { type: 'click', selector: '#view-heading' },
            context(),
          ),
        ).rejects.toThrow('Element is not attached to the DOM');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'is no success where the page moved itself under a click that asked for nothing',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        // Nobody acts: the application pushes its own address on a timer, which is a
        // redirect, a locale bounce or a consent flow on the real web. The click is on the
        // heading, so it asks for nothing at all — and the heading is redrawn under the same
        // id in every view, so the thing the click was aimed at is still there afterwards.
        //
        // The page having moved cannot be the whole of the rule: a destroyed context is
        // raised *by* a navigation commit, so "the page moved" is true of every one of them.
        // Without the target itself being gone, this would be recorded as an action that
        // worked, and would reset the give-up budgets of an agent that did nothing.
        await handle.page.evaluate(() => {
          (window as unknown as { pvMoveIn: (ms: number, to: string) => void }).pvMoveIn(
            100,
            '/signup',
          );
        });

        const result = await act(
          clickRaising(handle, destroyedContext('locator.click')),
          { type: 'click', selector: '#view-heading' },
          context(),
        );

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('navigation_error');
        // The page really did move, which is what makes this the case worth pinning.
        expect(result.url).toBe(`${site.url}/signup`);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'leaves a destroyed context on a page that went nowhere the navigation error it is today',
    async () => {
      const handle = await openSession({ id: 'A', url: `${site.url}/app.html` }, DESKTOP);
      try {
        const result = await act(
          clickRaising(handle, destroyedContext('locator.click')),
          { type: 'click', selector: '#view-heading' },
          context(),
        );

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('navigation_error');
        expect(result.url).toBe(`${site.url}/app.html`);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
