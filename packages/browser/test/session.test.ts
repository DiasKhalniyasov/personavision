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
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionBudget,
  act,
  capture,
  captureCacheKey,
  closeSession,
  createFixtureSource,
  createLiveSource,
  detectStep,
  extractElements,
  mapToAutomationFailure,
  openSession,
  readContentHash,
  readGeometry,
  readSessionState,
  resolvePrimaryAction,
  stableElementId,
  toAoiEntries,
  toScreenshotEntries,
  walkTask,
  withCache,
  writeScreenshot,
} from '../src/index.js';
import type {
  Capture,
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
      runDir: 'runs/unused-by-the-neutral-seams',
    });

    let handle: PageHandle;
    let captured: Capture;

    beforeAll(async () => {
      handle = await open(DESKTOP);
      captured = await capture(handle, contextFor(DESKTOP));
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await closeSession(handle);
    });

    it('carries the variant, the geometry and a content hash', () => {
      expect(captured.variant).toBe('v-desktop');
      expect(captured.viewport).toEqual(DESKTOP.viewport);
      expect(captured.pageHeight).toBe(1400);
      expect(captured.foldY).toBe(900);
      expect(captured.contentHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('carries nothing the neutral seams have yet to produce, and does not throw', () => {
      expect(captured.screenshot).toBeNull();
      expect(captured.step).toBeNull();
      expect(captured.elements).toEqual([]);
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

    it('extracts no elements yet', async () => {
      const geometry = await readGeometry(handle);
      await expect(extractElements(handle, geometry, 'cart')).resolves.toEqual([]);
    });

    // The screenshot seam is filled (#46) and asserted as files on disk in
    // `screenshot.test.ts`. What belongs here is the one case that writes nothing: a page
    // the task does not recognise, which is what `capture` above still passes it.
    it('writes no screenshot for a page with no step', async () => {
      await expect(
        writeScreenshot(handle, { runDir: 'runs/x', variant: 'v', step: null }),
      ).resolves.toBeNull();
    });

    it('detects no step yet', async () => {
      await expect(detectStep(handle, TASK)).resolves.toBeNull();
    });

    it('leaves the elements as they were when resolving the primary action', async () => {
      const elements: CaptureElement[] = [
        {
          id: 'e-000000000000',
          source: 'dom',
          role: 'button',
          name: 'Checkout',
          text: 'Checkout',
          bbox: { x: 16, y: 1200, width: 358, height: 48 },
          isPrimaryAction: false,
          belowFold: true,
          selector: '#cart-checkout',
        },
      ];
      await expect(resolvePrimaryAction(handle, elements, 'cart')).resolves.toEqual(elements);
    });

    it('cannot act yet', async () => {
      await expect(
        act(
          handle,
          { type: 'click', selector: '#cart-checkout' },
          {
            variant: 'v',
            device: DESKTOP,
            task: TASK,
            runDir: 'runs/x',
          },
        ),
      ).rejects.toThrow('act: not implemented');
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

  it('never recognises an error as one of ours yet, so the caller rethrows', () => {
    expect(mapToAutomationFailure(new Error('Timeout 30000ms exceeded'))).toBeNull();
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

  it('runs what the budget is given once, and counts nothing yet', async () => {
    const budget = new SessionBudget({ maxRetries: 2, wallClockMs: 1000 });
    let runs = 0;

    await expect(
      budget.attempt(async () => {
        runs += 1;
        return 'done';
      }),
    ).resolves.toBe('done');

    expect(runs).toBe(1);
    expect(budget.integrity()).toEqual({
      attempts: 0,
      retries: 0,
      elapsedMs: 0,
      exhausted: false,
    });
  });

  it('has no fixture source and no live source yet', () => {
    expect(() => createFixtureSource('runs/x')).toThrow('fixture source: not implemented');
    expect(() => createLiveSource()).toThrow('live source: not implemented');
  });

  it('cannot walk a task yet', async () => {
    await expect(
      walkTask({} as never, {
        variant: { id: 'v', url: 'http://127.0.0.1:1/cart.html' },
        device: DESKTOP,
        task: TASK,
        runDir: 'runs/x',
      }),
    ).rejects.toThrow('live source: not implemented');
  });
});

describe('stable element ids', () => {
  const parts = {
    source: 'dom' as const,
    role: 'button',
    name: 'Checkout',
    bbox: { x: 16, y: 1200, width: 358, height: 48 },
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

  it('is a different id for a different box, role, source or ordinal', () => {
    const baseline = stableElementId(parts);
    expect(stableElementId({ ...parts, bbox: { ...parts.bbox, y: 1201 } })).not.toBe(baseline);
    expect(stableElementId({ ...parts, role: 'link' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, source: 'a11y' })).not.toBe(baseline);
    expect(stableElementId({ ...parts, ordinal: 1 })).not.toBe(baseline);
  });
});
