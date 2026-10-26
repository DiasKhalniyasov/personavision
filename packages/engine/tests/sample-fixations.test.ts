import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session } from '@personavision/contract';
import { SCHEMA_VERSION, sessionSchema } from '@personavision/contract';
import { defaultEngineConfig, resolveEngineConfig } from '../src/config.js';
import type { PersonaTraits } from '../src/persona.js';
import { relevanceByArea } from '../src/relevance.js';
import { historyTermFor, sampleFixations, screenFixationCount } from '../src/sampling/index.js';
import type { SampleFixationsInput, SampledFixation, SamplerArea } from '../src/sampling/index.js';
import { loadFixture } from './fixtures/index.js';

/**
 * What a good test here asserts is a property of the *output*: the share of fixations a
 * weight moves, the shape of the sequence inhibition of return produces, the direction two
 * personas differ in. None of it asserts an intermediate salience or relevance value
 * element by element (#7, Testing Decisions).
 *
 * The statistical assertions are over a seeded generator, so every number below is
 * reproducible rather than probabilistic: a band that passes once passes forever unless a
 * draw changes. Each band is stated in its assertion and is wide enough to describe the
 * direction rather than this particular sequence.
 */
const SEEDS = 300;

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

/** The price fixture's elements are areas as they stand: `name`, `text`, `role`, `bbox`. */
const PRICE_SCREEN = loadFixture('price-and-fees').capture.elements;

/**
 * A screen of areas the terms cannot tell apart: the same role, the same words and the
 * same size, so salience and relevance are flat and whatever structure the output has came
 * from inhibition of return.
 */
const uniformAreas = (count: number): SamplerArea[] =>
  Array.from({ length: count }, (_unused, position) => ({
    id: `area-${position}`,
    role: 'text',
    label: 'a block of text',
    text: 'a block of text',
    bbox: { x: 20 + position * 70, y: 20 + position * 50, width: 48, height: 24 },
  }));

const flatSalience = (areas: readonly SamplerArea[], value = 0.5): ReadonlyMap<string, number> =>
  new Map(areas.map((area) => [area.id, value]));

/** The goal no area on these screens says anything about: every relevance is the floor. */
const INDIFFERENT = { text: 'wgzq xhvl' };

type ScreenInput = Omit<SampleFixationsInput, 'seed'>;

const scanpathsOverSeeds = (
  input: ScreenInput,
  seeds = SEEDS,
): readonly (readonly SampledFixation[])[] =>
  Array.from(
    { length: seeds },
    (_unused, seed) => sampleFixations({ ...input, seed: seed + 1 }).fixations,
  );

/** The share of all the fixations over all the seeds that landed in one of these areas. */
const shareOn = (ids: readonly string[], input: ScreenInput, seeds = SEEDS): number => {
  const all = scanpathsOverSeeds(input, seeds).flat();
  const on = all.filter((fixation) => fixation.aoiId !== null && ids.includes(fixation.aoiId));
  return on.length / all.length;
};

/**
 * How far apart two consecutive looks at the same area are, counted in fixations of the
 * whole sequence — so an adjacent re-fixation is 1 and a return three looks later is 3.
 * With `aoiId` given, only that area's returns; the distances are still the sequence's.
 */
const returnDistances = (fixations: readonly SampledFixation[], aoiId?: string): number[] => {
  const lastAt = new Map<string, number>();
  const distances: number[] = [];
  fixations.forEach((fixation, position) => {
    if (fixation.aoiId === null) return;
    const previous = lastAt.get(fixation.aoiId);
    if (previous !== undefined && (aoiId === undefined || fixation.aoiId === aoiId)) {
      distances.push(position - previous);
    }
    lastAt.set(fixation.aoiId, position);
  });
  return distances;
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

describe('sampleFixations is deterministic', () => {
  const input: ScreenInput = {
    aois: PRICE_SCREEN,
    goal: { text: 'pay for the boots' },
    persona: MIDDLING,
    salience: flatSalience(PRICE_SCREEN, 0.4),
  };

  it('answers byte-identical fixations and saccades for the same input', () => {
    const first = sampleFixations({ ...input, seed: 4242 });
    const second = sampleFixations({ ...input, seed: 4242 });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('answers a different sequence for a different seed', () => {
    const first = sampleFixations({ ...input, seed: 4242 });
    const other = sampleFixations({ ...input, seed: 4243 });

    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it('answers the same bytes in a second process', () => {
    /** No `salience` map: the input has to cross a process boundary as JSON. */
    const crossProcess: SampleFixationsInput = {
      aois: PRICE_SCREEN,
      goal: { text: 'pay for the boots' },
      persona: MIDDLING,
      seed: 4242,
      weights: { alpha: 1.3, beta: 0.7, gamma: 1.1 },
    };
    const child = fileURLToPath(new URL('sample-fixations.child.ts', import.meta.url));

    const elsewhere = execFileSync(
      process.execPath,
      ['--conditions', 'development', '--import', 'tsx', child, JSON.stringify(crossProcess)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );

    expect(elsewhere).toBe(JSON.stringify(sampleFixations(crossProcess)));
  });
});

describe('the weights move the sampling in the documented direction', () => {
  it('raising beta raises the share landing on the areas relevance favours', () => {
    const goal = { text: 'find the total price' };
    const relevance = relevanceByArea({ areas: PRICE_SCREEN, goal });
    const favoured = [...relevance]
      .sort(([, left], [, right]) => right - left)
      .slice(0, 2)
      .map(([id]) => id);
    const input: ScreenInput = {
      aois: PRICE_SCREEN,
      goal,
      persona: MIDDLING,
      salience: flatSalience(PRICE_SCREEN, 0.4),
    };

    const indifferent = shareOn(favoured, { ...input, weights: { beta: 0 } });
    const goalDriven = shareOn(favoured, { ...input, weights: { beta: 8 } });

    expect(goalDriven).toBeGreaterThan(indifferent + 0.1);
  });

  it('raising alpha raises the share landing on the high-salience area', () => {
    const areas = uniformAreas(6);
    const salience = new Map(
      areas.map((area, position) => [area.id, position === 0 ? 0.95 : 0.05]),
    );
    const input: ScreenInput = { aois: areas, goal: INDIFFERENT, persona: MIDDLING, salience };

    const indifferent = shareOn([areas[0].id], { ...input, weights: { alpha: 0 } });
    const salienceDriven = shareOn([areas[0].id], { ...input, weights: { alpha: 8 } });

    expect(salienceDriven).toBeGreaterThan(indifferent + 0.1);
  });

  it('raising gamma pushes a revisit further out, which is what it scales', () => {
    const areas = uniformAreas(6);
    const input: ScreenInput = {
      aois: areas,
      goal: INDIFFERENT,
      persona: MIDDLING,
      salience: flatSalience(areas),
    };

    const distancesAt = (gamma: number): number[] =>
      scanpathsOverSeeds({ ...input, weights: { gamma } }).flatMap((fixations) =>
        returnDistances(fixations),
      );

    const unsuppressed = mean(distancesAt(0));
    const suppressed = mean(distancesAt(4));

    expect(suppressed).toBeGreaterThan(unsuppressed);
  });
});

describe('inhibition of return', () => {
  const areas = uniformAreas(6);
  const input: ScreenInput = {
    aois: areas,
    goal: INDIFFERENT,
    persona: MIDDLING,
    salience: flatSalience(areas),
  };

  it('never fixates one area more times in a row than the allowance', () => {
    const { immediateRepeatAllowance } = defaultEngineConfig.inhibitionOfReturn;
    const runs = scanpathsOverSeeds(input)
      .flatMap((fixations) => returnDistances(fixations))
      .filter((distance) => distance === 1);

    expect(immediateRepeatAllowance).toBe(1);
    expect(runs).toHaveLength(0);
  });

  it('allows the run the allowance allows, and no longer, when calibration raises it', () => {
    const allowed = scanpathsOverSeeds({
      ...input,
      weights: { inhibitionOfReturn: { immediateRepeatAllowance: 2 } },
    });
    const runLengths = allowed.map((fixations) => {
      let longest = 1;
      let run = 1;
      fixations.forEach((fixation, position) => {
        if (position === 0) return;
        run = fixation.aoiId === fixations[position - 1].aoiId ? run + 1 : 1;
        longest = Math.max(longest, run);
      });
      return longest;
    });

    expect(Math.max(...runLengths)).toBe(2);
  });

  it('decays, so a return a couple of fixations later is possible', () => {
    const distances = scanpathsOverSeeds(input).flatMap((fixations) => returnDistances(fixations));

    expect(distances.filter((distance) => distance === 2).length).toBeGreaterThan(0);
  });
});

describe('a deliberate return', () => {
  const { inhibitionOfReturn } = defaultEngineConfig;

  it('raises the history term instead of suppressing it', () => {
    const returning = { fixationCount: 1, fixationsSince: 4, consecutive: 1 };
    const justLooked = { fixationCount: 1, fixationsSince: 1, consecutive: 1 };

    expect(historyTermFor(returning, 0.9)).toBeGreaterThan(0);
    expect(historyTermFor(justLooked, 0.9)).toBeLessThan(0);
    expect(historyTermFor(returning, 0.1)).toBeLessThan(0);
    expect(historyTermFor(undefined, 0.9)).toBe(0);
  });

  it('happens when the goal still points at the area, and not when it does not', () => {
    /** The primary action, which this goal's words reach above the configured threshold. */
    const goal = { text: 'pay for the boots' };
    const relevance = relevanceByArea({ areas: PRICE_SCREEN, goal });
    expect(relevance.get('cta-pay')).toBeGreaterThanOrEqual(
      inhibitionOfReturn.deliberateReturnRelevance,
    );

    const input: ScreenInput = {
      aois: PRICE_SCREEN,
      goal,
      persona: MIDDLING,
      salience: flatSalience(PRICE_SCREEN, 0.4),
      weights: { gamma: 3 },
    };
    const returnsToTheAction = (overrides: ScreenInput): number =>
      scanpathsOverSeeds(overrides).flatMap((fixations) => returnDistances(fixations, 'cta-pay'))
        .length;

    const deliberate = returnsToTheAction(input);
    /** The same screen with the threshold out of the goal's reach: no return is raised. */
    const accidental = returnsToTheAction({
      ...input,
      weights: { gamma: 3, inhibitionOfReturn: { deliberateReturnRelevance: 0.99 } },
    });

    expect(deliberate).toBeGreaterThan(accidental);
  });

  it('is distinguishable in the output from an immediate re-fixation', () => {
    const goal = { text: 'pay for the boots' };
    const distances = scanpathsOverSeeds({
      aois: PRICE_SCREEN,
      goal,
      persona: MIDDLING,
      salience: flatSalience(PRICE_SCREEN, 0.4),
    }).flatMap((fixations) => returnDistances(fixations, 'cta-pay'));

    /** A deliberate return is fixations apart; an immediate re-fixation would be adjacent. */
    expect(distances.filter((distance) => distance === 1)).toHaveLength(0);
    expect(
      distances.filter((distance) => distance >= inhibitionOfReturn.deliberateReturnAfterFixations)
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('the persona drives the sequence', () => {
  const goal = { text: 'pay for the boots' };
  const screen = (traits: PersonaTraits): readonly SampledFixation[] =>
    sampleFixations({
      aois: PRICE_SCREEN,
      goal,
      persona: traits,
      salience: flatSalience(PRICE_SCREEN, 0.4),
      seed: 99,
    }).fixations;

  const reading = screen(withTrait('scanningVsReading', 0));
  const scanning = screen(withTrait('scanningVsReading', 1));

  it('gives a scanning persona more fixations than a reading one on the same seed', () => {
    expect(scanning.length).toBeGreaterThan(reading.length);
  });

  it('gives a scanning persona a shorter median fixation than a reading one', () => {
    const scanningMedian = median(scanning.map((fixation) => fixation.durationMs));
    const readingMedian = median(reading.map((fixation) => fixation.durationMs));

    expect(scanningMedian).toBeLessThan(readingMedian);
  });

  it('spends the persistence row on the screen, over the count row', () => {
    const patient = screenFixationCount(withTrait('persistence', 1));
    const impatient = screenFixationCount(withTrait('persistence', 0));

    expect(patient).toBeGreaterThan(impatient);
  });
});

describe('the shape of the output', () => {
  const goal = { text: 'pay for the boots' };
  const first = sampleFixations({
    aois: PRICE_SCREEN,
    goal,
    persona: MIDDLING,
    salience: flatSalience(PRICE_SCREEN, 0.4),
    seed: 11,
  });
  /** The second screen of the same session: the history is the first screen's fixations. */
  const second = sampleFixations({
    aois: PRICE_SCREEN,
    goal,
    persona: MIDDLING,
    salience: flatSalience(PRICE_SCREEN, 0.4),
    seed: 12,
    history: first.fixations,
    screenIndex: 1,
  });
  const fixations = [...first.fixations, ...second.fixations];
  const saccades = [...first.saccades, ...second.saccades];

  it('lands every fixation inside its own area', () => {
    const boxes = new Map(PRICE_SCREEN.map((area) => [area.id, area.bbox]));
    for (const fixation of fixations) {
      const box = boxes.get(fixation.aoiId ?? '');
      expect(box).toBeDefined();
      if (box === undefined) continue;
      expect(fixation.pageX).toBeGreaterThan(box.x);
      expect(fixation.pageX).toBeLessThan(box.x + box.width);
      expect(fixation.pageY).toBeGreaterThan(box.y);
      expect(fixation.pageY).toBeLessThan(box.y + box.height);
    }
  });

  it('numbers the fixations contiguously and continuously across the session', () => {
    expect(fixations.map((fixation) => fixation.index)).toEqual(
      fixations.map((_unused, position) => position),
    );
    expect(second.fixations[0].index).toBe(first.fixations.length);
  });

  it('moves the clock strictly forward', () => {
    const times = fixations.map((fixation) => fixation.tMs);
    expect(times[0]).toBe(0);
    for (const [position, tMs] of times.entries()) {
      if (position === 0) continue;
      const previous = fixations[position - 1];
      expect(tMs).toBeGreaterThan(previous.tMs + previous.durationMs);
    }
  });

  it('names two existing fixations in every saccade', () => {
    const indices = new Set(fixations.map((fixation) => fixation.index));
    for (const saccade of saccades) {
      expect(indices.has(saccade.fromFixation)).toBe(true);
      expect(indices.has(saccade.toFixation)).toBe(true);
      expect(saccade.toFixation).toBe(saccade.fromFixation + 1);
      expect(saccade.amplitudePx).toBeGreaterThanOrEqual(0);
      expect(saccade.durationMs).toBeGreaterThan(0);
    }
  });

  it('validates against the contract, with no invented field', () => {
    const session: Session = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: 'S-01',
      runId: '2026-10-26-1200-sampler-fixture',
      variant: 'A',
      taskId: 'buy-boots',
      kind: 'simulated',
      persona: {
        id: 'middling',
        traits: MIDDLING,
        device: {
          name: 'Desktop 1440',
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
          touch: false,
        },
      },
      participant: null,
      seed: 11,
      startedAt: '2026-10-26T12:00:00.000Z',
      durationMs: 30_000,
      screens: [0, 1].map((index) => ({
        index,
        step: 'price-and-fees',
        screenshot: 'screenshots/A/price-and-fees.png',
        scrollY: 0,
        intent: 'Pay for the boots.',
        decidedAction: 'click Pay now',
      })),
      fixations: [...fixations],
      saccades: [...saccades],
      actions: [],
      outcome: {
        status: 'success',
        step: 'price-and-fees',
        reason: 'paid',
        attribution: 'product',
        excludedFromScores: false,
      },
      integrity: { selectorFailures: 0, retries: 0 },
    };

    expect(sessionSchema.parse(session)).toEqual(session);
  });

  it('reports no fixation at all for an area it never selected', () => {
    /** More areas than this persona has looks, so some area cannot have been fixated. */
    const areas = uniformAreas(20);
    const salience = new Map(areas.map((area, position) => [area.id, position === 0 ? 1 : 0]));
    const drawn = sampleFixations({
      aois: areas,
      goal: INDIFFERENT,
      persona: MIDDLING,
      salience,
      seed: 3,
      weights: { alpha: 12 },
    });
    const looked = new Set(drawn.fixations.map((fixation) => fixation.aoiId));
    const neverLooked = areas.filter((area) => !looked.has(area.id));

    expect(neverLooked.length).toBeGreaterThan(0);
    /** Nothing stands in for them: no entry, and so no zero-duration fixation either. */
    expect(drawn.fixations.length).toBe(screenFixationCount(MIDDLING));
    for (const fixation of drawn.fixations) {
      expect(fixation.durationMs).toBeGreaterThanOrEqual(
        defaultEngineConfig.fixationDuration.minMs,
      );
    }
  });
});

describe('the screens that could crash it', () => {
  it('answers nothing at all for a screen with no areas', () => {
    expect(sampleFixations({ aois: [], goal: INDIFFERENT, persona: MIDDLING, seed: 1 })).toEqual({
      fixations: [],
      saccades: [],
    });
  });

  it('gives every fixation to the only area on a one-area screen', () => {
    const [only] = uniformAreas(1);
    const { fixations, saccades } = sampleFixations({
      aois: [only],
      goal: INDIFFERENT,
      persona: MIDDLING,
      seed: 5,
    });

    expect(fixations.length).toBe(screenFixationCount(MIDDLING));
    expect(new Set(fixations.map((fixation) => fixation.aoiId))).toEqual(new Set([only.id]));
    expect(saccades).toHaveLength(fixations.length - 1);
  });

  it('samples a screen with no salience map, weighing the term as nothing', () => {
    const resolved = resolveEngineConfig();
    const { fixations } = sampleFixations({
      aois: PRICE_SCREEN,
      goal: { text: 'pay for the boots' },
      persona: MIDDLING,
      seed: 8,
    });

    expect(fixations.length).toBe(screenFixationCount(MIDDLING, resolved.config));
    expect(fixations.every((fixation) => fixation.aoiId !== null)).toBe(true);
  });
});
