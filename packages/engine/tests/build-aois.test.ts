import { readFileSync, readdirSync } from 'node:fs';
import { runSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { aoiId, buildAois, noSegmenter } from '../src/aois/index.js';
import type { SegmentedArea, Segmenter, SegmenterInput } from '../src/aois/index.js';
import type { Capture, CaptureElement } from '../src/types.js';

/**
 * Inline captures and a test double for the `Segmenter`, as #64 asks: the seam is the
 * point of the ticket, and a double proves it is honoured without waiting for either real
 * segmenter (#66, #69). The fixture captures (#61) are for the behavioural suite (#70).
 */

const VARIANT = 'A';
const STEP = 'cart';
const FOLD_Y = 900;

const element = (overrides: Partial<CaptureElement> = {}): CaptureElement => ({
  id: 'dom-1',
  source: 'dom',
  role: 'button',
  name: 'Checkout',
  text: 'Checkout',
  bbox: { x: 1080, y: 620, width: 220, height: 48 },
  isPrimaryAction: false,
  belowFold: false,
  selector: 'button.checkout',
  ...overrides,
});

const capture = (
  elements: readonly CaptureElement[],
  overrides: Partial<Capture> = {},
): Capture => ({
  step: STEP,
  screenshot: `screenshots/${VARIANT}/${STEP}.png`,
  viewport: { width: 1440, height: 900 },
  pageHeight: 2400,
  foldY: FOLD_Y,
  elements,
  ...overrides,
});

/** The same control as the browser step reports it: once from the DOM, once from the a11y tree. */
const CHECKOUT_FROM_DOM = element({
  id: 'dom-checkout',
  source: 'dom',
  role: 'button',
  // The DOM entry often has no accessible name — the label has to come from the a11y one.
  name: '',
  text: 'Checkout now',
  isPrimaryAction: true,
});

const CHECKOUT_FROM_A11Y = element({
  id: 'a11y-checkout',
  source: 'a11y',
  role: 'button',
  name: 'Checkout and pay',
  text: 'Checkout now',
  isPrimaryAction: true,
});

const PROMO = element({
  id: 'dom-promo',
  source: 'dom',
  role: null,
  name: '',
  text: 'Free shipping over £50',
  bbox: { x: 120, y: 240, width: 600, height: 64 },
  selector: '.promo',
});

const BELOW_FOLD_LINK = element({
  id: 'dom-terms',
  source: 'dom',
  role: 'link',
  name: 'Terms and conditions',
  text: 'Terms and conditions',
  bbox: { x: 120, y: 1800, width: 180, height: 24 },
  belowFold: true,
  selector: 'a.terms',
});

const segmenterReturning = (areas: readonly SegmentedArea[]): Segmenter => ({
  segment: () => areas,
});

const CARD_GRID: SegmentedArea = {
  id: 'a-cart-region-product-card-grid-120-400-900x300',
  label: 'Product card grid',
  role: null,
  bbox: { x: 120, y: 400, width: 900, height: 300 },
};

describe('buildAois', () => {
  it('merges the DOM and accessibility reports of one control into one area', async () => {
    const aois = await buildAois({
      capture: capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y]),
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(aois).toHaveLength(1);
    expect(aois[0].label).toBe('Checkout and pay');
    expect(aois[0].source).toBe('dom');
    expect(aois[0].role).toBe('button');
  });

  it('falls back to visible text, then to the role, so a label is never blank', async () => {
    const aois = await buildAois({
      capture: capture([PROMO, element({ id: 'dom-bare', name: '', text: '', role: 'button' })]),
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(aois.map((aoi) => aoi.label)).toEqual(['Free shipping over £50', 'button']);
  });

  it('builds identical ids and identical order from the same capture twice', async () => {
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO, BELOW_FOLD_LINK]);
    const input = { capture: screen, variant: VARIANT, segmenter: noSegmenter };

    expect(await buildAois(input)).toEqual(await buildAois(input));
  });

  it('is unmoved by the order the capture listed its elements in', async () => {
    const elements = [CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO, BELOW_FOLD_LINK];
    const asListed = await buildAois({
      capture: capture(elements),
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID]),
    });
    const reversed = await buildAois({
      capture: capture([...elements].reverse()),
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID]),
    });

    expect(reversed).toEqual(asListed);
    expect(reversed.map((aoi) => aoi.id)).toEqual(asListed.map((aoi) => aoi.id));
  });

  it('distinguishes two controls with the same role and name at different positions', async () => {
    const first = element({ id: 'dom-add-1', name: 'Add to basket' });
    const second = element({
      id: 'dom-add-2',
      name: 'Add to basket',
      bbox: { x: 1080, y: 760, width: 220, height: 48 },
    });

    const aois = await buildAois({
      capture: capture([first, second]),
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(aois).toHaveLength(2);
    expect(new Set(aois.map((aoi) => aoi.id)).size).toBe(2);
  });

  it('keeps the areas of two variants apart, so one run can hold both', async () => {
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y]);
    const [a] = await buildAois({ capture: screen, variant: 'A', segmenter: noSegmenter });
    const [b] = await buildAois({ capture: screen, variant: 'B', segmenter: noSegmenter });

    expect(a.id).not.toBe(b.id);
    expect([a.variant, b.variant]).toEqual(['A', 'B']);
    expect([a.step, b.step]).toEqual([STEP, STEP]);
  });

  it('reads belowFold off the fold line, on both sides of it and at it', async () => {
    const atTheFold = element({
      id: 'dom-at-fold',
      name: 'At the fold',
      bbox: { x: 120, y: FOLD_Y, width: 200, height: 40 },
      belowFold: false,
    });
    const straddling = element({
      id: 'dom-straddling',
      name: 'Straddling the fold',
      bbox: { x: 120, y: FOLD_Y - 20, width: 200, height: 80 },
      belowFold: true,
    });

    const aois = await buildAois({
      capture: capture([PROMO, atTheFold, straddling, BELOW_FOLD_LINK]),
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(aois.map((aoi) => [aoi.label, aoi.belowFold])).toEqual([
      ['Free shipping over £50', false],
      ['Straddling the fold', false],
      ['At the fold', true],
      ['Terms and conditions', true],
    ]);
  });

  it('carries the declared primary action through as the one area that has it', async () => {
    const aois = await buildAois({
      capture: capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO, BELOW_FOLD_LINK]),
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID]),
    });

    expect(aois.filter((aoi) => aoi.isPrimaryAction).map((aoi) => aoi.label)).toEqual([
      'Checkout and pay',
    ]);
  });

  it('carries the geometry through unchanged, in page space', async () => {
    const [aoi] = await buildAois({
      capture: capture([BELOW_FOLD_LINK]),
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(aoi.bbox).toEqual(BELOW_FOLD_LINK.bbox);
  });

  it('returns areas the contract accepts, with no field invented outside it', async () => {
    const aois = await buildAois({
      capture: capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO, BELOW_FOLD_LINK]),
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID]),
    });

    expect(runSchema.shape.aois.parse(aois)).toEqual(aois);
    for (const aoi of aois) {
      expect(Object.keys(aoi).sort()).toEqual([
        'bbox',
        'belowFold',
        'id',
        'isPrimaryAction',
        'label',
        'role',
        'source',
        'step',
        'variant',
      ]);
      expect(['dom', 'a11y', 'sam']).toContain(aoi.source);
    }
  });
});

describe('the Segmenter seam', () => {
  it('is given the screenshot and the areas the elements already explain', async () => {
    const seen: SegmenterInput[] = [];
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO]);

    await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: {
        segment: (input) => {
          seen.push(input);
          return [];
        },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].capture.screenshot).toBe(screen.screenshot);
    expect(seen[0].explained.map((aoi) => aoi.label)).toEqual([
      'Free shipping over £50',
      'Checkout and pay',
    ]);
  });

  it('tags what it returns as segmented and sorts it in among the element-derived areas', async () => {
    const aois = await buildAois({
      capture: capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO, BELOW_FOLD_LINK]),
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID]),
    });

    expect(aois.map((aoi) => [aoi.label, aoi.source])).toEqual([
      ['Free shipping over £50', 'dom'],
      ['Product card grid', 'sam'],
      ['Checkout and pay', 'dom'],
      ['Terms and conditions', 'dom'],
    ]);
    expect(aois.find((aoi) => aoi.source === 'sam')?.isPrimaryAction).toBe(false);
  });

  it('takes an asynchronous segmenter, since both planned ones are', async () => {
    const aois = await buildAois({
      capture: capture([PROMO]),
      variant: VARIANT,
      segmenter: { segment: () => Promise.resolve([CARD_GRID]) },
    });

    expect(aois.map((aoi) => aoi.source)).toEqual(['dom', 'sam']);
  });

  it('orders segmented areas deterministically whatever order they arrive in', async () => {
    const second: SegmentedArea = {
      id: 'a-cart-region-hero-banner-0-80-1440x200',
      label: 'Hero banner',
      role: null,
      bbox: { x: 0, y: 80, width: 1440, height: 200 },
    };
    const screen = capture([PROMO]);

    const asGiven = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: segmenterReturning([CARD_GRID, second]),
    });
    const reversed = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: segmenterReturning([second, CARD_GRID]),
    });

    expect(asGiven.map((aoi) => aoi.label)).toEqual([
      'Hero banner',
      'Free shipping over £50',
      'Product card grid',
    ]);
    expect(reversed).toEqual(asGiven);
  });

  it('leaves the element-derived areas alone when the segmenter returns nothing', async () => {
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO]);
    const withoutOne = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    expect(
      await buildAois({ capture: screen, variant: VARIANT, segmenter: segmenterReturning([]) }),
    ).toEqual(withoutOne);
  });

  it('leaves them alone when the segmenter throws, and when it rejects', async () => {
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO]);
    const withoutOne = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: noSegmenter,
    });

    const throwing: Segmenter = {
      segment: () => {
        throw new Error('no credential for the Meta Model API');
      },
    };
    const rejecting: Segmenter = { segment: () => Promise.reject(new Error('timed out')) };

    expect(await buildAois({ capture: screen, variant: VARIANT, segmenter: throwing })).toEqual(
      withoutOne,
    );
    expect(await buildAois({ capture: screen, variant: VARIANT, segmenter: rejecting })).toEqual(
      withoutOne,
    );
  });

  it('builds the element-derived areas with no segmenter named at all', async () => {
    const screen = capture([CHECKOUT_FROM_DOM, CHECKOUT_FROM_A11Y, PROMO]);

    expect(await buildAois({ capture: screen, variant: VARIANT })).toEqual(
      await buildAois({ capture: screen, variant: VARIANT, segmenter: noSegmenter }),
    );
  });

  it('drops a region with no extent, no box, a blank label or a duplicate id', async () => {
    const screen = capture([PROMO]);
    const fromElements = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: noSegmenter,
    });
    // A segmenter is third-party code — one of them a reply from a service (#69) — so the
    // shapes below are the ones a run artifact must never be built out of, including the
    // ones that would throw on the way: no box at all, and nothing at all.
    const malformed = [
      { ...CARD_GRID, bbox: { ...CARD_GRID.bbox, height: 0 } },
      { ...CARD_GRID, id: 'a-cart-region-blank-0-0-10x10', label: '   ' },
      { ...CARD_GRID, id: fromElements[0].id, label: 'Stealing an element id' },
      { ...CARD_GRID, bbox: { ...CARD_GRID.bbox, x: Number.NaN } },
      { id: 'a-cart-region-boxless-0-0-10x10', label: 'No box at all', role: null },
      {
        ...CARD_GRID,
        id: 'a-cart-region-infinite-0-0-10x10',
        bbox: { ...CARD_GRID.bbox, width: Number.POSITIVE_INFINITY },
      },
      null,
      undefined,
      'not an area at all',
      CARD_GRID,
      { ...CARD_GRID, label: 'The same region twice' },
    ] as unknown as readonly SegmentedArea[];

    const aois = await buildAois({
      capture: screen,
      variant: VARIANT,
      segmenter: segmenterReturning(malformed),
    });

    expect(aois.map((aoi) => aoi.label)).toEqual(['Free shipping over £50', 'Product card grid']);
  });

  it('takes a region as given but never a field the contract would reject', async () => {
    const sloppy = {
      ...CARD_GRID,
      role: 42,
      bbox: { ...CARD_GRID.bbox, inventedByTheSegmenter: true },
    } as unknown as SegmentedArea;

    const aois = await buildAois({
      capture: capture([PROMO]),
      variant: VARIANT,
      segmenter: segmenterReturning([sloppy]),
    });
    const segmented = aois.find((aoi) => aoi.source === 'sam');

    expect(segmented?.role).toBeNull();
    expect(Object.keys(segmented?.bbox ?? {}).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(runSchema.shape.aois.parse(aois)).toEqual(aois);
  });

  it('survives a segmenter that returns something that is not a list', async () => {
    const screen = capture([PROMO]);
    const sloppy = { segment: () => undefined } as unknown as Segmenter;

    expect(await buildAois({ capture: screen, variant: VARIANT, segmenter: sloppy })).toEqual(
      await buildAois({ capture: screen, variant: VARIANT, segmenter: noSegmenter }),
    );
  });
});

describe('aoiId', () => {
  it('reads like the ids the artifact already carries', () => {
    expect(
      aoiId({
        variant: 'A',
        step: 'cart',
        role: 'button',
        label: 'Checkout and pay',
        bbox: { x: 1080, y: 620, width: 220, height: 48 },
      }),
    ).toBe('a-cart-button-checkout-and-pay-1080-620-220x48');
  });

  it('writes a negative origin without a stray dash', () => {
    expect(
      aoiId({
        variant: 'A',
        step: 'cart',
        role: null,
        label: 'Off-canvas drawer',
        bbox: { x: -12, y: 40, width: 200, height: 100 },
      }),
    ).toBe('a-cart-region-off-canvas-drawer-n12-40-200x100');
  });
});

/**
 * #7 makes purity a hard requirement: a capture in, areas out. The screenshot leaves here
 * as the path the capture carried, and only an injected segmenter may go and look at it.
 *
 * `config.test.ts` holds the package-wide scan and explains why purity is asserted over
 * the sources rather than by spying at run time; this is #64's own criterion, kept where a
 * reader of this ticket looks for it.
 */
it('is pure: nothing under src/aois reaches for a file, a socket or an unseeded draw', () => {
  const aoisDir = new URL('../src/aois/', import.meta.url);
  const sources = readdirSync(aoisDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ entry, text: readFileSync(new URL(entry, aoisDir), 'utf8') }));

  expect(sources.map(({ entry }) => entry).sort()).toEqual([
    'aoi-id.ts',
    'build-aois.ts',
    // #66's offline segmenter lives here too, and `sharp` opens the screenshot for it.
    // That is the seam's own exception and not a hole in this scan: the forbidden names
    // below are what *this package* may not ask for, and the heuristic asks for none.
    'heuristic-segmenter.ts',
    'index.ts',
    'segmenter.ts',
  ]);
  for (const forbidden of [
    'node:fs',
    'node:net',
    'node:http',
    'node:dns',
    'fetch(',
    'XMLHttpRequest',
    'Math.random',
  ]) {
    for (const { entry, text } of sources) expect(`${entry}: ${text}`).not.toContain(forbidden);
  }
});
