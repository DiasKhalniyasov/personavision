/**
 * Generates the committed calibration corpus.
 *
 * `pnpm -F @personavision/calibration corpus` writes `test/corpus/<name>.json` and
 * `test/corpus/<name>.png` for every name in `src/corpus.ts`. It is deterministic — solid
 * rectangles painted into a raw buffer and Gaussian blobs evaluated in closed form, with
 * no fonts, no randomness and no timestamps — so a reviewer regenerates the corpus and the
 * working tree stays clean. `test/corpus.test.ts` holds that, and every invariant of every
 * record.
 *
 * **These are synthetic records, not UEyes bytes.** The auto-decision on #11 forbids
 * vendoring the dataset, so the whole step's committed test material is the four small
 * records built here, each existing for one property a later ticket needs: see the comments
 * on `CORPUS_RECORD_NAMES` and `packages/calibration/docs/corpus.md`.
 *
 * Geometry is image space, as `src/types.ts` specifies: the origin is the image's top-left
 * pixel, `x` runs right and `y` runs down. A map is coarser than its image, and its blob
 * centres are given here in **image pixels** while the spreads are in **cells**, because a
 * spread is about how many cells a metric sees the peak across.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { CORPUS_RECORD_NAMES, corpusRecordPaths } from '../src/corpus.js';
import type { CorpusRecordData, CorpusRecordName } from '../src/corpus.js';
import type {
  Display,
  Fixation,
  ImageSize,
  RecordCategory,
  SaliencyMap,
  Scanpath,
  ViewingDurationSeconds,
} from '../src/types.js';

/** An 8-bit sRGB colour. */
export type Rgb = readonly [number, number, number];

/** A rectangle in image space. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** An image painted as raw RGB, which `sharp` encodes to PNG. */
export interface Sheet {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * One Gaussian bump of a human saliency map. `cx`/`cy` are image pixels — the point the
 * humans looked at — and `sx`/`sy` are standard deviations in map cells.
 */
interface Blob {
  readonly cx: number;
  readonly cy: number;
  readonly sx: number;
  readonly sy: number;
  readonly weight: number;
}

/** A fixation as the spec states it: where, and for how long. Its `tMs` is derived. */
interface FixationSpec {
  readonly x: number;
  readonly y: number;
  readonly durationMs: number;
}

interface ScanpathSpec {
  readonly participantId: string;
  readonly fixations: readonly FixationSpec[];
}

/** Everything one record is: what to paint, what the humans' map is, who looked where. */
export interface RecordSpec {
  readonly category: RecordCategory;
  readonly imageSize: ImageSize;
  readonly display: Display;
  readonly viewingDurationSeconds: ViewingDurationSeconds;
  /** The map's resolution in cells, which is coarser than the image. */
  readonly map: ImageSize;
  readonly background: Rgb;
  /** The salient regions painted on the field, which the test asserts the image carries. */
  readonly regions: readonly { readonly box: Box; readonly colour: Rgb }[];
  readonly blobs: readonly Blob[];
  readonly scanpaths: readonly ScanpathSpec[];
}

/**
 * The gap between one fixation's end and the next one's onset: the saccade. One value for
 * the whole corpus, because nothing here is a claim about saccade duration — it is what
 * makes `tMs` ordered and consistent with `durationMs`.
 */
const SACCADE_MS = 40;

/**
 * How many decimal places a map cell is written to.
 *
 * Twelve, so the committed JSON stays compact and byte-identical across regeneration while
 * the rounding moves the sum by at most 192 × 5e-13. The maps are therefore `sum-to-one`
 * to within 1e-9, which is the tolerance `docs/corpus.md` states and the test asserts.
 */
const CELL_DECIMALS = 12;

const sheet = (width: number, height: number, background: Rgb): Sheet => {
  const data = new Uint8Array(width * height * 3);
  for (let offset = 0; offset < data.length; offset += 3) {
    data[offset] = background[0];
    data[offset + 1] = background[1];
    data[offset + 2] = background[2];
  }
  return { width, height, data };
};

/** Paints one rectangle, clipped to the image. */
const paint = (target: Sheet, area: Box, colour: Rgb): void => {
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

/**
 * The humans' aggregated map: the blobs summed over the cell grid, then scaled so the
 * cells sum to one. A cell far from every blob rounds to exactly zero — in ground truth
 * that is a cell the humans did not look at, not a missing value.
 */
const saliencyMap = (spec: RecordSpec): SaliencyMap => {
  const { width, height } = spec.map;
  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (const blob of spec.blobs) {
        const dx = (x + 0.5 - (blob.cx * width) / spec.imageSize.width) / blob.sx;
        const dy = (y + 0.5 - (blob.cy * height) / spec.imageSize.height) / blob.sy;
        value += blob.weight * Math.exp(-0.5 * (dx * dx + dy * dy));
      }
      raw.push(value);
    }
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  // A record whose blobs cancel or are missing has no distribution to scale to one, and
  // dividing anyway would commit 192 cells of `null`. Fail at the write, not three tickets
  // later when a metric reads the file.
  if (!(total > 0))
    throw new Error(
      `the map of a record with blobs ${JSON.stringify(spec.blobs)} sums to ${total}`,
    );
  const scale = 10 ** CELL_DECIMALS;
  return {
    width,
    height,
    values: raw.map((value) => Math.round((value / total) * scale) / scale),
    imageSize: spec.imageSize,
    normalisation: 'sum-to-one',
  };
};

/** A participant's fixations, with `tMs` run forward from the first one at zero. */
const scanpath = (spec: ScanpathSpec): Scanpath => {
  let onset = 0;
  const fixations: Fixation[] = spec.fixations.map((fixation, index) => {
    const tMs = onset;
    onset += fixation.durationMs + SACCADE_MS;
    return { index, tMs, durationMs: fixation.durationMs, x: fixation.x, y: fixation.y };
  });
  return { participantId: spec.participantId, fixations };
};

const display = (width: number, height: number, scale: number): Display => ({
  viewport: { width, height },
  scale,
});

/**
 * The corpus, as geometry. A cell of these maps is 20 image pixels a side, so a fixation at
 * the centre of cell `(cx, cy)` is the image pixel `(cx * 20 + 10, cy * 20 + 10)` — which
 * is how the fixations below were chosen, so that the participants of one record agree on
 * some cells and not on others.
 */
const SPECS: Record<CorpusRecordName, RecordSpec> = {
  // A light hero band on a mid-grey field: one obvious target, and three participants who
  // all look at it while agreeing on only some of its cells.
  'webpage-bright-hero': {
    category: 'webpage',
    imageSize: { width: 320, height: 240 },
    display: display(320, 240, 1),
    viewingDurationSeconds: 3,
    map: { width: 16, height: 12 },
    background: [120, 120, 120],
    regions: [{ box: { x: 60, y: 40, width: 140, height: 80 }, colour: [250, 250, 250] }],
    // Wider than tall, like the band it describes.
    blobs: [{ cx: 130, cy: 80, sx: 1.8, sy: 1.0, weight: 1 }],
    scanpaths: [
      {
        participantId: 'p-01',
        fixations: [
          { x: 130, y: 90, durationMs: 320 },
          { x: 90, y: 70, durationMs: 260 },
          { x: 170, y: 90, durationMs: 240 },
        ],
      },
      {
        participantId: 'p-02',
        fixations: [
          { x: 130, y: 90, durationMs: 300 },
          { x: 170, y: 90, durationMs: 280 },
          { x: 110, y: 50, durationMs: 220 },
        ],
      },
      {
        participantId: 'p-03',
        fixations: [
          { x: 130, y: 90, durationMs: 360 },
          { x: 150, y: 70, durationMs: 300 },
        ],
      },
    ],
  },
  // Two panels of the same brightness on a dark desktop: location alone cannot tell the
  // two apart, so only a metric that reads order sees that both participants went left
  // first.
  'desktop-two-panels': {
    category: 'desktop',
    imageSize: { width: 320, height: 240 },
    display: display(320, 240, 1),
    viewingDurationSeconds: 3,
    map: { width: 16, height: 12 },
    background: [90, 90, 90],
    regions: [
      { box: { x: 20, y: 60, width: 120, height: 120 }, colour: [240, 240, 240] },
      { box: { x: 180, y: 60, width: 120, height: 120 }, colour: [240, 240, 240] },
    ],
    blobs: [
      { cx: 80, cy: 120, sx: 1.4, sy: 1.6, weight: 1 },
      { cx: 240, cy: 120, sx: 1.4, sy: 1.6, weight: 1 },
    ],
    scanpaths: [
      {
        participantId: 'p-01',
        fixations: [
          { x: 80, y: 120, durationMs: 300 },
          { x: 70, y: 100, durationMs: 240 },
          { x: 240, y: 120, durationMs: 280 },
        ],
      },
      {
        participantId: 'p-02',
        fixations: [
          { x: 90, y: 130, durationMs: 320 },
          { x: 240, y: 120, durationMs: 300 },
          { x: 250, y: 150, durationMs: 220 },
        ],
      },
    ],
  },
  // A phone screenshot at a 2× device scale factor, cut at one second of viewing: one
  // participant, one fixation, which is as degenerate as ground truth gets.
  'mobile-single-fixation': {
    category: 'mobile',
    imageSize: { width: 240, height: 320 },
    display: display(120, 160, 2),
    viewingDurationSeconds: 1,
    map: { width: 12, height: 16 },
    background: [238, 238, 238],
    regions: [{ box: { x: 40, y: 60, width: 160, height: 80 }, colour: [40, 40, 40] }],
    blobs: [{ cx: 120, cy: 100, sx: 1.4, sy: 1.0, weight: 1 }],
    scanpaths: [{ participantId: 'p-01', fixations: [{ x: 120, y: 100, durationMs: 420 }] }],
  },
  // One flat colour, nothing painted on it, and a map so broad it is nearly uniform: a
  // confident prediction here is wrong, and a metric worth having says so.
  'poster-uniform-field': {
    category: 'poster',
    imageSize: { width: 320, height: 240 },
    display: display(320, 240, 1),
    viewingDurationSeconds: 3,
    map: { width: 16, height: 12 },
    background: [170, 170, 170],
    regions: [],
    // Spreads near the grid's own size: the field gives attention nothing to settle on.
    blobs: [{ cx: 160, cy: 120, sx: 9, sy: 7, weight: 1 }],
    scanpaths: [
      {
        participantId: 'p-01',
        fixations: [
          { x: 50, y: 50, durationMs: 240 },
          { x: 270, y: 190, durationMs: 220 },
          { x: 160, y: 120, durationMs: 260 },
        ],
      },
      {
        participantId: 'p-02',
        fixations: [
          { x: 270, y: 50, durationMs: 230 },
          { x: 50, y: 190, durationMs: 250 },
        ],
      },
    ],
  },
};

/** One record's spec, so the test asserts against the geometry the generator painted. */
export const corpusSpec = (name: CorpusRecordName): RecordSpec => SPECS[name];

export interface BuiltRecord {
  readonly data: CorpusRecordData;
  /** The image as raw RGB: the pixels the committed PNG encodes. */
  readonly sheet: Sheet;
}

/**
 * One record, built and painted but not written. `test/corpus.test.ts` builds every record
 * this way and compares it against the committed files, so the claim that the committed
 * bytes are this generator's output is asserted rather than documented.
 */
export const buildRecord = (name: CorpusRecordName): BuiltRecord => {
  const spec = SPECS[name];
  const target = sheet(spec.imageSize.width, spec.imageSize.height, spec.background);
  for (const region of spec.regions) paint(target, region.box, region.colour);
  return {
    data: {
      id: name,
      category: spec.category,
      imageSize: spec.imageSize,
      display: spec.display,
      viewingDurationSeconds: spec.viewingDurationSeconds,
      saliencyMap: saliencyMap(spec),
      scanpaths: spec.scanpaths.map((path) => scanpath(path)),
    },
    sheet: target,
  };
};

/** The committed PNG of a built record: the only place the encoder's options are set. */
export const encodeImage = async (built: BuiltRecord): Promise<Buffer> =>
  sharp(built.sheet.data, {
    raw: { width: built.sheet.width, height: built.sheet.height, channels: 3 },
  })
    // Explicit, so the bytes depend on nothing but the pixels: no metadata, no date.
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();

/** The committed JSON of a built record, formatted as the repository formats JSON. */
export const encodeData = (built: BuiltRecord): string =>
  `${JSON.stringify(built.data, null, 2)}\n`;

const write = async (
  name: CorpusRecordName,
): Promise<{ readonly json: number; readonly png: number }> => {
  const built = buildRecord(name);
  const paths = corpusRecordPaths(name);
  const json = encodeData(built);
  const png = await encodeImage(built);
  writeFileSync(paths.data, json, 'utf8');
  writeFileSync(paths.image, png);
  return { json: Buffer.byteLength(json), png: png.byteLength };
};

const main = async (): Promise<void> => {
  let total = 0;
  for (const name of CORPUS_RECORD_NAMES) {
    const { json, png } = await write(name);
    total += json + png;
    process.stdout.write(`${name}: ${png} B png, ${json} B json\n`);
  }
  process.stdout.write(`${CORPUS_RECORD_NAMES.length} records, ${total} B in all\n`);
};

/** Run as a script. An import — the test building the records — writes nothing. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
