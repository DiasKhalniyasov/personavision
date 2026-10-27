import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSeededRandom } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCANPATH,
  BaselineError,
  CENTRE_BIAS_PRIOR,
  MAP_RENDERING,
  RANDOM_FIXATION_UNIFORMITY,
  centreBiasBaseline,
  centreBiasPeakCell,
  centreBiasPrior,
  mapResolution,
  randomFixationBaseline,
  renderSaliencyMap,
  sampleDurationMs,
  scanpathOf,
} from '../src/baselines/index.js';
import { loadCorpus } from '../src/corpus.js';
import { cc } from '../src/metrics/saliency.js';
import { scoreScanpathAgainstHumans } from '../src/metrics/scanpath.js';
import * as entryPoint from '../src/index.js';
import type { ImageSize, Predictor, SaliencyMap } from '../src/types.js';

/** The assignment is the assertion: both baselines satisfy the seam #81 declares. */
const BASELINES: readonly { readonly name: string; readonly predictor: Predictor }[] = [
  { name: 'the centre-bias prior', predictor: centreBiasBaseline },
  { name: 'the random-fixation baseline', predictor: randomFixationBaseline },
];

/**
 * A bare image at a size, as the seam takes one. The bytes are never decoded: a baseline
 * reads no pixels, which is the whole of what makes it a baseline.
 */
const imageOf = (size: ImageSize): Parameters<Predictor>[0] => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  size,
  display: { viewport: { width: size.width, height: size.height }, scale: 1 },
});

/** `Math.max(...)` over a large map overflows the call stack, so the maximum is folded. */
const greatest = (values: readonly number[]): number =>
  values.reduce((best, value) => (value > best ? value : best), Number.NEGATIVE_INFINITY);

const least = (values: readonly number[]): number =>
  values.reduce((best, value) => (value < best ? value : best), Number.POSITIVE_INFINITY);

const sumOf = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

/** The mass of a map within `sigmas` standard deviations of the prior's centre, in cells. */
const massWithin = (map: SaliencyMap, sigmas: number): number => {
  const sigma = CENTRE_BIAS_PRIOR.spreadShare * Math.min(map.width, map.height);
  const centreX = CENTRE_BIAS_PRIOR.centreXShare * map.width;
  const centreY = CENTRE_BIAS_PRIOR.centreYShare * map.height;
  let mass = 0;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const offsetX = x + MAP_RENDERING.cellCentre - centreX;
      const offsetY = y + MAP_RENDERING.cellCentre - centreY;
      if (Math.hypot(offsetX, offsetY) <= sigmas * sigma)
        mass += map.values[y * map.width + x] ?? 0;
    }
  }
  return mass;
};

const mean = (values: readonly number[]): number => sumOf(values) / values.length;

describe('both baselines satisfy the Predictor seam', () => {
  it.each(BASELINES)('$name is exported from the package entry point', ({ predictor }) => {
    expect(Object.values(entryPoint)).toContain(predictor);
  });

  it('and so is everything a reader of a figure needs to say what produced it', () => {
    expect(Object.values(entryPoint)).toContain(renderSaliencyMap);
    expect(Object.values(entryPoint)).toContain(MAP_RENDERING);
    expect(Object.values(entryPoint)).toContain(CENTRE_BIAS_PRIOR);
    expect(Object.values(entryPoint)).toContain(BASELINE_SCANPATH);
  });

  it.each(BASELINES)(
    '$name returns a map and a scanpath for a bare image',
    async ({ predictor }) => {
      const prediction = await predictor(imageOf({ width: 1280, height: 1024 }), 3);

      expect(prediction.saliencyMap.normalisation).toBe('sum-to-one');
      // A predicted scanpath belongs to no participant; a human one names theirs (#84).
      expect(prediction.scanpath.participantId).toBeNull();
      expect(prediction.scanpath.fixations).toHaveLength(BASELINE_SCANPATH.fixations);
      // The display the image was shown at travels with the prediction, so #88 can report it.
      expect(prediction.display).toEqual({ viewport: { width: 1280, height: 1024 }, scale: 1 });
    },
  );
});

describe('the map-rendering function', () => {
  it('mirrors the kernel, resolution and normalisation #68 documents for the engine', () => {
    // The engine cannot be imported from here, so the correspondence is in data and in the
    // doc. These are `packages/engine`'s `prediction.map` defaults, value for value; if a
    // change to either side makes them disagree, #87's criteria ask for it to be said on
    // #11 and #87 rather than quietly reconciled.
    expect(MAP_RENDERING.cellPx).toBe(10);
    expect(MAP_RENDERING.kernelSigmaShare).toBe(0.03);
    expect(MAP_RENDERING.kernelRadiusSigmas).toBe(3);
    expect(MAP_RENDERING.dwellWeightExponent).toBe(1);
    expect(MAP_RENDERING.normalisation).toBe('sum-to-one');
    expect(MAP_RENDERING.coordinates).toBe('row-major-image-space');
    expect(Object.isFrozen(MAP_RENDERING)).toBe(true);
  });

  it('and the engine’s own defaults still say the same, read from its source', () => {
    // `MAP_RENDERING`'s own doc and `docs/baselines.md` claim a correspondence with
    // `packages/engine`'s `prediction.map`. This package may not *import* the engine — the
    // dependency runs one way and `test/dependency-direction.test.ts` asserts it — but it can
    // read the file as text, which is what that test does to make its own cross-package
    // claim. So a retuned engine kernel fails here instead of silently turning every reported
    // margin into a blur difference.
    const config = readFileSync(
      fileURLToPath(new URL('../../engine/src/config.ts', import.meta.url)),
      'utf8',
    );
    const block = /^ {4}map: \{$([\s\S]*?)^ {4}\},$/m.exec(config)?.[1];

    expect(
      block,
      'the engine’s prediction.map block moved; this mirror has to move with it',
    ).toBeDefined();
    for (const key of [
      'cellPx',
      'kernelSigmaShare',
      'kernelRadiusSigmas',
      'dwellWeightExponent',
    ] as const) {
      const value = new RegExp(`^\\s*${key}: ([-\\d.]+),$`, 'm').exec(block ?? '')?.[1];

      expect(value, key).toBeDefined();
      expect(Number(value), key).toBe(MAP_RENDERING[key]);
    }
  });

  it('is named in the baselines doc beside what it mirrors, since the code cannot say it', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../docs/baselines.md', import.meta.url)),
      'utf8',
    );

    expect(doc).toContain('#68');
    expect(doc).toContain(`${String(MAP_RENDERING.cellPx)} image pixels`);
    expect(doc).toContain(String(MAP_RENDERING.kernelSigmaShare));
    expect(doc).toContain(MAP_RENDERING.normalisation);
  });

  it('resolves the image downscaled by the cell, rounded per side, never below one cell', () => {
    expect(mapResolution({ width: 320, height: 240 })).toEqual({ width: 32, height: 24 });
    expect(mapResolution({ width: 1170, height: 2532 })).toEqual({ width: 117, height: 253 });
    expect(mapResolution({ width: 1, height: 1 })).toEqual({ width: 1, height: 1 });
  });

  it('spreads one fixation around the cell it landed in, and the values sum to one', () => {
    const imageSize = { width: 320, height: 240 };
    // Inside cell (16, 12) rather than on its corner: a fixation exactly on a cell boundary
    // is equidistant from the two cells either side of it and they hold the same value.
    const map = renderSaliencyMap([{ x: 165, y: 125, durationMs: 300 }], imageSize);
    const peak = map.values.indexOf(greatest(map.values));

    expect(map).toMatchObject({ width: 32, height: 24, imageSize, normalisation: 'sum-to-one' });
    expect(sumOf(map.values)).toBeCloseTo(1, 12);
    // Row-major image space: cell (x, y) is `values[y * width + x]`, origin top-left.
    expect({ x: peak % map.width, y: Math.floor(peak / map.width) }).toEqual({ x: 16, y: 12 });
  });

  it('weights a fixation by its dwell, as the engine does', () => {
    const imageSize = { width: 320, height: 240 };
    const [short, long] = [
      { x: 40, y: 40, durationMs: 100 },
      { x: 280, y: 200, durationMs: 400 },
    ];
    const map = renderSaliencyMap([short, long], imageSize);
    const cellOf = (point: { x: number; y: number }): number =>
      Math.floor((point.y * map.height) / imageSize.height) * map.width +
      Math.floor((point.x * map.width) / imageSize.width);

    expect(map.values[cellOf(long)]).toBeGreaterThan(map.values[cellOf(short)]!);
  });

  it('answers a uniform distribution when there is no mass to spread, never a NaN', () => {
    const map = renderSaliencyMap([], { width: 320, height: 240 });

    expect(sumOf(map.values)).toBeCloseTo(1, 12);
    expect(new Set(map.values).size).toBe(1);
  });

  it('refuses a size no map can be drawn over, and a point outside the image', () => {
    expect(() => renderSaliencyMap([], { width: 0, height: 240 })).toThrow(BaselineError);
    expect(() => renderSaliencyMap([], { width: 320, height: Number.NaN })).toThrow(
      /not a whole number of pixels/,
    );
    // A fraction is refused however large: #83's metrics read a map's `imageSize` to decide
    // whether two maps describe the same picture, so a malformed size has to stop here.
    expect(() => renderSaliencyMap([], { width: 320.5, height: 240 })).toThrow(
      /320\.5 is not a whole number of pixels/,
    );
    expect(() =>
      renderSaliencyMap([{ x: 321, y: 10, durationMs: 200 }], { width: 320, height: 240 }),
    ).toThrow(/outside the 320 × 240 image/);
  });
});

describe('the centre-bias prior', () => {
  it('peaks in the cell its documented centre falls in', () => {
    for (const imageSize of [
      { width: 320, height: 240 },
      { width: 1280, height: 1024 },
      { width: 1170, height: 2532 },
    ]) {
      const prior = centreBiasPrior(imageSize);
      const peak = centreBiasPeakCell(imageSize);

      expect(
        prior.values[peak.y * prior.width + peak.x],
        `${imageSize.width}×${imageSize.height}`,
      ).toBe(greatest(prior.values));
      // Horizontally centred, and the peak above the middle: the documented top bias.
      expect(peak.x).toBe(Math.floor(prior.width / 2));
      expect(peak.y).toBeLessThan(Math.floor(prior.height / 2));
    }
  });

  it('spreads by the documented quarter of the image’s shorter side', () => {
    // A Gaussian holds 39% of its mass within one standard deviation and 86% within two;
    // these run a little higher because the tails that fall off the image are renormalised
    // away. Measured 0.42 and 0.91 on both sizes.
    for (const imageSize of [
      { width: 320, height: 240 },
      { width: 1280, height: 1024 },
    ]) {
      const prior = centreBiasPrior(imageSize);

      expect(massWithin(prior, 1)).toBeGreaterThan(0.39);
      expect(massWithin(prior, 1)).toBeLessThan(0.46);
      expect(massWithin(prior, 2)).toBeGreaterThan(0.86);
      expect(massWithin(prior, 3)).toBeGreaterThan(0.99);
    }
  });

  it('is a parameter, so a sensitivity check is a call and not an edit to the source', () => {
    const imageSize = { width: 320, height: 240 };
    const wider = centreBiasPrior(imageSize, { ...CENTRE_BIAS_PRIOR, spreadShare: 0.5 });
    const narrower = centreBiasPrior(imageSize, { ...CENTRE_BIAS_PRIOR, spreadShare: 0.1 });
    const peak = centreBiasPeakCell(imageSize);
    const peakOf = (map: SaliencyMap): number => map.values[peak.y * map.width + peak.x] ?? 0;

    // A wider spread puts less of the distribution in the peak cell, and a narrower one more.
    expect(peakOf(wider)).toBeLessThan(peakOf(centreBiasPrior(imageSize)));
    expect(peakOf(narrower)).toBeGreaterThan(peakOf(centreBiasPrior(imageSize)));
    // And the truncation is read rather than decorative: one standard deviation leaves the
    // corners of the map empty, where the committed `whole-map` setting leaves no cell at 0.
    expect(least(centreBiasPrior(imageSize, { ...CENTRE_BIAS_PRIOR, truncation: 1 }).values)).toBe(
      0,
    );
    expect(least(centreBiasPrior(imageSize).values)).toBeGreaterThan(0);
  });

  it('is finite, non-negative, normalised, and has no zero cell for KLD to read as a hole', () => {
    const prior = centreBiasPrior({ width: 1170, height: 2532 });

    expect(prior.values).toHaveLength(prior.width * prior.height);
    expect(prior.values.every((value) => Number.isFinite(value))).toBe(true);
    expect(least(prior.values)).toBeGreaterThan(0);
    expect(sumOf(prior.values)).toBeCloseTo(1, 12);
    expect(prior.normalisation).toBe('sum-to-one');
  });

  it('does not move with the seed: only the scanpath drawn from it does', async () => {
    const image = imageOf({ width: 800, height: 600 });
    const [first, second] = await Promise.all([
      centreBiasBaseline(image, 1),
      centreBiasBaseline(image, 2),
    ]);

    expect(second.saliencyMap).toEqual(first.saliencyMap);
    expect(second.scanpath).not.toEqual(first.scanpath);
  });

  it('draws every fixation of its scanpath inside the image', async () => {
    for (const imageSize of [
      { width: 1, height: 1 },
      { width: 320, height: 240 },
      { width: 1170, height: 2532 },
    ]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const { scanpath } = await centreBiasBaseline(imageOf(imageSize), seed);

        expect(
          scanpath.fixations.every(
            (fixation) =>
              fixation.x >= 0 &&
              fixation.x < imageSize.width &&
              fixation.y >= 0 &&
              fixation.y < imageSize.height,
          ),
          `${imageSize.width}×${imageSize.height} seed ${String(seed)}`,
        ).toBe(true);
      }
    }
  });

  it('draws them near the prior’s centre on average, which is what a prior means', async () => {
    const image = imageOf({ width: 1280, height: 1024 });
    const xs: number[] = [];
    const ys: number[] = [];
    for (let seed = 1; seed <= 64; seed += 1) {
      for (const fixation of (await centreBiasBaseline(image, seed)).scanpath.fixations) {
        xs.push(fixation.x / 1280);
        ys.push(fixation.y / 1024);
      }
    }

    // Measured over these 64 seeds: 0.5031 and 0.4287 — the prior's own 0.5 and 0.42.
    expect(mean(xs)).toBeCloseTo(CENTRE_BIAS_PRIOR.centreXShare, 1);
    expect(mean(ys)).toBeCloseTo(CENTRE_BIAS_PRIOR.centreYShare, 1);
    // Above the geometric middle, which is what the top bias means — named as 0.5 rather
    // than borrowed from `centreXShare`, which is only incidentally the same number.
    expect(mean(ys)).toBeLessThan(0.5);
  });
});

describe('the random-fixation baseline', () => {
  it('is seeded: the same seed gives byte-identical fixations', async () => {
    const image = imageOf({ width: 1280, height: 1024 });
    const [first, second] = await Promise.all([
      randomFixationBaseline(image, 11),
      randomFixationBaseline(image, 11),
    ]);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('and a different seed gives different ones', async () => {
    const image = imageOf({ width: 1280, height: 1024 });
    const first = await randomFixationBaseline(image, 11);
    const other = await randomFixationBaseline(image, 12);

    expect(other.scanpath.fixations).not.toEqual(first.scanpath.fixations);
    expect(other.saliencyMap.values).not.toEqual(first.saliencyMap.values);
  });

  it('draws uniformly over the image, within the stated tolerance', async () => {
    const size = { width: 1280, height: 1024 };
    const { firstSeed, seedCount, quadrantShare, tolerance } = RANDOM_FIXATION_UNIFORMITY;
    const quadrants = [0, 0, 0, 0];
    let drawn = 0;
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed += 1) {
      for (const fixation of (await randomFixationBaseline(imageOf(size), seed)).scanpath
        .fixations) {
        const quadrant =
          (fixation.x < size.width / 2 ? 0 : 1) + (fixation.y < size.height / 2 ? 0 : 2);
        quadrants[quadrant] += 1;
        drawn += 1;
      }
    }

    expect(drawn).toBe(seedCount * BASELINE_SCANPATH.fixations);
    // Measured: the four shares run 0.2492 … 0.2516, the widest departure 0.0016. The seed
    // set is committed, so that is exact rather than noisy, and the tolerance is what the
    // claim needs to survive a change of seed range.
    for (const [quadrant, count] of quadrants.entries()) {
      expect(Math.abs(count / drawn - quadrantShare), `quadrant ${String(quadrant)}`).toBeLessThan(
        tolerance,
      );
    }
  });
});

describe('the fixation count and the dwell distribution are committed data', () => {
  it('frozen, and shared by both baselines so a margin between them is spatial', () => {
    expect(Object.isFrozen(BASELINE_SCANPATH)).toBe(true);
    expect(Object.isFrozen(BASELINE_SCANPATH.duration)).toBe(true);
    expect(Object.isFrozen(CENTRE_BIAS_PRIOR)).toBe(true);
    expect(Object.isFrozen(RANDOM_FIXATION_UNIFORMITY)).toBe(true);
  });

  it.each(BASELINES)('$name produces the committed number of fixations', async ({ predictor }) => {
    const { scanpath } = await predictor(imageOf({ width: 320, height: 240 }), 5);

    expect(scanpath.fixations).toHaveLength(BASELINE_SCANPATH.fixations);
    expect(scanpath.fixations.map((fixation) => fixation.index)).toEqual(
      scanpath.fixations.map((_, index) => index),
    );
  });

  it.each(BASELINES)('$name dwells inside the committed distribution', async ({ predictor }) => {
    const durations: number[] = [];
    for (let seed = 1; seed <= 32; seed += 1) {
      for (const fixation of (await predictor(imageOf({ width: 320, height: 240 }), seed)).scanpath
        .fixations) {
        durations.push(fixation.durationMs);
      }
    }
    const { minMs, maxMs, medianMs } = BASELINE_SCANPATH.duration;
    const sorted = [...durations].sort((a, b) => a - b);
    const sampleMedian = sorted[sorted.length >> 1] ?? 0;

    expect(least(durations)).toBeGreaterThanOrEqual(minMs);
    expect(greatest(durations)).toBeLessThanOrEqual(maxMs);
    // Log-normal at the committed median. 320 dwells put the sample median within a quarter
    // of it — measured 256 ms for uniform noise and 267 ms for the prior, whose draws come
    // in a different order and so are a different sample of the same distribution.
    expect(sampleMedian).toBeGreaterThan(medianMs * 0.75);
    expect(sampleMedian).toBeLessThan(medianMs * 1.25);
  });

  it.each(BASELINES)('$name sets onsets from the dwells and one saccade', async ({ predictor }) => {
    const { scanpath } = await predictor(imageOf({ width: 320, height: 240 }), 9);

    scanpath.fixations.forEach((fixation, position) => {
      const previous = scanpath.fixations[position - 1];
      const expected =
        previous === undefined
          ? 0
          : previous.tMs + previous.durationMs + BASELINE_SCANPATH.saccadeMs;

      expect(fixation.tMs).toBeCloseTo(expected, 12);
    });
  });

  it('draws a dwell from the distribution rather than from a constant', () => {
    const random = createSeededRandom(4);
    const drawn = Array.from({ length: 64 }, () => sampleDurationMs(random));

    expect(new Set(drawn).size).toBeGreaterThan(32);
    expect(drawn.every((dwell) => dwell >= BASELINE_SCANPATH.duration.minMs)).toBe(true);
  });

  it('builds an ordered scanpath that belongs to no participant', () => {
    const scanpath = scanpathOf([{ x: 1, y: 2 }], createSeededRandom(1));

    expect(scanpath.participantId).toBeNull();
    expect(scanpath.fixations).toHaveLength(1);
    expect(scanpath.fixations[0]).toMatchObject({ index: 0, tMs: 0, x: 1, y: 2 });
  });
});

describe('both baselines run on the smallest and on a large image', () => {
  const sizes = [
    { width: 1, height: 1 },
    { width: 4096, height: 4096 },
  ] as const;

  it.each(BASELINES.flatMap((baseline) => sizes.map((size) => ({ ...baseline, size }))))(
    '$name on $size.width × $size.height',
    async ({ predictor, size }) => {
      const { saliencyMap, scanpath } = await predictor(imageOf(size), 2);
      const resolution = mapResolution(size);

      expect({ width: saliencyMap.width, height: saliencyMap.height }).toEqual(resolution);
      expect(saliencyMap.values).toHaveLength(resolution.width * resolution.height);
      expect(saliencyMap.imageSize).toEqual(size);
      expect(sumOf(saliencyMap.values)).toBeCloseTo(1, 10);
      expect(least(saliencyMap.values)).toBeGreaterThanOrEqual(0);
      expect(scanpath.fixations).toHaveLength(BASELINE_SCANPATH.fixations);
    },
  );
});

describe('what the two baselines are evidence of', () => {
  it('the prior beats uniform noise on every committed record, which is why it is the one to beat', () => {
    // The floor and the reference, measured on the committed synthetic corpus (#82), as the
    // mean over the seeds below. #88 reports these beside the engine's own figure; the
    // numbers here are what `docs/baselines.md` quotes.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const record of loadCorpus()) {
      const image = { bytes: new Uint8Array([0]), size: record.imageSize, display: record.display };
      // The prior does not move with the seed, so one call is the mean over any seeds.
      const priorCc = cc(centreBiasPrior(record.imageSize), record.saliencyMap);
      const randomCc = mean(
        seeds.map((seed) =>
          cc(randomFixationBaseline(image, seed).saliencyMap, record.saliencyMap),
        ),
      );

      expect(priorCc, record.id).toBeGreaterThan(randomCc);
    }
  });

  it('though part of that gap is the blur and not the placement, as the doc reports', () => {
    // The two baselines are rendered at the blur each one's definition asks for — the random
    // baseline at the engine's kernel, the prior at its own quarter of the shorter side — so a
    // broad field correlates better with a human fixation map than ten small blobs wherever
    // they sit. Re-rendering the *same* random fixations at the prior's spread is how much of
    // the gap is really about where they landed, and `docs/baselines.md` prints both columns.
    // Measured: −0.026 becomes 0.265 on `webpage-bright-hero`, and 0.088 becomes 0.222 on
    // `desktop-two-panels`, where the prior's 0.232 is then all but matched.
    for (const record of loadCorpus()) {
      const image = { bytes: new Uint8Array([0]), size: record.imageSize, display: record.display };
      const resolution = mapResolution(record.imageSize);
      const priorShare =
        (CENTRE_BIAS_PRIOR.spreadShare * Math.min(resolution.width, resolution.height)) /
        Math.max(resolution.width, resolution.height);
      const { scanpath, saliencyMap } = randomFixationBaseline(image, 1);
      const blurMatched = renderSaliencyMap(scanpath.fixations, record.imageSize, {
        ...MAP_RENDERING,
        kernelSigmaShare: priorShare,
        kernelRadiusSigmas: Number.POSITIVE_INFINITY,
      });

      expect(
        cc(blurMatched, record.saliencyMap),
        `${record.id}: the same fixations at the prior's blur`,
      ).toBeGreaterThan(cc(saliencyMap, record.saliencyMap));
    }
  });

  it('but says next to nothing about the order attention was paid in', () => {
    // Neither baseline has any sequence logic — each fixation is drawn independently — so
    // ScanMatch separates them by hundredths where CC separates them by halves. A scanpath
    // figure a little above the prior is not evidence that a predictor got the order right,
    // and `docs/baselines.md` says so.
    const record = loadCorpus()[0]!;
    const image = { bytes: new Uint8Array([0]), size: record.imageSize, display: record.display };
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const scanMatchOf = (predictor: typeof centreBiasBaseline): number =>
      mean(
        seeds.map(
          (seed) =>
            scoreScanpathAgainstHumans(predictor(image, seed).scanpath, record).prediction
              .scanMatch,
        ),
      );

    // Measured: 0.203 for the prior and 0.176 for uniform noise on `webpage-bright-hero`.
    expect(
      Math.abs(scanMatchOf(centreBiasBaseline) - scanMatchOf(randomFixationBaseline)),
    ).toBeLessThan(0.1);
  });
});
