import { isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { resolveEngineConfig } from '../config.js';
import type { EngineConfigOverrides, SegmentationConfig } from '../config.js';
import type { BoundingBox, Capture } from '../types.js';
import { aoiId } from './aoi-id.js';
import type { SegmentedArea, Segmenter, SegmenterInput } from './segmenter.js';

/**
 * The offline heuristic `Segmenter`: the regions the DOM does not explain, from the image.
 *
 * This is the **default** segmenter — the deterministic engine, the demo and CI all run on
 * it, with no credential and no network, and the SAM 3.1 segmenter (#69) is additive on
 * top. A hero image, a card grid or a banner arrives from the browser step as nothing at
 * all, and attention still lands on it; this partitions what the elements left over so
 * that dwell has somewhere to be attributed.
 *
 * The partition, in one paragraph. The screenshot is averaged onto a grid of small square
 * cells in page space. Cells that touch an area the capture's elements already explain are
 * struck out, so nothing here can ever compete with a control. The page's background
 * colour is estimated as the most common colour on the grid; a surviving cell far enough
 * from it is *ink*. Ink cells that touch and that are close in colour and luminance to the
 * cell their region started at coalesce into one region, whose cell bounds snap it to a
 * rectangle. Four filters then throw candidates away — too small, too thin, a sliver, not
 * rectangular enough — and the largest of what is left, at most `maxRegions` of them, are
 * returned. Every bound is a number in `EngineConfig.segmentation`, because #11 fits them.
 *
 * **Why it is honest.** The background estimate is what stops this inventing areas. A page
 * of plain prose has no ink the elements did not already explain, so the grid has no
 * surviving ink cell, so the answer is nothing — not one area per paragraph of paper. A
 * segmenter is only worth having if "I found nothing" is one of the things it can say.
 *
 * **Deterministic.** No draw, no clock, no iteration over an unordered map. The grid is
 * walked in row-major order, a region is the connected set of ink cells similar to its
 * seed (which is path-independent, so traversal order cannot change membership), and ties
 * in the largest-first cut are broken by position. The same screenshot and the same
 * explained areas give byte-identical regions, ids and order.
 *
 * **Purity.** The engine reads no file; a segmenter may. `sharp` opens the screenshot at
 * the path the capture carries, which is the seam's explicit exception (`segmenter.ts`),
 * and `readImage` replaces even that for a caller that already holds the pixels.
 */

/** Raw pixels of a screenshot, as `sharp`'s `raw()` yields them. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** 1, 2, 3 or 4. Below three, channel 0 is read as grey; above, the fourth is ignored. */
  readonly channels: number;
  /** Row-major, channel-interleaved, one byte per channel. */
  readonly data: Uint8Array;
}

/** How the screenshot's pixels are obtained. The default opens the path with `sharp`. */
export type ImageReader = (screenshotPath: string) => RasterImage | Promise<RasterImage>;

export interface HeuristicSegmenterOptions {
  /**
   * The run directory `capture.screenshot` is relative to, since the browser step records
   * that path run-directory-relative. Omitted, the path is used exactly as it arrives —
   * which is right for a caller that hands over an absolute one, and finds nothing for a
   * caller that does not. A session driver constructs the segmenter with the run directory
   * it is writing to rather than leaning on `defaultSegmenter`.
   */
  readonly runDir?: string;
  /** Layered over the engine defaults, so a caller overrides one threshold and no more. */
  readonly config?: EngineConfigOverrides;
  /** For a caller that already holds the pixels — a test, or a pipeline that cached them. */
  readonly readImage?: ImageReader;
}

/**
 * The naming grid: thirds of the page, by a region's centre.
 *
 * Deliberately **not** in `EngineConfig`. These change what a region is called and never
 * which regions exist, and calibration cannot fit a word. Thirds because that is the
 * coarsest division that still distinguishes the three columns of a card grid.
 */
const COLUMN_WORDS = ['left', 'centre', 'right'] as const;
const ROW_WORDS = ['top', 'middle', 'bottom'] as const;
const NAMING_BANDS = 3;

/**
 * What a region is called, by shape. A designer reading the areas-of-interest table sees
 * "Bottom left card", not "region-7" — and the table already reads "Promo banner" and
 * "Trust badges" for segments in `docs/design/prototype.html`.
 */
const BANNER_WIDTH_SHARE = 0.75;
const IMAGE_AREA_SHARE = 0.2;

/** The default reader: `sharp` opens the screenshot and hands back its raw pixels. */
const readWithSharp: ImageReader = async (screenshotPath) => {
  const { data, info } = await sharp(screenshotPath).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
};

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

const luminanceOf = (red: number, green: number, blue: number): number =>
  LUMA_R * red + LUMA_G * green + LUMA_B * blue;

/** Root-mean-square channel difference: one number for "how different these two colours are". */
const colourDistance = (a: ArrayLike<number>, b: ArrayLike<number>, at: number): number => {
  const red = a[at] - b[0];
  const green = a[at + 1] - b[1];
  const blue = a[at + 2] - b[2];
  return Math.sqrt((red * red + green * green + blue * blue) / 3);
};

const intersects = (a: BoundingBox, b: BoundingBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The screenshot averaged onto square cells of page space. */
interface Grid {
  readonly columns: number;
  readonly rows: number;
  readonly cellPx: number;
  /** Mean colour, three entries per cell at `3 * index`. */
  readonly colour: Float64Array;
  readonly luminance: Float64Array;
  /** 0 for a cell no pixel of the image fell in — a page taller than its screenshot. */
  readonly covered: Uint8Array;
}

/**
 * Averages the image onto the grid.
 *
 * The screenshot may be at a device pixel ratio above one, so page space is mapped onto
 * image space by the ratio of their extents rather than assumed to be one to one. A cell
 * is the mean of the image pixels that fall in it, summed in a fixed order.
 */
const gridOf = (image: RasterImage, capture: Capture, cellPx: number): Grid => {
  const columns = Math.max(1, Math.ceil(capture.viewport.width / cellPx));
  const rows = Math.max(1, Math.ceil(capture.pageHeight / cellPx));
  const colour = new Float64Array(columns * rows * 3);
  const luminance = new Float64Array(columns * rows);
  const covered = new Uint8Array(columns * rows);

  const scaleX = image.width / capture.viewport.width;
  const scaleY = image.height / capture.pageHeight;
  const { channels, data } = image;
  const greyscale = channels < 3;

  for (let row = 0; row < rows; row += 1) {
    const top = Math.min(image.height, Math.round(row * cellPx * scaleY));
    const bottom = Math.min(image.height, Math.round((row + 1) * cellPx * scaleY));
    for (let column = 0; column < columns; column += 1) {
      const left = Math.min(image.width, Math.round(column * cellPx * scaleX));
      const right = Math.min(image.width, Math.round((column + 1) * cellPx * scaleX));
      let red = 0;
      let green = 0;
      let blue = 0;
      let counted = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const at = (y * image.width + x) * channels;
          red += data[at];
          green += greyscale ? data[at] : data[at + 1];
          blue += greyscale ? data[at] : data[at + 2];
          counted += 1;
        }
      }
      if (counted === 0) continue;
      const index = row * columns + column;
      colour[index * 3] = red / counted;
      colour[index * 3 + 1] = green / counted;
      colour[index * 3 + 2] = blue / counted;
      luminance[index] = luminanceOf(red / counted, green / counted, blue / counted);
      covered[index] = 1;
    }
  }

  return { columns, rows, cellPx, colour, luminance, covered };
};

/**
 * The page's background colour: the mean of the cells in the most populated colour bucket.
 *
 * The modal bucket rather than the mean of the page, because the mean of a page half
 * covered in cards is a colour nothing on it actually is. Every covered cell counts,
 * explained or not — the paper under a control is the same paper. Ties go to the lowest
 * bucket key, so the answer never depends on insertion order.
 */
const backgroundColourOf = (grid: Grid, bucketLevels: number): readonly number[] => {
  const counts = new Map<number, number>();
  const levels = Math.max(1, Math.round(bucketLevels));
  const bucketOf = (index: number): number =>
    Math.floor(grid.colour[index * 3] / levels) * 65536 +
    Math.floor(grid.colour[index * 3 + 1] / levels) * 256 +
    Math.floor(grid.colour[index * 3 + 2] / levels);

  for (let index = 0; index < grid.covered.length; index += 1) {
    if (grid.covered[index] === 0) continue;
    const bucket = bucketOf(index);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  let modal = -1;
  let best = 0;
  for (const [bucket, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > best) {
      modal = bucket;
      best = count;
    }
  }

  let red = 0;
  let green = 0;
  let blue = 0;
  let counted = 0;
  for (let index = 0; index < grid.covered.length; index += 1) {
    if (grid.covered[index] === 0 || bucketOf(index) !== modal) continue;
    red += grid.colour[index * 3];
    green += grid.colour[index * 3 + 1];
    blue += grid.colour[index * 3 + 2];
    counted += 1;
  }

  return counted === 0 ? [255, 255, 255] : [red / counted, green / counted, blue / counted];
};

/** Cells that touch an explained area are struck out, so no region can compete with a control. */
const strikeOutExplained = (
  grid: Grid,
  explained: readonly BoundingBox[],
  available: Uint8Array,
): void => {
  for (const box of explained) {
    const firstColumn = Math.max(0, Math.floor(box.x / grid.cellPx));
    const lastColumn = Math.min(grid.columns - 1, Math.ceil((box.x + box.width) / grid.cellPx) - 1);
    const firstRow = Math.max(0, Math.floor(box.y / grid.cellPx));
    const lastRow = Math.min(grid.rows - 1, Math.ceil((box.y + box.height) / grid.cellPx) - 1);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        available[row * grid.columns + column] = 0;
      }
    }
  }
};

/** One coalesced region, still in cell coordinates. */
interface Region {
  readonly cells: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

/**
 * The connected sets of ink cells, each coalesced around the first cell that found it.
 *
 * A cell joins the region its neighbour belongs to only if it is close to that region's
 * **seed** cell, not merely to the neighbour — otherwise a gradient walks a region across
 * a whole page one tolerable step at a time. Admission therefore depends on the cell
 * alone, which is what makes the result independent of the order the stack is drained in.
 */
const regionsOf = (
  grid: Grid,
  ink: Uint8Array,
  similarity: SegmentationConfig['similarity'],
): Region[] => {
  const taken = new Uint8Array(ink.length);
  const found: Region[] = [];
  const stack: number[] = [];

  for (let seed = 0; seed < ink.length; seed += 1) {
    if (ink[seed] === 0 || taken[seed] === 1) continue;

    const seedColour = [
      grid.colour[seed * 3],
      grid.colour[seed * 3 + 1],
      grid.colour[seed * 3 + 2],
    ];
    const seedLuminance = grid.luminance[seed];
    const joins = (index: number): boolean =>
      ink[index] === 1 &&
      taken[index] === 0 &&
      Math.abs(grid.luminance[index] - seedLuminance) <= similarity.luminanceDistance &&
      colourDistance(grid.colour, seedColour, index * 3) <= similarity.colourDistance;

    let cells = 0;
    let firstColumn = grid.columns;
    let lastColumn = -1;
    let firstRow = grid.rows;
    let lastRow = -1;

    taken[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const column = index % grid.columns;
      const row = (index - column) / grid.columns;
      cells += 1;
      if (column < firstColumn) firstColumn = column;
      if (column > lastColumn) lastColumn = column;
      if (row < firstRow) firstRow = row;
      if (row > lastRow) lastRow = row;

      if (column > 0 && joins(index - 1)) {
        taken[index - 1] = 1;
        stack.push(index - 1);
      }
      if (column < grid.columns - 1 && joins(index + 1)) {
        taken[index + 1] = 1;
        stack.push(index + 1);
      }
      if (row > 0 && joins(index - grid.columns)) {
        taken[index - grid.columns] = 1;
        stack.push(index - grid.columns);
      }
      if (row < grid.rows - 1 && joins(index + grid.columns)) {
        taken[index + grid.columns] = 1;
        stack.push(index + grid.columns);
      }
    }

    found.push({ cells, firstColumn, lastColumn, firstRow, lastRow });
  }

  return found;
};

/** A region's cell bounds as a page-space rectangle, snapped to the grid and clipped to the page. */
const rectangleOf = (region: Region, grid: Grid, capture: Capture): BoundingBox => {
  const x = Math.max(0, region.firstColumn * grid.cellPx);
  const y = Math.max(0, region.firstRow * grid.cellPx);
  return {
    x,
    y,
    width: Math.min(capture.viewport.width, (region.lastColumn + 1) * grid.cellPx) - x,
    height: Math.min(capture.pageHeight, (region.lastRow + 1) * grid.cellPx) - y,
  };
};

const bandOf = (centre: number, extent: number): number =>
  extent <= 0
    ? 0
    : Math.min(NAMING_BANDS - 1, Math.max(0, Math.floor((centre / extent) * NAMING_BANDS)));

/**
 * Where on the page the region is, in the fewest words that still place it: "centre" when
 * it is in the middle both ways, one word when it is central in one of them, two when it
 * is in a corner.
 */
const placeOf = (bbox: BoundingBox, capture: Capture): string => {
  const column = COLUMN_WORDS[bandOf(bbox.x + bbox.width / 2, capture.viewport.width)];
  const row = ROW_WORDS[bandOf(bbox.y + bbox.height / 2, capture.pageHeight)];
  if (column === 'centre' && row === 'middle') return 'centre';
  if (row === 'middle') return column;
  if (column === 'centre') return row;
  return `${row} ${column}`;
};

/** Banner, image or card, by how much of the screen the region takes and in which direction. */
const kindOf = (bbox: BoundingBox, capture: Capture): string => {
  const viewportArea = capture.viewport.width * capture.viewport.height;
  if (bbox.width >= BANNER_WIDTH_SHARE * capture.viewport.width && bbox.width > bbox.height) {
    return 'banner';
  }
  return viewportArea > 0 && (bbox.width * bbox.height) / viewportArea >= IMAGE_AREA_SHARE
    ? 'image'
    : 'card';
};

/**
 * The label, from the region's own geometry and nothing else — so it is stable for the
 * same region across runs, and two regions of one screen are told apart by where they are.
 */
const labelOf = (bbox: BoundingBox, capture: Capture): string => {
  const words = `${placeOf(bbox, capture)} ${kindOf(bbox, capture)}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Largest first, then down the page and across, so the cut to `maxRegions` is total. */
const byAreaThenPosition = (a: BoundingBox, b: BoundingBox): number =>
  b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x;

const inReadingOrder = (a: SegmentedArea, b: SegmentedArea): number =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The offline heuristic segmenter.
 *
 * `role` is `null` on every region it returns, as the seam specifies for an area that is
 * just image: the heuristic reads colour, and colour does not tell it that a region is a
 * price or a menu. `aoiId` writes `region` where a control's id writes `button`, which is
 * exactly how a segmented area reads in the artifact today.
 */
export const heuristicSegmenter = (options: HeuristicSegmenterOptions = {}): Segmenter => {
  const { config } = resolveEngineConfig(options.config);
  const settings = config.segmentation;
  const readImage = options.readImage ?? readWithSharp;

  const screenshotPathOf = (capture: Capture): string =>
    options.runDir === undefined || isAbsolute(capture.screenshot)
      ? capture.screenshot
      : join(options.runDir, capture.screenshot);

  return {
    segment: async (input: SegmenterInput): Promise<readonly SegmentedArea[]> => {
      const { capture, explained, variant } = input;
      if (capture.viewport.width <= 0 || capture.pageHeight <= 0) return [];

      const cellPx = Math.max(1, Math.round(settings.cellPx));
      const image = await readImage(screenshotPathOf(capture));
      if (image.width <= 0 || image.height <= 0) return [];

      const grid = gridOf(image, capture, cellPx);
      const background = backgroundColourOf(grid, settings.background.bucketLevels);
      const backgroundLuminance = luminanceOf(background[0], background[1], background[2]);

      const available = Uint8Array.from(grid.covered);
      const explainedBoxes = explained.map((area) => area.bbox);
      strikeOutExplained(grid, explainedBoxes, available);

      const ink = new Uint8Array(available.length);
      for (let index = 0; index < ink.length; index += 1) {
        if (available[index] === 0) continue;
        const farInLuminance =
          Math.abs(grid.luminance[index] - backgroundLuminance) >
          settings.background.luminanceDistance;
        const farInColour =
          colourDistance(grid.colour, background, index * 3) > settings.background.colourDistance;
        ink[index] = farInLuminance || farInColour ? 1 : 0;
      }

      const viewportArea = capture.viewport.width * capture.viewport.height;
      const candidates = regionsOf(grid, ink, settings.similarity)
        .map((region) => ({ region, bbox: rectangleOf(region, grid, capture) }))
        .filter(({ region, bbox }) => {
          if (bbox.width <= 0 || bbox.height <= 0) return false;
          // Too small on its shorter side, too small in all, a sliver, or a shape whose
          // rectangle is mostly not the region — each is a candidate, not an area.
          if (Math.min(bbox.width, bbox.height) < settings.minSidePx) return false;
          if (bbox.width * bbox.height < settings.minAreaShare * viewportArea) return false;
          const aspect = Math.min(bbox.width, bbox.height) / Math.max(bbox.width, bbox.height);
          if (aspect < settings.minAspectRatio) return false;
          const inRectangle =
            (region.lastColumn + 1 - region.firstColumn) * (region.lastRow + 1 - region.firstRow);
          if (region.cells / inRectangle < settings.minRectangularity) return false;
          // The rectangle of an imperfectly rectangular region can reach over a control
          // even though none of its cells did. An area of interest that overlaps one the
          // elements explain would split a control's dwell, so it is dropped, not shrunk.
          return !explainedBoxes.some((box) => intersects(bbox, box));
        })
        .map(({ bbox }) => bbox)
        .sort(byAreaThenPosition)
        .slice(0, Math.max(0, Math.round(settings.maxRegions)));

      return candidates
        .map((bbox): SegmentedArea => {
          const label = labelOf(bbox, capture);
          return {
            id: aoiId({ variant, step: capture.step, role: null, label, bbox }),
            label,
            role: null,
            bbox,
          };
        })
        .sort(inReadingOrder);
    },
  };
};
