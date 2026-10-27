/**
 * Which step of the task a page is on, and which control advances it.
 *
 * Both are the task's own declarations, resolved against a live page: a step is a URL
 * pattern **and** a required element, and its primary action is the selector it names. So
 * most of this suite is about what must not happen — a page labelled from its URL alone, a
 * label read off the page's words, a primary action that quietly resolves to nothing. It
 * drives Chromium against the fixture site rather than a stub, because a selector either
 * resolves on a real page or it does not.
 *
 * Ids and boxes are quoted from `fixtures/site/LANDMARKS.md`; `fixture-site.test.ts` holds
 * that record and the pages together, so nothing here re-reads the markup to discover what
 * is on a page.
 *
 * Everything goes through the package's entry point, except the one helper that measures a
 * page — which is what the element extractor produces for real once its own ticket lands.
 */

/// <reference lib="dom" />
// `measuredCandidates` runs inside the page, not in Node, so this file needs the DOM types.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AutomationFailure,
  capture,
  closeSession,
  detectStep,
  openSession,
  resolvePrimaryAction,
  taskStep,
} from '../src/index.js';
import type {
  Box,
  CaptureContext,
  CaptureElement,
  Device,
  PageHandle,
  TaskDefinition,
  TaskStep,
} from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

const BROWSER_TIMEOUT_MS = 60_000;

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
 * The task the fixture pages are written for, as `LANDMARKS.md` declares it — the payment
 * pattern matching `no-control.html` and no pattern anchored at its end included, because
 * those two are the cases this suite exists for.
 */
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

/** A step of the task, through the package's own lookup rather than a second copy of it. */
const stepNamed = (id: string): TaskStep => {
  const step = taskStep(TASK, id);
  if (step === null) throw new Error(`the task declares no ${id} step`);
  return step;
};

/** A landmark of the fixture site: its id, and the page-space box `LANDMARKS.md` records. */
interface Landmark {
  readonly id: string;
  readonly bbox: Box;
}

/** One step page: the step it is on, its declared control, and another control on it. */
interface StepPage {
  readonly path: string;
  readonly step: string;
  readonly primary: Landmark;
  /** A control resolution must leave alone, so that marking the right one means something. */
  readonly decoy: Landmark;
}

/** The cart page, named on its own because the cases about matching itself are run on it. */
const CART: StepPage = {
  path: '/cart.html',
  step: 'cart',
  primary: { id: 'cart-checkout', bbox: { x: 16, y: 784, width: 358, height: 44 } },
  decoy: { id: 'cart-promo-apply', bbox: { x: 16, y: 862, width: 358, height: 28 } },
};

const STEP_PAGES: readonly StepPage[] = [
  CART,
  {
    path: '/payment.html',
    step: 'payment',
    primary: { id: 'payment-submit', bbox: { x: 28, y: 468, width: 200, height: 44 } },
    decoy: { id: 'payment-card-number', bbox: { x: 28, y: 324, width: 334, height: 32 } },
  },
  {
    path: '/review.html',
    step: 'review',
    primary: { id: 'review-place-order', bbox: { x: 16, y: 600, width: 358, height: 44 } },
    decoy: { id: 'review-back', bbox: { x: 16, y: 520, width: 358, height: 24 } },
  },
  {
    path: '/confirmation.html',
    step: 'confirmation',
    primary: {
      id: 'confirmation-continue-shopping',
      bbox: { x: 16, y: 480, width: 358, height: 44 },
    },
    decoy: { id: 'confirmation-order-number', bbox: { x: 28, y: 300, width: 334, height: 24 } },
  },
];

/** A candidate element: what an extractor hands resolution, with the box under test. */
const candidate = (
  id: string,
  bbox: Box,
  overrides: Partial<CaptureElement> = {},
): CaptureElement => ({
  id,
  source: 'dom',
  role: null,
  name: null,
  text: null,
  bbox,
  isPrimaryAction: false,
  belowFold: false,
  selector: `#${id}`,
  ...overrides,
});

/** The decoy and the declared control of a page, in that order, with boxes from the record. */
const candidatesFor = (page: StepPage): CaptureElement[] => [
  candidate(page.decoy.id, page.decoy.bbox),
  candidate(page.primary.id, page.primary.bbox),
];

const markedIds = (elements: readonly CaptureElement[]): string[] =>
  elements.filter((element) => element.isPrimaryAction).map((element) => element.id);

/**
 * Candidates the browser measured, one per selector, boxed in page space.
 *
 * Element extraction is another ticket's seam and produces nothing yet, so the
 * browser-produced candidate list is built here instead: the matching rule has to hold
 * against boxes a page reported as well as against boxes written by hand, and that is the
 * whole point of matching by box. When extraction lands this becomes a call to it.
 */
const measuredCandidates = async (
  handle: PageHandle,
  selectors: readonly string[],
): Promise<CaptureElement[]> =>
  handle.page.evaluate<CaptureElement[], string[]>(
    (chosen) => {
      return chosen.map((selector, index) => {
        const node = document.querySelector(selector);
        if (node === null) throw new Error(`the fixture page has no ${selector}`);
        const rect = node.getBoundingClientRect();
        return {
          id: `measured-${index}`,
          source: 'dom' as const,
          role: null,
          name: null,
          text: null,
          bbox: {
            x: rect.x + window.scrollX,
            y: rect.y + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
          isPrimaryAction: false,
          belowFold: false,
          selector,
        };
      });
    },
    [...selectors],
  );

/** What the page says, so that a test asserting a label is not read from words can prove it. */
const bodyText = async (handle: PageHandle): Promise<string> =>
  handle.page.evaluate(() => document.body.textContent ?? '');

/** The error a rejected resolution threw, rather than the assertion that it threw one. */
const failureFrom = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

describeWithChromium('step detection', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const open = (path: string, device: Device = DESKTOP): Promise<PageHandle> =>
    openSession({ id: `v-${device.name}`, url: `${site.url}${path}` }, device);

  for (const page of STEP_PAGES) {
    it(
      `labels ${page.path} with the ${page.step} step`,
      async () => {
        const handle = await open(page.path);
        try {
          await expect(detectStep(handle, TASK)).resolves.toBe(page.step);
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  }

  it(
    'labels the review step when the payment form has put a query string on the URL',
    async () => {
      const handle = await open('/review.html?card=4111111111111111&expiry=03');
      try {
        await expect(detectStep(handle, TASK)).resolves.toBe('review');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'labels nothing when the URL matches a step whose required element is absent',
    async () => {
      const handle = await open('/no-control.html');
      try {
        await expect(detectStep(handle, TASK)).resolves.toBeNull();
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'labels nothing on a page the task does not declare',
    async () => {
      // This page's frames never load, so it is opened on `domcontentloaded`.
      const handle = await openSession(
        { id: 'v-outside', url: `${site.url}/broken-frame.html` },
        DESKTOP,
        { waitUntil: 'domcontentloaded', navigationTimeoutMs: 15_000 },
      );
      try {
        await expect(detectStep(handle, TASK)).resolves.toBeNull();
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'labels the review page by its URL and element although its words name another step',
    async () => {
      const handle = await open('/review.html');
      try {
        // `review-back` reads "Back to payment": the page's words name the step before it.
        expect((await bodyText(handle)).toLowerCase()).toContain('payment');
        await expect(detectStep(handle, TASK)).resolves.toBe('review');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'labels nothing on a page whose words name the step it fails to satisfy',
    async () => {
      const handle = await open('/no-control.html');
      try {
        // Its heading reads "Payment unavailable", and its URL matches the payment pattern.
        expect((await bodyText(handle)).toLowerCase()).toContain('payment');
        await expect(detectStep(handle, TASK)).resolves.toBeNull();
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'takes the first step whose pattern matches and whose required element is present',
    async () => {
      const decoyFirst: TaskDefinition = {
        ...TASK,
        steps: [
          {
            id: 'decoy',
            label: 'Decoy',
            match: { urlPattern: '/cart\\.html', requiredSelector: '#payment-form' },
            primaryAction: { selector: '#cart-checkout' },
          },
          ...TASK.steps,
        ],
      };

      const handle = await open('/cart.html');
      try {
        await expect(detectStep(handle, decoyFirst)).resolves.toBe('cart');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises a plain error, naming the step, for a URL pattern that is not a pattern',
    async () => {
      const handle = await open('/cart.html');
      try {
        const broken: TaskDefinition = {
          ...TASK,
          steps: [
            {
              ...stepNamed('cart'),
              match: { ...stepNamed('cart').match, urlPattern: '/cart(.html' },
            },
          ],
        };

        const failure = await failureFrom(detectStep(handle, broken));

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(AutomationFailure);
        expect((failure as Error).message).toContain('cart');
        expect((failure as Error).message).toContain('/cart(.html');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises a plain error, naming the step, for a required element it cannot parse',
    async () => {
      const handle = await open('/cart.html');
      try {
        const broken: TaskDefinition = {
          ...TASK,
          steps: [
            {
              ...stepNamed('cart'),
              // Playwright's own locator syntax, which no page can resolve as CSS.
              match: { ...stepNamed('cart').match, requiredSelector: 'text=Your cart' },
            },
          ],
        };

        const failure = await failureFrom(detectStep(handle, broken));

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(AutomationFailure);
        expect((failure as Error).message).toContain('text=Your cart');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'labels nothing when the task declares no steps at all',
    async () => {
      const handle = await open('/cart.html');
      try {
        await expect(detectStep(handle, { ...TASK, steps: [] })).resolves.toBeNull();
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});

describeWithChromium('primary-action resolution', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const open = (path: string, device: Device = DESKTOP): Promise<PageHandle> =>
    openSession({ id: `v-${device.name}`, url: `${site.url}${path}` }, device);

  for (const page of STEP_PAGES) {
    it(
      `marks the control the ${page.step} step declares, and no other`,
      async () => {
        const handle = await open(page.path);
        try {
          const resolved = await resolvePrimaryAction(
            handle,
            candidatesFor(page),
            stepNamed(page.step),
          );

          expect(markedIds(resolved)).toEqual([page.primary.id]);
          expect(resolved).toHaveLength(2);
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      `marks it among candidates the browser measured on ${page.path}`,
      async () => {
        const handle = await open(page.path);
        try {
          const measured = await measuredCandidates(handle, [
            `#${page.decoy.id}`,
            `#${page.primary.id}`,
          ]);
          const resolved = await resolvePrimaryAction(handle, measured, stepNamed(page.step));
          const marked = resolved.filter((element) => element.isPrimaryAction);

          expect(marked).toHaveLength(1);
          expect(marked[0]?.bbox).toEqual(page.primary.bbox);
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  }

  it(
    'marks by box, not by how the extractor spelled its selector',
    async () => {
      const handle = await open(CART.path);
      try {
        const candidates = [
          candidate('promo', CART.decoy.bbox, { selector: 'body > button:nth-of-type(3)' }),
          candidate('checkout', CART.primary.bbox, { selector: 'a.control-primary >> nth=0' }),
        ];

        const resolved = await resolvePrimaryAction(handle, candidates, stepNamed('cart'));

        expect(markedIds(resolved)).toEqual(['checkout']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'tolerates the sub-pixel rounding an extractor may have applied to a box',
    async () => {
      const handle = await open(CART.path);
      try {
        const rounded = {
          x: CART.primary.bbox.x + 0.4,
          y: CART.primary.bbox.y - 0.4,
          width: CART.primary.bbox.width - 0.3,
          height: CART.primary.bbox.height + 0.3,
        };

        const resolved = await resolvePrimaryAction(
          handle,
          [candidate(CART.decoy.id, CART.decoy.bbox), candidate('rounded', rounded)],
          stepNamed('cart'),
        );

        expect(markedIds(resolved)).toEqual(['rounded']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'matches in page space, so a scrolled page resolves the same control',
    async () => {
      const handle = await open(CART.path, MOBILE);
      try {
        await handle.page.evaluate(() => {
          window.scrollTo(0, 400);
        });

        const resolved = await resolvePrimaryAction(handle, candidatesFor(CART), stepNamed('cart'));

        expect(markedIds(resolved)).toEqual([CART.primary.id]);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'marks one element when two candidates share the declared control, in list order',
    async () => {
      const handle = await open(CART.path);
      try {
        const resolved = await resolvePrimaryAction(
          handle,
          [
            candidate('checkout-dom', CART.primary.bbox),
            candidate('checkout-a11y', CART.primary.bbox, { source: 'a11y' }),
          ],
          stepNamed('cart'),
        );

        expect(markedIds(resolved)).toEqual(['checkout-dom']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'marks exactly one element, clearing a mark the candidates arrived with',
    async () => {
      const handle = await open(CART.path);
      try {
        const resolved = await resolvePrimaryAction(
          handle,
          [
            candidate(CART.decoy.id, CART.decoy.bbox, { isPrimaryAction: true }),
            candidate(CART.primary.id, CART.primary.bbox),
          ],
          stepNamed('cart'),
        );

        expect(markedIds(resolved)).toEqual([CART.primary.id]);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises selector_not_found when the declared control is not on the page, and marks nothing',
    async () => {
      const handle = await open(CART.path);
      try {
        // Seeded with a mark, so that "marks nothing" is a claim about this call rather than
        // about a list that happened to arrive unmarked.
        const candidates = [
          candidate(CART.decoy.id, CART.decoy.bbox, { isPrimaryAction: true }),
          candidate(CART.primary.id, CART.primary.bbox),
        ];
        const asGiven = structuredClone(candidates);
        const unresolvable: TaskStep = {
          ...stepNamed('cart'),
          primaryAction: { selector: '#cart-checkout-that-is-not-there' },
        };

        const failure = await failureFrom(resolvePrimaryAction(handle, candidates, unresolvable));

        expect(failure).toBeInstanceOf(AutomationFailure);
        expect((failure as AutomationFailure).reason).toBe('selector_not_found');
        expect(candidates).toEqual(asGiven);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises selector_not_found when the declared control is on the page but not rendered',
    async () => {
      const handle = await open(CART.path);
      try {
        // A control taken out of the rendering reports a box of zeros, which is no box at
        // all: it cannot be looked at, so it is not a primary action that resolved.
        await handle.page.evaluate(() => {
          document
            .querySelector<HTMLElement>('#cart-checkout')
            ?.style.setProperty('display', 'none');
        });

        const failure = await failureFrom(
          resolvePrimaryAction(handle, candidatesFor(CART), stepNamed('cart')),
        );

        expect(failure).toBeInstanceOf(AutomationFailure);
        expect((failure as AutomationFailure).reason).toBe('selector_not_found');
        expect((failure as AutomationFailure).message).toContain('not-rendered');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises selector_not_found when the control resolves but is none of the candidates',
    async () => {
      const handle = await open(CART.path);
      try {
        const candidates = [candidate(CART.decoy.id, CART.decoy.bbox, { isPrimaryAction: true })];
        const asGiven = structuredClone(candidates);

        const failure = await failureFrom(
          resolvePrimaryAction(handle, candidates, stepNamed('cart')),
        );

        expect(failure).toBeInstanceOf(AutomationFailure);
        expect((failure as AutomationFailure).reason).toBe('selector_not_found');
        expect(candidates).toEqual(asGiven);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'marks the box nearest the declared control, not the first within the tolerance',
    async () => {
      const handle = await open(CART.path);
      try {
        const near = { ...CART.primary.bbox, y: CART.primary.bbox.y + 0.6 };

        const resolved = await resolvePrimaryAction(
          handle,
          [candidate('near', near), candidate('exact', CART.primary.bbox)],
          stepNamed('cart'),
        );

        expect(markedIds(resolved)).toEqual(['exact']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises a plain error, naming the step, for a selector it cannot parse',
    async () => {
      const handle = await open(CART.path);
      try {
        const gibberish: TaskStep = {
          ...stepNamed('cart'),
          // Playwright's own locator syntax, which no page can resolve as CSS.
          primaryAction: { selector: 'text=Checkout' },
        };

        const failure = await failureFrom(
          resolvePrimaryAction(handle, candidatesFor(CART), gibberish),
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(AutomationFailure);
        expect((failure as Error).message).toContain('cart');
        expect((failure as Error).message).toContain('text=Checkout');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'marks nothing when the page is on no step, because nothing is declared',
    async () => {
      const handle = await open('/no-control.html');
      try {
        const candidates = [
          candidate('no-control-back', { x: 16, y: 288, width: 358, height: 24 }),
        ];

        await expect(resolvePrimaryAction(handle, candidates, null)).resolves.toEqual(candidates);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'resolves to no elements, and raises nothing, when there are no candidates at all',
    async () => {
      // A capture whose extractor produced nothing has no element to mark and none to leave
      // silently false — and it is not a screen attention can be attributed on either way.
      const handle = await open(CART.path);
      try {
        await expect(resolvePrimaryAction(handle, [], stepNamed('cart'))).resolves.toEqual([]);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});

/**
 * What the two seams do to a capture, through `capture()` itself.
 *
 * The composition is written once in `src/capture.ts` and is where these two meet: the step
 * it detects is the label the `Capture` carries and part of the cache key, and a step whose
 * declared control cannot be resolved now fails the whole capture, which is how a session is
 * excluded rather than scored as a zero.
 */
describeWithChromium('a capture of a page on a step', () => {
  let site: FixtureSite;
  /** A capture of a page on a step writes its screenshot: into a temporary run directory. */
  let runDir: string;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  // One run directory per test, because a capture is cached inside it (`cache.ts`) and the
  // assertions below ask different things of the same screen of the same variant.
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-steps-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const open = (path: string): Promise<PageHandle> =>
    openSession({ id: 'v-desktop', url: `${site.url}${path}` }, DESKTOP);

  const contextFor = (task: TaskDefinition): CaptureContext => ({
    variant: 'v-desktop',
    device: DESKTOP,
    task,
    runDir,
  });

  it(
    'is labelled with the step, not with a guess at the URL',
    async () => {
      const handle = await open(CART.path);
      try {
        expect((await capture(handle, contextFor(TASK))).step).toBe('cart');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'carries no label at all on a page the task does not declare',
    async () => {
      const handle = await open('/no-control.html');
      try {
        expect((await capture(handle, contextFor(TASK))).step).toBeNull();
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'fails as ours when the step declares a control the page does not have',
    async () => {
      const handle = await open(CART.path);
      try {
        const swapped: TaskDefinition = {
          ...TASK,
          steps: [
            { ...stepNamed('cart'), primaryAction: { selector: '#cart-checkout-out-of-stock' } },
          ],
        };

        const failure = await failureFrom(capture(handle, contextFor(swapped)));

        expect(failure).toBeInstanceOf(AutomationFailure);
        expect((failure as AutomationFailure).reason).toBe('selector_not_found');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});

/** The one part of this that needs no browser: reading a detected id back as a declaration. */
describe('the step a detected id names', () => {
  it('is the step the task declares under that id', () => {
    expect(taskStep(TASK, 'review')).toBe(stepNamed('review'));
  });

  it('is no step when nothing was detected', () => {
    expect(taskStep(TASK, null)).toBeNull();
  });

  it('says so for an id the task does not declare, rather than resolving to no step', () => {
    // Resolving to `null` here would hand `resolvePrimaryAction` a page with no declaration
    // and mark nothing on it — the silent zero this module exists to avoid.
    expect(() => taskStep(TASK, 'checkout-v2')).toThrow('checkout-v2');
  });
});
