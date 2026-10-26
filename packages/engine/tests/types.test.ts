import { describe, expect, it } from 'vitest';
import type { Capture } from '../src/types.js';

/**
 * A capture shaped exactly as `packages/browser` publishes it (#6), assigned to the
 * engine's own published input type.
 *
 * The assignment is the test: it is checked by `tsc -p tsconfig.tests.json`, so a field
 * renamed on either side of the structural seam fails the build here rather than in the
 * run loop. The engine imports nothing from `packages/browser` — the auto-decision on #7.
 */
const captureFromTheBrowserStep = {
  step: 'cart',
  screenshot: 'screenshots/a/cart.png',
  viewport: { width: 1280, height: 800 },
  pageHeight: 2400,
  foldY: 800,
  elements: [
    {
      id: 'button-checkout-1',
      source: 'dom',
      role: 'button',
      name: 'Checkout',
      text: 'Checkout',
      bbox: { x: 980, y: 420, width: 160, height: 44 },
      isPrimaryAction: true,
      belowFold: false,
      selector: '[data-test="checkout"]',
    },
    {
      id: 'text-total-1',
      source: 'a11y',
      role: null,
      name: 'Total $48.00',
      text: '$48.00',
      bbox: { x: 980, y: 360, width: 160, height: 24 },
      isPrimaryAction: false,
      belowFold: false,
      selector: '[data-test="total"]',
    },
    {
      id: 'sam-hero-1',
      source: 'sam',
      role: null,
      name: '',
      text: '',
      bbox: { x: 0, y: 1200, width: 1280, height: 400 },
      isPrimaryAction: false,
      belowFold: true,
      selector: '',
    },
  ],
} as const satisfies Capture;

describe("the engine's published input", () => {
  it("accepts a capture shaped as the browser step's Capture", () => {
    const capture: Capture = captureFromTheBrowserStep;

    expect(capture.elements.filter((element) => element.isPrimaryAction)).toHaveLength(1);
    expect(capture.elements.map((element) => element.source)).toEqual(['dom', 'a11y', 'sam']);
    expect(capture.foldY).toBeLessThan(capture.pageHeight);
  });
});
