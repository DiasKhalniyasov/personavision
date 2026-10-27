/**
 * The proof that the demo shop can be driven: the task of `demo.config.ts`, walked from the
 * cart to the confirmation page on both variants, at both viewports.
 *
 * This is the hand-off between the shop and the browser step, demonstrated rather than
 * assumed — stories 7 and 8 of #10. Four drives run in `beforeAll`, one per variant and
 * device, and the tests below read what they left behind. What is asserted is what a session
 * would record: the step each screen was labelled with, the one element per screen that
 * carries `isPrimaryAction`, where the completing action sits against the fold, and the order
 * number on the page the task ends on.
 *
 * Three facts about the drive are the point of it:
 *
 * - **The step label is the task's declaration, never the page's words.** `shared/help.html`
 *   carries the shop's `Cart (1)` badge and `shared/card-frame.html` says "Card number";
 *   both are off the task and both come back with no label at all.
 * - **Variant B is completable.** Its completing action is below the fold at both viewports,
 *   which is planted defect 1; an agent that scrolls to it buys the boots all the same.
 * - **Nothing here needs a port, a key or a network.** `serveDemoShop()` takes a free port on
 *   loopback, and the variants are derived from the base URL it reports.
 *
 * The fold numbers asserted here are the ones `demo/README.md`'s fold arithmetic quotes.
 */

/// <reference lib="dom" />
// The callback that reads a control's box runs inside the page, not in Node: this file needs
// the DOM types, and the reference travels with the file (see `packages/browser/src/act.ts`).
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, capture, closeSession, detectStep, openSession } from '@personavision/browser';
import type {
  Box,
  Capture,
  CaptureContext,
  CaptureElement,
  Device,
  PageHandle,
} from '@personavision/browser';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NORTHWIND_DEVICE_MIX, NORTHWIND_TASK, northwindVariants } from '../demo.config.ts';
import { serveDemoShop } from '../serve.ts';
import type { DemoShop } from '../serve.ts';

/** As the browser package's own suites do: a developer without Chromium is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** Four drives and a browser launch each: well past Vitest's default. */
const BROWSER_TIMEOUT_MS = 60_000;
const DRIVE_TIMEOUT_MS = 240_000;

/** The two devices of the mix, taken from the personas that are on them. */
const MOBILE = NORTHWIND_DEVICE_MIX.rushed;
const DESKTOP = NORTHWIND_DEVICE_MIX.careful;

/** The step nothing advances from: the task's last. */
const TERMINAL_STEP = NORTHWIND_TASK.steps.at(-1);
if (TERMINAL_STEP === undefined) throw new Error('the demo task declares no steps');

/** One screen of a drive: what the session saw, and whether it had to scroll to go on. */
interface Screen {
  readonly capture: Capture;
  readonly primaryAction: CaptureElement;
  /** Where the control the step declares actually is, read off the page itself. */
  readonly declaredBox: Box;
  readonly scrolled: boolean;
}

/** One drive: the screens in order, where it ended, and what the last page said. */
interface Drive {
  readonly screens: Screen[];
  readonly finalUrl: string;
  readonly orderNumber: string;
}

/**
 * The page-space box of the control a step declares, read out of the page. The capture's own
 * reading is what is being checked, so this is taken independently of it.
 */
const declaredBoxOf = (handle: PageHandle, selector: string): Promise<Box> =>
  handle.page.evaluate((chosen) => {
    const node = document.querySelector(chosen);
    if (node === null) throw new Error(`the shop has no ${chosen}`);
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }, selector);

const theOnlyPrimaryAction = (screen: Capture): CaptureElement => {
  const marked = screen.elements.filter((element) => element.isPrimaryAction);
  if (marked.length !== 1) {
    throw new Error(
      `the ${String(screen.step)} step of variant ${screen.variant} marks ${marked.length} primary actions, not one`,
    );
  }
  return marked[0];
};

describeWithChromium('driving the northwind task', () => {
  let shop: DemoShop;
  let runDir: string;
  const drives = new Map<string, Drive>();

  const driveKey = (variant: string, device: Device): string => `${variant}@${device.name}`;

  /**
   * One variant under one device, from its start URL to wherever the task runs out.
   *
   * The loop is the task's own: capture the screen, then act on the control the step
   * declares — scrolling to it first when the capture reports it below the fold, which is
   * what an agent that cannot see it would have to do.
   */
  const drive = async (variantId: string, device: Device): Promise<Drive> => {
    const variant = northwindVariants(shop.url).find((candidate) => candidate.id === variantId);
    if (variant === undefined) throw new Error(`no variant ${variantId} in the demo config`);

    const handle: PageHandle = await openSession(variant, device);
    const ctx: CaptureContext = { variant: variant.id, device, task: NORTHWIND_TASK, runDir };
    const screens: Screen[] = [];

    try {
      for (const step of NORTHWIND_TASK.steps) {
        const screen = await capture(handle, ctx);
        const primaryAction = theOnlyPrimaryAction(screen);
        const target = { selector: step.primaryAction.selector };
        const declaredBox = await declaredBoxOf(handle, target.selector);

        // The confirmation step is terminal: nothing advances from it.
        if (step.id === TERMINAL_STEP.id) {
          screens.push({ capture: screen, primaryAction, declaredBox, scrolled: false });
          break;
        }

        // A drive runs in `beforeAll`, so each check names where it was: a hook error that
        // says only `false` would not say which variant on which device stopped advancing.
        const where = `the ${step.id} step of variant ${variant.id} on ${device.name}`;

        const scrolled = primaryAction.belowFold;
        if (scrolled) {
          const scroll = await act(handle, { type: 'scroll', ...target }, ctx);
          expect(scroll.ok, where).toBe(true);
          expect(scroll.scrollY, `${where} scrolled to its primary action`).toBeGreaterThan(0);
        }

        const click = await act(handle, { type: 'click', ...target }, ctx);
        expect(click.failure, where).toBeUndefined();
        expect(click.ok, where).toBe(true);
        screens.push({ capture: screen, primaryAction, declaredBox, scrolled });
      }

      const orderNumber = await handle.page
        .locator(TERMINAL_STEP.primaryAction.selector)
        .innerText();
      return { screens, finalUrl: handle.page.url(), orderNumber };
    } finally {
      await closeSession(handle);
    }
  };

  beforeAll(async () => {
    shop = await serveDemoShop();
    runDir = await mkdtemp(join(tmpdir(), 'northwind-drive-'));

    for (const variantId of ['a', 'b']) {
      for (const device of [MOBILE, DESKTOP]) {
        drives.set(driveKey(variantId, device), await drive(variantId, device));
      }
    }
  }, DRIVE_TIMEOUT_MS);

  afterAll(async () => {
    await shop.close();
    await rm(runDir, { recursive: true, force: true });
  });

  const driven = (variant: string, device: Device): Drive => {
    const result = drives.get(driveKey(variant, device));
    if (result === undefined)
      throw new Error(`variant ${variant} was not driven on ${device.name}`);
    return result;
  };

  /** The completing action's screen: the review step, whichever drive it came from. */
  const reviewScreen = (variant: string, device: Device): Screen => {
    const screen = driven(variant, device).screens.find(
      (candidate) => candidate.capture.step === 'review',
    );
    if (screen === undefined)
      throw new Error(`the ${variant} drive on ${device.name} never reviewed`);
    return screen;
  };

  it('serves the shop on loopback, so a drive reaches no network beyond this machine', () => {
    expect(shop.url).toBe(`http://127.0.0.1:${shop.port}`);
    expect(northwindVariants(shop.url).map((variant) => variant.url)).toEqual([
      `http://127.0.0.1:${shop.port}/a/cart.html`,
      `http://127.0.0.1:${shop.port}/b/cart.html`,
    ]);
  });

  it('states the task sentence, the four steps and the device mix', () => {
    expect(NORTHWIND_TASK.prompt).toBe('Buy the hiking boots and pay with the saved card.');
    expect(NORTHWIND_TASK.steps.map((step) => step.id)).toEqual([
      'cart',
      'payment',
      'review',
      'confirm',
    ]);
    // The prototype's four personas, two to a device: the mix is checked by who shares a
    // device with whom and by the two geometries, not by four copies of the same literal.
    expect(Object.keys(NORTHWIND_DEVICE_MIX)).toEqual(['rushed', 'careful', 'firsttime', 'price']);
    expect(NORTHWIND_DEVICE_MIX.price).toEqual(MOBILE);
    expect(NORTHWIND_DEVICE_MIX.firsttime).toEqual(DESKTOP);
    expect(MOBILE).toEqual({
      name: 'iPhone 15',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
    });
    expect(DESKTOP).toEqual({
      name: 'MacBook Air 13',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      touch: false,
    });
  });

  for (const variant of ['a', 'b']) {
    for (const device of [MOBILE, DESKTOP]) {
      it(`drives variant ${variant} to the confirmation page on ${device.name}`, () => {
        const result = driven(variant, device);

        expect(result.screens.map((screen) => screen.capture.step)).toEqual([
          'cart',
          'payment',
          'review',
          'confirm',
        ]);
        expect(new URL(result.finalUrl).pathname).toBe(`/${variant}/confirmation.html`);
        expect(result.orderNumber).toContain('NW-20418');
      });

      it(`resolves one primary action per step of variant ${variant} on ${device.name}`, () => {
        for (const screen of driven(variant, device).screens) {
          const where = `the ${String(screen.capture.step)} step of variant ${variant}`;

          // `capture` would have raised `selector_not_found` rather than report a screen, so
          // reaching here is the declared selector resolving on every page of the drive.
          expect(
            screen.capture.elements.filter((element) => element.isPrimaryAction),
            `${where} marks one primary action`,
          ).toHaveLength(1);

          // And the element marked is the control the step declares, not merely some element:
          // its box is the one the page itself reports for the declared selector, to within
          // the pixel of tolerance resolution itself allows for an extractor's rounding.
          for (const edge of ['x', 'y', 'width', 'height'] as const) {
            expect(
              Math.abs(screen.primaryAction.bbox[edge] - screen.declaredBox[edge]),
              `${where}: the marked element's ${edge}`,
            ).toBeLessThanOrEqual(1);
          }
        }
      });
    }
  }

  it('reports variant A’s completing action above the fold at both viewports', () => {
    for (const device of [MOBILE, DESKTOP]) {
      const screen = reviewScreen('a', device);
      expect(screen.primaryAction.belowFold).toBe(false);
      expect(screen.primaryAction.bbox.y).toBeLessThan(screen.capture.foldY);
      expect(screen.scrolled).toBe(false);
    }
  });

  it('reports variant B’s completing action below the fold at both viewports', () => {
    const mobile = reviewScreen('b', MOBILE);
    const desktop = reviewScreen('b', DESKTOP);

    for (const screen of [mobile, desktop]) {
      expect(screen.primaryAction.belowFold).toBe(true);
      // The agent had to scroll to it, and still completed the task: defect 1 costs
      // attention without breaking the flow.
      expect(screen.scrolled).toBe(true);
    }

    // `demo/README.md`'s fold arithmetic, measured: a top edge at 1748 px against the two
    // folds, so 904 px below the mobile fold and 848 px below the desktop one. The spacer
    // grew from 676 px in #78: at 676 the control was one 0.75-viewport scroll away, which
    // the swarm found and clicked, and a control the swarm finds is not planted defect 1.
    expect(Math.round(mobile.primaryAction.bbox.y)).toBe(1748);
    expect(Math.round(mobile.primaryAction.bbox.y - mobile.capture.foldY)).toBe(904);
    expect(Math.round(desktop.primaryAction.bbox.y - desktop.capture.foldY)).toBe(848);
    // Past one scroll of the decision loop's own 0.75 of a viewport, at both viewports:
    // this is what makes it a control nobody sees rather than one nobody sees at first.
    for (const screen of [mobile, desktop]) {
      const oneScroll = Math.round(screen.capture.viewport.height * 0.75);
      expect(screen.primaryAction.bbox.y).toBeGreaterThan(
        oneScroll + screen.capture.viewport.height,
      );
    }
  });

  it(
    'labels a page reached outside the task with no step, whatever its words say',
    async () => {
      for (const path of ['/shared/help.html', '/shared/card-frame.html']) {
        const handle = await openSession({ id: 'off-task', url: `${shop.url}${path}` }, MOBILE);
        try {
          expect(await detectStep(handle, NORTHWIND_TASK)).toBeNull();
          // The page does say the words a guess would have been made from.
          expect(await handle.page.locator('body').innerText()).toMatch(/Cart \(1\)|Card number/);
        } finally {
          await closeSession(handle);
        }
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
