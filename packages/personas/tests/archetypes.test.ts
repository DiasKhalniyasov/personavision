import { describe, expect, it } from 'vitest';
import { ARCHETYPES, MAX_OFFSET, TRAIT_NAMES } from '../src/archetypes.js';
import { traitCentre } from '../src/audience.js';
import { audienceWith } from './helpers.js';

/**
 * The two properties the archetype table rests on. They are what make the audience-to-trait
 * mapping behaviour rather than documentation: without the first, "raising priceSensitivity
 * raises detailOrientation" would depend on how many people were generated; without the
 * second, an audience at the end of a scale would generate identical people.
 */
describe('the archetype table', () => {
  it.each(TRAIT_NAMES)('displaces people around the centre of %s without moving it', (trait) => {
    const total = ARCHETYPES.reduce((sum, archetype) => sum + archetype.offsets[trait], 0);

    expect(total).toBeCloseTo(0, 10);
  });

  it.each(TRAIT_NAMES)('keeps %s a direction and a distance, never an absolute value', (trait) => {
    for (const archetype of ARCHETYPES) {
      expect(Math.abs(archetype.offsets[trait])).toBeLessThan(0.5);
    }
  });

  it('is what the displacement scale is read off, so editing an offset moves it', () => {
    const furthest = Math.max(
      ...ARCHETYPES.flatMap((archetype) =>
        TRAIT_NAMES.map((trait) => Math.abs(archetype.offsets[trait])),
      ),
    );

    expect(MAX_OFFSET).toBe(furthest);
  });

  it('names the four people the design contract names, in the prototype order', () => {
    expect(ARCHETYPES.map((archetype) => archetype.name)).toStrictEqual([
      'Rushed buyer',
      'Careful comparer',
      'First-time visitor',
      'Price-sensitive scanner',
    ]);
  });

  it('gives each archetype a segment clause of its own', () => {
    expect(new Set(ARCHETYPES.map((archetype) => archetype.segmentClause)).size).toBe(
      ARCHETYPES.length,
    );
  });
});

describe('the audience centre', () => {
  it('moves interfaceFamiliarity further than any other trait, and only by techSavviness', () => {
    const moved = (techSavviness: number, priceSensitivity = 0.5) =>
      traitCentre(audienceWith({ techSavviness, priceSensitivity })).interfaceFamiliarity;

    // The contract's word is "directly": it is the trait techSavviness is about, so it takes
    // the largest coefficient of the five and nothing else touches it.
    expect(moved(1) - moved(0)).toBeGreaterThan(
      traitCentre(audienceWith({ techSavviness: 1 })).scanningVsReading -
        traitCentre(audienceWith({ techSavviness: 0 })).scanningVsReading,
    );
    expect(moved(0.4, 0)).toBe(moved(0.4, 1));
    expect(moved(0.2)).toBeLessThan(moved(0.8));
  });

  it('stops every centre short of the ends of the scale, so a spread always has room', () => {
    // A centre of 0 or 1 has nothing on one side of it: everybody an archetype pushes that
    // way lands on the boundary together, and the swarm reports clones on that trait.
    for (const techSavviness of [0, 1]) {
      for (const priceSensitivity of [0, 1]) {
        for (const ageRange of [
          { min: 0, max: 1 },
          { min: 110, max: 120 },
        ]) {
          const centre = traitCentre(audienceWith({ techSavviness, priceSensitivity, ageRange }));
          for (const trait of TRAIT_NAMES) {
            expect(centre[trait]).toBeGreaterThan(0);
            expect(centre[trait]).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('leaves the two traits no audience field moves at the midpoint', () => {
    const centre = traitCentre(audienceWith({ techSavviness: 1, priceSensitivity: 0 }));

    expect(centre.persistence).toBe(0.5);
    expect(centre.riskTolerance).toBe(0.5);
  });

  it('keeps every centre inside 0..1 for the extremes of every field', () => {
    const extremes = [
      audienceWith({ techSavviness: 0, priceSensitivity: 0, ageRange: { min: 0, max: 1 } }),
      audienceWith({ techSavviness: 1, priceSensitivity: 1, ageRange: { min: 110, max: 120 } }),
      audienceWith({ techSavviness: 0, priceSensitivity: 1, ageRange: { min: 110, max: 120 } }),
      audienceWith({ techSavviness: 1, priceSensitivity: 0, ageRange: { min: 0, max: 1 } }),
    ];

    for (const audience of extremes) {
      const centre = traitCentre(audience);
      for (const trait of TRAIT_NAMES) {
        expect(centre[trait]).toBeGreaterThanOrEqual(0);
        expect(centre[trait]).toBeLessThanOrEqual(1);
      }
    }
  });
});
