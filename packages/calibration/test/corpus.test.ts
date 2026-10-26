import { readFileSync, statSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildRecord, corpusSpec, encodeData } from '../scripts/make-corpus.js';
import { corpusRecordPaths, parseCorpusRecordData } from '../src/corpus.js';
import {
  CORPUS_RECORD_NAMES,
  CorpusError,
  loadCorpus,
  loadCorpusCategory,
  loadCorpusRecord,
  RECORD_CATEGORIES,
} from '../src/index.js';
import type { CorpusRecordName, Fixation, GroundTruthRecord } from '../src/index.js';

/**
 * The corpus is step #11's shared test material, so this file asserts four things about it:
 * that the committed files really are the generator's output, that every record holds the
 * invariants a later ticket will read without re-checking, that the property each record
 * exists for is measurably there in the committed bytes, and that the loader fails loudly.
 *
 * A metric ticket asserting "an over-confident prediction is punished on a uniform field"
 * is only testing something if the field really is uniform.
 */

/** Total committed bytes, as `docs/corpus.md` states the budget. */
const SIZE_BUDGET_BYTES = 32 * 1024;

/**
 * How far the cells of a committed map may sum from one. The generator rounds each cell to
 * twelve decimal places so the JSON is compact and stable, which moves the sum by at most
 * a few hundred times 5e-13; `docs/corpus.md` states this tolerance.
 */
const SUM_TOLERANCE = 1e-9;

/** The cell a fixation falls in, by the rule `SaliencyMap` documents. */
const cellOf = (record: GroundTruthRecord, fixation: Fixation): string => {
  const { width, height } = record.saliencyMap;
  const x = Math.floor((fixation.x * width) / record.imageSize.width);
  const y = Math.floor((fixation.y * height) / record.imageSize.height);
  return `${x},${y}`;
};

/** The share of a map's mass held by its ten heaviest cells: how concentrated it is. */
const topCellShare = (record: GroundTruthRecord, cells = 10): number => {
  const sorted = [...record.saliencyMap.values].sort((a, b) => b - a);
  return sorted.slice(0, cells).reduce((sum, value) => sum + value, 0);
};

/** The heaviest cell over the mean cell: 1 is perfectly flat. */
const peakOverMean = (record: GroundTruthRecord): number => {
  const { values } = record.saliencyMap;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.max(...values) / (total / values.length);
};

/**
 * The human-to-human agreement of a record: the mean Jaccard overlap of the map cells two
 * participants fixated, over every pair of them.
 *
 * This is a deliberately plain stand-in for ScanMatch, computed here rather than imported:
 * #84 owns the real scanpath metrics and this package may not wait for them to assert that
 * the corpus has a ceiling to measure. What it pins is the property #84 needs — that the
 * participants of one record agree in part and not in whole — not a published figure.
 */
const humanAgreement = (record: GroundTruthRecord): number => {
  const cellSets = record.scanpaths.map(
    (scanpath) => new Set(scanpath.fixations.map((fixation) => cellOf(record, fixation))),
  );
  const overlaps: number[] = [];
  for (let i = 0; i < cellSets.length; i += 1) {
    for (let j = i + 1; j < cellSets.length; j += 1) {
      const a = cellSets[i];
      const b = cellSets[j];
      if (a === undefined || b === undefined) throw new Error('missing scanpath');
      const shared = [...a].filter((cell) => b.has(cell)).length;
      overlaps.push(shared / (a.size + b.size - shared));
    }
  }
  if (overlaps.length === 0) throw new Error(`${record.id} has only one scanpath`);
  return overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length;
};

/** The committed image as single-channel luminance, in image space. */
const luminanceOf = async (
  imagePath: string,
): Promise<{ readonly width: number; readonly height: number; readonly data: Uint8Array }> => {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(1);
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
};

const meanLuminance = (
  image: { readonly width: number; readonly height: number; readonly data: Uint8Array },
  area: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): number => {
  let total = 0;
  let count = 0;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const level = image.data[y * image.width + x];
      // An area reaching outside the image is a misstated region, not a dark one: averaging
      // in zeros would let a wrong box still satisfy a contrast assertion.
      if (level === undefined || x < 0 || y < 0 || x >= image.width || y >= image.height) {
        throw new Error(`the area leaves the image at ${x},${y}`);
      }
      total += level;
      count += 1;
    }
  }
  return total / count;
};

const record = (name: CorpusRecordName): GroundTruthRecord => loadCorpusRecord(name);

describe.each(CORPUS_RECORD_NAMES)('%s', (name) => {
  it('is the committed output of the generator', async () => {
    const built = buildRecord(name);
    const paths = corpusRecordPaths(name);
    // Both files, because a record is its JSON and its image together: a map regenerated
    // against a differently painted image would still be a corpus that does not hold.
    expect(readFileSync(paths.data, 'utf8')).toBe(encodeData(built));
    // The image is compared as pixels rather than as PNG bytes, as the engine's fixtures
    // are: the deflate stream depends on the architecture `sharp` was built for, so
    // comparing it would fail on a machine that is not the one the corpus was generated
    // on. An encoder upgrade is not a failure here; a differently painted image is.
    const { data, info } = await sharp(paths.image).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(Buffer.from(data).equals(Buffer.from(built.sheet.data))).toBe(true);
  });

  it('loads as the ground truth #81 declares', () => {
    // The declared type is the assertion — `loadCorpusRecord` returns `GroundTruthRecord`,
    // so a record missing a field fails `pnpm typecheck`. What is left to check at runtime
    // is that the committed bytes carry what the compiler cannot see.
    const loaded: GroundTruthRecord = record(name);
    expect(loaded.id).toBe(name);
    expect(RECORD_CATEGORIES).toContain(loaded.category);
    expect(loaded.imagePath).toBe(corpusRecordPaths(name).image);
    expect(loaded.saliencyMap.normalisation).toBe('sum-to-one');
    expect(loaded.scanpaths.length).toBeGreaterThan(0);
  });

  it('has a map that is finite, non-negative and summed to one', () => {
    const { saliencyMap, imageSize } = record(name);
    expect(saliencyMap.values).toHaveLength(saliencyMap.width * saliencyMap.height);
    const bad = saliencyMap.values.filter((value) => !Number.isFinite(value) || value < 0);
    expect(bad).toEqual([]);
    const sum = saliencyMap.values.reduce((total, value) => total + value, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(SUM_TOLERANCE);
    expect(saliencyMap.imageSize).toEqual(imageSize);
    // The map is coarser than the image and agrees with its aspect ratio, so a metric
    // comparing cell for cell is comparing the same picture.
    expect(saliencyMap.width).toBeLessThan(imageSize.width);
    expect(imageSize.width * saliencyMap.height).toBe(imageSize.height * saliencyMap.width);
  });

  it('names the display the humans saw, and it covers the image exactly', () => {
    const { display, imageSize } = record(name);
    expect({
      width: display.viewport.width * display.scale,
      height: display.viewport.height * display.scale,
    }).toEqual(imageSize);
  });

  it('matches the image it names', async () => {
    const loaded = record(name);
    const image = await sharp(loaded.imagePath).metadata();
    expect({ width: image.width, height: image.height }).toEqual(loaded.imageSize);
  });

  it('keeps every fixation inside the image, in order, with a positive dwell', () => {
    const loaded = record(name);
    for (const scanpath of loaded.scanpaths) {
      expect(scanpath.participantId).not.toBeNull();
      expect(scanpath.fixations.length).toBeGreaterThan(0);
      expect(scanpath.fixations.map((fixation) => fixation.index)).toEqual(
        scanpath.fixations.map((_, index) => index),
      );
      let previousEnd = -1;
      for (const fixation of scanpath.fixations) {
        const inside =
          fixation.x >= 0 &&
          fixation.y >= 0 &&
          fixation.x < loaded.imageSize.width &&
          fixation.y < loaded.imageSize.height;
        expect({ fixation: fixation.index, inside }).toEqual({
          fixation: fixation.index,
          inside: true,
        });
        expect(fixation.durationMs).toBeGreaterThan(0);
        // A fixation begins after the one before it ended: the gap is the saccade.
        expect(fixation.tMs).toBeGreaterThan(previousEnd);
        previousEnd = fixation.tMs + fixation.durationMs;
      }
      // The ground truth is cut at a stated viewing duration and does not run past it.
      expect(previousEnd).toBeLessThanOrEqual(loaded.viewingDurationSeconds * 1000);
    }
    const participants = loaded.scanpaths.map((scanpath) => scanpath.participantId);
    expect(new Set(participants).size).toBe(participants.length);
  });
});

describe('the property each record exists for', () => {
  it('webpage-bright-hero: the map is measurably peaked, on a measurably brighter region', async () => {
    const loaded = record('webpage-bright-hero');
    expect(topCellShare(loaded)).toBeGreaterThan(0.5);
    expect(peakOverMean(loaded)).toBeGreaterThan(10);

    const spec = corpusSpec('webpage-bright-hero');
    const hero = spec.regions[0];
    if (hero === undefined) throw new Error('the hero record paints no region');
    const image = await luminanceOf(loaded.imagePath);
    const field = { x: 0, y: spec.imageSize.height - 40, width: spec.imageSize.width, height: 40 };
    expect(meanLuminance(image, hero.box) - meanLuminance(image, field)).toBeGreaterThan(100);

    // The humans looked at the region, not past it.
    for (const scanpath of loaded.scanpaths) {
      for (const fixation of scanpath.fixations) {
        const inside =
          fixation.x >= hero.box.x &&
          fixation.x < hero.box.x + hero.box.width &&
          fixation.y >= hero.box.y &&
          fixation.y < hero.box.y + hero.box.height;
        expect({ participant: scanpath.participantId, inside }).toEqual({
          participant: scanpath.participantId,
          inside: true,
        });
      }
    }
  });

  it('poster-uniform-field: the map is measurably flat, on one flat colour', async () => {
    const loaded = record('poster-uniform-field');
    expect(topCellShare(loaded)).toBeLessThan(0.1);
    expect(peakOverMean(loaded)).toBeLessThan(1.5);
    // Flatter than every other record in the corpus, by both measures.
    for (const other of loadCorpus()) {
      if (other.id === loaded.id) continue;
      expect({ id: other.id, flatter: topCellShare(loaded) < topCellShare(other) }).toEqual({
        id: other.id,
        flatter: true,
      });
    }

    const image = await luminanceOf(loaded.imagePath);
    expect(new Set(image.data).size).toBe(1);
    expect(corpusSpec('poster-uniform-field').regions).toEqual([]);
  });

  it('desktop-two-panels: two regions of equal weight, visited in a fixed order', () => {
    const loaded = record('desktop-two-panels');
    const spec = corpusSpec('desktop-two-panels');
    expect(spec.regions).toHaveLength(2);
    const [left, right] = spec.regions;
    if (left === undefined || right === undefined) throw new Error('two panels expected');
    // Equally bright, so no predictor can prefer one by brightness alone.
    expect(left.colour).toEqual(right.colour);

    // Equal mass either side of the midline, so location alone cannot order them.
    const { saliencyMap } = loaded;
    const half = saliencyMap.width / 2;
    let leftMass = 0;
    let rightMass = 0;
    saliencyMap.values.forEach((value, index) => {
      if (index % saliencyMap.width < half) leftMass += value;
      else rightMass += value;
    });
    expect(Math.abs(leftMass - rightMass)).toBeLessThan(1e-6);

    // Every participant looked at the left panel before the right one, which is the only
    // thing distinguishing the two and the thing an order-sensitive metric must see.
    const midline = loaded.imageSize.width / 2;
    for (const scanpath of loaded.scanpaths) {
      const sides = scanpath.fixations.map((fixation) => (fixation.x < midline ? 'left' : 'right'));
      expect({ participant: scanpath.participantId, sides }).toEqual({
        participant: scanpath.participantId,
        sides: [...sides].sort((a, b) => (a === b ? 0 : a === 'left' ? -1 : 1)),
      });
      expect(sides).toContain('left');
      expect(sides).toContain('right');
    }
  });

  it('mobile-single-fixation: one participant, one fixation, at a 2× device scale factor', () => {
    const loaded = record('mobile-single-fixation');
    expect(loaded.scanpaths).toHaveLength(1);
    expect(loaded.scanpaths[0]?.fixations).toHaveLength(1);
    expect(loaded.scanpaths[0]?.fixations[0]?.index).toBe(0);
    expect(loaded.scanpaths[0]?.fixations[0]?.tMs).toBe(0);
    expect(loaded.viewingDurationSeconds).toBe(1);
    expect(loaded.display.scale).toBe(2);
  });

  it('webpage-bright-hero: its participants give an agreement ceiling to measure', () => {
    const loaded = record('webpage-bright-hero');
    expect(loaded.scanpaths.length).toBeGreaterThan(2);
    const agreement = humanAgreement(loaded);
    // Neither 0 nor 1: the participants overlap in part, so #84's human-to-human ceiling is
    // a number between the two and not a degenerate case in disguise.
    expect(agreement).toBeGreaterThan(0);
    expect(agreement).toBeLessThan(1);
  });
});

describe('the loader', () => {
  it('returns one record by name', () => {
    expect(loadCorpusRecord('webpage-bright-hero').id).toBe('webpage-bright-hero');
  });

  it('loads every declared record, in corpus order', () => {
    expect(loadCorpus().map((loaded) => loaded.id)).toEqual([...CORPUS_RECORD_NAMES]);
  });

  it('holds every category, so no per-category report is empty', () => {
    const categories = loadCorpus().map((loaded) => loaded.category);
    for (const category of RECORD_CATEGORIES) expect(categories).toContain(category);
  });

  it('returns all the records of one category', () => {
    expect(loadCorpusCategory('webpage').map((loaded) => loaded.id)).toEqual([
      'webpage-bright-hero',
    ]);
    for (const category of RECORD_CATEGORIES) {
      const loaded = loadCorpusCategory(category);
      expect({ category, empty: loaded.length === 0 }).toEqual({ category, empty: false });
      expect(loaded.every((one) => one.category === category)).toBe(true);
    }
  });

  it('fails loudly on an unknown name, naming the records that exist', () => {
    expect(() => loadCorpusRecord('ueyes-0001')).toThrow(CorpusError);
    expect(() => loadCorpusRecord('ueyes-0001')).toThrow(/webpage-bright-hero/);
  });

  it('fails loudly on an unknown category, naming the categories', () => {
    expect(() => loadCorpusCategory('email')).toThrow(CorpusError);
    expect(() => loadCorpusCategory('email')).toThrow(/webpage, desktop, mobile, poster/);
  });

  it('fails loudly on a file that is not the record it is named after', () => {
    const sound = JSON.parse(
      readFileSync(corpusRecordPaths('webpage-bright-hero').data, 'utf8'),
    ) as Record<string, unknown>;
    expect(() => parseCorpusRecordData('webpage-bright-hero', sound)).not.toThrow();
    expect(() => parseCorpusRecordData('webpage-bright-hero', 'not an object')).toThrow(
      CorpusError,
    );
    expect(() =>
      parseCorpusRecordData('webpage-bright-hero', { ...sound, id: 'desktop-two-panels' }),
    ).toThrow(/not its name/);
    expect(() =>
      parseCorpusRecordData('webpage-bright-hero', { ...sound, category: 'email' }),
    ).toThrow(/not one of/);
    expect(() =>
      parseCorpusRecordData('webpage-bright-hero', {
        ...sound,
        saliencyMap: { width: 16, height: 12, values: [1], imageSize: {}, normalisation: 'none' },
      }),
    ).toThrow(/192 cells/);
    expect(() => parseCorpusRecordData('webpage-bright-hero', { ...sound, scanpaths: [] })).toThrow(
      /carries no scanpath/,
    );
    expect(() =>
      parseCorpusRecordData('webpage-bright-hero', {
        ...sound,
        saliencyMap: { ...(sound.saliencyMap as object), normalisation: 'peak-to-one' },
      }),
    ).toThrow(/not sum-to-one/);
    expect(() =>
      parseCorpusRecordData('webpage-bright-hero', { ...sound, viewingDurationSeconds: 2 }),
    ).toThrow(/not one of 1, 3, 7/);
  });
});

describe('the committed bytes', () => {
  it(`stay under the ${SIZE_BUDGET_BYTES} byte budget the corpus doc states`, () => {
    const total = CORPUS_RECORD_NAMES.map((name) => corpusRecordPaths(name))
      .flatMap((paths) => [paths.data, paths.image])
      .reduce((sum, path) => sum + statSync(path).size, 0);
    expect(total).toBeLessThan(SIZE_BUDGET_BYTES);
  });
});
