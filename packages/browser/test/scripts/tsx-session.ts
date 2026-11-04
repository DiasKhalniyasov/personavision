/**
 * One real browser session, driven from source. Spawned, not imported.
 *
 * `tsx-session.test.ts` runs this file under `tsx` as a subprocess — the invocation
 * `pnpm open` and `pnpm dev` use — because what it is about is the transpiler, and no
 * transpiler can be reproduced from inside a suite that a different one transformed.
 * Vitest's own transform injects no `keepNames` helper; esbuild, which is what `tsx` is,
 * does, and that helper's call used to travel into the page with the function
 * `page.evaluate` serialises (`src/session.ts`).
 *
 * So the session below touches every module of this package that evaluates a function
 * inside the page, once each:
 *
 * - `session.ts` — `readSessionState`, and the init script under test
 * - `geometry.ts` — `readGeometry`, through `capture`
 * - `capture.ts` — `readContentHash`, through `capture`
 * - `extract/elements.ts` — `extractElements`, through `capture`
 * - `steps.ts` — `detectStep`, through `capture` and again through `act`
 * - `act.ts` — the scroll by a delta, which is that module's own `page.evaluate`
 *
 * It prints one JSON object on stdout and exits 0. Anything that throws leaves the process
 * non-zero with the error on stderr, which is what the suite reads: a `ReferenceError` out
 * of any of the six is a failure there rather than a product nobody can run from source.
 *
 * Nothing is asserted here. The script reports what it saw and the suite judges it, so a
 * wrong number is a diff in the test output and not an exit code to go looking for.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, capture, closeSession, openSession, readSessionState } from '../../src/index.js';
import type { CaptureContext, Device, TaskDefinition } from '../../src/index.js';
import { serveFixtureSite } from '../helpers/static-site.js';

/** One of the two devices `fixtures/site/LANDMARKS.md` positions everything for. */
const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/**
 * The first step of the fixture site's task, as `LANDMARKS.md` declares it. One step is
 * enough: a step to detect and a primary action to resolve is what the page-evaluating
 * modules need, and walking further would only open more browsers.
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
  ],
};

/** Any non-zero delta reaches `act.ts`'s own `page.evaluate`; this one stays on the page. */
const SCROLL_DELTA_Y = 120;

const site = await serveFixtureSite();
const runDir = await mkdtemp(join(tmpdir(), 'personavision-tsx-session-'));

try {
  const variant = { id: 'v-desktop', url: `${site.url}/cart.html` };
  const handle = await openSession(variant, DESKTOP);

  try {
    const ctx: CaptureContext = { variant: variant.id, device: DESKTOP, task: TASK, runDir };
    const state = await readSessionState(handle);
    const screen = await capture(handle, ctx);
    const scrolled = await act(handle, { type: 'scroll', deltaY: SCROLL_DELTA_Y }, ctx);

    process.stdout.write(
      `${JSON.stringify({
        screens: 1,
        url: state.url,
        viewport: state.viewport,
        step: screen.step,
        pageHeight: screen.pageHeight,
        foldY: screen.foldY,
        screenshot: screen.screenshot,
        elements: screen.elements.length,
        primaryActions: screen.elements.filter((element) => element.isPrimaryAction).length,
        action: { ok: scrolled.ok, step: scrolled.step, scrollY: scrolled.scrollY },
      })}\n`,
    );
  } finally {
    await closeSession(handle);
  }
} finally {
  await rm(runDir, { recursive: true, force: true });
  await site.close();
}
