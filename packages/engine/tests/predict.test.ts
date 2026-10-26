import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { defaultEngineConfig } from '../src/config.js';
import type { EngineConfigOverrides } from '../src/config.js';
import { predict } from '../src/predict.js';
import type { ImageSize, PredictorImage, SaliencyMap } from '../src/predict.js';
import { loadAllFixtures } from './fixtures/index.js';

/**
 * `predict` on a bare screenshot: no DOM, no goal, no persona (#68).
 *
 * What is asserted here is a property of the *output* — the map's resolution against the
 * image's, where its peak sits, where the first fixations land, what a changed parameter
 * moves — and never an intermediate salience value area by area (#7, Testing Decisions).
 *
 * The images are built with `sharp` in the test rather than taken from the shared capture
 * fixtures (#61), because the cases this path has to answer for are *images* and not
 * pages: one bright region on a flat field, a field with nothing on it at all, a very
 * small image and a very large one. The five committed fixtures are used too, as the
 * breadth over which the map's invariants are held.
 *
 * The statistical assertions run over a seeded generator with a fixed list of seeds, so
 * every number below is reproducible rather than probabilistic, and each band is stated in
 * its assertion wide enough to describe a direction rather than one sequence.
 */

/** Mid grey: the flat field every image below is painted on. */
const FIELD = { r: 128, g: 128, b: 128 };

/** Bright and saturated, so both contrast terms have something to find. */
const BRIGHT = { r: 255, g: 230, b: 0 };

/** The canonical test image's size, and the size the corpus states its ground truth at. */
const IMAGE: ImageSize = { width: 320, height: 240 };

/**
 * The one bright region on the flat field. Comfortably past every filter the segmenter
 * applies — a fifth of the image, 80 pixels on its shorter side, square-ish and
 * rectangular — so this test is about `predict` and not about whether #66 found anything.
 */
const REGION = { x: 60, y: 40, width: 140, height: 80 } as const;

const flatField = async (size: ImageSize = IMAGE): Promise<Uint8Array> =>
  sharp({ create: { width: size.width, height: size.height, channels: 3, background: FIELD } })
    .png()
    .toBuffer();

const withRegion = async (
  size: ImageSize = IMAGE,
  region: { x: number; y: number; width: number; height: number } = REGION,
): Promise<Uint8Array> => {
  const patch = await sharp({
    create: { width: region.width, height: region.height, channels: 3, background: BRIGHT },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size.width, height: size.height, channels: 3, background: FIELD },
  })
    .composite([{ input: patch, left: region.x, top: region.y }])
    .png()
    .toBuffer();
};

/** The size the bytes decode to, for the sweep over images of several shapes. */
const sizeOf = async (bytes: Uint8Array): Promise<ImageSize> => {
  const { width, height } = await sharp(bytes).metadata();
  return { width: width ?? 0, height: height ?? 0 };
};

const SEED = 7;

const bare = (bytes: Uint8Array, size: ImageSize = IMAGE): PredictorImage => ({ bytes, size });

/** The map's documented resolution: the image downscaled by `cellPx`, never below a cell. */
const expectedResolution = (
  size: ImageSize,
  cellPx: number = defaultEngineConfig.prediction.map.cellPx,
): { width: number; height: number } => ({
  width: Math.max(1, Math.round(size.width / cellPx)),
  height: Math.max(1, Math.round(size.height / cellPx)),
});

const sumOf = (map: SaliencyMap): number => map.values.reduce((total, value) => total + value, 0);

/** The cell holding the map's greatest value, as the image point at that cell's centre. */
const peakOf = (map: SaliencyMap): { x: number; y: number } => {
  let peak = 0;
  for (const [cell, value] of map.values.entries()) if (value > map.values[peak]) peak = cell;
  return {
    x: ((peak % map.width) + 0.5) * (map.imageSize.width / map.width),
    y: (Math.floor(peak / map.width) + 0.5) * (map.imageSize.height / map.height),
  };
};

const inside = (
  point: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number },
): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

/** Every seed the statistical assertions average over. Fixed, so the numbers are stable. */
const SEEDS = Array.from({ length: 40 }, (_unused, position) => position + 1);

/** The six salience terms with every weight off: no bottom-up preference of any kind. */
const NO_SALIENCE_TERMS = {
  luminanceContrast: 0,
  colourContrast: 0,
  relativeArea: 0,
  centreBias: 0,
  topBias: 0,
  rolePrior: 0,
} as const;

/**
 * Where a configuration's fixations sit on a flat field, over every seed: the mean distance
 * from the image's centre as a share of its half-diagonal, and the mean height as a share
 * of the image. Both are means over hundreds of fixations, so a prior that moves the
 * sampling moves them well clear of the sampling noise.
 */
const whereTheLooksLand = async (
  bytes: Uint8Array,
  weights: EngineConfigOverrides,
): Promise<{ distanceFromCentre: number; height: number; fixations: number }> => {
  let distance = 0;
  let height = 0;
  let fixations = 0;
  for (const seed of SEEDS) {
    const { scanpath } = await predict(bare(bytes), seed, { weights });
    for (const fixation of scanpath.fixations) {
      const offsetX = fixation.x / IMAGE.width - 0.5;
      const offsetY = fixation.y / IMAGE.height - 0.5;
      distance += Math.sqrt(offsetX * offsetX + offsetY * offsetY);
      height += fixation.y / IMAGE.height;
      fixations += 1;
    }
  }
  return {
    distanceFromCentre: distance / fixations,
    height: height / fixations,
    fixations,
  };
};

describe('predict on a bare screenshot', () => {
  it('answers a map at the documented resolution and a non-empty scanpath', async () => {
    const { saliencyMap, scanpath } = await predict(bare(await withRegion()), SEED);

    expect({ width: saliencyMap.width, height: saliencyMap.height }).toEqual(
      expectedResolution(IMAGE),
    );
    // The documented resolution for the canonical image, written out: a 20-pixel cell.
    expect([saliencyMap.width, saliencyMap.height]).toEqual([16, 12]);
    expect(saliencyMap.values).toHaveLength(saliencyMap.width * saliencyMap.height);
    expect(saliencyMap.imageSize).toEqual(IMAGE);
    expect(scanpath.fixations.length).toBeGreaterThan(0);
  });

  it('belongs to no participant, and names no area of interest or screen', async () => {
    const { scanpath } = await predict(bare(await withRegion()), SEED);

    expect(scanpath.participantId).toBeNull();
    for (const fixation of scanpath.fixations) {
      expect(Object.keys(fixation).sort()).toEqual(['durationMs', 'index', 'tMs', 'x', 'y']);
    }
  });

  it('runs the scanpath in order, from a clock that starts at zero and rises', async () => {
    const { scanpath } = await predict(bare(await withRegion()), SEED);

    expect(scanpath.fixations.map((fixation) => fixation.index)).toEqual(
      scanpath.fixations.map((_unused, position) => position),
    );
    expect(scanpath.fixations[0].tMs).toBe(0);
    for (const [position, fixation] of scanpath.fixations.entries()) {
      if (position > 0) expect(fixation.tMs).toBeGreaterThan(scanpath.fixations[position - 1].tMs);
      expect(fixation.durationMs).toBeGreaterThan(0);
    }
  });

  it('keeps every fixation inside the image, in image pixels', async () => {
    const { scanpath } = await predict(bare(await withRegion()), SEED);

    for (const fixation of scanpath.fixations) {
      expect(fixation.x).toBeGreaterThanOrEqual(0);
      expect(fixation.y).toBeGreaterThanOrEqual(0);
      expect(fixation.x).toBeLessThanOrEqual(IMAGE.width);
      expect(fixation.y).toBeLessThanOrEqual(IMAGE.height);
    }
  });
});

describe('the same image and seed', () => {
  it('answer a byte-identical map and scanpath', async () => {
    const bytes = await withRegion();

    const first = await predict(bare(bytes), SEED);
    const second = await predict(bare(bytes), SEED);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('and a different seed answers a different scanpath', async () => {
    const bytes = await withRegion();

    const first = await predict(bare(bytes), SEED);
    const other = await predict(bare(bytes), SEED + 1);

    expect(JSON.stringify(other.scanpath)).not.toBe(JSON.stringify(first.scanpath));
    expect(JSON.stringify(other.saliencyMap)).not.toBe(JSON.stringify(first.saliencyMap));
  });
});

describe('the saliency map', () => {
  /** The five committed fixtures plus the two synthetic extremes: the breadth of images. */
  const everyImage = async (): Promise<readonly { name: string; bytes: Uint8Array }[]> => [
    ...loadAllFixtures().map((fixture) => ({
      name: fixture.name,
      bytes: new Uint8Array(readFileSync(fixture.screenshotPath)),
    })),
    { name: 'one bright region', bytes: await withRegion() },
    { name: 'a flat field', bytes: await flatField() },
  ];

  it('is finite, non-negative and sums to one on every tested image', async () => {
    for (const { name, bytes } of await everyImage()) {
      const { saliencyMap } = await predict(bare(bytes, await sizeOf(bytes)), SEED);

      expect({ name, normalisation: saliencyMap.normalisation }).toEqual({
        name,
        normalisation: 'sum-to-one',
      });
      for (const value of saliencyMap.values) {
        expect(Number.isFinite(value) && value >= 0).toBe(true);
      }
      expect({ name, sum: Number(sumOf(saliencyMap).toFixed(9)) }).toEqual({ name, sum: 1 });
    }
  });

  it('is the image downscaled by cellPx, for a very small image and a very large one', async () => {
    const tiny: ImageSize = { width: 24, height: 16 };
    const huge: ImageSize = { width: 1600, height: 1200 };

    const small = await predict(bare(await flatField(tiny), tiny), SEED);
    const large = await predict(
      bare(await withRegion(huge, { ...REGION, x: 600, y: 400 }), huge),
      SEED,
    );

    expect({ width: small.saliencyMap.width, height: small.saliencyMap.height }).toEqual(
      expectedResolution(tiny),
    );
    // An image smaller than one cell still gets a map: one cell, holding all of the mass.
    expect([small.saliencyMap.width, small.saliencyMap.height]).toEqual([1, 1]);
    expect(small.saliencyMap.values).toEqual([1]);
    expect(small.scanpath.fixations.length).toBeGreaterThan(0);

    expect({ width: large.saliencyMap.width, height: large.saliencyMap.height }).toEqual(
      expectedResolution(huge),
    );
    expect(Number(sumOf(large.saliencyMap).toFixed(9))).toBe(1);
  });

  it('takes its resolution from the configuration rather than from this module', async () => {
    const bytes = await withRegion();
    const cellPx = 40;

    const { saliencyMap } = await predict(bare(bytes), SEED, {
      weights: { prediction: { map: { cellPx } } },
    });

    expect({ width: saliencyMap.width, height: saliencyMap.height }).toEqual(
      expectedResolution(IMAGE, cellPx),
    );
  });

  it('spreads a fixation further when the configured kernel is widened', async () => {
    const bytes = await withRegion();

    const { saliencyMap: narrow } = await predict(bare(bytes), SEED);
    const { saliencyMap: wide } = await predict(bare(bytes), SEED, {
      weights: { prediction: { map: { kernelSigmaShare: 0.3 } } },
    });

    // The mass is the same — both sum to one — so a wider kernel is a lower peak.
    expect(Math.max(...wide.values)).toBeLessThan(Math.max(...narrow.values));
    expect(wide.values.filter((value) => value > 0).length).toBeGreaterThan(
      narrow.values.filter((value) => value > 0).length,
    );
  });

  it('weighs fixations by dwell, and counts them when the exponent is zeroed', async () => {
    const bytes = await withRegion();

    const { saliencyMap: byDwell } = await predict(bare(bytes), SEED);
    const { saliencyMap: byCount } = await predict(bare(bytes), SEED, {
      weights: { prediction: { map: { dwellWeightExponent: 0 } } },
    });

    expect(byCount.values).not.toEqual(byDwell.values);
    expect(Number(sumOf(byCount).toFixed(9))).toBe(1);
  });
});

describe('one bright region on a flat field', () => {
  it('puts the map’s peak inside the region', async () => {
    const { saliencyMap } = await predict(bare(await withRegion()), SEED);

    expect(inside(peakOf(saliencyMap), REGION)).toBe(true);
  });

  it('lands the first fixations of the scanpath in it', async () => {
    const { scanpath } = await predict(bare(await withRegion()), SEED);

    for (const fixation of scanpath.fixations.slice(0, 3)) {
      expect({ x: Math.round(fixation.x), y: Math.round(fixation.y), inRegion: true }).toEqual({
        x: Math.round(fixation.x),
        y: Math.round(fixation.y),
        inRegion: inside(fixation, REGION),
      });
    }
  });

  it('does so from whichever seed it is given', async () => {
    const bytes = await withRegion();

    for (const seed of SEEDS.slice(0, 8)) {
      const { scanpath, saliencyMap } = await predict(bare(bytes), seed);
      expect({ seed, peakInRegion: inside(peakOf(saliencyMap), REGION) }).toEqual({
        seed,
        peakInRegion: true,
      });
      expect({ seed, firstInRegion: inside(scanpath.fixations[0], REGION) }).toEqual({
        seed,
        firstInRegion: true,
      });
    }
  });
});

/**
 * An image with nothing in it is not a degenerate case to special-case away: it is an
 * image a human still looks at, and the position priors are what is left to say where.
 * The segmenter honestly finds nothing on a flat field — that is #66's whole point — so
 * `predict` falls back to a grid of cells and scores those with the same salience terms.
 * The three assertions below are the expected behaviour, not a tolerated one.
 */
describe('a flat, featureless image', () => {
  it('still answers a valid map and a non-empty scanpath', async () => {
    const { saliencyMap, scanpath } = await predict(bare(await flatField()), SEED);

    expect(scanpath.fixations.length).toBeGreaterThan(0);
    expect({ width: saliencyMap.width, height: saliencyMap.height }).toEqual(
      expectedResolution(IMAGE),
    );
    expect(Number(sumOf(saliencyMap).toFixed(9))).toBe(1);
    expect(saliencyMap.values.some((value) => value > 0)).toBe(true);
    // Not one blob in one place: the looks are spread over the grid of prior cells.
    expect(
      new Set(scanpath.fixations.map((fixation) => Math.round(fixation.x))).size,
    ).toBeGreaterThan(1);
  });

  it('is driven by the centre bias, which pulls the looks inward', async () => {
    const bytes = await flatField();

    const withoutPriors = await whereTheLooksLand(bytes, {
      salience: { weights: NO_SALIENCE_TERMS },
    });
    const withCentreBias = await whereTheLooksLand(bytes, {
      alpha: 8,
      salience: { weights: { ...NO_SALIENCE_TERMS, centreBias: 1 } },
    });

    // 0.373 with no prior at all against 0.211 with the centre bias leading: a quarter
    // nearer the centre is the direction, not the particular pair of numbers.
    expect(withCentreBias.distanceFromCentre).toBeLessThan(withoutPriors.distanceFromCentre * 0.75);
    expect(withoutPriors.fixations).toBeGreaterThan(0);
  });

  it('and by the top bias, which pulls them up the image', async () => {
    const bytes = await flatField();

    const withoutPriors = await whereTheLooksLand(bytes, {
      salience: { weights: NO_SALIENCE_TERMS },
    });
    const withTopBias = await whereTheLooksLand(bytes, {
      alpha: 8,
      salience: { weights: { ...NO_SALIENCE_TERMS, topBias: 1 } },
    });

    // With no prior the mean look sits at about half the image's height; with the top bias
    // leading it sits in the upper third.
    expect(withoutPriors.height).toBeGreaterThan(0.4);
    expect(withTopBias.height).toBeLessThan(0.33);
  });
});

describe('the display a prediction was made at', () => {
  it('is defaulted from the image’s own dimensions and reported back', async () => {
    const { display } = await predict(bare(await withRegion()), SEED);

    expect(display).toEqual({ viewport: { width: 320, height: 240 }, scale: 1 });
  });

  it('is the caller’s when one is given, and the scanpath stays in image pixels', async () => {
    const bytes = await withRegion();
    const display = { viewport: { width: 160, height: 120 }, scale: 2 };

    const prediction = await predict({ bytes, size: IMAGE, display }, SEED);

    expect(prediction.display).toEqual(display);
    expect(prediction.saliencyMap.imageSize).toEqual(IMAGE);
    for (const fixation of prediction.scanpath.fixations) {
      expect(fixation.x).toBeLessThanOrEqual(IMAGE.width);
      expect(fixation.y).toBeLessThanOrEqual(IMAGE.height);
    }
    expect(inside(prediction.scanpath.fixations[0], REGION)).toBe(true);
  });

  it('is defaulted rather than carried when a given number is not a usable one', async () => {
    const bytes = await withRegion();

    const prediction = await predict(
      { bytes, size: IMAGE, display: { viewport: { width: 0, height: Number.NaN }, scale: 0 } },
      SEED,
    );

    expect(prediction.display).toEqual({ viewport: { width: 320, height: 240 }, scale: 1 });
  });

  it('reads the scanpath in the image’s space even when the display disagrees', async () => {
    const bytes = await withRegion();

    // A display that cannot be true of a 320x240 image: 320 CSS pixels at 2 image pixels
    // each would be a 640-pixel-wide image. The regions are still laid out in the page the
    // viewport describes, so the fixations have to come back in the same space — scaling
    // them by `display.scale` would push every one of them off the region it was drawn in,
    // and the clamp would hide it as a plausible prediction.
    const prediction = await predict(
      { bytes, size: IMAGE, display: { viewport: { width: 320, height: 240 }, scale: 2 } },
      SEED,
    );

    expect(inside(prediction.scanpath.fixations[0], REGION)).toBe(true);
    expect(inside(peakOf(prediction.saliencyMap), REGION)).toBe(true);
  });

  it('scales each axis by its own factor when the viewport’s shape disagrees', async () => {
    const bytes = await withRegion();

    // Half the width in CSS pixels and the full height: the horizontal factor is 2 and the
    // vertical factor is 1, which one scale cannot express.
    const prediction = await predict(
      { bytes, size: IMAGE, display: { viewport: { width: 160, height: 240 }, scale: 2 } },
      SEED,
    );

    for (const fixation of prediction.scanpath.fixations) {
      expect({ inRegion: true, x: fixation.x }).toEqual({
        inRegion: inside(fixation, REGION),
        x: fixation.x,
      });
    }
  });

  it('describes the image the bytes decoded to, not a declared size that disagrees', async () => {
    const bytes = await withRegion();

    const { saliencyMap } = await predict({ bytes, size: { width: 9999, height: 1 } }, SEED);

    expect(saliencyMap.imageSize).toEqual(IMAGE);
  });
});

/**
 * Two ways a prediction could come back plausible and wrong, and does not.
 *
 * `buildAois` swallows a segmenter's throw because a segmenter is additive to the areas the
 * elements explain. Here there are no elements, so a swallowed throw would be reported as
 * an image with nothing in it; and `resolveEngineConfig` validates no override, so a leaf
 * that is not a number could ask for an array of invalid length or a grid of no cells.
 */
describe('a failure is not reported as a flat image', () => {
  it('raises a segmenter’s error rather than falling back to the position priors', async () => {
    const bytes = await withRegion();
    const broken = {
      segment: () => {
        throw new Error('the segmenter broke');
      },
    };

    await expect(predict(bare(bytes), SEED, { segmenter: broken })).rejects.toThrow(
      'the segmenter broke',
    );
  });

  it('still answers a valid prediction when a configured leaf is not a number', async () => {
    const bytes = await flatField();

    const coarse = await predict(bare(bytes), SEED, {
      weights: { prediction: { map: { cellPx: Number.NaN } } },
    });
    const gridless = await predict(bare(bytes), SEED, {
      weights: { prediction: { priorGridCellsAcross: Number.NaN } },
    });

    // One image pixel a cell, which is the floor of the documented relationship.
    expect({ width: coarse.saliencyMap.width, height: coarse.saliencyMap.height }).toEqual(IMAGE);
    expect(Number(sumOf(coarse.saliencyMap).toFixed(9))).toBe(1);
    expect(gridless.scanpath.fixations.length).toBeGreaterThan(0);
    expect(Number(sumOf(gridless.saliencyMap).toFixed(9))).toBe(1);
  });
});

/**
 * The seam the calibration step scores this function through, restated field for field.
 *
 * Neither package may import the other: `@personavision/engine` depends on
 * `@personavision/contract` and `sharp` only (#7, asserted in `tests/config.test.ts`), and
 * `packages/calibration/test/dependency-direction.test.ts` asserts that no file in
 * `packages/engine` imports the calibration package. So the seam is held the way
 * `tests/types.test.ts` holds the browser step's `Capture`: the other side's types are
 * written out here, and the assignment below is checked by `tsc -p tsconfig.tests.json`.
 * A field renamed on either side fails the build here rather than at the point of wiring.
 */
interface CalibrationImageSize {
  readonly width: number;
  readonly height: number;
}
interface CalibrationDisplay {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly scale: number;
}
interface CalibrationSaliencyMap {
  readonly width: number;
  readonly height: number;
  readonly values: readonly number[];
  readonly imageSize: CalibrationImageSize;
  readonly normalisation: 'sum-to-one' | 'peak-to-one' | 'none';
}
interface CalibrationFixation {
  readonly index: number;
  readonly tMs: number;
  readonly durationMs: number;
  readonly x: number;
  readonly y: number;
}
interface CalibrationScanpath {
  readonly participantId: string | null;
  readonly fixations: readonly CalibrationFixation[];
}
interface CalibrationPredictorImage {
  readonly bytes: Uint8Array;
  readonly size: CalibrationImageSize;
  readonly display: CalibrationDisplay;
}
interface CalibrationPrediction {
  readonly saliencyMap: CalibrationSaliencyMap;
  readonly scanpath: CalibrationScanpath;
  readonly display?: CalibrationDisplay;
}
type CalibrationPredictor = (
  image: CalibrationPredictorImage,
  seed: number,
) => CalibrationPrediction | Promise<CalibrationPrediction>;

describe('the Predictor seam', () => {
  it('is satisfied by predict, with the image and the seed the benchmark hands over', async () => {
    const scoreThrough: CalibrationPredictor = predict;
    const bytes = await withRegion();

    const prediction = await scoreThrough(
      { bytes, size: IMAGE, display: { viewport: { width: 320, height: 240 }, scale: 1 } },
      SEED,
    );

    expect(prediction.saliencyMap.normalisation).toBe('sum-to-one');
    expect(prediction.scanpath.participantId).toBeNull();
    expect(prediction.scanpath.fixations.length).toBeGreaterThan(0);
  });
});

describe('the package docs', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  /**
   * #68's criterion: a reviewer of a reported figure has to be able to read what was
   * compared, because CC, NSS, KLD and AUC-Judd are each sensitive to some of it.
   */
  it('state the resolution, the kernel, the normalisation and the convention', () => {
    for (const stated of [
      'cellPx',
      'kernelSigmaShare',
      'kernelRadiusSigmas',
      'dwellWeightExponent',
      'sum-to-one',
      'values[y * width + x]',
      'CC, NSS, KLD and AUC-Judd',
    ]) {
      expect({ stated, inReadme: readme.includes(stated) }).toEqual({ stated, inReadme: true });
    }
  });
});
