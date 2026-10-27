/**
 * The fixture capture source, asserted with nothing running.
 *
 * This suite imports no browser and starts no server — `playwright` and `serveFixtureSite`
 * appear nowhere in it — and one test holds that by hand: it breaks `child_process`'s
 * launchers and `net.Socket`'s `connect` for the length of a whole replay, so "no browser
 * and no socket" is a thing that was checked rather than a thing that was intended.
 *
 * What it asserts is the interface's four methods over the **committed** capture set — the
 * one `scripts/record-captures.ts` recorded from the fixture site — plus the failures, which
 * are asserted over sets written here, because a directory with a step missing is not
 * something the recorder can produce.
 *
 * The numbers quoted are `test/fixtures/site/LANDMARKS.md`'s, which is the record of what is
 * on those pages; `determinism.test.ts` is what keeps the committed set and that record from
 * drifting apart.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureSource } from '../src/index.js';
import type { Action, CaptureContext, CaptureSource, Device, PageHandle } from '../src/index.js';

/** The committed capture set, as `record:captures` wrote it. */
const COMMITTED = fileURLToPath(new URL('./fixtures/captures', import.meta.url));

/** The two devices the committed set was recorded under, as its index records them. */
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

/** The recorded walk, in order. */
const WALK = ['cart', 'payment', 'review', 'confirmation'] as const;

/**
 * The task a context carries. A replay reads none of it — the recorded sequence is what it
 * advances along — so this is the shape and not the fixture site's declaration.
 */
const TASK = {
  id: 'checkout',
  prompt: 'Buy the canvas tote bag',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
      primaryAction: { selector: '#cart-checkout' },
    },
  ],
};

/** The cart page, as `LANDMARKS.md` records it. */
const CART_PAGE_HEIGHT = 1400;
const CART_CHECKOUT = '#cart-checkout';
const CART_PROMO_APPLY = '#cart-promo-apply';
const CART_PROMO_APPLY_Y = 862;
const CART_FOOTER_NOTE = '#cart-footer-note';
const CART_FOOTER_NOTE_Y = 1200;
const CART_REMOVE_TOTE = '#cart-remove-tote';
const CART_BANNER = '#cart-banner';
const CART_BANNER_Y = 16;

const nodeRequire = createRequire(import.meta.url);

/**
 * Runs something with every way of launching a process or opening a socket broken.
 *
 * Playwright launches Chromium through `child_process` and talks to it over a socket, and
 * both are reached through the CommonJS module objects patched here, so a replay that tried
 * either fails inside this call instead of quietly succeeding on a developer's machine that
 * happens to have a browser installed.
 */
const withNothingRunning = async <T>(body: () => Promise<T>): Promise<T> => {
  const childProcess = nodeRequire('node:child_process') as Record<string, unknown>;
  const net = nodeRequire('node:net') as { Socket: { prototype: Record<string, unknown> } };
  const launchers = ['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execFileSync', 'execSync'];

  const saved = new Map(launchers.map((name) => [name, childProcess[name]]));
  const savedConnect = net.Socket.prototype.connect;
  const refuse = (what: string) => (): never => {
    throw new Error(`fixture mode reached for ${what}`);
  };

  for (const name of launchers) childProcess[name] = refuse(`child_process.${name}`);
  net.Socket.prototype.connect = refuse('a socket');

  try {
    return await body();
  } finally {
    for (const [name, original] of saved) childProcess[name] = original;
    net.Socket.prototype.connect = savedConnect;
  }
};

describe('createFixtureSource', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-fixture-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const context = (variant: string, device: Device): CaptureContext => ({
    variant,
    device,
    task: TASK,
    runDir,
  });

  /** A session over the committed set, closed however the test ends. */
  const session = async (
    variant: string,
    device: Device,
    body: (source: CaptureSource, page: PageHandle, ctx: CaptureContext) => Promise<void>,
  ): Promise<void> => {
    const source = createFixtureSource(COMMITTED);
    const ctx = context(variant, device);
    const page = await source.openSession(
      { id: variant, url: 'https://shop.invalid/cart.html' },
      device,
    );
    try {
      await body(source, page, ctx);
    } finally {
      await source.close(page);
    }
  };

  describe('replaying the committed set', () => {
    it('answers with the recorded capture of the step the session is on', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const capture = await source.capture(page, ctx);

        expect(capture.variant).toBe('A');
        expect(capture.step).toBe('cart');
        expect(capture.viewport).toEqual({ width: 390, height: 844 });
        expect(capture.pageHeight).toBe(CART_PAGE_HEIGHT);
        expect(capture.foldY).toBe(844);
        expect(capture.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(capture.elements.length).toBeGreaterThan(0);
      });
    });

    it('marks exactly one element as the step the task declares its primary action', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const capture = await source.capture(page, ctx);
        const marked = capture.elements.filter((element) => element.isPrimaryAction);

        expect(marked).toHaveLength(1);
        expect(marked[0]?.selector).toBe(CART_CHECKOUT);
      });
    });

    it('records the control that changes side with the viewport on the side it was recorded', async () => {
      const foldOf = async (variant: string, device: Device): Promise<boolean | undefined> => {
        let belowFold: boolean | undefined;
        await session(variant, device, async (source, page, ctx) => {
          const capture = await source.capture(page, ctx);
          belowFold = capture.elements.find(
            (element) => element.selector === CART_PROMO_APPLY,
          )?.belowFold;
        });
        return belowFold;
      };

      // y 862: below a 844-tall viewport's fold and above a 900-tall one's.
      expect(await foldOf('A', MOBILE)).toBe(true);
      expect(await foldOf('B', DESKTOP)).toBe(false);
    });

    it('puts the recorded screenshot in the run directory, at the path run.json records', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const capture = await source.capture(page, ctx);

        expect(capture.screenshot).toBe(runPaths('').screenshot('A', 'cart'));

        const written = await readFile(runPaths(runDir).screenshot('A', 'cart'));
        const recorded = await readFile(runPaths(COMMITTED).screenshot('A', 'cart'));
        expect(written.equals(recorded)).toBe(true);
      });
    });

    it('hands out a capture that shares nothing with the next one', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const first = await source.capture(page, ctx);
        const second = await source.capture(page, ctx);

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.elements[0]).not.toBe(second.elements[0]);

        first.elements[0] = { ...first.elements[0]!, id: 'rewritten' };
        first.pageHeight = 1;
        expect((await source.capture(page, ctx)).elements[0]?.id).toBe(second.elements[0]?.id);
        expect((await source.capture(page, ctx)).pageHeight).toBe(CART_PAGE_HEIGHT);
      });
    });

    it('replays with no browser launched and no socket opened', async () => {
      await withNothingRunning(async () => {
        const source = createFixtureSource(COMMITTED);
        const ctx = context('B', DESKTOP);
        const page = await source.openSession(
          { id: 'B', url: 'https://shop.invalid/cart.html' },
          DESKTOP,
        );
        const steps: (string | null)[] = [];

        try {
          for (const step of WALK) {
            const capture = await source.capture(page, ctx);
            steps.push(capture.step);
            if (step === WALK[WALK.length - 1]) break;
            const advanced = await source.act(
              page,
              {
                type: 'click',
                selector: capture.elements.find((element) => element.isPrimaryAction)!.selector,
              },
              ctx,
            );
            expect(advanced.ok).toBe(true);
          }
        } finally {
          await source.close(page);
        }

        expect(steps).toEqual([...WALK]);
      });
    });
  });

  describe('act', () => {
    /** Clicks the primary action of whatever step the session is on. */
    const clickPrimary = async (
      source: CaptureSource,
      page: PageHandle,
      ctx: CaptureContext,
    ): Promise<ReturnType<CaptureSource['act']>> => {
      const capture = await source.capture(page, ctx);
      const primary = capture.elements.find((element) => element.isPrimaryAction);
      expect(primary).toBeDefined();
      return source.act(page, { type: 'click', elementId: primary?.id }, ctx);
    };

    it('advances one step along the recorded sequence and reports ok', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const advanced = await clickPrimary(source, page, ctx);

        expect(advanced.ok).toBe(true);
        expect(advanced.failure).toBeUndefined();
        expect(advanced.step).toBe('payment');
        expect((await source.capture(page, ctx)).step).toBe('payment');
      });
    });

    it('reports where the page is in the URL space of the variant it was opened on', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const advanced = await clickPrimary(source, page, ctx);

        expect(advanced.url).toBe('https://shop.invalid/payment.html');
        expect(advanced.scrollY).toBe(0);
      });
    });

    it('walks the whole recorded sequence', async () => {
      await session('B', DESKTOP, async (source, page, ctx) => {
        const reached = ['cart'];
        for (let index = 1; index < WALK.length; index += 1) {
          reached.push((await clickPrimary(source, page, ctx)).step ?? 'none');
        }

        expect(reached).toEqual([...WALK]);
      });
    });

    it('reports a typed failure at the end of the recording rather than inventing a page', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        for (let index = 1; index < WALK.length; index += 1) {
          await clickPrimary(source, page, ctx);
        }
        expect((await source.capture(page, ctx)).step).toBe('confirmation');

        const over = await clickPrimary(source, page, ctx);

        expect(over.ok).toBe(false);
        expect(over.failure).toBe('navigation_error');
        // The session is left where it was, not on a page nobody recorded.
        expect(over.step).toBe('confirmation');
        expect((await source.capture(page, ctx)).step).toBe('confirmation');
      });
    });

    it('reports ok on the same step for a control the recording does not advance on', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const remove = await source.act(page, { type: 'click', selector: CART_REMOVE_TOTE }, ctx);

        expect(remove.ok).toBe(true);
        expect(remove.step).toBe('cart');
      });
    });

    it('reports selector_not_found for a target no recorded element carries', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const bySelector = await source.act(page, { type: 'click', selector: '#not-here' }, ctx);
        const byId = await source.act(page, { type: 'click', elementId: 'e-000000000000' }, ctx);

        expect(bySelector).toMatchObject({
          ok: false,
          failure: 'selector_not_found',
          step: 'cart',
        });
        expect(byId).toMatchObject({ ok: false, failure: 'selector_not_found', step: 'cart' });
      });
    });

    it('steps backwards along the recording, and off the first step is a navigation error', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        await clickPrimary(source, page, ctx);

        const back = await source.act(page, { type: 'back' }, ctx);
        expect(back).toMatchObject({ ok: true, step: 'cart' });

        const off = await source.act(page, { type: 'back' }, ctx);
        expect(off).toMatchObject({ ok: false, failure: 'navigation_error', step: 'cart' });
        expect((await source.capture(page, ctx)).step).toBe('cart');
      });
    });

    it('scrolls by a delta, clamped to the recorded page', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        expect((await source.act(page, { type: 'scroll', deltaY: 300 }, ctx)).scrollY).toBe(300);
        expect((await source.act(page, { type: 'scroll', deltaY: -1000 }, ctx)).scrollY).toBe(0);
        // The page is 1400 tall at a 844-tall viewport: 556 is as far as it goes.
        expect((await source.act(page, { type: 'scroll', deltaY: 9000 }, ctx)).scrollY).toBe(
          CART_PAGE_HEIGHT - 844,
        );
        expect((await source.act(page, { type: 'scroll' }, ctx)).scrollY).toBe(
          CART_PAGE_HEIGHT - 844,
        );
      });
    });

    it('scrolls a targeted element the minimum that puts it in view', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        const to = (selector: string): Action => ({ type: 'scroll', selector });

        // 862 + 28 - 844: the control that sits just below the mobile fold comes into view
        // at the bottom of the viewport, not at the top of it.
        expect((await source.act(page, to(CART_PROMO_APPLY), ctx)).scrollY).toBe(
          CART_PROMO_APPLY_Y + 28 - 844,
        );
        expect((await source.act(page, to(CART_FOOTER_NOTE), ctx)).scrollY).toBe(
          CART_FOOTER_NOTE_Y + 40 - 844,
        );
        // The checkout is already on screen from there, so it moves the page not at all.
        expect((await source.act(page, to(CART_CHECKOUT), ctx)).scrollY).toBe(
          CART_FOOTER_NOTE_Y + 40 - 844,
        );
        // The banner is above it, so the page comes back to the banner's own top edge.
        expect((await source.act(page, to(CART_BANNER), ctx)).scrollY).toBe(CART_BANNER_Y);
      });
    });

    it('leaves the session where it is when something is typed', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        await source.act(page, { type: 'scroll', deltaY: 120 }, ctx);
        const typed = await source.act(
          page,
          { type: 'type', selector: CART_PROMO_APPLY, value: 'SAVE10' },
          ctx,
        );

        expect(typed).toMatchObject({ ok: true, step: 'cart', scrollY: 120 });
      });
    });

    it('starts a step it arrives on at the top of the page', async () => {
      await session('A', MOBILE, async (source, page, ctx) => {
        await source.act(page, { type: 'scroll', deltaY: 400 }, ctx);
        expect((await clickPrimary(source, page, ctx)).scrollY).toBe(0);
      });
    });
  });

  describe('what it refuses', () => {
    it('names the variants it holds when asked for one it does not', async () => {
      const source = createFixtureSource(COMMITTED);

      await expect(
        source.openSession({ id: 'C', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(/no variant "C".*"A", "B"/s);
    });

    it('names the device a variant was recorded under when another is asked for', async () => {
      const source = createFixtureSource(COMMITTED);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, DESKTOP),
      ).rejects.toThrow(/recorded at 390x844.*asks for 1440x900/s);
    });

    it('accepts a device whose name and touch differ, because a recording does not depend on them', async () => {
      const source = createFixtureSource(COMMITTED);
      const relabelled: Device = { ...MOBILE, name: 'iPhone 15', touch: false };

      const page = await source.openSession({ id: 'A', url: 'https://shop.invalid/' }, relabelled);
      try {
        expect(page.device.name).toBe('iPhone 15');
      } finally {
        await source.close(page);
      }
    });

    it('names the directory it replays when handed a page it did not open', async () => {
      const source = createFixtureSource(COMMITTED);
      const other = createFixtureSource(COMMITTED);
      const page = await other.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE);

      try {
        await expect(source.capture(page, context('A', MOBILE))).rejects.toThrow(
          /was not opened by the fixture capture source/,
        );
        await expect(source.close(page)).rejects.toThrow(/was not opened by/);
      } finally {
        await other.close(page);
      }
    });

    it('says a closed session has no page, and closing twice is not an error', async () => {
      const source = createFixtureSource(COMMITTED);
      const page = await source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE);
      await source.close(page);
      await source.close(page);

      await expect(source.capture(page, context('A', MOBILE))).rejects.toThrow(/is closed/);
    });

    it('refuses a capture context that names another variant than the session', async () => {
      await session('A', MOBILE, async (source, page) => {
        await expect(source.capture(page, context('B', MOBILE))).rejects.toThrow(
          /replays variant "A", and the capture context says "B"/,
        );
      });
    });

    it('has no browser to reach for, and says so where it was reached for', async () => {
      await session('A', MOBILE, async (_source, page) => {
        expect(() => page.page.url()).toThrow(/holds no browser, so there is no page.url/);
        expect(() => page.browser.version()).toThrow(/no browser.version/);
        expect(() => page.context.pages()).toThrow(/no context.pages/);
        expect(page.headless).toBe(true);
      });
    });
  });

  describe('a capture set that is not one', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'personavision-set-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const write = async (path: string, value: unknown): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    };

    const index = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      formatVersion: 1,
      variants: [{ id: 'A', device: MOBILE, steps: [{ step: 'cart', path: '/cart.html' }] }],
      ...overrides,
    });

    const capture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      variant: 'A',
      step: 'cart',
      screenshot: null,
      viewport: { width: 390, height: 844 },
      pageHeight: 1400,
      foldY: 844,
      elements: [],
      contentHash: '0123456789abcdef',
      ...overrides,
    });

    const open = async (): Promise<{ source: CaptureSource; page: PageHandle }> => {
      const source = createFixtureSource(dir);
      return {
        source,
        page: await source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      };
    };

    it('names the index it looked for when the directory holds none', async () => {
      const source = createFixtureSource(dir);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(new RegExp(`looked for ${join(dir, 'capture-set.json')}`));
    });

    it('names the capture it looked for when a recorded step has no file', async () => {
      await write(join(dir, 'capture-set.json'), index());
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        new RegExp(`looked for ${join(dir, 'captures', 'A', 'cart.json')}`),
      );
    });

    it('names the screenshot it looked for when a recorded capture has no image', async () => {
      await write(join(dir, 'capture-set.json'), index());
      await write(
        join(dir, 'captures', 'A', 'cart.json'),
        capture({ screenshot: runPaths('').screenshot('A', 'cart') }),
      );
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        /looked for the screenshot of variant "A" step "cart"/,
      );
    });

    it('refuses a capture set written for another format version', async () => {
      await write(join(dir, 'capture-set.json'), index({ formatVersion: 2 }));
      const source = createFixtureSource(dir);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(/format-2 capture set, and this module reads format 1/);
    });

    it('refuses a field it does not declare, at its own path', async () => {
      await write(join(dir, 'capture-set.json'), index());
      await write(join(dir, 'captures', 'A', 'cart.json'), capture({ scrollY: 0 }));
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        /the capture carries "scrollY", which this module does not declare/,
      );
    });

    it('names the field, what it should be and what it is', async () => {
      await write(join(dir, 'capture-set.json'), index());
      await write(join(dir, 'captures', 'A', 'cart.json'), capture({ foldY: 'most of it' }));
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        /foldY should be a finite number, and is "most of it"/,
      );
    });

    it('refuses a capture that is not JSON, naming the file', async () => {
      await write(join(dir, 'capture-set.json'), index());
      await write(join(dir, 'captures', 'A', 'cart.json'), 'not json at all');
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        new RegExp(`${join(dir, 'captures', 'A', 'cart.json').replace(/\\/g, '\\\\')} is not JSON`),
      );
    });

    it('refuses a capture recorded under another variant or step than it is filed as', async () => {
      await write(join(dir, 'capture-set.json'), index());
      await write(join(dir, 'captures', 'A', 'cart.json'), capture({ step: 'payment' }));
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        /records variant "A" step "payment", and a capture set addresses it as variant "A" step "cart"/,
      );
    });

    it('refuses a capture that marks two primary actions', async () => {
      const element = (id: string): Record<string, unknown> => ({
        id,
        source: 'dom',
        role: 'link',
        name: 'Checkout',
        text: 'Checkout',
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        isPrimaryAction: true,
        belowFold: false,
        selector: CART_CHECKOUT,
      });
      await write(join(dir, 'capture-set.json'), index());
      await write(
        join(dir, 'captures', 'A', 'cart.json'),
        capture({ elements: [element('e-1'), element('e-2')] }),
      );
      const { source, page } = await open();

      await expect(source.capture(page, { ...context('A', MOBILE), runDir })).rejects.toThrow(
        /2 elements are marked as the step's primary action \(e-1, e-2\)/,
      );
    });

    it('refuses an index that records a variant with no steps', async () => {
      await write(
        join(dir, 'capture-set.json'),
        index({ variants: [{ id: 'A', device: MOBILE, steps: [] }] }),
      );
      const source = createFixtureSource(dir);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(/variants\[0\].steps should be at least one recorded step/);
    });

    it('refuses an index that records one variant twice', async () => {
      const variant = { id: 'A', device: MOBILE, steps: [{ step: 'cart', path: '/cart.html' }] };
      await write(join(dir, 'capture-set.json'), index({ variants: [variant, variant] }));
      const source = createFixtureSource(dir);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(/variants\[1\] records "A" a second time/);
    });

    it('refuses a recorded step whose path is not one', async () => {
      await write(
        join(dir, 'capture-set.json'),
        index({
          variants: [{ id: 'A', device: MOBILE, steps: [{ step: 'cart', path: 'cart.html' }] }],
        }),
      );
      const source = createFixtureSource(dir);

      await expect(
        source.openSession({ id: 'A', url: 'https://shop.invalid/' }, MOBILE),
      ).rejects.toThrow(/path should be a path beginning with "\/"/);
    });
  });
});
