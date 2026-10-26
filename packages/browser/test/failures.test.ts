/**
 * Our own breakage, named as ours.
 *
 * Every failure of the browser driver is typed, carries a reason a person can read, and
 * becomes a session outcome that is excluded from the scores — never something the product
 * did. `docs/FLOW.md` section 8 keeps *abandoned*, *failed* and *automation failure* apart,
 * and this file is where that separation is held for the fourth one: there is no path
 * through this module that produces `attribution: "product"`.
 *
 * The four reasons are driven against the real thing. A selector the fixture site does not
 * have, its never-answering `/slow` route, its `/boom` route and a port nothing listens on,
 * and `broken-frame.html`'s two frames each produce their own reason, out of the errors
 * Chromium's driver actually raises — and each is produced **within the cap the operation
 * was given**, not by hanging until the test runner gives up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, sessionSchema } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutomationFailure,
  closeSession,
  frameFailure,
  mapToAutomationFailure,
  navigationFailure,
  openSession,
  toAutomationFailure,
  toAutomationFailureOutcome,
  watchFrameFailures,
} from '../src/index.js';
import type { AutomationFailureOutcome, AutomationFailureReason, Device } from '../src/index.js';
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

/**
 * The cap every page operation below is given. It is far under the test runner's patience on
 * purpose: a failure that arrives after it would be a hang, and the assertions say so.
 */
const CAP_MS = 500;

/**
 * How long a capped page operation may take and still count as capped. The cap it was given
 * several times over, which is what separates "capped" from "hung": the never-answering
 * route does not answer *at all*, so without the cap nothing below would ever return.
 */
const PATIENCE_MS = CAP_MS * 8;

/**
 * The same, for an operation that launches Chromium on the way: a cold launch on a loaded
 * machine is seconds, and it is not what the cap is about.
 */
const LAUNCHING_PATIENCE_MS = 20_000;

/** Long enough to launch a browser and load a page on a cold machine (`geometry.test.ts`). */
const BROWSER_TIMEOUT_MS = 60_000;

/** The four reasons, in the order `types.ts` declares them. */
const REASONS: readonly AutomationFailureReason[] = [
  'selector_not_found',
  'timeout',
  'navigation_error',
  'frame_error',
];

/** A session the contract accepts, carrying the outcome under test and nothing else of note. */
const sessionWith = (outcome: AutomationFailureOutcome): unknown => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: 'S-01',
  runId: '2026-10-27-1000-fixture',
  variant: 'control',
  taskId: 'checkout',
  kind: 'simulated',
  persona: null,
  participant: null,
  seed: 7,
  startedAt: '2026-10-27T10:00:00.000Z',
  durationMs: 1_200,
  screens: [],
  fixations: [],
  saccades: [],
  actions: [],
  outcome,
  integrity: { selectorFailures: 1, retries: 1 },
});

/**
 * Runs an operation that is expected to break, and reads what broke as one of ours. Fails
 * the test when nothing broke, when the error is not ours to classify, or when the failure
 * took longer to arrive than a capped operation may.
 */
const failureOf = async (
  attempting: string,
  withinMs: number,
  operation: () => Promise<unknown>,
): Promise<AutomationFailure> => {
  const started = Date.now();
  const thrown = await operation().then(
    () => null,
    (error: unknown) => error,
  );
  const elapsed = Date.now() - started;

  if (thrown === null) throw new Error(`${attempting}: expected a failure of ours, nothing broke`);
  const failure = toAutomationFailure(thrown, attempting);
  if (failure === null) {
    throw new Error(`${attempting}: not recognised as one of ours — ${String(thrown)}`);
  }
  expect(elapsed).toBeLessThan(withinMs);
  return failure;
};

const waitUntil = async (ready: () => boolean, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return ready();
};

describe('a thrown error, read as one of ours', () => {
  it('reads the four reasons out of the errors Chromium raises', () => {
    const selectorTimeout = new Error(
      "locator.waitFor: Timeout 300ms exceeded.\nCall log:\n  - waiting for locator('#nope') to be visible\n",
    );
    selectorTimeout.name = 'TimeoutError';
    const navigationTimeout = new Error(
      'page.goto: Timeout 300ms exceeded.\nCall log:\n  - navigating to "http://127.0.0.1:1/slow", waiting until "load"\n',
    );
    navigationTimeout.name = 'TimeoutError';
    const refused = new Error(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:65343/x\n',
    );
    const frameStalled = new Error('frame.waitForLoadState: Timeout 300ms exceeded.\n');
    frameStalled.name = 'TimeoutError';

    expect(mapToAutomationFailure(selectorTimeout)).toBe('selector_not_found');
    expect(mapToAutomationFailure(navigationTimeout)).toBe('timeout');
    expect(mapToAutomationFailure(refused)).toBe('navigation_error');
    expect(mapToAutomationFailure(frameStalled)).toBe('frame_error');
  });

  it('reads a failure of ours it is handed again as the reason it already carries', () => {
    const ours = new AutomationFailure('frame_error', 'a frame never loaded');
    expect(mapToAutomationFailure(ours)).toBe('frame_error');
  });

  it('places nothing it cannot place, so the caller rethrows', () => {
    expect(mapToAutomationFailure(new Error('the shop declined the card'))).toBeNull();
    expect(mapToAutomationFailure('not even an error')).toBeNull();
    expect(mapToAutomationFailure(null)).toBeNull();
    expect(mapToAutomationFailure(undefined)).toBeNull();
    expect(toAutomationFailure(new Error('the shop declined the card'), 'paying')).toBeNull();
  });

  it('names what was being attempted, and the selector that never resolved', () => {
    const timeout = new Error(
      "locator.waitFor: Timeout 300ms exceeded.\nCall log:\n  - waiting for locator('#cart-checkout') to be visible\n",
    );
    timeout.name = 'TimeoutError';

    const failure = toAutomationFailure(timeout, 'waiting for the cart checkout link');
    expect(failure?.reason).toBe('selector_not_found');
    expect(failure?.message).toContain('waiting for the cart checkout link');
    expect(failure?.message).toContain('#cart-checkout');
    expect(failure?.cause).toBe(timeout);
  });

  it('reads a navigation that answered with a status the page cannot be used at', () => {
    const answered = (status: number): { url: () => string; status: () => number } => ({
      url: () => 'http://127.0.0.1:5173/boom',
      status: () => status,
    });

    const failure = navigationFailure(answered(500), 'opening the payment step');
    expect(failure?.reason).toBe('navigation_error');
    expect(failure?.message).toContain('opening the payment step');
    expect(failure?.message).toContain('500');
    expect(failure?.message).toContain('http://127.0.0.1:5173/boom');

    expect(navigationFailure(answered(200), 'opening the payment step')).toBeNull();
    expect(navigationFailure(null, 'opening the payment step')).toBeNull();
  });

  it('reads a frame whose own document never arrived', () => {
    const failure = frameFailure(
      { url: 'http://frame.invalid/card.html', errorText: 'net::ERR_NAME_NOT_RESOLVED' },
      'loading the card details frame',
    );

    expect(failure.reason).toBe('frame_error');
    expect(failure.message).toContain('loading the card details frame');
    expect(failure.message).toContain('http://frame.invalid/card.html');
    expect(failure.message).toContain('net::ERR_NAME_NOT_RESOLVED');
  });
});

describe('the session outcome a failure of ours produces', () => {
  it('parses against the contract for each of the four reasons, and is always ours', () => {
    for (const reason of REASONS) {
      const failure = new AutomationFailure(reason, `waiting for the cart: ${reason}`);
      const outcome = toAutomationFailureOutcome(failure, 'cart');

      expect(outcome).toEqual({
        status: 'automation_failure',
        step: 'cart',
        reason: `waiting for the cart: ${reason}`,
        attribution: 'automation',
        excludedFromScores: true,
      });

      const parsed = sessionSchema.parse(sessionWith(outcome));
      expect(parsed.outcome.status).toBe('automation_failure');
      expect(parsed.outcome.attribution).toBe('automation');
      expect(parsed.outcome.excludedFromScores).toBe(true);
    }
  });

  it('names a step the session never reached rather than leaving it blank', () => {
    const failure = new AutomationFailure('navigation_error', 'opening the variant: refused');

    for (const step of [null, '', '  ']) {
      const outcome = toAutomationFailureOutcome(failure, step);
      expect(outcome.step.trim()).not.toBe('');
      expect(() => sessionSchema.parse(sessionWith(outcome))).not.toThrow();
    }
  });

  it('has no path to a product-attributed outcome, over the four reasons', () => {
    // The vocabulary first: whatever the reason, the outcome is ours and excluded.
    const attributions = REASONS.map(
      (reason) =>
        toAutomationFailureOutcome(new AutomationFailure(reason, `broke: ${reason}`), 'payment')
          .attribution,
    );
    expect(new Set(attributions)).toEqual(new Set(['automation']));

    // And then the source, because an outcome is only as honest as the module that writes
    // it: neither file this ticket fills can even spell the other attribution.
    for (const file of ['../src/failure-mapping.ts', '../src/budget.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).not.toContain("'product'");
      expect(source).not.toContain('excludedFromScores: false');
    }
  });
});

/**
 * The four reasons, out of a real browser against the fixture site.
 *
 * Two cases here navigate through `handle.page` rather than `openSession`. Both judge
 * something a navigation *produces* — the response it answered with, the frame requests it
 * made — so the navigation has to happen while the test is watching, and on a session that
 * is already open. `PageHandle` publishes the page for exactly this kind of seam
 * (`types.ts`); nothing else in this file reaches past the package's own surface.
 */
describeWithChromium('the four failures, against the fixture site', () => {
  let site: FixtureSite;
  let closedPort: number;

  beforeAll(async () => {
    site = await serveFixtureSite();
    // A port that was listening and is not any more: a navigation there is refused at once.
    const vacated = await serveFixtureSite();
    closedPort = vacated.port;
    await vacated.close();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await site.close();
  });

  it(
    'reads a selector the site does not have as selector_not_found, naming it',
    async () => {
      const handle = await openSession({ id: 'control', url: `${site.url}/cart.html` }, MOBILE);
      try {
        const failure = await failureOf('waiting for the cart checkout link', PATIENCE_MS, () =>
          handle.page.locator('#cart-checkout-that-is-not-there').waitFor({ timeout: CAP_MS }),
        );

        expect(failure.reason).toBe('selector_not_found');
        expect(failure.message).toContain('#cart-checkout-that-is-not-there');
        expect(failure.message).toContain('waiting for the cart checkout link');
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reads the never-answering route as timeout',
    async () => {
      const failure = await failureOf('opening the payment step', LAUNCHING_PATIENCE_MS, () =>
        openSession({ id: 'control', url: `${site.url}/slow` }, MOBILE, {
          navigationTimeoutMs: CAP_MS,
        }),
      );

      expect(failure.reason).toBe('timeout');
      expect(failure.message).toContain('opening the payment step');
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reads a port nothing listens on as navigation_error',
    async () => {
      const failure = await failureOf('opening the variant', LAUNCHING_PATIENCE_MS, () =>
        openSession({ id: 'control', url: `http://127.0.0.1:${closedPort}/cart.html` }, MOBILE, {
          navigationTimeoutMs: CAP_MS,
        }),
      );

      expect(failure.reason).toBe('navigation_error');
      expect(failure.message).toContain('opening the variant');
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reads the 500 route as navigation_error, from the status it answered with',
    async () => {
      // The navigation itself succeeds here — the page simply *is* a server error — so the
      // failure is read off the navigation's response, not out of a thrown error.
      const handle = await openSession({ id: 'control', url: `${site.url}/cart.html` }, MOBILE);
      try {
        const response = await handle.page.goto(`${site.url}/boom`, {
          timeout: BROWSER_TIMEOUT_MS,
        });
        expect(response?.status()).toBe(500);

        const failure = navigationFailure(response, 'opening the payment step');
        if (failure === null) throw new Error('a 500 is a navigation this module refuses to use');
        expect(failure.reason).toBe('navigation_error');
        expect(failure.message).toContain('500');

        const outcome = toAutomationFailureOutcome(failure, 'payment');
        expect(outcome.attribution).toBe('automation');
        expect(outcome.excludedFromScores).toBe(true);
      } finally {
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reads broken-frame.html as frame_error, naming the frame that never arrived',
    async () => {
      // The watch is attached before the page with the broken frames is opened: a frame
      // request that failed before anything was listening is one nothing can report.
      const handle = await openSession({ id: 'control', url: `${site.url}/cart.html` }, MOBILE);
      const watch = watchFrameFailures(handle, 'loading the card details frames');

      try {
        // Waiting for this page's `load` event waits forever, so it is opened on
        // `domcontentloaded` — `LANDMARKS.md` records why.
        await handle.page.goto(`${site.url}/broken-frame.html`, {
          waitUntil: 'domcontentloaded',
          timeout: BROWSER_TIMEOUT_MS,
        });

        const named = (): boolean =>
          watch.seen().some((failure) => failure.message.includes('frame.invalid'));
        expect(await waitUntil(named, PATIENCE_MS)).toBe(true);

        for (const failure of watch.seen()) {
          expect(failure.reason).toBe('frame_error');
          expect(failure.message).toContain('loading the card details frames');
          expect(toAutomationFailureOutcome(failure, 'payment')).toMatchObject({
            status: 'automation_failure',
            attribution: 'automation',
            excludedFromScores: true,
          });
        }
      } finally {
        watch.stop();
        await closeSession(handle);
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
