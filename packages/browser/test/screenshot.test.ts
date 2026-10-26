/**
 * The full-page screenshot, asserted as a file on disk.
 *
 * What a screen needs from this seam is an image it can register overlays to: at the path
 * `run.json` records, covering the whole document rather than the viewport, and at the
 * device's pixels so a box measured in CSS pixels scales onto it. Those are the three
 * things tested here, by reading the PNG's own header — no assertion reaches into
 * Playwright, and nothing here is told what the library did.
 *
 * The run directory is a fresh temporary one per test, so "one file at one path" is a
 * statement about a directory listing and not about a name.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeSession, openSession, readGeometry, writeScreenshot } from '../src/index.js';
import type { Device, PageHandle } from '../src/index.js';
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

/** The PNG signature, so that "a readable PNG" is read and not inferred from the suffix. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's pixel dimensions, read out of its first chunk.
 *
 * Every PNG opens with the 8-byte signature and then IHDR: a 4-byte length, the type, and
 * the width and height as big-endian 32-bit integers. Reading them here keeps the
 * assertion about the image rather than about the library that wrote it, and needs no
 * decoder.
 */
const pngSize = (bytes: Buffer): { width: number; height: number; signed: boolean } => {
  // Checked before the integers are read: a short or empty file should fail as "not a PNG"
  // and not as a buffer out of bounds.
  const signed =
    bytes.byteLength >= 24 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.subarray(12, 16).toString() === 'IHDR';

  return signed
    ? { signed, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : { signed, width: 0, height: 0 };
};

describeWithChromium('writeScreenshot', () => {
  let site: FixtureSite;
  let runDir: string;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-screenshot-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const open = (device: Device, path = '/cart.html'): Promise<PageHandle> =>
    openSession({ id: `v-${device.name}`, url: `${site.url}${path}` }, device);

  it(
    'writes the step of the variant where run.json says it is, and returns that path',
    async () => {
      const handle = await open(DESKTOP);
      try {
        const written = await writeScreenshot(handle, {
          runDir,
          variant: 'A',
          step: 'cart',
        });

        expect(written).toBe('screenshots/A/cart.png');
        expect(written).toBe(runPaths('').screenshot('A', 'cart'));

        const image = await readFile(join(runDir, 'screenshots', 'A', 'cart.png'));
        expect(pngSize(image).signed).toBe(true);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  for (const device of [MOBILE, DESKTOP]) {
    it(
      `covers the whole page at the ${device.name} device's pixels, not the viewport`,
      async () => {
        const handle = await open(device);
        try {
          // The fixture pages are absolutely positioned and none of them is wider than the
          // narrow viewport (`fixtures/site/LANDMARKS.md`), so the document is exactly as
          // wide as the viewport at both devices and as tall as the page.
          const geometry = await readGeometry(handle);
          const written = await writeScreenshot(handle, { runDir, variant: 'A', step: 'cart' });
          if (written === null) throw new Error('a known step writes a screenshot');

          const { width, height } = pngSize(await readFile(join(runDir, written)));

          expect(geometry.pageHeight).toBeGreaterThan(geometry.viewport.height);
          expect(width).toBe(geometry.viewport.width * device.deviceScaleFactor);
          expect(height).toBe(geometry.pageHeight * device.deviceScaleFactor);
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  }

  it(
    'leaves one file at one path when the same screen is captured twice',
    async () => {
      const handle = await open(DESKTOP);
      try {
        const first = await writeScreenshot(handle, { runDir, variant: 'A', step: 'cart' });
        const again = await writeScreenshot(handle, { runDir, variant: 'A', step: 'cart' });

        expect(again).toBe(first);
        await expect(readdir(join(runDir, 'screenshots', 'A'))).resolves.toEqual(['cart.png']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'writes nothing at all for a page the task does not recognise',
    async () => {
      const handle = await open(DESKTOP, '/no-control.html');
      try {
        await expect(
          writeScreenshot(handle, { runDir, variant: 'A', step: null }),
        ).resolves.toBeNull();

        await expect(readdir(runDir)).resolves.toEqual([]);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'refuses a variant or a step that is not one path segment, and writes nothing',
    async () => {
      const handle = await open(DESKTOP);
      try {
        await expect(
          writeScreenshot(handle, { runDir, variant: 'A', step: '../../../escaped' }),
        ).rejects.toThrow('one path segment');
        await expect(
          writeScreenshot(handle, { runDir, variant: 'a/b', step: 'cart' }),
        ).rejects.toThrow('one path segment');

        await expect(readdir(runDir)).resolves.toEqual([]);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'keeps two variants of the same step apart',
    async () => {
      const handle = await open(DESKTOP);
      try {
        await writeScreenshot(handle, { runDir, variant: 'A', step: 'cart' });
        await writeScreenshot(handle, { runDir, variant: 'B', step: 'cart' });

        expect((await readdir(join(runDir, 'screenshots'))).sort()).toEqual(['A', 'B']);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
