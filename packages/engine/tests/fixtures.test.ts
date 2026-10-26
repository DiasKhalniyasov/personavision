import { statSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { runPaths } from '@personavision/contract';
import { BACKGROUNDS, buildFixture } from '../scripts/make-fixtures.js';
import type { Rgb } from '../scripts/make-fixtures.js';
import type { BoundingBox, Capture } from '../src/index.js';
import { CARD_GRID_REGION, FIXTURE_NAMES, loadAllFixtures, loadFixture } from './fixtures/index.js';
import type { FixtureName } from './fixtures/index.js';

/**
 * The fixtures are the attention-engine step's shared test material, so this file asserts
 * three things about them: that the committed files really are the generator's output,
 * that every capture holds the invariants a later ticket will read without re-checking,
 * and that the property each fixture exists for is measurably there in the image. A
 * salience ticket asserting "the banner attracts an early fixation" is only testing
 * something if the banner really is the high-contrast area of its page.
 */

/**
 * The element ids of each fixture, and its declared primary action. Spelled out rather
 * than derived: these ids are what later tickets name in their assertions, so a rename
 * fails here, in the package that owns the fixtures, instead of in the ticket that reads
 * them. `null` is a fixture that claims no primary action at all.
 */
const EXPECTED: Record<
  FixtureName,
  { readonly ids: readonly string[]; readonly primaryActionId: string | null }
> = {
  'high-contrast-banner': {
    ids: ['banner-promo', 'heading-product', 'copy-product', 'cta-add-to-cart', 'link-size-guide'],
    primaryActionId: 'cta-add-to-cart',
  },
  'below-fold-primary-action': {
    ids: [
      'heading-order-review',
      'copy-order-summary',
      'copy-shipping-terms',
      'cta-place-order',
      'link-help',
    ],
    primaryActionId: 'cta-place-order',
  },
  'price-and-fees': {
    ids: [
      'heading-order-summary',
      'label-item',
      'price-item',
      'label-fee',
      'price-fee',
      'label-total',
      'price-total',
      'cta-pay',
    ],
    primaryActionId: 'cta-pay',
  },
  'card-grid-unexplained': {
    ids: ['heading-catalogue', 'link-filter'],
    primaryActionId: null,
  },
  'plain-text-control': {
    ids: ['copy-paragraph-one', 'copy-paragraph-two', 'copy-paragraph-three'],
    primaryActionId: null,
  },
};

/** Total committed bytes, as the package README states them. */
const SIZE_BUDGET_BYTES = 32 * 1024;

/** The screenshot as single-channel luminance, in page space. */
interface Luminance {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const luminanceOf = async (screenshotPath: string): Promise<Luminance> => {
  const { data, info } = await sharp(screenshotPath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // One byte per pixel is what the indexing below assumes; an alpha channel would make it
  // read every other byte as brightness and keep passing on nonsense.
  expect(info.channels).toBe(1);
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
};

/** Brightness summed over one region, clipped to the page. Integer pixels, so floored. */
const regionSum = (image: Luminance, area: BoundingBox): { sum: number; count: number } => {
  const left = Math.max(0, Math.floor(area.x));
  const top = Math.max(0, Math.floor(area.y));
  const right = Math.min(image.width, Math.floor(area.x + area.width));
  const bottom = Math.min(image.height, Math.floor(area.y + area.height));
  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      sum += image.data[y * image.width + x] ?? 0;
      count += 1;
    }
  }
  return { sum, count };
};

const meanInside = (image: Luminance, area: BoundingBox): number => {
  const { sum, count } = regionSum(image, area);
  return count === 0 ? 0 : sum / count;
};

/** The mean of everything the area does not cover — the same pixels, counted once. */
const meanOutside = (image: Luminance, area: BoundingBox): number => {
  const whole = regionSum(image, { x: 0, y: 0, width: image.width, height: image.height });
  const inside = regionSum(image, area);
  const count = whole.count - inside.count;
  return count === 0 ? 0 : (whole.sum - inside.sum) / count;
};

const standardDeviationInside = (image: Luminance, area: BoundingBox): number => {
  const mean = meanInside(image, area);
  const left = Math.max(0, Math.floor(area.x));
  const top = Math.max(0, Math.floor(area.y));
  const right = Math.min(image.width, Math.floor(area.x + area.width));
  const bottom = Math.min(image.height, Math.floor(area.y + area.height));
  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      sum += ((image.data[y * image.width + x] ?? 0) - mean) ** 2;
      count += 1;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
};

/**
 * How unevenly the page's brightness is spread: the largest difference between any two of
 * sixteen equal tiles' mean luminance. One statistic, so "this page has a standout area"
 * and "this page has none" are the same measurement with different expectations.
 */
const tileSpread = (image: Luminance, tiles = 4): number => {
  const means: number[] = [];
  for (let row = 0; row < tiles; row += 1) {
    for (let column = 0; column < tiles; column += 1) {
      const x = Math.floor((column * image.width) / tiles);
      const y = Math.floor((row * image.height) / tiles);
      means.push(
        meanInside(image, {
          x,
          y,
          width: Math.floor(((column + 1) * image.width) / tiles) - x,
          height: Math.floor(((row + 1) * image.height) / tiles) - y,
        }),
      );
    }
  }
  return Math.max(...means) - Math.min(...means);
};

const covers = (area: BoundingBox, x: number, y: number): boolean =>
  x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;

const overlaps = (one: BoundingBox, other: BoundingBox): boolean =>
  one.x < other.x + other.width &&
  other.x < one.x + one.width &&
  one.y < other.y + other.height &&
  other.y < one.y + one.height;

/**
 * Painted pixels no element accounts for. Only `card-grid-unexplained` is allowed any, and
 * only inside its grid: everywhere else, ink an element does not explain would make a
 * later ticket's explained-versus-unexplained partition wrong about a page it trusts.
 */
const inkNoElementExplains = (
  name: FixtureName,
): { readonly outsideElements: number; readonly outsideCardGrid: number } => {
  const { sheet, background } = buildFixture(name);
  const { capture } = loadFixture(name);
  let outsideElements = 0;
  let outsideCardGrid = 0;
  for (let y = 0; y < sheet.height; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const offset = (y * sheet.width + x) * 3;
      const painted = ([0, 1, 2] as const).some(
        (channel) => sheet.data[offset + channel] !== background[channel],
      );
      if (!painted) continue;
      if (capture.elements.some((element) => covers(element.bbox, x, y))) continue;
      outsideElements += 1;
      if (!covers(CARD_GRID_REGION, x, y)) outsideCardGrid += 1;
    }
  }
  return { outsideElements, outsideCardGrid };
};

const elementById = (capture: Capture, id: string) => {
  const found = capture.elements.find((element) => element.id === id);
  if (found === undefined) throw new Error(`${capture.step} has no element "${id}"`);
  return found;
};

describe('the loader', () => {
  it('returns a fixture by name', () => {
    const { name, capture, screenshotPath, capturePath } = loadFixture('price-and-fees');
    expect(name).toBe('price-and-fees');
    expect(capture.step).toBe('price-and-fees');
    expect(screenshotPath).toMatch(/price-and-fees\.png$/);
    expect(capturePath).toMatch(/price-and-fees\.json$/);
  });

  it('fails loudly on an unknown name, naming the fixtures that exist', () => {
    expect(() => loadFixture('high-contrast-bannner')).toThrow(/Unknown engine fixture/);
    expect(() => loadFixture('high-contrast-bannner')).toThrow(/price-and-fees/);
  });

  it('loads every declared fixture', () => {
    expect(loadAllFixtures().map((fixture) => fixture.name)).toEqual([...FIXTURE_NAMES]);
  });
});

describe.each(FIXTURE_NAMES)('%s', (name) => {
  const { capture, screenshotPath } = loadFixture(name);
  const expected = EXPECTED[name];

  it('is the committed output of the generator', async () => {
    // `pnpm -F @personavision/engine fixtures` is how the files are produced, and the
    // working tree staying clean after it is a reviewer's proof. This is the one CI runs:
    // the generator is built here and compared against what is committed. The screenshot
    // is compared as pixels rather than as PNG bytes, so an encoder upgrade is not a
    // failure — a changed page is.
    const built = buildFixture(name);
    expect(capture).toEqual(built.capture);
    const { data, info } = await sharp(screenshotPath).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(Buffer.from(data).equals(Buffer.from(built.sheet.data))).toBe(true);
  });

  it('is the engine’s published capture input', () => {
    const published: Capture = capture;
    expect(published.step).toBe(name);
    // The path layout belongs to `@personavision/contract`; no package re-derives it.
    expect(published.screenshot).toBe(runPaths('').screenshot('A', name));
    expect(published.viewport.width).toBeGreaterThan(0);
    expect(published.viewport.height).toBeGreaterThan(0);
    expect(published.elements.length).toBeGreaterThan(0);
  });

  it('has a fold one viewport down a page at least that tall', () => {
    expect(capture.foldY).toBe(capture.viewport.height);
    expect(capture.pageHeight).toBeGreaterThanOrEqual(capture.viewport.height);
  });

  it('matches the screenshot it names', async () => {
    const image = await luminanceOf(screenshotPath);
    expect({ width: image.width, height: image.height }).toEqual({
      width: capture.viewport.width,
      height: capture.pageHeight,
    });
  });

  it('has the ids later tickets name, each once', () => {
    const ids = capture.elements.map((element) => element.id);
    expect(ids).toEqual([...expected.ids]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every box inside the page', () => {
    for (const { id, bbox } of capture.elements) {
      expect({ id, inside: bbox.x >= 0 && bbox.y >= 0 }).toEqual({ id, inside: true });
      expect({ id, right: bbox.x + bbox.width <= capture.viewport.width }).toEqual({
        id,
        right: true,
      });
      expect({ id, bottom: bbox.y + bbox.height <= capture.pageHeight }).toEqual({
        id,
        bottom: true,
      });
      expect({ id, sized: bbox.width > 0 && bbox.height > 0 }).toEqual({ id, sized: true });
    }
  });

  it('reports belowFold exactly as foldY implies', () => {
    for (const { id, bbox, belowFold } of capture.elements) {
      expect({ id, belowFold }).toEqual({ id, belowFold: bbox.y >= capture.foldY });
    }
  });

  it('declares the primary action it claims and no other', () => {
    const declared = capture.elements.filter((element) => element.isPrimaryAction);
    expect(declared.map((element) => element.id)).toEqual(
      expected.primaryActionId === null ? [] : [expected.primaryActionId],
    );
  });

  it('paints only ink its elements explain', () => {
    const { outsideElements, outsideCardGrid } = inkNoElementExplains(name);
    if (name === 'card-grid-unexplained') {
      expect(outsideElements).toBeGreaterThan(0);
      expect(outsideCardGrid).toBe(0);
      return;
    }
    expect(outsideElements).toBe(0);
  });
});

describe('the property each fixture exists for', () => {
  it('high-contrast-banner: the banner is measurably higher contrast than its surroundings', async () => {
    const { capture, screenshotPath } = loadFixture('high-contrast-banner');
    const image = await luminanceOf(screenshotPath);
    const banner = elementById(capture, 'banner-promo').bbox;
    const difference = Math.abs(meanInside(image, banner) - meanOutside(image, banner));
    expect(difference).toBeGreaterThan(60);
  });

  it('plain-text-control: the page is measurably uniform, and the most uniform of the five', async () => {
    const spreads = await Promise.all(
      loadAllFixtures().map(async (fixture) => ({
        name: fixture.name,
        spread: tileSpread(await luminanceOf(fixture.screenshotPath)),
      })),
    );
    const plain = spreads.find((entry) => entry.name === 'plain-text-control');
    expect(plain?.spread).toBeLessThan(12);
    expect(Math.min(...spreads.map((entry) => entry.spread))).toBe(plain?.spread);
  });

  it('below-fold-primary-action: the primary action lies strictly below the fold', () => {
    const { capture } = loadFixture('below-fold-primary-action');
    const cta = elementById(capture, 'cta-place-order');
    expect(cta.isPrimaryAction).toBe(true);
    expect(cta.bbox.y).toBeGreaterThan(capture.foldY);
    expect(cta.belowFold).toBe(true);
    // A never-fixated case needs the control to be reachable but far: a scroll away.
    expect(capture.pageHeight).toBeGreaterThan(capture.foldY * 2);
  });

  it('price-and-fees: a total, a line price and a service fee carry role and text', () => {
    const { capture } = loadFixture('price-and-fees');
    const money = capture.elements.filter((element) => element.id.startsWith('price-'));
    expect(money.map((element) => element.id)).toEqual(['price-item', 'price-fee', 'price-total']);
    expect(money.map((element) => element.text)).toEqual(['$42.00', '$6.00', '$48.00']);
    expect(money.map((element) => element.name)).toEqual(['Item price', 'Service fee', 'Total']);
    for (const element of money) expect(element.role).toBe('text');
  });

  it('card-grid-unexplained: no element covers the grid, which has structure to segment', async () => {
    const { capture, screenshotPath } = loadFixture('card-grid-unexplained');
    for (const { id, bbox } of capture.elements) {
      expect({ id, coversGrid: overlaps(bbox, CARD_GRID_REGION) }).toEqual({
        id,
        coversGrid: false,
      });
    }
    const image = await luminanceOf(screenshotPath);
    expect(standardDeviationInside(image, CARD_GRID_REGION)).toBeGreaterThan(15);
  });
});

describe('the committed bytes', () => {
  it(`stay under the README’s ${SIZE_BUDGET_BYTES} byte budget`, () => {
    const total = loadAllFixtures()
      .flatMap((fixture) => [fixture.capturePath, fixture.screenshotPath])
      .reduce((sum, path) => sum + statSync(path).size, 0);
    expect(total).toBeLessThan(SIZE_BUDGET_BYTES);
  });

  it('paint a near-white page, as an ordinary page is', () => {
    for (const name of FIXTURE_NAMES) {
      const background: Rgb = BACKGROUNDS[name];
      expect({ name, light: background.every((channel) => channel >= 230) }).toEqual({
        name,
        light: true,
      });
    }
  });
});
