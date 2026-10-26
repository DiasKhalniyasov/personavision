import { personaSchema } from '@personavision/contract';
import type { Persona } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { AudienceValidationError, GENERATOR_VERSION, generatePersonas } from '../src/index.js';
import { audienceWith, median, spread, traitValues, withShare } from './helpers.js';
import { DESKTOP_CLASS, MOBILE_CLASS } from './helpers.js';

const TRAITS = [
  'persistence',
  'scanningVsReading',
  'detailOrientation',
  'interfaceFamiliarity',
  'patience',
  'riskTolerance',
] as const satisfies readonly (keyof Persona['traits'])[];

describe('generatePersonas: determinism', () => {
  it('produces byte-identical people for the same audience and seed', () => {
    const audience = audienceWith();
    const first = generatePersonas(audience, { seed: 7 });
    const second = generatePersonas(audience, { seed: 7 });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('produces different people for a different seed', () => {
    const audience = audienceWith();

    expect(JSON.stringify(generatePersonas(audience, { seed: 8 }))).not.toBe(
      JSON.stringify(generatePersonas(audience, { seed: 7 })),
    );
  });

  it('falls back to the seed the audience was generated from', () => {
    const audience = audienceWith({
      generatedFrom: { seed: 99, generatorVersion: GENERATOR_VERSION },
    });

    expect(JSON.stringify(generatePersonas(audience))).toBe(
      JSON.stringify(generatePersonas(audience, { seed: 99 })),
    );
  });

  it('rejects a seed that is not an integer, because it has to round-trip through the artifact', () => {
    expect(() => generatePersonas(audienceWith(), { seed: 1.5 })).toThrow(/seed/);
  });
});

describe('generatePersonas: the contract', () => {
  const audience = audienceWith({ size: 9 });
  const personas = generatePersonas(audience, { seed: 3 });

  it('returns audience.size people', () => {
    expect(personas).toHaveLength(audience.size);
  });

  it('returns people that parse against the contract persona shape', () => {
    for (const persona of personas) {
      expect(personaSchema.safeParse(persona)).toMatchObject({ success: true });
    }
  });

  it('carries the audience it was generated from on every person', () => {
    expect(personas.map((persona) => persona.audienceId)).toEqual(
      Array.from({ length: audience.size }, () => audience.id),
    );
  });

  it('labels every person with a non-empty segment', () => {
    for (const persona of personas) {
      expect(persona.segment.length).toBeGreaterThan(0);
      expect(persona.segment).toContain('·');
    }
  });

  it('gives every person an id of its own, as the artifact requires', () => {
    expect(new Set(personas.map((persona) => persona.id)).size).toBe(audience.size);
  });

  it('gives every person a name of its own, so a sessions list can name them apart', () => {
    expect(new Set(personas.map((persona) => persona.name)).size).toBe(audience.size);
  });
});

describe('generatePersonas: spread', () => {
  it('does not return clones: patience and scanningVsReading are spread across the set', () => {
    const personas = generatePersonas(audienceWith({ size: 12 }), { seed: 4 });

    expect(spread(traitValues(personas, 'patience'))).toBeGreaterThan(0.2);
    expect(spread(traitValues(personas, 'scanningVsReading'))).toBeGreaterThan(0.2);
  });

  it('spreads every trait, not only the two the audience moves', () => {
    const personas = generatePersonas(audienceWith({ size: 12 }), { seed: 4 });

    for (const trait of TRAITS) {
      expect(spread(traitValues(personas, trait))).toBeGreaterThan(0.1);
    }
  });

  it('separates two people who share an archetype, so size is not four people repeated', () => {
    const personas = generatePersonas(audienceWith({ size: 8 }), { seed: 5 });
    const first = personas[0];
    const fifth = personas[4];
    if (first === undefined || fifth === undefined) throw new Error('expected eight people');

    expect(fifth.name).not.toBe(first.name);
    expect(fifth.traits).not.toEqual(first.traits);
  });
});

describe('generatePersonas: every trait stays on the 0..1 scale', () => {
  const extremes = [
    audienceWith({ techSavviness: 0 }),
    audienceWith({ techSavviness: 1 }),
    audienceWith({ priceSensitivity: 0 }),
    audienceWith({ priceSensitivity: 1 }),
    audienceWith({ ageRange: { min: 0, max: 0 } }),
    audienceWith({ ageRange: { min: 100, max: 120 } }),
    audienceWith({ ageRange: { min: 18, max: 24 }, techSavviness: 1, priceSensitivity: 1 }),
    audienceWith({ ageRange: { min: 65, max: 95 }, techSavviness: 0, priceSensitivity: 0 }),
  ];

  for (const audience of extremes) {
    const label = `tech ${audience.techSavviness}, price ${audience.priceSensitivity}, ages ${audience.ageRange.min}-${audience.ageRange.max}`;
    it(`holds every trait inside 0..1 for ${label}`, () => {
      for (const persona of generatePersonas({ ...audience, size: 24 }, { seed: 6 })) {
        for (const trait of TRAITS) {
          expect(persona.traits[trait]).toBeGreaterThanOrEqual(0);
          expect(persona.traits[trait]).toBeLessThanOrEqual(1);
        }
      }
    });
  }
});

describe('generatePersonas: the audience moves the traits it is documented to move', () => {
  const medianTrait = (
    audience: Parameters<typeof generatePersonas>[0],
    trait: keyof Persona['traits'],
  ) => median(traitValues(generatePersonas(audience, { seed: 11 }), trait));

  it('raises median interfaceFamiliarity as techSavviness rises', () => {
    const medians = [0.1, 0.3, 0.5, 0.7, 0.9].map((techSavviness) =>
      medianTrait(audienceWith({ size: 40, techSavviness }), 'interfaceFamiliarity'),
    );

    expect(medians).toStrictEqual([...medians].sort((left, right) => left - right));
    expect(new Set(medians).size).toBe(medians.length);
  });

  it('raises median detailOrientation as priceSensitivity rises', () => {
    const medians = [0.1, 0.3, 0.5, 0.7, 0.9].map((priceSensitivity) =>
      medianTrait(audienceWith({ size: 40, priceSensitivity }), 'detailOrientation'),
    );

    expect(medians).toStrictEqual([...medians].sort((left, right) => left - right));
    expect(new Set(medians).size).toBe(medians.length);
  });

  it('lowers median patience as priceSensitivity rises', () => {
    const medians = [0.1, 0.3, 0.5, 0.7, 0.9].map((priceSensitivity) =>
      medianTrait(audienceWith({ size: 40, priceSensitivity }), 'patience'),
    );

    expect(medians).toStrictEqual([...medians].sort((left, right) => right - left));
    expect(new Set(medians).size).toBe(medians.length);
  });

  it('raises median patience as the audience ages, and lowers median scanningVsReading with it', () => {
    const older = audienceWith({ size: 40, ageRange: { min: 55, max: 75 } });
    const younger = audienceWith({ size: 40, ageRange: { min: 18, max: 28 } });

    expect(medianTrait(older, 'patience')).toBeGreaterThan(medianTrait(younger, 'patience'));
    expect(medianTrait(older, 'scanningVsReading')).toBeLessThan(
      medianTrait(younger, 'scanningVsReading'),
    );
  });

  it('raises median scanningVsReading as techSavviness rises', () => {
    const medians = [0.1, 0.5, 0.9].map((techSavviness) =>
      medianTrait(audienceWith({ size: 40, techSavviness }), 'scanningVsReading'),
    );

    expect(medians).toStrictEqual([...medians].sort((left, right) => left - right));
    expect(new Set(medians).size).toBe(medians.length);
  });
});

describe('generatePersonas: an audience that fails the contract is rejected before generation', () => {
  const invalid = [
    {
      what: 'a device mix whose shares do not sum to one',
      audience: {
        ...audienceWith(),
        devices: [withShare(MOBILE_CLASS, 0.5), withShare(DESKTOP_CLASS, 0.2)],
      },
      path: 'devices',
    },
    {
      what: 'an age range that runs backwards',
      audience: { ...audienceWith(), ageRange: { min: 60, max: 20 } },
      path: 'ageRange',
    },
    {
      what: 'a techSavviness off the 0..1 scale',
      audience: { ...audienceWith(), techSavviness: 1.4 },
      path: 'techSavviness',
    },
    {
      what: 'a size of zero',
      audience: { ...audienceWith(), size: 0 },
      path: 'size',
    },
    {
      what: 'an empty device mix',
      audience: { ...audienceWith(), devices: [] },
      path: 'devices',
    },
    {
      what: 'a field the contract does not declare',
      audience: { ...audienceWith(), workspaceId: 'ws-1' },
      path: 'workspaceId',
    },
  ];

  for (const { what, audience, path } of invalid) {
    it(`rejects ${what}, naming the offending path`, () => {
      expect(() => generatePersonas(audience as never, { seed: 1 })).toThrow(
        AudienceValidationError,
      );
      try {
        generatePersonas(audience as never, { seed: 1 });
      } catch (error) {
        if (!(error instanceof AudienceValidationError)) throw error;
        expect(error.issues.map((issue) => issue.path)).toContain(path);
        expect(error.message).toContain(path);
      }
    });
  }

  it('rejects an audience generated by another version of the generator', () => {
    const audience = audienceWith({
      generatedFrom: { seed: 1, generatorVersion: 'persona-gen-0' },
    });

    expect(() => generatePersonas(audience, { seed: 1 })).toThrow(/generatorVersion/);
  });
});
