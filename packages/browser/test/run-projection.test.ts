/**
 * Captures projected into `run.json`'s two arrays.
 *
 * The captures here are inline: this is a pure mapping, and a browser would only make the
 * test slower and the inputs harder to see. What is not inlined is the schema — the entries
 * are placed into the committed example run and the whole artifact is parsed by
 * `@personavision/contract`, so a field this module spells wrongly, omits or invents is a
 * failure here rather than a run directory that cannot be read.
 */

import { readFileSync } from 'node:fs';
import { runSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { toAoiEntries, toScreenshotEntries } from '../src/index.js';
import type { Capture, CaptureElement } from '../src/index.js';

const element = (overrides: Partial<CaptureElement> = {}): CaptureElement => ({
  id: 'e-0123456789ab',
  source: 'dom',
  role: 'link',
  name: 'Checkout',
  text: 'Checkout',
  bbox: { x: 16, y: 1200, width: 358, height: 48 },
  isPrimaryAction: true,
  belowFold: true,
  selector: '#cart-checkout',
  ...overrides,
});

const capture = (overrides: Partial<Capture> = {}): Capture => ({
  variant: 'A',
  step: 'cart',
  screenshot: 'screenshots/A/cart.png',
  viewport: { width: 390, height: 844 },
  pageHeight: 1400,
  foldY: 844,
  elements: [element()],
  contentHash: '0123456789abcdef',
  ...overrides,
});

/**
 * The committed example run, used as a carrier: the two arrays under test are swapped into
 * it and the artifact is parsed whole. Everything else in it is another step's, and nothing
 * here asserts anything about it.
 */
const exampleRun = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL('../../../runs/2026-10-24-1402-northwind-demo/run.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;

/** The artifact as it would be written from these captures, parsed by the contract. */
const parsedRunFrom = (captures: readonly Capture[]) =>
  runSchema.parse({
    ...exampleRun(),
    screenshots: toScreenshotEntries(captures),
    aois: toAoiEntries(captures),
  });

describe('toScreenshotEntries', () => {
  it('records one row per captured screen, with the geometry of the capture it came from', () => {
    const mobile = capture();
    const desktop = capture({
      variant: 'B',
      step: 'payment',
      screenshot: 'screenshots/B/payment.png',
      viewport: { width: 1440, height: 900 },
      pageHeight: 1200,
      foldY: 900,
    });

    expect(toScreenshotEntries([mobile, desktop])).toEqual([
      {
        variant: 'A',
        step: 'cart',
        path: 'screenshots/A/cart.png',
        viewport: { width: 390, height: 844 },
        pageHeight: 1400,
        foldY: 844,
      },
      {
        variant: 'B',
        step: 'payment',
        path: 'screenshots/B/payment.png',
        viewport: { width: 1440, height: 900 },
        pageHeight: 1200,
        foldY: 900,
      },
    ]);
  });

  it('parses as a run.json, with the path the capture carries', () => {
    const captures = [capture()];
    const run = parsedRunFrom(captures);

    expect(run.screenshots).toEqual(toScreenshotEntries(captures));
    expect(run.screenshots[0]?.path).toBe('screenshots/A/cart.png');
  });

  it('records no row for a screen whose image was never written', () => {
    expect(toScreenshotEntries([capture({ screenshot: null })])).toEqual([]);
  });

  it('records one row for a screen a dozen sessions all captured', () => {
    const sessions = Array.from({ length: 12 }, () => capture());

    expect(toScreenshotEntries([...sessions, capture({ variant: 'B' })])).toEqual([
      expect.objectContaining({ variant: 'A', step: 'cart' }),
      expect.objectContaining({ variant: 'B', step: 'cart' }),
    ]);
  });
});

describe('toAoiEntries', () => {
  it('carries the element id, the box and both flags through unchanged', () => {
    const control = element();
    const banner = element({
      id: 'e-ba1111111111',
      source: 'a11y',
      role: 'region',
      name: 'Free delivery',
      text: null,
      bbox: { x: 16, y: 16, width: 358, height: 48 },
      isPrimaryAction: false,
      belowFold: false,
    });

    expect(toAoiEntries([capture({ elements: [control, banner] })])).toEqual([
      {
        id: 'e-0123456789ab',
        variant: 'A',
        step: 'cart',
        label: 'Checkout',
        source: 'dom',
        role: 'link',
        bbox: { x: 16, y: 1200, width: 358, height: 48 },
        isPrimaryAction: true,
        belowFold: true,
      },
      {
        id: 'e-ba1111111111',
        variant: 'A',
        step: 'cart',
        label: 'Free delivery',
        source: 'a11y',
        role: 'region',
        bbox: { x: 16, y: 16, width: 358, height: 48 },
        isPrimaryAction: false,
        belowFold: false,
      },
    ]);
  });

  it('parses as a run.json, with both sources carried through', () => {
    const captures = [
      capture({
        elements: [element(), element({ id: 'e-ba1111111111', source: 'a11y' })],
      }),
    ];
    const run = parsedRunFrom(captures);

    expect(run.aois).toEqual(toAoiEntries(captures));
    expect(run.aois.map((aoi) => aoi.source)).toEqual(['dom', 'a11y']);
  });

  it('names an element by its accessible name, its text, its role, then its id', () => {
    const labels = toAoiEntries([
      capture({
        elements: [
          element({ id: 'e-named', name: 'Save for later', text: 'Save' }),
          element({ id: 'e-texted', name: null, text: 'Apply a promo code' }),
          element({ id: 'e-blank', name: '  ', text: '', role: 'generic' }),
          element({ id: 'e-roleless', name: null, text: null, role: null }),
        ],
      }),
    ]).map((aoi) => aoi.label);

    expect(labels).toEqual(['Save for later', 'Apply a promo code', 'generic', 'e-roleless']);
  });

  it('records an area for a screen that was measured but never pictured', () => {
    expect(toAoiEntries([capture({ screenshot: null })])).toHaveLength(1);
  });

  it('records one area however many sessions saw it, and keeps the two screens apart', () => {
    const onCart = capture();
    const onPayment = capture({
      step: 'payment',
      screenshot: 'screenshots/A/payment.png',
      // An element id is minted from the element and not from the screen, so the same
      // control at the same box on the next step arrives with the same id.
      elements: [element()],
    });

    expect(toAoiEntries([onCart, capture(), onPayment]).map((aoi) => [aoi.step, aoi.id])).toEqual([
      ['cart', 'e-0123456789ab'],
      ['payment', 'e-0123456789ab'],
    ]);
  });
});

describe('a capture whose step is still unknown', () => {
  const unknown = capture({ step: null, screenshot: null });

  it('contributes to neither list', () => {
    expect(toScreenshotEntries([unknown])).toEqual([]);
    expect(toAoiEntries([unknown])).toEqual([]);
    expect(toAoiEntries([unknown, capture()])).toHaveLength(1);
  });

  it('leaves a run.json that still parses', () => {
    const run = parsedRunFrom([unknown]);

    expect(run.screenshots).toEqual([]);
    expect(run.aois).toEqual([]);
  });
});
