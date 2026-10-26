/**
 * Generates the engine's committed fixture captures.
 *
 * `pnpm -F @personavision/engine fixtures` writes `tests/fixtures/<name>.json` and
 * `tests/fixtures/<name>.png` for every name in `tests/fixtures/index.ts`. It is
 * deterministic — solid rectangles painted into a raw buffer, no fonts, no randomness, no
 * timestamps — so a reviewer regenerates the fixtures and the working tree stays clean.
 * `tests/fixtures.test.ts` holds that, and the invariants of every capture.
 *
 * These are synthetic captures, not browser output: the engine is pure and must run
 * thousands of times cheaply, so the whole step's test material is five small pages built
 * with `sharp` here. Each one exists for one property a later ticket needs — see the
 * comments in `tests/fixtures/index.ts` and the fixtures section of the package README.
 *
 * Geometry is page space, as `src/types.ts` specifies: the origin is the top-left of the
 * full page, so an element below the fold has a `y` above `foldY`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { runPaths } from '@personavision/contract';
import type { BoundingBox, Capture, CaptureElement, ElementSource } from '../src/types.js';
import { CARD_GRID_REGION, FIXTURE_NAMES } from '../tests/fixtures/index.js';
import type { FixtureName } from '../tests/fixtures/index.js';

/** An 8-bit sRGB colour. */
export type Rgb = readonly [number, number, number];

/** One colour of a list, by position: a missing one is a mistake, not a grey card. */
const colour = (colours: readonly Rgb[], index: number): Rgb => {
  const found = colours[index];
  if (found === undefined) throw new Error(`no colour at ${index} of ${colours.length}`);
  return found;
};

/** A page painted as raw RGB, which `sharp` encodes to PNG. */
export interface Sheet {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const box = (x: number, y: number, width: number, height: number): BoundingBox => ({
  x,
  y,
  width,
  height,
});

const sheet = (width: number, height: number, background: Rgb): Sheet => {
  const data = new Uint8Array(width * height * 3);
  for (let offset = 0; offset < data.length; offset += 3) {
    data[offset] = background[0];
    data[offset + 1] = background[1];
    data[offset + 2] = background[2];
  }
  return { width, height, data };
};

/** Paints one rectangle, clipped to the page. */
const paint = (target: Sheet, area: BoundingBox, colour: Rgb): void => {
  const left = Math.max(0, Math.trunc(area.x));
  const top = Math.max(0, Math.trunc(area.y));
  const right = Math.min(target.width, Math.trunc(area.x + area.width));
  const bottom = Math.min(target.height, Math.trunc(area.y + area.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * target.width + x) * 3;
      target.data[offset] = colour[0];
      target.data[offset + 1] = colour[1];
      target.data[offset + 2] = colour[2];
    }
  }
};

/** Paints `count` text-like bars down the page, the way a paragraph reads from a distance. */
const paintTextRows = (
  target: Sheet,
  start: BoundingBox,
  options: { readonly count: number; readonly pitch: number },
  colour: Rgb,
): void => {
  for (let row = 0; row < options.count; row += 1) {
    paint(target, { ...start, y: start.y + row * options.pitch }, colour);
  }
};

interface ElementSpec {
  readonly id: string;
  readonly role: string | null;
  readonly name: string;
  /** The visible text, which is not always the accessible name; defaults to the name. */
  readonly text?: string;
  readonly bbox: BoundingBox;
  readonly primary?: boolean;
  readonly source?: ElementSource;
}

/**
 * `belowFold` is derived, never written by hand: an element is below the fold when its top
 * edge is at or past `foldY`, so it needed a scroll to be seen. `tests/fixtures.test.ts`
 * re-derives it from `foldY` and fails if a committed fixture disagrees.
 */
const element = (spec: ElementSpec, foldY: number): CaptureElement => ({
  id: spec.id,
  source: spec.source ?? 'dom',
  role: spec.role,
  name: spec.name,
  text: spec.text ?? spec.name,
  bbox: spec.bbox,
  isPrimaryAction: spec.primary ?? false,
  belowFold: spec.bbox.y >= foldY,
  selector: `#${spec.id}`,
});

interface FixtureSpec {
  readonly capture: Capture;
  readonly paint: (target: Sheet) => void;
}

const INK: Rgb = [96, 96, 96];
const BODY: Rgb = [168, 168, 168];
const CONTROL: Rgb = [32, 96, 200];

/** The fixture's screenshot path as `run.json` records one: run-directory relative. */
const screenshotPath = (name: FixtureName): string => runPaths('').screenshot('A', name);

const highContrastBanner = (): FixtureSpec => {
  const foldY = 320;
  const banner = box(0, 0, 480, 72);
  const cta = box(24, 216, 160, 40);
  return {
    capture: {
      step: 'high-contrast-banner',
      screenshot: screenshotPath('high-contrast-banner'),
      viewport: { width: 480, height: 320 },
      pageHeight: 320,
      foldY,
      elements: [
        element(
          {
            id: 'banner-promo',
            role: 'img',
            name: 'Spring sale — 40% off every boot',
            text: 'Spring sale — 40% off every boot',
            bbox: banner,
          },
          foldY,
        ),
        element(
          {
            id: 'heading-product',
            role: 'heading',
            name: 'Ridgeline hiking boots',
            bbox: box(24, 96, 320, 22),
          },
          foldY,
        ),
        element(
          {
            id: 'copy-product',
            role: 'text',
            name: 'A waterproof three-season boot with a rubber toe cap.',
            bbox: box(24, 136, 420, 56),
          },
          foldY,
        ),
        element(
          { id: 'cta-add-to-cart', role: 'button', name: 'Add to cart', bbox: cta, primary: true },
          foldY,
        ),
        element(
          { id: 'link-size-guide', role: 'link', name: 'Size guide', bbox: box(208, 228, 96, 14) },
          foldY,
        ),
      ],
    },
    paint: (target) => {
      // The banner is the only saturated area on an otherwise near-white page: the
      // contrast a bottom-up salience claim is made about is in these two colours.
      paint(target, banner, [214, 32, 16]);
      paint(target, box(24, 96, 320, 22), INK);
      paintTextRows(target, box(24, 140, 420, 8), { count: 3, pitch: 16 }, BODY);
      paint(target, cta, CONTROL);
      paint(target, box(208, 228, 96, 14), CONTROL);
    },
  };
};

const belowFoldPrimaryAction = (): FixtureSpec => {
  const foldY = 240;
  const cta = box(24, 620, 200, 44);
  return {
    capture: {
      step: 'below-fold-primary-action',
      screenshot: screenshotPath('below-fold-primary-action'),
      viewport: { width: 360, height: 240 },
      pageHeight: 760,
      foldY,
      elements: [
        element(
          {
            id: 'heading-order-review',
            role: 'heading',
            name: 'Review your order',
            bbox: box(24, 24, 240, 22),
          },
          foldY,
        ),
        element(
          {
            id: 'copy-order-summary',
            role: 'text',
            name: 'One pair of Ridgeline hiking boots, size 43.',
            bbox: box(24, 64, 312, 120),
          },
          foldY,
        ),
        element(
          {
            id: 'copy-shipping-terms',
            role: 'text',
            name: 'Delivery takes three to five working days.',
            bbox: box(24, 288, 312, 280),
          },
          foldY,
        ),
        element(
          { id: 'cta-place-order', role: 'button', name: 'Place order', bbox: cta, primary: true },
          foldY,
        ),
        element(
          { id: 'link-help', role: 'link', name: 'Need help?', bbox: box(24, 696, 140, 14) },
          foldY,
        ),
      ],
    },
    paint: (target) => {
      paint(target, box(24, 24, 240, 22), INK);
      // The row counts keep the last bar inside its element's box: a bar painted past
      // one would be ink no element explains, which only `card-grid-unexplained` may have.
      paintTextRows(target, box(24, 68, 312, 8), { count: 7, pitch: 16 }, BODY);
      paintTextRows(target, box(24, 292, 312, 8), { count: 17, pitch: 16 }, BODY);
      paint(target, cta, CONTROL);
      paint(target, box(24, 696, 140, 14), CONTROL);
    },
  };
};

const priceAndFees = (): FixtureSpec => {
  const foldY = 320;
  const cta = box(24, 208, 180, 44);
  return {
    capture: {
      step: 'price-and-fees',
      screenshot: screenshotPath('price-and-fees'),
      viewport: { width: 400, height: 320 },
      pageHeight: 320,
      foldY,
      elements: [
        // In document order, label then amount per row: a step that models reading order
        // reads `capture.elements` as the page reads. The three amounts share the
        // `price-` prefix, so a goal-relevance ticket can select them as a family.
        element(
          {
            id: 'heading-order-summary',
            role: 'heading',
            name: 'Order summary',
            bbox: box(24, 24, 200, 22),
          },
          foldY,
        ),
        element(
          {
            id: 'label-item',
            role: 'text',
            name: 'Ridgeline hiking boots',
            bbox: box(24, 72, 180, 14),
          },
          foldY,
        ),
        element(
          {
            id: 'price-item',
            role: 'text',
            name: 'Item price',
            text: '$42.00',
            bbox: box(300, 72, 76, 14),
          },
          foldY,
        ),
        element(
          { id: 'label-fee', role: 'text', name: 'Service fee', bbox: box(24, 104, 180, 14) },
          foldY,
        ),
        element(
          {
            id: 'price-fee',
            role: 'text',
            name: 'Service fee',
            text: '$6.00',
            bbox: box(300, 104, 76, 14),
          },
          foldY,
        ),
        element(
          { id: 'label-total', role: 'text', name: 'Total', bbox: box(24, 152, 180, 18) },
          foldY,
        ),
        element(
          {
            id: 'price-total',
            role: 'text',
            name: 'Total',
            text: '$48.00',
            bbox: box(288, 152, 88, 18),
          },
          foldY,
        ),
        element(
          { id: 'cta-pay', role: 'button', name: 'Pay now', bbox: cta, primary: true },
          foldY,
        ),
      ],
    },
    paint: (target) => {
      paint(target, box(24, 24, 200, 22), INK);
      paint(target, box(24, 72, 180, 14), BODY);
      paint(target, box(300, 72, 76, 14), BODY);
      paint(target, box(24, 104, 180, 14), BODY);
      paint(target, box(300, 104, 76, 14), BODY);
      // The total reads heavier than the lines above it, as a total does.
      paint(target, box(24, 152, 180, 18), [64, 64, 64]);
      paint(target, box(288, 152, 88, 18), [64, 64, 64]);
      paint(target, cta, CONTROL);
    },
  };
};

const cardGridUnexplained = (): FixtureSpec => {
  const foldY = 360;
  const columns = 3;
  const rows = 2;
  const columnGap = 14;
  const rowGap = 24;
  // Derived, so the cards fill `CARD_GRID_REGION` exactly however the region is edited.
  const cardWidth = (CARD_GRID_REGION.width - columnGap * (columns - 1)) / columns;
  const cardHeight = (CARD_GRID_REGION.height - rowGap * (rows - 1)) / rows;
  const cardColours: readonly Rgb[] = [
    [182, 146, 120],
    [120, 150, 176],
    [150, 176, 132],
    [196, 170, 96],
    [160, 132, 176],
    [132, 172, 172],
  ];
  return {
    capture: {
      step: 'card-grid-unexplained',
      screenshot: screenshotPath('card-grid-unexplained'),
      viewport: { width: 480, height: 360 },
      pageHeight: 360,
      foldY,
      // Nothing is reported for the grid: the cards are background images the DOM does not
      // explain, which is the unexplained area the segmenter has to partition.
      elements: [
        element(
          {
            id: 'heading-catalogue',
            role: 'heading',
            name: 'Boots for every trail',
            bbox: box(16, 24, 240, 26),
          },
          foldY,
        ),
        element(
          { id: 'link-filter', role: 'link', name: 'Filter by size', bbox: box(336, 30, 128, 16) },
          foldY,
        ),
      ],
    },
    paint: (target) => {
      paint(target, box(16, 24, 240, 26), INK);
      paint(target, box(336, 30, 128, 16), CONTROL);
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          paint(
            target,
            box(
              CARD_GRID_REGION.x + column * (cardWidth + columnGap),
              CARD_GRID_REGION.y + row * (rowGap + cardHeight),
              cardWidth,
              cardHeight,
            ),
            colour(cardColours, row * columns + column),
          );
        }
      }
    },
  };
};

const plainTextControl = (): FixtureSpec => {
  const foldY = 300;
  return {
    capture: {
      step: 'plain-text-control',
      screenshot: screenshotPath('plain-text-control'),
      viewport: { width: 400, height: 300 },
      pageHeight: 300,
      foldY,
      // No primary action and no control: the null case, which should produce no strong
      // preference for any area.
      elements: [
        element(
          {
            id: 'copy-paragraph-one',
            role: 'text',
            name: 'Our boots are made in the same workshop they were in 1974.',
            bbox: box(16, 12, 368, 86),
          },
          foldY,
        ),
        element(
          {
            id: 'copy-paragraph-two',
            role: 'text',
            name: 'Every pair is resoled rather than replaced.',
            bbox: box(16, 108, 368, 86),
          },
          foldY,
        ),
        element(
          {
            id: 'copy-paragraph-three',
            role: 'text',
            name: 'The leather comes from one tannery in Tuscany.',
            bbox: box(16, 204, 368, 86),
          },
          foldY,
        ),
      ],
    },
    // Low contrast and the same density everywhere: eighteen identical bars at one pitch,
    // so no region of the page stands out from any other.
    paint: (target) => {
      paintTextRows(target, box(16, 12, 368, 6), { count: 18, pitch: 16 }, [201, 201, 201]);
    },
  };
};

const FIXTURE_SPECS: Record<FixtureName, () => FixtureSpec> = {
  'high-contrast-banner': highContrastBanner,
  'below-fold-primary-action': belowFoldPrimaryAction,
  'price-and-fees': priceAndFees,
  'card-grid-unexplained': cardGridUnexplained,
  'plain-text-control': plainTextControl,
};

/** The page background of each fixture: near-white, as an ordinary page is. */
export const BACKGROUNDS: Record<FixtureName, Rgb> = {
  'high-contrast-banner': [244, 244, 244],
  'below-fold-primary-action': [250, 250, 250],
  'price-and-fees': [252, 252, 252],
  'card-grid-unexplained': [246, 246, 246],
  'plain-text-control': [237, 237, 237],
};

const OUT_DIR = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));

export interface RenderedFixture {
  readonly capture: Capture;
  /** The page as raw RGB: the pixels the committed PNG encodes. */
  readonly sheet: Sheet;
  readonly background: Rgb;
}

/**
 * One fixture, built and painted but not written. `tests/fixtures.test.ts` builds every
 * fixture this way and compares it against the committed files, so the claim that the
 * committed bytes are this generator's output is asserted rather than documented.
 */
export const buildFixture = (name: FixtureName): RenderedFixture => {
  const spec = FIXTURE_SPECS[name]();
  const target = sheet(spec.capture.viewport.width, spec.capture.pageHeight, BACKGROUNDS[name]);
  spec.paint(target);
  return { capture: spec.capture, sheet: target, background: BACKGROUNDS[name] };
};

const write = async (
  name: FixtureName,
): Promise<{ readonly json: number; readonly png: number }> => {
  const { capture, sheet: target } = buildFixture(name);

  const png = await sharp(target.data, {
    raw: { width: target.width, height: target.height, channels: 3 },
  })
    // Explicit, so the bytes depend on nothing but the pixels: no metadata, no date.
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();

  const json = `${JSON.stringify(capture, null, 2)}\n`;
  writeFileSync(join(OUT_DIR, `${name}.json`), json, 'utf8');
  writeFileSync(join(OUT_DIR, `${name}.png`), png);
  return { json: Buffer.byteLength(json), png: png.byteLength };
};

const main = async (): Promise<void> => {
  let total = 0;
  for (const name of FIXTURE_NAMES) {
    const { json, png } = await write(name);
    total += json + png;
    process.stdout.write(`${name}: ${png} B png, ${json} B json\n`);
  }
  process.stdout.write(`${FIXTURE_NAMES.length} fixtures, ${total} B in all\n`);
};

/** Run as a script. An import — the test building the fixtures — writes nothing. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
