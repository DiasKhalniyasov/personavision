/**
 * Page geometry, at two devices, against pages whose height is a stated fact.
 *
 * `fixtures/site/LANDMARKS.md` records a height per page and the fold at each of the two
 * viewports, and those numbers were read out of a browser rather than computed. So this
 * suite can assert equality rather than a range: every page, at both devices, through the
 * package's public entry point and nothing else.
 *
 * No assertion here reaches into Playwright: a session is opened with `openSession` and
 * measured with `readGeometry`, which is all the rest of the step is allowed to assume.
 * Playwright is imported for one thing only — asking where the browser would be, so
 * that a machine without one is skipped rather than failed.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSession, isBelowFold, openSession, readGeometry } from '../src/index.js';
import type { Device, PageHandle } from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/**
 * Chromium has to be on disk. `pnpm --filter @personavision/browser exec playwright install
 * chromium` puts it there and CI caches it; a developer who has not run it yet gets these
 * suites skipped rather than a wall of launch failures — except in CI, where a missing
 * browser is a broken workflow and must fail.
 */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

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
 * Page heights, as `LANDMARKS.md` states them. They hold at both viewports: every landmark
 * is positioned from the document origin, so nothing reflows, and no page is shorter than
 * the taller viewport.
 */
const PAGE_HEIGHTS = [
  { path: '/cart.html', pageHeight: 1400 },
  { path: '/payment.html', pageHeight: 1200 },
  { path: '/review.html', pageHeight: 1100 },
  { path: '/confirmation.html', pageHeight: 1000 },
  { path: '/no-control.html', pageHeight: 1000 },
] as const;

/** Long enough to launch a browser and load a page on a cold machine. */
const BROWSER_TIMEOUT_MS = 60_000;

describeWithChromium('page geometry', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  for (const device of [MOBILE, DESKTOP]) {
    describe(`at ${device.name} (${device.viewport.width}x${device.viewport.height})`, () => {
      it.each(PAGE_HEIGHTS)(
        'measures $path',
        async ({ path, pageHeight }) => {
          const handle = await openSession({ id: device.name, url: `${site.url}${path}` }, device);
          try {
            const geometry = await readGeometry(handle);

            expect(geometry.viewport).toEqual(device.viewport);
            expect(geometry.pageHeight).toBe(pageHeight);
            // The fold is the viewport's bottom edge in page space at scroll 0.
            expect(geometry.foldY).toBe(device.viewport.height);
          } finally {
            await closeSession(handle);
          }
        },
        BROWSER_TIMEOUT_MS,
      );
    });
  }

  it(
    'measures a page one of whose frames never arrives',
    async () => {
      // `broken-frame.html` points a frame at `/slow`, which is accepted and never
      // answered, so the page never fires `load`. Its geometry is still a fact.
      const handle = await openSession(
        { id: 'broken', url: `${site.url}/broken-frame.html` },
        DESKTOP,
        { waitUntil: 'domcontentloaded' },
      );
      try {
        const geometry = await readGeometry(handle);
        expect(geometry.pageHeight).toBe(1000);
        expect(geometry.foldY).toBe(900);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'puts the fold between the two devices on the page that crosses it',
    async () => {
      // The cart is 1400 tall, so its lower half is below the mobile fold at 844 and the
      // desktop fold at 900 — and a box between the two is above one and below the other.
      const sessions: PageHandle[] = [];
      try {
        for (const device of [MOBILE, DESKTOP]) {
          const handle = await openSession(
            { id: device.name, url: `${site.url}/cart.html` },
            device,
          );
          sessions.push(handle);
          const geometry = await readGeometry(handle);
          expect(isBelowFold({ y: 860 }, geometry)).toBe(device.name === 'mobile');
          expect(isBelowFold({ y: 820 }, geometry)).toBe(false);
          expect(isBelowFold({ y: 950 }, geometry)).toBe(true);
        }
      } finally {
        await Promise.all(sessions.map(closeSession));
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
