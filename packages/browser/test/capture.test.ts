/**
 * A navigation under a capture, waited out and the screen read again.
 *
 * A site navigating while we read it is an ordinary event on the real web — a redirect, a
 * locale bounce, a framework taking over the first paint, a consent flow replacing the
 * document — and the composition in `capture.ts` is five reads that each run `page.evaluate`:
 * a navigation between any two of them destroys the execution context the next one runs in.
 * On `main` before #419 that error travelled to the session budget, which retried the whole
 * capture twice and ended the session as an automation failure; five of six sessions over
 * `www.canva.com` were lost that way.
 *
 * What is held here is the shape of the recovery, not just that it recovers:
 *
 * 1. The screen that is captured is **the page the session ended on** — its step, its
 *    screenshot, its elements and its content hash — and the next session over that screen
 *    gets it out of the cache, which is the content hash saying the same thing.
 * 2. It costs the session **no retry**: the re-read is below the budget, so the counters the
 *    artifact's `integrity` block reports do not move (#50).
 * 3. It happens **at most once per capture**. A second destroyed context in one capture is
 *    raised, and the budget's existing caps end the session rather than a re-read loop
 *    answering a redirect loop for ever.
 *
 * The timing is the hard part of testing it, and it is tested from both ends. The fixture
 * page under `fixtures/navigation/` really navigates, scheduled as the capture starts, which
 * is the whole thing end to end but cannot promise *which* read the navigation lands under —
 * so what it asserts of the recovery is a bound. The destroyed context is therefore also
 * injected at a named read, with the page really moved underneath, which is what pins the
 * recovery itself: the message is the driver's own, from `helpers/driver-errors.ts`.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node (see `geometry.test.ts`).

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AutomationFailure,
  SessionBudget,
  capture,
  closeSession,
  openSession,
  readContentHash,
} from '../src/index.js';
import type { Capture, CaptureContext, Device, PageHandle, TaskDefinition } from '../src/index.js';
import { CHROMIUM_INSTALLED } from './helpers/chromium.js';
import { destroyedContext } from './helpers/driver-errors.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** This ticket's own pages: see `fixtures/navigation/README.md`. */
const NAVIGATION_DIR = fileURLToPath(new URL('./fixtures/navigation', import.meta.url));

const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** Long enough to launch a browser and load a page on a cold machine (`geometry.test.ts`). */
const BROWSER_TIMEOUT_MS = 60_000;

/**
 * How long `navigates.html` holds its main thread after asking to navigate, so that a read of
 * it is in flight when the new document commits — the fixture's README says why a loopback
 * destination needs that. A second rather than a moment, so that it holds on a machine
 * running the whole suite at once.
 */
const HOLD_MS = 1_000;

/**
 * The wall clock the redirect-loop session runs under. Small on purpose: a page that
 * replaces itself before it is parsed offers no document to settle on, so the session ends
 * on this cap, and the suite should not spend the default minute finding that out.
 */
const LOOP_WALL_CLOCK_MS = 3_000;

/** The two pages of `fixtures/navigation/`, as a task that knows both of them as steps. */
const TASK: TaskDefinition = {
  id: 'reading',
  prompt: 'Read the page',
  steps: [
    {
      id: 'start',
      label: 'Welcome',
      match: { urlPattern: '/navigates\\.html', requiredSelector: '#start-heading' },
      primaryAction: { selector: '#start-link' },
    },
    {
      id: 'destination',
      label: 'Your order',
      match: { urlPattern: '/destination\\.html', requiredSelector: '#destination-heading' },
      primaryAction: { selector: '#destination-link' },
    },
  ],
};

/**
 * A handle that counts the compositions of a capture, and may break one.
 *
 * A composition opens with the geometry read and nothing else in the module measures the
 * page (`capture.ts`, `geometry.ts`), so counting that read counts compositions — including
 * one that died before it got any further, which is what a navigation under the first read
 * leaves behind. Nothing is reached into and no part of the capture is stood in for.
 * `onComposition` runs just before that read and may throw, which is how a destroyed context
 * is put under a named read rather than wherever a timer happened to land.
 *
 * Every other call is forwarded to the real page, bound to it: a driver object's own methods
 * read fields of their own, and `this` has to be the page rather than this proxy.
 */
const watchingCompositions = (
  handle: PageHandle,
  onComposition: (composition: number) => Promise<void> = async () => undefined,
): { readonly handle: PageHandle; compositions: () => number } => {
  let compositions = 0;

  const page = new Proxy(handle.page, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== 'evaluate') return value.bind(target);

      return async (...args: unknown[]): Promise<unknown> => {
        const [fn] = args;
        if (typeof fn === 'function' && fn.toString().includes('pageHeight')) {
          compositions += 1;
          await onComposition(compositions);
        }
        return (value as (...given: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  });

  return { handle: { ...handle, page }, compositions: () => compositions };
};

describeWithChromium('a navigation under a capture', () => {
  let site: FixtureSite;
  let runDir: string;
  const opened: PageHandle[] = [];

  beforeAll(async () => {
    site = await serveFixtureSite({ root: NAVIGATION_DIR });
  });

  afterAll(async () => {
    await site.close();
  });

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-capture-navigation-'));
  });

  // Given a browser's worth of patience rather than the ten seconds a hook has by default:
  // closing four Chromium sessions on a machine running the whole suite at once takes longer
  // than that, and a teardown that runs out of time fails tests that have already passed.
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((handle) => closeSession(handle)));
    await rm(runDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  const open = async (path: string): Promise<PageHandle> => {
    const handle = await openSession({ id: 'A', url: `${site.url}${path}` }, DESKTOP);
    opened.push(handle);
    return handle;
  };

  const contextFor = (): CaptureContext => ({
    variant: 'A',
    device: DESKTOP,
    task: TASK,
    runDir,
  });

  /** The screenshot a capture wrote, which a page on a known step always has. */
  const screenshotOf = (captured: Capture): string => {
    if (captured.screenshot === null) {
      throw new Error('a page on a step is captured with a screenshot');
    }
    return captured.screenshot;
  };

  /** What a rejected capture threw, or `null` when nothing was thrown. */
  const thrownBy = (captured: Promise<Capture>): Promise<unknown> =>
    captured.then(
      () => null,
      (error: unknown) => error,
    );

  it(
    'captures the page a navigation during the read landed on, and spends no retry on it',
    async () => {
      const handle = await open('/navigates.html');
      const watched = watchingCompositions(handle);
      const budget = new SessionBudget();

      // Scheduled from the page, to land on the capture's first read: see the fixture for
      // why the page holds its main thread after asking to navigate. The hold travels as an
      // argument, because only the function's own source reaches the page.
      await handle.page.evaluate((holdMs) => {
        (window as unknown as { pvNavigateIn: (ms: number, holdMs: number) => void }).pvNavigateIn(
          0,
          holdMs,
        );
      }, HOLD_MS);
      const captured = await capture(watched.handle, contextFor(), budget);

      // The destination, whole: its step, its picture, its elements, its hash.
      expect(handle.page.url()).toContain('/destination.html');
      expect(captured.step).toBe('destination');
      expect(screenshotOf(captured)).toContain('destination');
      expect(existsSync(join(runDir, screenshotOf(captured)))).toBe(true);
      expect(captured.elements.length).toBeGreaterThan(0);
      expect(captured.contentHash).toBe(await readContentHash(handle));

      // Nothing of ours was raised and nothing was charged to the session: a navigation is
      // not a fault, and the counters the artifact reports say so.
      expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 0, retries: 0 });
      expect(budget.integrity().attempts).toBe(1);
      // Twice and no more: the composition the navigation killed, and the re-read that
      // answered — whichever of the reads it landed under.
      expect(watched.compositions()).toBe(2);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "composes the screen a second time, and caches it under the destination's content hash",
    async () => {
      const first = await open('/navigates.html');
      const startHash = await readContentHash(first);
      const budget = new SessionBudget();

      /** The page goes somewhere else under the content-hash read, and that read dies of it. */
      const navigatingUnderTheRead = async (handle: PageHandle, composition: number) => {
        if (composition > 1) return;
        await handle.page.goto(`${site.url}/destination.html`, { waitUntil: 'domcontentloaded' });
        throw destroyedContext();
      };

      const watched = watchingCompositions(first, (composition) =>
        navigatingUnderTheRead(first, composition),
      );
      const captured = await capture(watched.handle, contextFor(), budget);

      expect(watched.compositions()).toBe(2);
      expect(captured.step).toBe('destination');
      expect(captured.contentHash).toBe(await readContentHash(first));
      expect(captured.contentHash).not.toBe(startHash);
      expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 0, retries: 0 });

      // The entry is the destination's, so a second session over the same screen is a hit —
      // and a hit writes nothing, which is what the deleted picture staying gone says
      // (`cache.test.ts` holds that observation).
      const image = join(runDir, screenshotOf(captured));
      await rm(image);

      const second = await open('/navigates.html');
      const again = await capture(
        watchingCompositions(second, (composition) => navigatingUnderTheRead(second, composition))
          .handle,
        contextFor(),
      );

      expect(again).toEqual(captured);
      expect(existsSync(image)).toBe(false);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'raises the second destroyed context of one capture, and the budget ends the session',
    async () => {
      const handle = await open('/navigates.html');
      const budget = new SessionBudget({ wallClockMs: 20_000 });
      const watched = watchingCompositions(handle, async () => {
        throw destroyedContext();
      });

      const thrown = await thrownBy(capture(watched.handle, contextFor(), budget));

      expect(thrown).toBeInstanceOf(AutomationFailure);
      expect((thrown as AutomationFailure).reason).toBe('navigation_error');
      expect((thrown as AutomationFailure).message).toContain('retry cap');
      // The budget's own caps ended it, with the retries it always spends on a failure of
      // ours — two, and not one per re-read.
      expect(budget.integrity().exhausted).toBe(true);
      expect(budget.integrity().attempts).toBe(3);
      expect(budget.sessionIntegrity().retries).toBe(2);
      // Two compositions per attempt and no more: the re-read is bounded.
      expect(watched.compositions()).toBe(2 * budget.integrity().attempts);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'ends one automation failure on a page that never stops navigating, rather than looping',
    async () => {
      // Opened on a quiet page and then sent into the loop: a session cannot be *opened* on
      // a page that replaces itself before it has finished loading, and what is under test
      // is the capture rather than the opening navigation.
      const handle = await open('/destination.html');
      const watched = watchingCompositions(handle);
      const budget = new SessionBudget({ maxRetries: 0, wallClockMs: LOOP_WALL_CLOCK_MS });
      await handle.page
        .goto(`${site.url}/redirect-loop.html?ms=0`, { waitUntil: 'commit' })
        .catch(() => undefined);

      const thrown = await thrownBy(capture(watched.handle, contextFor(), budget));

      // A failure of ours, and only one of them. Which of the two reasons depends on what
      // the storm of navigations killed — the second read of the capture, or the wait for a
      // document that is replaced before it is parsed — and both are a cap of the budget's
      // ending the session, which is the point: nothing here re-reads for ever.
      expect(thrown).toBeInstanceOf(AutomationFailure);
      expect(['navigation_error', 'timeout']).toContain((thrown as AutomationFailure).reason);
      expect(budget.integrity().exhausted).toBe(true);
      expect(budget.integrity().attempts).toBe(1);
      // At most two compositions in that one attempt: the bound holds on a page that offers
      // the capture an unbounded number of new documents.
      expect(watched.compositions()).toBeLessThanOrEqual(2);
    },
    BROWSER_TIMEOUT_MS,
  );
});
