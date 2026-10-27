/**
 * The capture cache, asserted as files in a run directory.
 *
 * Three things are held here. First, that a hit is indistinguishable from a miss: a second
 * session over the same variant, step and device gets the first session's geometry, element
 * ids and screenshot path back, and no second picture is taken. Second, that a hit never
 * describes a picture that is no longer there — an entry belongs to a screen, and whatever
 * overwrites that screen's image overwrites its entry. Third, that the cache can only ever
 * cost a run a screenshot: a truncated entry, an entry belonging to another key and a run
 * directory that cannot be written to are each a miss rather than a failed session.
 *
 * A cache hit is otherwise invisible: `writeScreenshot` writes one file per screen, so two
 * writes to one path leave the same single file a cached capture does. The tests below
 * therefore **delete the screenshot between the two captures** — a hit writes nothing, so
 * the file it names stays gone, and a fresh capture puts it back. That is the one
 * observation that separates the two without timing anything.
 *
 * The run directory is a fresh temporary one inside a temporary parent, so "under the run
 * directory, and nothing outside it" is a statement about two directory listings.
 */

/// <reference lib="dom" />
// The mutation that makes the page a different screen runs inside the page, not in Node
// (see `geometry.test.ts`).

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runPaths } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, closeSession, openSession, withCache } from '../src/index.js';
import type { Capture, CaptureContext, Device, PageHandle, TaskDefinition } from '../src/index.js';
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

const BROWSER_TIMEOUT_MS = 60_000;

/**
 * A PNG's pixel dimensions, read out of the IHDR chunk its first bytes are: the 8-byte
 * signature, a length, the type, then the width and the height as big-endian 32-bit
 * integers. `screenshot.test.ts` holds the written image to its format; here these two
 * numbers are what tells one device's render of a screen from the other's. An image that is
 * not a readable PNG fails the read, which is the right answer either way.
 */
const pngSize = (bytes: Buffer): { width: number; height: number } => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

/** Every file under a directory, by its relative path: a listing, not a name. */
const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(relative(dir, entry.parentPath), entry.name))
    .sort();
};

describe('the capture cache', () => {
  /** What a cached call answers: nested, so that a hit has to have been read back whole. */
  interface Answer {
    calls: number;
    ids: string[];
  }

  /** Work that counts its own calls, because a hit is a count that did not move. */
  const counted = (): { calls: () => number; work: () => Promise<Answer> } => {
    let calls = 0;
    return {
      calls: () => calls,
      work: async () => {
        calls += 1;
        return { calls, ids: ['cart-checkout', 'cart-promo-apply'] };
      },
    };
  };

  /** The one file the cache has written for a screen, which a test then damages. */
  const soleEntry = async (dir: string): Promise<string> => {
    const files = await filesUnder(dir);
    if (files.length !== 1) {
      throw new Error(
        `the cache writes one file per screen, and this run directory holds ${files.length}`,
      );
    }
    return join(dir, files[0]);
  };

  let parent: string;
  let runDir: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'personavision-cache-'));
    runDir = join(parent, 'run');
    await mkdir(runDir);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('answers a key it has already answered without running the work again', async () => {
    const { calls, work } = counted();

    const first = await withCache('one screen', work, { runDir });
    const again = await withCache('one screen', work, { runDir });

    expect(calls()).toBe(1);
    expect(again).toEqual(first);
    // Equal and not the same object: the second answer came off the disk, which is what
    // makes the cache outlive the process that filled it.
    expect(again).not.toBe(first);
  });

  it('answers a stored nothing, rather than taking it for a miss', async () => {
    let calls = 0;
    const nothing = async (): Promise<null> => {
      calls += 1;
      return null;
    };

    await expect(withCache('one screen', nothing, { runDir })).resolves.toBeNull();
    await expect(withCache('one screen', nothing, { runDir })).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it('runs the work for a key it has not answered', async () => {
    const { calls, work } = counted();

    await withCache('one screen', work, { runDir });
    await withCache('another screen', work, { runDir });

    expect(calls()).toBe(2);
  });

  it('answers a screen that has not changed from its entry', async () => {
    const { calls, work } = counted();
    const screen = 'A|cart';

    const first = await withCache('as it rendered', work, { runDir, screen });
    const again = await withCache('as it rendered', work, { runDir, screen });

    expect(calls()).toBe(1);
    expect(again).toEqual(first);
  });

  it('answers only what was last written to a screen', async () => {
    const { calls, work } = counted();
    const screen = 'A|cart';

    await withCache('as it first rendered', work, { runDir, screen });
    await withCache('as it rendered later', work, { runDir, screen });
    // The first content again. Its entry was overwritten by the second, so this is a miss —
    // which is what keeps a capture from naming an image that has since been replaced.
    await withCache('as it first rendered', work, { runDir, screen });

    expect(calls()).toBe(3);
    expect(await filesUnder(runDir)).toHaveLength(1);
  });

  it('keeps two screens apart, whatever they were captured at', async () => {
    const { calls, work } = counted();

    await withCache('one render', work, { runDir, screen: 'A|cart' });
    await withCache('one render', work, { runDir, screen: 'A|payment' });
    await withCache('one render', work, { runDir, screen: 'A|cart' });

    expect(calls()).toBe(2);
    expect(await filesUnder(runDir)).toHaveLength(2);
  });

  it('remembers nothing about work that threw', async () => {
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls += 1;
      throw new Error('the page would not answer');
    };

    // A capture that raised an automation failure is not an answer about a screen: the
    // next session over it has to try the page itself.
    await expect(withCache('one screen', failing, { runDir })).rejects.toThrow('would not answer');
    await expect(withCache('one screen', failing, { runDir })).rejects.toThrow('would not answer');
    expect(calls).toBe(2);
    expect(await filesUnder(runDir)).toEqual([]);
  });

  it('writes under the run directory, and nothing outside it', async () => {
    const { work } = counted();

    await withCache('one screen', work, { runDir });

    expect(await readdir(parent)).toEqual(['run']);
    // One key, one file: the entry is renamed into place, so no half-written leftover
    // stays behind beside it.
    expect(await filesUnder(runDir)).toHaveLength(1);
  });

  it('starts cold in a fresh run directory', async () => {
    const { calls, work } = counted();
    const fresh = join(parent, 'fresh-run');
    await mkdir(fresh);

    await withCache('one screen', work, { runDir });
    await withCache('one screen', work, { runDir: fresh });

    expect(calls()).toBe(2);
  });

  it('misses every lookup, and writes nothing, when there is no run directory', async () => {
    const { calls, work } = counted();

    await withCache('one screen', work);
    await withCache('one screen', work);

    expect(calls()).toBe(2);
    expect(await filesUnder(runDir)).toEqual([]);
    expect(await readdir(parent)).toEqual(['run']);
  });

  it('misses a truncated entry, and caches again over it', async () => {
    const { calls, work } = counted();
    await withCache('one screen', work, { runDir });

    const entry = await soleEntry(runDir);
    const body = await readFile(entry, 'utf8');
    // A session that died mid-write: valid JSON up to the point it stopped.
    await writeFile(entry, body.slice(0, Math.max(1, Math.floor(body.length / 2))), 'utf8');

    await expect(withCache('one screen', work, { runDir })).resolves.toMatchObject({ calls: 2 });
    // And the damage is not permanent: the entry the miss wrote is a hit.
    await expect(withCache('one screen', work, { runDir })).resolves.toMatchObject({ calls: 2 });
    expect(calls()).toBe(2);
  });

  for (const [field, value] of [
    ['key', 'a different screen'],
    ['version', 'from some later format'],
  ] as const) {
    it(`misses an entry whose ${field} is not the one it is looking for`, async () => {
      const { calls, work } = counted();
      await withCache('one screen', work, { runDir });

      const entry = await soleEntry(runDir);
      const stored = JSON.parse(await readFile(entry, 'utf8')) as Record<string, unknown>;
      await writeFile(entry, JSON.stringify({ ...stored, [field]: value }), 'utf8');

      await expect(withCache('one screen', work, { runDir })).resolves.toMatchObject({ calls: 2 });
      expect(calls()).toBe(2);
    });
  }

  it('answers the work when the run directory cannot be written to', async () => {
    const { calls, work } = counted();
    // A run directory that is a file: every write into it fails, and no capture may.
    const notADirectory = join(parent, 'run.json');
    await writeFile(notADirectory, '{}\n', 'utf8');

    await expect(withCache('one screen', work, { runDir: notADirectory })).resolves.toMatchObject({
      calls: 1,
    });
    await expect(withCache('one screen', work, { runDir: notADirectory })).resolves.toMatchObject({
      calls: 2,
    });
    expect(calls()).toBe(2);
  });
});

/** The task the fixture pages are written for, as `fixtures/site/LANDMARKS.md` declares it. */
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
  ],
};

describeWithChromium('a capture in a run directory', () => {
  let site: FixtureSite;
  let parent: string;
  let runDir: string;
  const opened: PageHandle[] = [];

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'personavision-capture-cache-'));
    runDir = join(parent, 'run');
    await mkdir(runDir);
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((handle) => closeSession(handle)));
    await rm(parent, { recursive: true, force: true });
  });

  /**
   * A session over the one variant these tests use. Two of them differ only in the device,
   * so what the cache key separates them by is the device and nothing else.
   */
  const session = async (device: Device): Promise<PageHandle> => {
    const handle = await openSession({ id: 'A', url: `${site.url}/cart.html` }, device);
    opened.push(handle);
    return handle;
  };

  const contextFor = (device: Device, dir = runDir): CaptureContext => ({
    variant: 'A',
    device,
    task: TASK,
    runDir: dir,
  });

  /** The screenshot a capture wrote, which a known step always has. */
  const screenshotOf = (captured: Capture): string => {
    if (captured.screenshot === null) {
      throw new Error('the cart page is on a step, so its capture names a screenshot');
    }
    return captured.screenshot;
  };

  it(
    "gives a second session the first one's capture, and does not take the picture again",
    async () => {
      const first = await capture(await session(DESKTOP), contextFor(DESKTOP));
      const image = join(runDir, screenshotOf(first));
      await rm(image);

      const second = await capture(await session(DESKTOP), contextFor(DESKTOP));

      // The same geometry, the same element ids and the same screenshot path.
      expect(second).toEqual(first);
      expect(second.elements.map((element) => element.id)).toEqual(
        first.elements.map((element) => element.id),
      );
      expect(existsSync(image)).toBe(false);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'leaves one screenshot on disk for two sessions over the same screen',
    async () => {
      await capture(await session(DESKTOP), contextFor(DESKTOP));
      await capture(await session(DESKTOP), contextFor(DESKTOP));

      const files = await filesUnder(runDir);
      expect(files.filter((file) => file.endsWith('.png'))).toEqual([
        join(runPaths('').screenshot('A', 'cart')),
      ]);
      // The screenshot and one cache entry: nothing else is written into a run.
      expect(files).toHaveLength(2);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'captures a changed page again, and rewrites its screenshot',
    async () => {
      const handle = await session(DESKTOP);
      const first = await capture(handle, contextFor(DESKTOP));
      const image = join(runDir, screenshotOf(first));
      await rm(image);

      await handle.page.evaluate(() => {
        const heading = document.querySelector('#cart-heading');
        if (heading === null) throw new Error('the cart page has a heading');
        heading.textContent = 'Your cart, one tote lighter';
      });
      const second = await capture(handle, contextFor(DESKTOP));

      expect(second.contentHash).not.toBe(first.contentHash);
      // The same screen of the same variant, so the same address — and written again.
      expect(screenshotOf(second)).toBe(screenshotOf(first));
      expect(existsSync(image)).toBe(true);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'captures the same screen again for a different device',
    async () => {
      const first = await capture(await session(DESKTOP), contextFor(DESKTOP));
      const image = join(runDir, screenshotOf(first));
      await rm(image);

      const second = await capture(await session(MOBILE), contextFor(MOBILE));

      // The markup is the same at both viewports, so the device is the only part of the
      // key that differs — and it is enough.
      expect(second.contentHash).toBe(first.contentHash);
      expect(second.viewport).toEqual(MOBILE.viewport);
      expect(second.foldY).toBe(MOBILE.viewport.height);
      expect(existsSync(image)).toBe(true);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'does not answer a session with a capture whose picture has been overwritten',
    async () => {
      const desktop = await capture(await session(DESKTOP), contextFor(DESKTOP));
      const image = join(runDir, screenshotOf(desktop));

      // A mobile session's picture of that screen lands on the same path: one image per
      // screen of one variant, whichever device took it.
      const mobile = await capture(await session(MOBILE), contextFor(MOBILE));
      expect(screenshotOf(mobile)).toBe(screenshotOf(desktop));
      expect(pngSize(await readFile(image)).width).toBe(
        MOBILE.viewport.width * MOBILE.deviceScaleFactor,
      );

      const again = await capture(await session(DESKTOP), contextFor(DESKTOP));

      // A hit here would hand this session the first capture's geometry and element boxes
      // over the mobile render. `run-projection.ts` records the last capture of a screen
      // because it is the one on disk, so the two have to agree — and a miss answers the
      // same as the hit would have, which is the point of the whole seam.
      expect(again).toEqual(desktop);
      expect(pngSize(await readFile(image))).toEqual({
        width: again.viewport.width * DESKTOP.deviceScaleFactor,
        height: again.pageHeight * DESKTOP.deviceScaleFactor,
      });
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'starts cold in a fresh run directory, and writes nothing outside it',
    async () => {
      const handle = await session(DESKTOP);
      const first = await capture(handle, contextFor(DESKTOP));

      const fresh = join(parent, 'fresh-run');
      await mkdir(fresh);
      const second = await capture(handle, contextFor(DESKTOP, fresh));

      expect(screenshotOf(second)).toBe(screenshotOf(first));
      expect(existsSync(join(fresh, screenshotOf(second)))).toBe(true);
      // One screenshot and one cache entry in each: the second run wrote into its own.
      expect(await filesUnder(fresh)).toHaveLength(2);
      expect(await filesUnder(runDir)).toHaveLength(2);
      expect((await readdir(parent)).sort()).toEqual(['fresh-run', 'run']);
    },
    BROWSER_TIMEOUT_MS,
  );
});
