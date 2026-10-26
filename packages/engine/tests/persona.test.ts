import { describe, expect, it } from 'vitest';
import { defaultEngineConfig, resolveEngineConfig } from '../src/config.js';
import {
  CONVENTIONAL_CONTROL_ROLES,
  fixationCountFor,
  fixationDurationMedianMsFor,
  personaSamplingParams,
  rolePriorFor,
} from '../src/persona.js';
import type { PersonaTraits } from '../src/persona.js';

/** Mid-scale on every trait, so a test can raise exactly one of them. */
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

/** One test per row of the table in `packages/engine/src/persona.ts`. */
describe('the persona-trait table', () => {
  it('shortens fixations as scanningVsReading rises', () => {
    const reader = personaSamplingParams(withTrait('scanningVsReading', 0));
    const scanner = personaSamplingParams(withTrait('scanningVsReading', 1));

    expect(scanner.fixationDurationScale).toBeLessThan(reader.fixationDurationScale);
    expect(fixationDurationMedianMsFor(withTrait('scanningVsReading', 1))).toBeLessThan(
      fixationDurationMedianMsFor(withTrait('scanningVsReading', 0)),
    );
  });

  it('raises the fixation count per screen as scanningVsReading rises', () => {
    const reader = personaSamplingParams(withTrait('scanningVsReading', 0));
    const scanner = personaSamplingParams(withTrait('scanningVsReading', 1));

    expect(scanner.fixationCountScale).toBeGreaterThan(reader.fixationCountScale);
    expect(fixationCountFor(withTrait('scanningVsReading', 1))).toBeGreaterThan(
      fixationCountFor(withTrait('scanningVsReading', 0)),
    );
  });

  it('lengthens dwell as detailOrientation rises', () => {
    expect(personaSamplingParams(withTrait('detailOrientation', 1)).dwellScale).toBeGreaterThan(
      personaSamplingParams(withTrait('detailOrientation', 0)).dwellScale,
    );
  });

  it('lengthens dwell as patience rises', () => {
    expect(personaSamplingParams(withTrait('patience', 1)).dwellScale).toBeGreaterThan(
      personaSamplingParams(withTrait('patience', 0)).dwellScale,
    );
  });

  it('raises the role prior on a conventional control as interfaceFamiliarity rises', () => {
    const unfamiliar = withTrait('interfaceFamiliarity', 0);
    const familiar = withTrait('interfaceFamiliarity', 1);

    expect(personaSamplingParams(familiar).rolePriorScale).toBeGreaterThan(
      personaSamplingParams(unfamiliar).rolePriorScale,
    );
    expect(rolePriorFor('button', familiar)).toBeGreaterThan(rolePriorFor('button', unfamiliar));
  });

  it('keeps an agent on one screen longer as persistence rises', () => {
    expect(
      personaSamplingParams(withTrait('persistence', 1)).screenPersistenceScale,
    ).toBeGreaterThan(personaSamplingParams(withTrait('persistence', 0)).screenPersistenceScale);
  });

  it('re-checks less before acting as riskTolerance rises', () => {
    expect(personaSamplingParams(withTrait('riskTolerance', 1)).verificationScale).toBeLessThan(
      personaSamplingParams(withTrait('riskTolerance', 0)).verificationScale,
    );
  });

  it('is monotonic across the scale, not only at its ends', () => {
    const scales = [0, 0.25, 0.5, 0.75, 1].map(
      (trait) => personaSamplingParams(withTrait('scanningVsReading', trait)).fixationCountScale,
    );

    for (let i = 1; i < scales.length; i += 1) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });
});

describe('sampling parameters at the ends of every trait', () => {
  const extremes: PersonaTraits[] = [
    {
      persistence: 0,
      scanningVsReading: 0,
      detailOrientation: 0,
      interfaceFamiliarity: 0,
      patience: 0,
      riskTolerance: 0,
    },
    {
      persistence: 1,
      scanningVsReading: 1,
      detailOrientation: 1,
      interfaceFamiliarity: 1,
      patience: 1,
      riskTolerance: 1,
    },
  ];

  it.each(extremes)('stays inside the stated bounds for %o', (traits) => {
    for (const scale of Object.values(personaSamplingParams(traits))) {
      expect(scale).toBeGreaterThan(0);
    }

    const { fixationDuration, fixationsPerScreen } = defaultEngineConfig;
    const durationMs = fixationDurationMedianMsFor(traits);
    expect(durationMs).toBeGreaterThanOrEqual(fixationDuration.minMs);
    expect(durationMs).toBeLessThanOrEqual(fixationDuration.maxMs);

    const count = fixationCountFor(traits);
    expect(count).toBeGreaterThanOrEqual(Math.max(1, fixationsPerScreen.min));
    expect(count).toBeLessThanOrEqual(fixationsPerScreen.max);
  });

  it('clamps rather than inventing a negative duration or an empty screen', () => {
    const { config } = resolveEngineConfig({
      persona: {
        fixationDurationScale: { atZero: -4, atOne: -4 },
        fixationCountScale: { atZero: 0.0001, atOne: 0.0001 },
      },
      fixationsPerScreen: { min: 2 },
    });

    expect(fixationDurationMedianMsFor(MIDDLING, config)).toBe(config.fixationDuration.minMs);
    expect(fixationCountFor(MIDDLING, config)).toBe(2);
  });
});

describe('rolePriorFor', () => {
  it('leaves a non-control role untouched by familiarity', () => {
    const unfamiliar = rolePriorFor('heading', withTrait('interfaceFamiliarity', 0));
    const familiar = rolePriorFor('heading', withTrait('interfaceFamiliarity', 1));

    expect(familiar).toBe(unfamiliar);
    expect(familiar).toBe(defaultEngineConfig.salience.rolePriors.heading);
  });

  it('falls back to the table other value for an unnamed role and for no role', () => {
    const { other } = defaultEngineConfig.salience.rolePriors;

    expect(rolePriorFor('figcaption', MIDDLING)).toBe(other);
    expect(rolePriorFor(null, MIDDLING)).toBe(other);
  });

  it('keeps every conventional control above prose, named in the table or not', () => {
    const { text } = defaultEngineConfig.salience.rolePriors;
    const unfamiliar = withTrait('interfaceFamiliarity', 0);

    for (const role of CONVENTIONAL_CONTROL_ROLES) {
      expect(rolePriorFor(role, unfamiliar)).toBeGreaterThan(rolePriorFor('text', unfamiliar));
      expect(rolePriorFor(role, unfamiliar)).toBeGreaterThan(text * 0.8);
    }
  });

  it('reads no inherited property for a role a page happens to call toString', () => {
    const { other } = defaultEngineConfig.salience.rolePriors;

    expect(rolePriorFor('toString', MIDDLING)).toBe(other);
    expect(rolePriorFor('hasOwnProperty', MIDDLING)).toBe(other);
  });

  it('reads its numbers from the configuration object, with no code change', () => {
    const { config } = resolveEngineConfig({ salience: { rolePriors: { button: 0.1 } } });

    expect(rolePriorFor('button', MIDDLING, config)).toBeLessThan(
      rolePriorFor('button', MIDDLING, defaultEngineConfig),
    );
  });
});
