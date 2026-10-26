/**
 * The candidate elements of the fixture site's pages, against the site's own record.
 *
 * `fixtures/site/LANDMARKS.md` states, for every landmark of every page, its role, its
 * accessible name, its page-space box and which side of the fold it falls on at each of the
 * two viewports. Those numbers were read out of a browser, so this suite asserts equality
 * rather than a range — and the roles and names it asserts are the ones that document says
 * **#45 makes enforced**: here they are checked against a live accessibility tree.
 *
 * Everything goes through the package's public entry point: a session is opened with
 * `openSession`, measured with `readGeometry` and read with `extractElements`. The page
 * handle is used for two things only — scrolling, to prove a box is in page space, and
 * counting the nodes a selector resolves to, which is a question about the document and not
 * about Playwright.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capture,
  closeSession,
  extractElements,
  openSession,
  readGeometry,
  readSessionState,
} from '../src/index.js';
import type { Box, CaptureElement, Device, PageHandle, TaskDefinition } from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** Long enough to launch a browser and load a page on a cold machine. */
const BROWSER_TIMEOUT_MS = 60_000;

/** The two devices `LANDMARKS.md` positions everything for. */
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

/**
 * One variant id for every session here. An element's id is a function of the screen — the
 * variant and step included — so a test that compared two sessions opened under two variant
 * ids would be asserting the opposite of what it means to.
 */
const VARIANT_ID = 'control';

/** The task these pages are written for, as `LANDMARKS.md` declares its step match rules. */
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
    {
      id: 'confirmation',
      label: 'Confirmation',
      match: { urlPattern: '/confirmation\\.html', requiredSelector: '#confirmation-receipt' },
      primaryAction: { selector: '#confirmation-continue-shopping' },
    },
  ],
};

/**
 * One row of a `LANDMARKS.md` table. `name` is the accessible name that document records,
 * `null` where it records none — a name it writes as — is empty in the accessibility tree,
 * not missing. `text` is given only where the document records visible text for the
 * landmark itself.
 */
interface Landmark {
  id: string;
  role: string;
  name: string | null;
  bbox: Box;
  text?: string;
  belowFold: { mobile: boolean; desktop: boolean };
}

const above = { mobile: false, desktop: false };
const below = { mobile: true, desktop: true };

/** `LANDMARKS.md`, "Page: cart.html". */
const CART: Landmark[] = [
  {
    id: 'cart-banner',
    role: 'generic',
    name: null,
    bbox: { x: 16, y: 16, width: 358, height: 48 },
    belowFold: above,
  },
  {
    id: 'cart-heading',
    role: 'heading',
    name: 'Your cart',
    text: 'Your cart',
    bbox: { x: 16, y: 80, width: 358, height: 40 },
    belowFold: above,
  },
  {
    id: 'cart-intro',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 128, width: 358, height: 56 },
    belowFold: above,
  },
  {
    id: 'cart-product-image',
    role: 'img',
    name: 'Canvas tote bag, natural',
    bbox: { x: 16, y: 200, width: 120, height: 120 },
    belowFold: above,
  },
  {
    id: 'cart-items',
    role: 'region',
    name: 'Cart items',
    bbox: { x: 16, y: 336, width: 358, height: 240 },
    belowFold: above,
  },
  {
    id: 'cart-item-tote-name',
    role: 'generic',
    name: null,
    text: 'Canvas tote bag',
    bbox: { x: 28, y: 348, width: 240, height: 20 },
    belowFold: above,
  },
  {
    id: 'cart-remove-tote',
    role: 'button',
    name: 'Remove',
    text: 'Remove',
    bbox: { x: 28, y: 376, width: 120, height: 32 },
    belowFold: above,
  },
  {
    id: 'cart-save-tote',
    role: 'button',
    name: 'Save the canvas tote for later',
    text: 'Save',
    bbox: { x: 156, y: 376, width: 206, height: 32 },
    belowFold: above,
  },
  {
    id: 'cart-item-mug-name',
    role: 'generic',
    name: null,
    text: 'Enamel mug',
    bbox: { x: 28, y: 432, width: 240, height: 20 },
    belowFold: above,
  },
  {
    id: 'cart-remove-mug',
    role: 'button',
    name: 'Remove',
    text: 'Remove',
    bbox: { x: 28, y: 460, width: 120, height: 32 },
    belowFold: above,
  },
  {
    id: 'cart-upsell-card',
    role: 'generic',
    name: null,
    bbox: { x: 16, y: 600, width: 358, height: 160 },
    belowFold: above,
  },
  {
    id: 'cart-checkout',
    role: 'link',
    name: 'Checkout',
    text: 'Checkout',
    bbox: { x: 16, y: 784, width: 358, height: 44 },
    belowFold: above,
  },
  {
    // The one that changes side with the viewport: y 862 is below a 844-tall viewport's
    // fold and above a 900-tall one's.
    id: 'cart-promo-apply',
    role: 'button',
    name: 'Apply a promo code',
    text: 'Apply a promo code',
    bbox: { x: 16, y: 862, width: 358, height: 28 },
    belowFold: { mobile: true, desktop: false },
  },
  {
    id: 'cart-footer-note',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 1200, width: 358, height: 40 },
    belowFold: below,
  },
];

/** `LANDMARKS.md`, "Page: payment.html". */
const PAYMENT: Landmark[] = [
  {
    id: 'payment-heading',
    role: 'heading',
    name: 'Payment',
    text: 'Payment',
    bbox: { x: 16, y: 16, width: 358, height: 40 },
    belowFold: above,
  },
  {
    id: 'payment-intro',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 72, width: 358, height: 56 },
    belowFold: above,
  },
  {
    id: 'payment-card-image',
    role: 'img',
    name: 'A payment card',
    bbox: { x: 16, y: 144, width: 120, height: 120 },
    belowFold: above,
  },
  {
    id: 'payment-form',
    role: 'form',
    name: 'Payment details',
    bbox: { x: 16, y: 288, width: 358, height: 300 },
    belowFold: above,
  },
  {
    id: 'payment-card-number',
    role: 'textbox',
    name: 'Card number',
    bbox: { x: 28, y: 324, width: 334, height: 32 },
    belowFold: above,
  },
  {
    id: 'payment-expiry-month',
    role: 'combobox',
    name: 'Expiry month',
    bbox: { x: 28, y: 396, width: 334, height: 32 },
    belowFold: above,
  },
  {
    id: 'payment-submit',
    role: 'button',
    name: 'Review order',
    text: 'Review order',
    bbox: { x: 28, y: 468, width: 200, height: 44 },
    belowFold: above,
  },
  {
    id: 'payment-footer-note',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 1000, width: 358, height: 40 },
    belowFold: below,
  },
];

/** `LANDMARKS.md`, "Page: review.html". */
const REVIEW: Landmark[] = [
  {
    id: 'review-heading',
    role: 'heading',
    name: 'Review your order',
    text: 'Review your order',
    bbox: { x: 16, y: 16, width: 358, height: 40 },
    belowFold: above,
  },
  {
    id: 'review-intro',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 72, width: 358, height: 56 },
    belowFold: above,
  },
  {
    id: 'review-product-image',
    role: 'img',
    name: 'Canvas tote bag, natural',
    bbox: { x: 16, y: 144, width: 120, height: 120 },
    belowFold: above,
  },
  {
    id: 'review-summary',
    role: 'region',
    name: 'Order summary',
    bbox: { x: 16, y: 288, width: 358, height: 200 },
    belowFold: above,
  },
  {
    id: 'review-total',
    role: 'generic',
    name: null,
    text: 'Total 48.00',
    bbox: { x: 28, y: 300, width: 334, height: 24 },
    belowFold: above,
  },
  {
    id: 'review-back',
    role: 'link',
    name: 'Back to payment',
    text: 'Back to payment',
    bbox: { x: 16, y: 520, width: 358, height: 24 },
    belowFold: above,
  },
  {
    id: 'review-place-order',
    role: 'link',
    name: 'Place order',
    text: 'Place order',
    bbox: { x: 16, y: 600, width: 358, height: 44 },
    belowFold: above,
  },
  {
    id: 'review-footer-note',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 1000, width: 358, height: 40 },
    belowFold: below,
  },
];

/** `LANDMARKS.md`, "Page: confirmation.html". */
const CONFIRMATION: Landmark[] = [
  {
    id: 'confirmation-heading',
    role: 'heading',
    name: 'Order confirmed',
    text: 'Order confirmed',
    bbox: { x: 16, y: 16, width: 358, height: 40 },
    belowFold: above,
  },
  {
    id: 'confirmation-intro',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 72, width: 358, height: 56 },
    belowFold: above,
  },
  {
    id: 'confirmation-receipt-image',
    role: 'img',
    name: 'A printed receipt',
    bbox: { x: 16, y: 144, width: 120, height: 120 },
    belowFold: above,
  },
  {
    id: 'confirmation-receipt',
    role: 'region',
    name: 'Receipt',
    bbox: { x: 16, y: 288, width: 358, height: 160 },
    belowFold: above,
  },
  {
    id: 'confirmation-order-number',
    role: 'generic',
    name: null,
    text: 'Order FIX-1001',
    bbox: { x: 28, y: 300, width: 334, height: 24 },
    belowFold: above,
  },
  {
    id: 'confirmation-continue-shopping',
    role: 'link',
    name: 'Continue shopping',
    text: 'Continue shopping',
    bbox: { x: 16, y: 480, width: 358, height: 44 },
    belowFold: above,
  },
  {
    id: 'confirmation-footer-note',
    role: 'paragraph',
    name: null,
    bbox: { x: 16, y: 940, width: 358, height: 40 },
    belowFold: below,
  },
];

/** The four step pages, with the step each one is. */
const STEP_PAGES = [
  { path: '/cart.html', step: 'cart', landmarks: CART },
  { path: '/payment.html', step: 'payment', landmarks: PAYMENT },
  { path: '/review.html', step: 'review', landmarks: REVIEW },
  { path: '/confirmation.html', step: 'confirmation', landmarks: CONFIRMATION },
] as const;

/** The one candidate of a source for a landmark, or a failure that says what was found. */
const sole = (
  elements: readonly CaptureElement[],
  id: string,
  source: CaptureElement['source'],
): CaptureElement => {
  const found = elements.filter(
    (element) => element.selector === `#${id}` && element.source === source,
  );
  const [first] = found;
  if (first === undefined || found.length !== 1) {
    throw new Error(`expected one ${source} candidate for #${id}, found ${found.length}`);
  }
  return first;
};

describeWithChromium('candidate elements', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const open = (device: Device, path: string): Promise<PageHandle> =>
    openSession({ id: VARIANT_ID, url: `${site.url}${path}` }, device);

  const extract = async (
    handle: PageHandle,
    step: string | null,
  ): Promise<readonly CaptureElement[]> =>
    extractElements(handle, await readGeometry(handle), step);

  for (const device of [MOBILE, DESKTOP]) {
    const side = device.name === 'mobile' ? 'mobile' : 'desktop';

    describe(`at ${device.name} (${device.viewport.width}x${device.viewport.height})`, () => {
      for (const page of STEP_PAGES) {
        describe(page.path, () => {
          let handle: PageHandle | undefined;
          let elements: readonly CaptureElement[] = [];

          beforeAll(async () => {
            handle = await open(device, page.path);
            elements = await extract(handle, page.step);
          }, BROWSER_TIMEOUT_MS);

          afterAll(async () => {
            // Only if it opened: a session that never did would otherwise be reported as a
            // teardown error instead of as the launch failure it is.
            if (handle !== undefined) {
              await closeSession(handle);
            }
          });

          const opened = (): PageHandle => {
            if (handle === undefined) {
              throw new Error('the session never opened');
            }
            return handle;
          };

          it.each(page.landmarks)('finds $id from both sources', (landmark: Landmark) => {
            const fromA11y = sole(elements, landmark.id, 'a11y');
            const fromDom = sole(elements, landmark.id, 'dom');

            // The accessibility tree is the authority on a role and a name.
            expect(fromA11y.role).toBe(landmark.role);
            expect(fromA11y.name).toBe(landmark.name);
            // The DOM agrees about the role and the box; the names are allowed to differ,
            // and where the record states visible text, that is what the DOM reads.
            expect(fromDom.role).toBe(landmark.role);
            if (landmark.text !== undefined) {
              expect(fromDom.text).toBe(landmark.text);
              expect(fromA11y.text).toBe(landmark.text);
            }

            for (const candidate of [fromA11y, fromDom]) {
              expect(candidate.bbox).toEqual(landmark.bbox);
              expect(candidate.belowFold).toBe(landmark.belowFold[side]);
              // The step's declared primary action is resolved onto these elsewhere.
              expect(candidate.isPrimaryAction).toBe(false);
            }
          });

          it('reports no element twice from one source', () => {
            for (const source of ['dom', 'a11y'] as const) {
              const selectors = elements
                .filter((element) => element.source === source)
                .map((element) => element.selector);
              expect(new Set(selectors).size).toBe(selectors.length);
            }
          });

          it('mints one id per element of the screen', () => {
            const ids = elements.map((element) => element.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const id of ids) {
              expect(id).toMatch(/^e-[0-9a-f]{12}$/);
            }
          });

          it(
            'gives every element a selector that resolves to exactly one node',
            async () => {
              const counts = await opened().page.evaluate(
                (selectors: string[]) =>
                  selectors.map((selector) => document.querySelectorAll(selector).length),
                elements.map((element) => element.selector),
              );
              expect(counts).toEqual(elements.map(() => 1));
            },
            BROWSER_TIMEOUT_MS,
          );
        });
      }
    });
  }

  describe('the cart, read twice', () => {
    let handle: PageHandle;
    let elements: readonly CaptureElement[];

    beforeAll(async () => {
      handle = await open(MOBILE, '/cart.html');
      elements = await extract(handle, 'cart');
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await closeSession(handle);
    });

    it(
      'reads an element that the handle has lost mid-extraction as gone, not as a crash',
      async () => {
        // The accessibility tree is one snapshot and its nodes are read one at a time
        // afterwards, so a page that changes in between can have dropped a node before it
        // is reached. A carousel doing that must not fail the capture of the rest.
        const other = await open(MOBILE, '/cart.html');
        try {
          await other.page.evaluate(() => {
            const card = document.querySelector('#cart-upsell-card');
            setTimeout(() => card?.remove(), 0);
          });
          const geometry = await readGeometry(other);
          const found = await extractElements(other, geometry, 'cart');
          expect(sole(found, 'cart-checkout', 'a11y').name).toBe('Checkout');
        } finally {
          await closeSession(other);
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it('names the aria-label-only control from the accessibility tree', () => {
      const fromA11y = sole(elements, 'cart-save-tote', 'a11y');
      const fromDom = sole(elements, 'cart-save-tote', 'dom');

      expect(fromA11y.name).toBe('Save the canvas tote for later');
      expect(fromDom.name).toBe('Save');
      // Both read the same words off the page; only the name they were given differs.
      expect(fromA11y.text).toBe('Save');
      expect(fromDom.text).toBe('Save');
      expect(fromA11y.id).not.toBe(fromDom.id);
    });

    it('tells the two controls with the same words apart', () => {
      for (const source of ['dom', 'a11y'] as const) {
        const tote = sole(elements, 'cart-remove-tote', source);
        const mug = sole(elements, 'cart-remove-mug', source);

        expect(tote.name).toBe(mug.name);
        expect(tote.role).toBe(mug.role);
        expect(tote.id).not.toBe(mug.id);
      }
    });

    it('states the box of a region the DOM cannot explain, and nothing else', () => {
      for (const id of ['cart-banner', 'cart-upsell-card']) {
        const region = sole(elements, id, 'dom');
        expect(region.name).toBeNull();
        expect(region.text).toBeNull();
        expect(region.bbox.width).toBeGreaterThan(0);
        expect(region.bbox.height).toBeGreaterThan(0);
      }
    });

    it(
      'reports boxes in page space, which a scroll does not move',
      async () => {
        const geometry = await readGeometry(handle);
        const before = await extractElements(handle, geometry, 'cart');

        await handle.page.evaluate(() => {
          window.scrollTo(0, 400);
        });
        expect((await readSessionState(handle)).scrollY).toBe(400);

        const after = await extractElements(handle, geometry, 'cart');
        expect(after).toEqual(before);
        // And the boxes are the page-space positions the record states.
        expect(sole(after, 'cart-footer-note', 'dom').bbox).toEqual({
          x: 16,
          y: 1200,
          width: 358,
          height: 40,
        });
        expect(sole(after, 'cart-checkout', 'dom').bbox).toEqual({
          x: 16,
          y: 784,
          width: 358,
          height: 44,
        });
      },
      BROWSER_TIMEOUT_MS,
    );
  });

  it(
    'mints the same ids in two sessions and at both viewports',
    async () => {
      const idsOf = async (device: Device): Promise<Record<string, string>> => {
        const handle = await open(device, '/cart.html');
        try {
          const elements = await extract(handle, 'cart');
          return Object.fromEntries(
            elements.map((element) => [`${element.source} ${element.selector}`, element.id]),
          );
        } finally {
          await closeSession(handle);
        }
      };

      const first = await idsOf(MOBILE);
      const second = await idsOf(MOBILE);
      const desktop = await idsOf(DESKTOP);

      expect(Object.keys(first).length).toBeGreaterThan(CART.length);
      expect(second).toEqual(first);
      // The two viewports put `cart-promo-apply` on different sides of the fold and still
      // name every element the same, which is what lets metrics be aggregated over both.
      expect(desktop).toEqual(first);
    },
    BROWSER_TIMEOUT_MS * 3,
  );

  describe('a page the fixture site does not have', () => {
    /**
     * The cases `LANDMARKS.md` says to bring your own fixture for. Every landmark on that
     * site is an opaque, statically positioned box, and these are the four kinds of element
     * that are not: one anchored to the viewport, one laid out but invisible, one painted
     * with nothing, and text in a table.
     */
    const PAGE = [
      '<!doctype html><html><head><style>',
      'body { margin: 0; height: 3000px; }',
      '#bar { position: fixed; top: 0; left: 0; width: 320px; height: 60px; background: #222 }',
      '#ghost { opacity: 0 }',
      '#glass { width: 300px; height: 300px; background: rgba(255, 0, 0, 0) }',
      '</style></head><body tabindex="-1">',
      '<div id="bar">Checkout</div>',
      '<p id="ghost">Prose nobody can see</p>',
      '<div id="glass"></div>',
      '<details id="faq"><summary id="ask">Shipping</summary><p id="answer">Two days</p></details>',
      '<table><caption id="cap">Order</caption><tbody><tr><td id="cell">Tote 48.00</td></tr></tbody></table>',
      '</body></html>',
    ].join('');

    let handle: PageHandle;
    let elements: readonly CaptureElement[];

    beforeAll(async () => {
      handle = await openSession(
        { id: VARIANT_ID, url: `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}` },
        MOBILE,
      );
      elements = await extract(handle, null);
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      if (handle !== undefined) {
        await closeSession(handle);
      }
    });

    const selectors = (): string[] => elements.map((element) => element.selector);

    it(
      'leaves an element anchored to the viewport where it paints',
      async () => {
        const bar = sole(elements, 'bar', 'dom');
        expect(bar.bbox).toEqual({ x: 0, y: 0, width: 320, height: 60 });

        await handle.page.evaluate(() => {
          window.scrollTo(0, 600);
        });
        expect((await readSessionState(handle)).scrollY).toBe(600);

        // A fixed element's box is not the document's: adding the scroll offset would walk
        // it 600 pixels down a page it never moved on, and past the fold with it.
        const after = await extractElements(handle, await readGeometry(handle), null);
        expect(sole(after, 'bar', 'dom').bbox).toEqual(bar.bbox);
        expect(sole(after, 'bar', 'dom').belowFold).toBe(false);
      },
      BROWSER_TIMEOUT_MS,
    );

    it('leaves out what is laid out and cannot be seen', () => {
      // `opacity: 0` prose, and the answer inside a collapsed `<details>`.
      expect(selectors()).not.toContain('#ghost');
      expect(selectors()).not.toContain('#answer');
    });

    it('leaves out a box that paints nothing', () => {
      // `rgba(255, 0, 0, 0)` is as transparent as `rgba(0, 0, 0, 0)`, and a 300x300 phantom
      // handed to segmentation as a region the DOM cannot explain would be a region that
      // is not there.
      expect(selectors()).not.toContain('#glass');
    });

    it('leaves out the page itself', () => {
      // `<body tabindex="-1">` is matched by the candidate selector, and a page-sized area
      // of interest would swallow every fixation on the page.
      expect(selectors()).not.toContain('html > body:nth-child(2)');
      expect(elements.every((element) => element.bbox.height < 3_000)).toBe(true);
    });

    it('finds the text a table holds', () => {
      expect(sole(elements, 'cell', 'dom').text).toBe('Tote 48.00');
      expect(sole(elements, 'cell', 'a11y').role).toBe('cell');
      expect(sole(elements, 'cap', 'dom').text).toBe('Order');
    });
  });

  it(
    'carries the elements into a capture',
    async () => {
      const handle = await open(MOBILE, '/cart.html');
      try {
        const captured = await capture(handle, {
          variant: VARIANT_ID,
          device: MOBILE,
          task: TASK,
          runDir: 'runs/elements-test',
        });

        expect(captured.elements.length).toBeGreaterThan(CART.length);
        expect(captured.foldY).toBe(MOBILE.viewport.height);
        const checkout = sole(captured.elements, 'cart-checkout', 'a11y');
        expect(checkout.name).toBe('Checkout');
        expect(checkout.belowFold).toBe(false);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
