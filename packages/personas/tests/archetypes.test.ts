import { describe, expect, it } from 'vitest';
import { ARCHETYPES, TRAIT_NAMES, traitCentre } from '../src/index.js';
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

  it.each(TRAIT_NAMES)('leaves %s reachable inside 0..1 from any centre', (trait) => {
    for (const archetype of ARCHETYPES) {
      expect(Math.abs(archetype.offsets[trait])).toBeLessThan(0.5);
    }
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
  it('reads interfaceFamiliarity straight off techSavviness', () => {
    expect(traitCentre(audienceWith({ techSavviness: 0.37 })).interfaceFamiliarity).toBe(0.37);
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
