/**
 * The whole module doing its job: a live walk of the four-step fixture task.
 *
 * This is the step's demo, asserted. One call over the fixture site opens a variant under an
 * emulated device, walks the cart, the payment form, the review and the confirmation, and
 * hands back per step a screenshot on disk, the geometry with its fold, the elements with
 * one of them marked as the step's primary action, the step's label and what the action did.
 *
 * Everything here goes through the package's public entry point — `createLiveSource` and
 * `walkTask` — and nothing reaches into Playwright or into a module behind it. The pages,
 * the boxes, the page heights and the step declarations are
 * `test/fixtures/site/LANDMARKS.md`'s, quoted rather than rediscovered.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths, runSchema } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionBudget,
  UNKNOWN_STEP,
  createLiveSource,
  toAoiEntries,
  toScreenshotEntries,
  walkTask,
} from '../../src/index.js';
import type { Capture, Device, TaskDefinition } from '../../src/index.js';
import { serveFixtureSite } from '../helpers/static-site.js';
import type { FixtureSite } from '../helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** A whole walk is four captures and three actions, so it is given the suite's own cap. */
const WALK_TIMEOUT_MS = 60_000;

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

/** The task the fixture site is written for: `LANDMARKS.md`'s "Step match rules", in full. */
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

/** The page heights and primary-action boxes `LANDMARKS.md` records, per step. */
const EXPECTED = [
  { step: 'cart', pageHeight: 1400, primary: { x: 16, y: 784, width: 358, height: 44 } },
  { step: 'payment', pageHeight: 1200, primary: { x: 28, y: 468, width: 200, height: 44 } },
  { step: 'review', pageHeight: 1100, primary: { x: 16, y: 600, width: 358, height: 44 } },
  { step: 'confirmation', pageHeight: 1000, primary: { x: 16, y: 480, width: 358, height: 44 } },
] as const;

/**
 * `cart-promo-apply`, the control that crosses the fold between the two viewports: page
 * space is the same at both, so it is found by the box `LANDMARKS.md` records for it.
 */
const PROMO_APPLY_Y = 862;

const promoApply = (screen: Capture) => screen.elements.filter((e) => e.bbox.y === PROMO_APPLY_Y);

/**
 * The committed example run, as a carrier: the two arrays a walk's captures project into are
 * swapped into it and the artifact is parsed whole, so a field this module spells wrongly is
 * a failure here rather than a run directory that cannot be read.
 */
const exampleRun = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL('../../../../runs/2026-10-24-1402-northwind-demo/run.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;

describeWithChromium('a live walk of the fixture task', () => {
  let site: FixtureSite;

  beforeAll(async () => {
    site = await serveFixtureSite();
  });

  afterAll(async () => {
    await site.close();
  });

  const variantAt = (device: Device, path = '/cart.html') => ({
    id: `v-${device.name}`,
    url: `${site.url}${path}`,
  });

  describe('the four steps, end to end', () => {
    let runDir: string;
    let walked: Awaited<ReturnType<typeof walkTask>>;
    let captures: Capture[];

    beforeAll(async () => {
      runDir = await mkdtemp(join(tmpdir(), 'personavision-walk-'));
      walked = await walkTask(createLiveSource(), {
        variant: variantAt(DESKTOP),
        device: DESKTOP,
        task: TASK,
        runDir,
      });
      captures = walked.screens.map((screen) => screen.capture);
    }, WALK_TIMEOUT_MS);

    afterAll(async () => {
      await rm(runDir, { recursive: true, force: true });
    });

    it('captures the four steps in the order the task declares them', () => {
      expect(captures.map((capture) => capture.step)).toEqual(
        EXPECTED.map((expected) => expected.step),
      );
    });

    it('writes a screenshot per step, under the path the capture records', () => {
      for (const { step } of EXPECTED) {
        const recorded = runPaths('').screenshot('v-desktop', step);
        const capture = captures.find((candidate) => candidate.step === step);

        expect(capture?.screenshot).toBe(recorded);
        expect(existsSync(runPaths(runDir).screenshot('v-desktop', step))).toBe(true);
      }
    });

    it('records the geometry of each page, with the desktop fold', () => {
      for (const { step, pageHeight } of EXPECTED) {
        const capture = captures.find((candidate) => candidate.step === step);

        expect(capture).toMatchObject({ viewport: DESKTOP.viewport, pageHeight, foldY: 900 });
      }
    });

    it('marks exactly one element per step as its primary action, in page space', () => {
      for (const { step, primary } of EXPECTED) {
        const capture = captures.find((candidate) => candidate.step === step);
        const marked = capture?.elements.filter((element) => element.isPrimaryAction) ?? [];

        expect(marked).toHaveLength(1);
        expect(marked[0]?.bbox).toEqual(primary);
      }
    });

    it('reports what the action on each screen did, and nothing done to the last', () => {
      const [cart, payment, review, confirmation] = walked.screens;

      expect(cart?.action).toMatchObject({ ok: true, step: 'payment' });
      expect(payment?.action).toMatchObject({ ok: true, step: 'review' });
      expect(review?.action).toMatchObject({ ok: true, step: 'confirmation' });
      expect(confirmation?.action).toBeNull();
    });

    it('completes on the confirmation step, with the integrity counters at zero', () => {
      expect(walked).toMatchObject({
        variant: 'v-desktop',
        step: 'confirmation',
        completed: true,
        failure: null,
        outcome: null,
      });
      expect(walked.integrity).toEqual({ selectorFailures: 0, retries: 0 });
    });

    it('projects into screenshot entries and areas of interest the contract parses', () => {
      const run = runSchema.parse({
        ...exampleRun(),
        screenshots: toScreenshotEntries(captures),
        aois: toAoiEntries(captures),
      });

      expect(run.screenshots.map((row) => row.step)).toEqual(
        EXPECTED.map((expected) => expected.step),
      );
      expect(run.aois.filter((row) => row.isPrimaryAction)).toHaveLength(EXPECTED.length);
      expect(run.aois.every((row) => row.variant === 'v-desktop')).toBe(true);
    });
  });

  it(
    'reports the control below the fold at the mobile device and not at the desktop one',
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'personavision-walk-fold-'));
      /** One screen each: a decision layer that stops on the cart is all this needs. */
      const stopOnTheCart = () => null;
      const cartAt = async (device: Device): Promise<Capture> => {
        const walked = await walkTask(createLiveSource(), {
          variant: variantAt(device),
          device,
          task: TASK,
          runDir,
          decide: stopOnTheCart,
        });
        expect(walked).toMatchObject({ step: 'cart', completed: false, failure: null });
        return walked.screens[0]?.capture as Capture;
      };

      try {
        const mobile = await cartAt(MOBILE);
        const desktop = await cartAt(DESKTOP);

        expect(promoApply(mobile).map((element) => element.name ?? element.text)).toContain(
          'Apply a promo code',
        );
        expect(promoApply(mobile).map((element) => element.belowFold)).not.toContain(false);
        expect(promoApply(desktop).map((element) => element.belowFold)).not.toContain(true);
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'ends as an automation failure when a step requires an element the page lacks',
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'personavision-walk-missing-'));
      /** The payment step of the same task, requiring an element payment.html has not. */
      const task: TaskDefinition = {
        ...TASK,
        steps: TASK.steps.map((step) =>
          step.id === 'payment'
            ? { ...step, match: { ...step.match, requiredSelector: '#nope' } }
            : step,
        ),
      };

      try {
        const walked = await walkTask(createLiveSource(), {
          variant: variantAt(DESKTOP),
          device: DESKTOP,
          task,
          runDir,
          // One attempt: the page is missing the element, and it will be missing it again.
          budget: new SessionBudget({ maxRetries: 0 }),
        });

        expect(walked.failure?.reason).toBe('selector_not_found');
        expect(walked.outcome).toMatchObject({
          status: 'automation_failure',
          step: 'payment',
          attribution: 'automation',
          excludedFromScores: true,
        });
        expect(walked.outcome?.reason).toContain('#nope');
        expect(walked).toMatchObject({ step: 'cart', completed: false });
        // The cart screen it did walk is kept, and the selector failure is counted.
        expect(walked.screens).toHaveLength(1);
        expect(walked.integrity).toEqual({ selectorFailures: 1, retries: 0 });
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'ends as an automation failure, never a product outcome, when the variant cannot be reached',
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'personavision-walk-unreachable-'));

      try {
        const walked = await walkTask(createLiveSource(), {
          // Port 1: nothing listens there, so the navigation is refused rather than slow.
          variant: { id: 'v-unreachable', url: 'http://127.0.0.1:1/cart.html' },
          device: DESKTOP,
          task: TASK,
          runDir,
          budget: new SessionBudget({ maxRetries: 0 }),
        });

        expect(walked.failure?.reason).toBe('navigation_error');
        expect(walked.outcome).toMatchObject({
          status: 'automation_failure',
          step: UNKNOWN_STEP,
          attribution: 'automation',
          excludedFromScores: true,
        });
        expect(walked).toMatchObject({ step: null, completed: false, screens: [] });
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    },
    WALK_TIMEOUT_MS,
  );
});
