/**
 * A Chromium session under an emulated device, the capture it produces, and the state of
 * every seam this step has yet to fill.
 *
 * Two things are held here. First, that emulation is real: the viewport, the device pixel
 * ratio and touch availability are read back **out of the page**, so what is asserted is
 * what Chromium did and not what this module remembers asking for. Second, that the
 * module's published surface is complete and neutral — every function exists, is typed and
 * either returns an empty or pass-through result or says plainly that it is not implemented.
 * That second part is what lets the step's other nine tickets run in parallel, so it is
 * tested rather than assumed.
 *
 * Everything goes through the package's entry point. No test here reaches into Playwright.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionBudget,
  capture,
  captureCacheKey,
  closeSession,
  createFixtureSource,
  extractElements,
  mapToAutomationFailure,
  openSession,
  readContentHash,
  readGeometry,
  readSessionState,
  stableElementId,
  toAoiEntries,
  toScreenshotEntries,
  withCache,
  writeScreenshot,
} from '../src/index.js';
import type { Capture, CaptureContext, Device, PageHandle, TaskDefinition } from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/**
 * Headed Chromium needs a display. A Linux CI runner has none, so that one assertion is
 * skipped there and runs everywhere a developer would actually want to watch a session.
 */
const HAS_DISPLAY = process.platform !== 'linux' || process.env.DISPLAY !== undefined;

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
  ],
};

const BROWSER_TIMEOUT_MS = 60_000;

describeWithChromium('a browser session', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const open = (device: Device, path = '/cart.html'): Promise<PageHandle> =>
    openSession({ id: `v-${device.name}`, url: `${site.url}${path}` }, device);

  it(
    'reports the mobile device it was opened with, as the page sees it',
    async () => {
      const handle = await open(MOBILE);
      try {
        const state = await readSessionState(handle);

        expect(state.viewport).toEqual(MOBILE.viewport);
        expect(state.deviceScaleFactor).toBe(MOBILE.deviceScaleFactor);
        expect(state.touch).toBe(true);
        expect(state.url).toBe(`${site.url}/cart.html`);
        expect(state.scrollY).toBe(0);
        expect(state.headless).toBe(true);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports the desktop device it was opened with, as the page sees it',
    async () => {
      const handle = await open(DESKTOP);
      try {
        const state = await readSessionState(handle);

        expect(state.viewport).toEqual(DESKTOP.viewport);
        expect(state.deviceScaleFactor).toBe(DESKTOP.deviceScaleFactor);
        expect(state.touch).toBe(false);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it.skipIf(!HAS_DISPLAY)(
    'opens headed when asked',
    async () => {
      const handle = await openSession({ id: 'headed', url: `${site.url}/cart.html` }, DESKTOP, {
        headless: false,
      });
      try {
        const state = await readSessionState(handle);
        expect(state.headless).toBe(false);
        // A headed window is a real one: it still measures.
        expect((await readGeometry(handle)).pageHeight).toBe(1400);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  describe('capture', () => {
    const contextFor = (device: Device): CaptureContext => ({
      variant: `v-${device.name}`,
      device,
      task: TASK,
      runDir,
    });

    /** The cart page is on a step, so this capture writes an image: not into the repository. */
    let runDir: string;
    let handle: PageHandle;
    let captured: Capture;

    beforeAll(async () => {
      runDir = await mkdtemp(join(tmpdir(), 'personavision-capture-'));
      handle = await open(DESKTOP);
      captured = await capture(handle, contextFor(DESKTOP));
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await closeSession(handle);
      await rm(runDir, { recursive: true, force: true });
    });

    it('carries the variant, the geometry and a content hash', () => {
      expect(captured.variant).toBe('v-desktop');
      expect(captured.viewport).toEqual(DESKTOP.viewport);
      expect(captured.pageHeight).toBe(1400);
      expect(captured.foldY).toBe(900);
      expect(captured.contentHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('carries the elements of the page, and does not throw', () => {
      // Extraction has landed, so a capture carries elements; `elements.test.ts` holds
      // what they are, against the fixture site's own record.
      expect(captured.elements.length).toBeGreaterThan(0);
      // One of them is the step's declared primary action; `steps.test.ts` holds which.
      expect(captured.elements.filter((element) => element.isPrimaryAction)).toHaveLength(1);
    });

    it('labels the step of the task the page is on, and writes the image under it', () => {
      expect(captured.step).toBe('cart');
      expect(captured.screenshot).toBe(runPaths('').screenshot('v-desktop', 'cart'));
    });

    it(
      'hashes the same page the same way twice',
      async () => {
        expect(await readContentHash(handle)).toBe(captured.contentHash);
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'hashes two different pages differently',
      async () => {
        const other = await open(DESKTOP, '/payment.html');
        try {
          expect(await readContentHash(other)).not.toBe(captured.contentHash);
        } finally {
          await closeSession(other);
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  });

  describe('the seams a later ticket fills', () => {
    let handle: PageHandle;

    beforeAll(async () => {
      handle = await open(DESKTOP);
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await closeSession(handle);
    });

    it('extracts the elements of the page it is on', async () => {
      const geometry = await readGeometry(handle);
      // What extraction finds is `elements.test.ts`'s subject, against `LANDMARKS.md`.
      // Here it is enough that the seam is filled: the cart has candidates.
      await expect(extractElements(handle, geometry, 'cart')).resolves.not.toEqual([]);
    });

    // The screenshot seam is filled (#46) and asserted as files on disk in
    // `screenshot.test.ts`. What belongs here is the one case that writes nothing: a page
    // the task does not recognise, which is what `capture` above still passes it.
    it('writes no screenshot for a page with no step', async () => {
      await expect(
        writeScreenshot(handle, { runDir: 'runs/x', variant: 'v', step: null }),
      ).resolves.toBeNull();
    });
  });
});

describe('the seams that need no browser', () => {
  // Filled by #46 and asserted in `run-projection.test.ts`: nothing to project is still
  // nothing, which is what the pipeline hands these before the first capture.
  it('projects no run entries from no captures', () => {
    expect(toScreenshotEntries([])).toEqual([]);
    expect(toAoiEntries([])).toEqual([]);
  });

  // Filled by #50 and asserted in `failures.test.ts`: a driver timeout is one of ours, and
  // an error this module cannot place still reaches the caller.
  it('reads an error of ours, and places nothing it cannot place', () => {
    expect(mapToAutomationFailure(new Error('Timeout 30000ms exceeded'))).toBe('timeout');
    expect(mapToAutomationFailure(new Error('the shop declined the card'))).toBeNull();
    expect(mapToAutomationFailure('not even an error')).toBeNull();
  });

  it('misses every cache lookup and runs the work', async () => {
    let runs = 0;
    const work = async (): Promise<number> => {
      runs += 1;
      return runs;
    };

    await expect(withCache('k', work)).resolves.toBe(1);
    await expect(withCache('k', work)).resolves.toBe(2);
    expect(runs).toBe(2);
  });

  it('builds a cache key from the variant URL, the step, the device and the content hash', () => {
    const parts = {
      variantUrl: 'http://127.0.0.1:1/cart.html',
      step: 'cart',
      device: DESKTOP,
      contentHash: 'abcdef0123456789',
    };

    expect(captureCacheKey(parts)).toBe(captureCacheKey(parts));
    expect(captureCacheKey({ ...parts, device: MOBILE })).not.toBe(captureCacheKey(parts));
    expect(captureCacheKey({ ...parts, step: 'payment' })).not.toBe(captureCacheKey(parts));
    expect(captureCacheKey({ ...parts, contentHash: '0000000000000000' })).not.toBe(
      captureCacheKey(parts),
    );
  });

  // Filled by #50 and asserted in `budget.test.ts`: an operation that works runs once, and
  // the counters a session artifact records are the attempt's, not nothing.
  it('runs what the budget is given once, and counts the attempt', async () => {
    const budget = new SessionBudget({ maxRetries: 2, wallClockMs: 1000 });
    let runs = 0;

    await expect(
      budget.attempt(async () => {
        runs += 1;
        return 'done';
      }),
    ).resolves.toBe('done');

    expect(runs).toBe(1);
    expect(budget.integrity()).toMatchObject({
      attempts: 1,
      retries: 0,
      selectorFailures: 0,
      exhausted: false,
    });
    expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 0, retries: 0 });
  });

  // Filled by #52 and asserted in `fixture-source.test.ts` and `determinism.test.ts`: a
  // fixture source is built without reaching a disk — its index is read when a session is
  // opened — so pointing one at a directory that is not there is not yet an error, and the
  // engine's offline mode can hold one before it has a run to replay into.
  it('builds a fixture source over a directory without reading it', () => {
    expect(() => createFixtureSource('runs/x')).not.toThrow();
  });
});

describe('stable element ids', () => {
  const parts = {
    variant: 'control',
    step: 'cart' as string | null,
    source: 'dom' as const,
    role: 'button',
    name: 'Checkout',
    path: '0/1/11',
  };

  it('is the same id for the same element of the same screen', () => {
    expect(stableElementId(parts)).toBe(stableElementId(parts));
    expect(stableElementId(parts)).toMatch(/^e-[0-9a-f]{12}$/);
  });

  it('ignores the casing and the spacing of an accessible name', () => {
    expect(stableElementId({ ...parts, name: '  CHECK OUT ' })).toBe(
      stableElementId({ ...parts, name: 'check   out' }),
    );
  });

  it('is a different id for a different position, role, source, screen or ordinal', () => {
    const baseline = stableElementId(parts);
    expect(stableElementId({ ...parts, path: '0/1/12' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, variant: 'treatment' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, step: 'review' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, role: 'link' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, source: 'a11y' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, ordinal: 1 })).not.toBe(baseline);
  });
});
