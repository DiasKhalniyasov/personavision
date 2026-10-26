import { createSeededRandom } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { defaultEngineConfig, resolveEngineConfig } from '../src/config.js';
import { personaSamplingParams } from '../src/persona.js';
import type { PersonaTraits } from '../src/persona.js';
import {
  drawFixationDurationMs,
  drawLandingPoint,
  drawSaccadeAmplitudePx,
  nextFixationStart,
  saccadeDurationMsFor,
} from '../src/sampling/distributions.js';
import type { BoundingBox } from '../src/types.js';

/**
 * These are statistical assertions over a *seeded* generator, so every number below is
 * reproducible rather than probabilistic: a tolerance that passes once passes forever
 * unless a draw changes. Each band is stated in the assertion and is wide enough that it
 * describes the distribution rather than this particular sequence.
 */
const SAMPLES = 20_000;

const MIDDLING: PersonaTraits = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

const withTrait = (trait: keyof PersonaTraits, value: number): PersonaTraits => ({
  ...MIDDLING,
  [trait]: value,
});

const READING = personaSamplingParams(withTrait('scanningVsReading', 0));
const SCANNING = personaSamplingParams(withTrait('scanningVsReading', 1));
const MIDDLING_PARAMS = personaSamplingParams(MIDDLING);

/** One draw per seed, so the sample is over many seeds rather than along one sequence. */
const overSeeds = <T>(draw: (rng: () => number) => T, samples = SAMPLES): T[] =>
  Array.from({ length: samples }, (_unused, seed) => draw(createSeededRandom(seed + 1)));

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const standardDeviation = (values: readonly number[]): number => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

/** A session's worth of draws, as the sampler will compose them, from one generator. */
const scanpath = (rng: () => number, fixations = 12) => {
  const box: BoundingBox = { x: 40, y: 120, width: 320, height: 48 };
  const drawn: unknown[] = [];
  let clock = { tMs: 0, durationMs: drawFixationDurationMs(MIDDLING_PARAMS, rng) };
  drawn.push({ ...clock, landing: drawLandingPoint(box, rng) });
  for (let index = 1; index < fixations; index += 1) {
    const amplitudePx = drawSaccadeAmplitudePx(rng);
    const saccadeMs = saccadeDurationMsFor(amplitudePx);
    const start = nextFixationStart(clock, saccadeMs, rng);
    clock = { tMs: start.tMs, durationMs: drawFixationDurationMs(MIDDLING_PARAMS, rng) };
    drawn.push({
      ...clock,
      gapMs: start.gapMs,
      amplitudePx,
      saccadeMs,
      landing: drawLandingPoint(box, rng),
    });
  }
  return drawn;
};

/**
 * That no draw reaches for the platform's unseeded generator is asserted over the whole of
 * `packages/engine/src` by the purity suite in `./config.test.ts`, which fails the build
 * if one appears; it is not restated here.
 */
describe('determinism', () => {
  it('draws a byte-identical sequence from an identically seeded generator', () => {
    const first = JSON.stringify(scanpath(createSeededRandom(4242)));
    const second = JSON.stringify(scanpath(createSeededRandom(4242)));

    expect(second).toBe(first);
  });

  it('draws a different sequence from a different seed', () => {
    const first = JSON.stringify(scanpath(createSeededRandom(4242)));
    const other = JSON.stringify(scanpath(createSeededRandom(4243)));

    expect(other).not.toBe(first);
  });
});

describe('fixation duration', () => {
  const durations = overSeeds((rng) => drawFixationDurationMs(MIDDLING_PARAMS, rng));

  it('is positive and within the configured bounds', () => {
    const { minMs, maxMs } = defaultEngineConfig.fixationDuration;
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(minMs);
    expect(Math.max(...durations)).toBeLessThanOrEqual(maxMs);
    expect(Math.min(...durations)).toBeGreaterThan(0);
  });

  it('is right-skewed: the mean sits above the median', () => {
    expect(mean(durations)).toBeGreaterThan(median(durations) * 1.05);
  });

  it('has a median within 3% of the configured median for a middling persona', () => {
    // A middling persona's scale is 1 by construction, so the configured median is the band's centre.
    expect(MIDDLING_PARAMS.fixationDurationScale).toBeCloseTo(1, 10);
    const configured = defaultEngineConfig.fixationDuration.medianMs;
    expect(median(durations)).toBeGreaterThan(configured * 0.97);
    expect(median(durations)).toBeLessThan(configured * 1.03);
  });

  it('is shorter for a scanning persona than a reading one, by the margin the table predicts', () => {
    const scanning = median(overSeeds((rng) => drawFixationDurationMs(SCANNING, rng)));
    const reading = median(overSeeds((rng) => drawFixationDurationMs(READING, rng)));
    const predicted =
      defaultEngineConfig.persona.fixationDurationScale.atOne /
      defaultEngineConfig.persona.fixationDurationScale.atZero;

    expect(scanning).toBeLessThan(reading);
    expect(scanning / reading).toBeGreaterThan(predicted * 0.98);
    expect(scanning / reading).toBeLessThan(predicted * 1.02);
  });

  it('loses only a tail to the lower clamp, even for the shortest-fixating persona', () => {
    const { medianMs, minMs } = defaultEngineConfig.fixationDuration;
    const scanning = overSeeds((rng) => drawFixationDurationMs(SCANNING, rng));
    const clamped = scanning.filter((duration) => duration === minMs);
    const predicted = medianMs * SCANNING.fixationDurationScale;

    // The module documents this share: a scanning median 1.9 sigma above `minMs`.
    expect(clamped.length / scanning.length).toBeGreaterThan(0.02);
    expect(clamped.length / scanning.length).toBeLessThan(0.04);
    // Enough to move the median by well under a millisecond, so the table's ratio holds.
    expect(Math.abs(median(scanning) - predicted)).toBeLessThan(1);
  });

  it('rises when the configured median rises, with no code change', () => {
    const { config } = resolveEngineConfig({ fixationDuration: { medianMs: 500 } });
    const longer = median(overSeeds((rng) => drawFixationDurationMs(MIDDLING_PARAMS, rng, config)));

    expect(longer).toBeGreaterThan(median(durations) * 1.8);
  });

  it('spreads wider when the configured logSigma rises, with no code change', () => {
    const { config } = resolveEngineConfig({ fixationDuration: { logSigma: 0.9 } });
    const wider = overSeeds((rng) => drawFixationDurationMs(MIDDLING_PARAMS, rng, config));

    expect(standardDeviation(wider)).toBeGreaterThan(standardDeviation(durations));
  });
});

describe('saccades', () => {
  const amplitudes = overSeeds((rng) => drawSaccadeAmplitudePx(rng));

  it('draws positive amplitudes inside the bound the generator imposes', () => {
    const { medianPx, logSigma } = defaultEngineConfig.saccade.amplitude;
    /**
     * Box-Muller over a generator whose smallest non-zero value is 2⁻³² cannot return a
     * normal beyond this, so the band is structural: it holds for any sample size, unlike
     * a sigma band, which a larger sample eventually leaves.
     */
    const maxZ = Math.sqrt(-2 * Math.log(2 ** -32));
    expect(Math.min(...amplitudes)).toBeGreaterThan(medianPx * Math.exp(-maxZ * logSigma));
    expect(Math.max(...amplitudes)).toBeLessThan(medianPx * Math.exp(maxZ * logSigma));

    const threeSigma = amplitudes.filter(
      (amplitudePx) =>
        amplitudePx > medianPx * Math.exp(-3 * logSigma) &&
        amplitudePx < medianPx * Math.exp(3 * logSigma),
    );
    expect(threeSigma.length / amplitudes.length).toBeGreaterThan(0.99);
    expect(median(amplitudes)).toBeGreaterThan(medianPx * 0.97);
    expect(median(amplitudes)).toBeLessThan(medianPx * 1.03);
  });

  it('takes longer for a longer jump, across the tested range', () => {
    const tested = [0, 10, 50, 100, 250, 500, 1000, 2000, 3999];
    const durations = tested.map((amplitudePx) => saccadeDurationMsFor(amplitudePx));

    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]!).toBeGreaterThan(durations[index - 1]!);
    }
  });

  it('keeps every duration within the configured bounds, including beyond the range', () => {
    const { minMs, maxMs } = defaultEngineConfig.saccade.duration;
    for (const amplitudePx of [-500, 0, 180, 4000, 100_000]) {
      const duration = saccadeDurationMsFor(amplitudePx);
      expect(duration).toBeGreaterThanOrEqual(minMs);
      expect(duration).toBeLessThanOrEqual(maxMs);
    }
    expect(saccadeDurationMsFor(100_000)).toBe(maxMs);
  });

  it('takes longer per pixel when the configured slope rises, with no code change', () => {
    const { config } = resolveEngineConfig({
      saccade: { duration: { msPerPixel: 0.05, maxMs: 400 } },
    });

    expect(saccadeDurationMsFor(1000, config)).toBeGreaterThan(saccadeDurationMsFor(1000));
  });

  it('draws longer amplitudes when the configured median rises, with no code change', () => {
    const { config } = resolveEngineConfig({ saccade: { amplitude: { medianPx: 400 } } });
    const longer = overSeeds((rng) => drawSaccadeAmplitudePx(rng, config));

    expect(median(longer)).toBeGreaterThan(median(amplitudes) * 2);
  });
});

describe('inter-fixation timing', () => {
  it('advances tMs strictly, with the saccade accounting for part of every gap', () => {
    const rng = createSeededRandom(77);
    let clock = { tMs: 0, durationMs: drawFixationDurationMs(MIDDLING_PARAMS, rng) };

    for (let index = 0; index < 500; index += 1) {
      const amplitudePx = drawSaccadeAmplitudePx(rng);
      const saccadeMs = saccadeDurationMsFor(amplitudePx);
      const start = nextFixationStart(clock, saccadeMs, rng);

      expect(start.tMs).toBeGreaterThan(clock.tMs + clock.durationMs);
      expect(start.gapMs).toBeGreaterThanOrEqual(
        saccadeMs + defaultEngineConfig.interFixation.minGapMs,
      );
      // The saccade is part of the gap, never the whole of it and never none of it.
      expect(saccadeMs / start.gapMs).toBeGreaterThan(0);
      expect(saccadeMs / start.gapMs).toBeLessThan(1);

      clock = { tMs: start.tMs, durationMs: drawFixationDurationMs(MIDDLING_PARAMS, rng) };
    }
  });

  it('has a median gap near the configured gap when the saccade is the shortest one', () => {
    // The shortest duration the relationship can return, rather than a number it cannot.
    const shortest = saccadeDurationMsFor(0);
    const gaps = overSeeds(
      (rng) => nextFixationStart({ tMs: 0, durationMs: 200 }, shortest, rng).gapMs,
    );
    const { gapMs } = defaultEngineConfig.interFixation;

    expect(median(gaps)).toBeGreaterThan(gapMs * 0.97);
    expect(median(gaps)).toBeLessThan(gapMs * 1.03);
  });

  it('is truncated by the floor on realistic saccades, which calibration has to know', () => {
    const { gapMs, minGapMs } = defaultEngineConfig.interFixation;
    const drawn = overSeeds((rng) => {
      const saccadeMs = saccadeDurationMsFor(drawSaccadeAmplitudePx(rng));
      return {
        saccadeMs,
        gapMs: nextFixationStart({ tMs: 0, durationMs: 200 }, saccadeMs, rng).gapMs,
      };
    });
    const floored = drawn.filter((gap) => gap.gapMs <= gap.saccadeMs + minGapMs + 1e-9);

    // Documented in the module: the floor binds for roughly two gaps in five…
    expect(floored.length / drawn.length).toBeGreaterThan(0.3);
    expect(floored.length / drawn.length).toBeLessThan(0.45);
    // …and lifts the realized mean above the configured gap rather than onto it.
    const realized = mean(drawn.map((gap) => gap.gapMs));
    expect(realized).toBeGreaterThan(gapMs);
    expect(realized).toBeLessThan(gapMs * 1.2);
  });

  it('widens every gap when the configured gap rises, with no code change', () => {
    const { config } = resolveEngineConfig({ interFixation: { gapMs: 120 } });
    const wider = overSeeds(
      (rng) => nextFixationStart({ tMs: 0, durationMs: 200 }, 10, rng, config).gapMs,
    );
    const base = overSeeds((rng) => nextFixationStart({ tMs: 0, durationMs: 200 }, 10, rng).gapMs);

    expect(median(wider)).toBeGreaterThan(median(base) * 2);
  });
});

describe('landing point', () => {
  const PAGE: BoundingBox = { x: 0, y: 0, width: 1440, height: 4200 };
  const TINY: BoundingBox = { x: 17, y: 42, width: 1, height: 1 };

  const insideOf = (box: BoundingBox) => (point: { x: number; y: number }) =>
    point.x > box.x &&
    point.x < box.x + box.width &&
    point.y > box.y &&
    point.y < box.y + box.height;

  it('is strictly inside a page-sized box, over many seeds', () => {
    const points = overSeeds((rng) => drawLandingPoint(PAGE, rng));
    expect(points.every(insideOf(PAGE))).toBe(true);
  });

  it('is strictly inside a 1×1 box, over many seeds', () => {
    const points = overSeeds((rng) => drawLandingPoint(TINY, rng));
    expect(points.every(insideOf(TINY))).toBe(true);
  });

  it('is strictly inside an ordinary control, over many seeds', () => {
    const button: BoundingBox = { x: 640, y: 320, width: 96, height: 40 };
    const points = overSeeds((rng) => drawLandingPoint(button, rng));
    expect(points.every(insideOf(button))).toBe(true);
  });

  it('spreads measurably, near but not exactly on the box centre', () => {
    const points = overSeeds((rng) => drawLandingPoint(PAGE, rng));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const expectedSpreadX = (PAGE.width / 2) * defaultEngineConfig.landing.spreadShare;
    const centreX = PAGE.x + PAGE.width / 2;

    expect(standardDeviation(xs)).toBeGreaterThan(expectedSpreadX * 0.9);
    expect(standardDeviation(xs)).toBeLessThan(expectedSpreadX * 1.1);
    expect(standardDeviation(ys)).toBeGreaterThan(0);
    // Centre-weighted, so the mean sits near the centre — and not on it.
    expect(Math.abs(mean(xs) - centreX)).toBeLessThan(expectedSpreadX * 0.05);
    expect(mean(xs)).not.toBe(centreX);
  });

  it('spreads wider when the configured share rises, with no code change', () => {
    const { config } = resolveEngineConfig({ landing: { spreadShare: 0.45 } });
    const wider = overSeeds((rng) => drawLandingPoint(PAGE, rng, config).x);
    const base = overSeeds((rng) => drawLandingPoint(PAGE, rng).x);

    expect(standardDeviation(wider)).toBeGreaterThan(standardDeviation(base) * 1.5);
  });

  it('stays on the page for a box that hangs off the left edge', () => {
    const offLeft: BoundingBox = { x: -40, y: 300, width: 120, height: 40 };
    const points = overSeeds((rng) => drawLandingPoint(offLeft, rng));

    // Strictly inside the box, and never a negative coordinate the artifact would reject.
    expect(points.every(insideOf(offLeft))).toBe(true);
    expect(Math.min(...points.map((point) => point.x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...points.map((point) => point.x))).toBeLessThan(offLeft.x + offLeft.width);
  });

  it('collapses to the page edge for a box with nothing on the page', () => {
    const offPage: BoundingBox = { x: -200, y: -80, width: 100, height: 40 };
    const point = drawLandingPoint(offPage, createSeededRandom(5));

    // No interior a session can record: a fixation's coordinates are never negative.
    expect(point).toEqual({ x: 0, y: 0 });
  });

  it('returns the box origin on an axis with no extent to land in', () => {
    const degenerate: BoundingBox = { x: 12, y: 34, width: 0, height: 20 };
    const point = drawLandingPoint(degenerate, createSeededRandom(9));

    expect(point.x).toBe(degenerate.x);
    expect(point.y).toBeGreaterThan(degenerate.y);
    expect(point.y).toBeLessThan(degenerate.y + degenerate.height);
  });
});
