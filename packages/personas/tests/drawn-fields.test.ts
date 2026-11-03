import { createSeededRandom } from '@personavision/contract';
import type { AgeGroup, Audience, Gender } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  AudienceValidationError,
  ageBracket,
  ageGroupApportionment,
  ageGroupYears,
  genderApportionment,
  languageApportionment,
  parseAudience,
} from '../src/audience.js';
import { drawnAges, generatePersonas } from '../src/generate.js';
import { deviceQuota, largestRemainder } from '../src/devices.js';
import { generateHoldout } from '../src/holdout.js';
import { ALMATY_PARENTS, EXPECTED_DRAWN_FIELDS } from './drawn-fields-expectation.js';
import { audienceWith, median } from './helpers.js';

/**
 * The gender split, the age groups and the language a person reads in: the three rows
 * `docs/FLOW.md` section 12 adds to the generator's mapping table (#278).
 *
 * Three things are being asserted, and they are different things. That the counts are the
 * shares — the audience's claim, at every size and seed. That who gets which is reproducible
 * — the seed's, against a committed expectation rather than a second call. And that an
 * audience declaring none of the three draws the people it always drew, which is the whole
 * reason `GENERATOR_VERSION` does not move.
 */

/** The rows of `EXPECTED_DRAWN_FIELDS`, as the generator produces them now. */
const drawnRows = (audience: Audience, seed = audience.generatedFrom.seed): string[] => {
  const people = generatePersonas(audience, { seed });
  const ages = drawnAges(audience, seed);
  if (ages === null) throw new Error('this audience declares age groups');
  return people.map((person, index) => {
    const drawn = ages[index];
    if (drawn === undefined) throw new Error('one age per person');
    return `${person.id}|${String(person.gender)}|${drawn.group}|${String(drawn.age)}|${String(person.language)}`;
  });
};

const tally = <Value>(values: readonly Value[]): Map<Value, number> => {
  const seen = new Map<Value, number>();
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);
  return seen;
};

const countsOf = <Value>(
  apportioned: readonly { readonly value: Value; readonly count: number }[] | null,
): Map<Value, number> => {
  if (apportioned === null) throw new Error('this audience declares the field');
  return new Map(apportioned.map(({ value, count }) => [value, count]));
};

describe('the same audience and seed draw the same hundred people', () => {
  it('matches the committed expectation, field for field', () => {
    expect(drawnRows(ALMATY_PARENTS)).toStrictEqual([...EXPECTED_DRAWN_FIELDS]);
  });

  it('is a hundred rows, so the expectation covers every person', () => {
    expect(EXPECTED_DRAWN_FIELDS).toHaveLength(ALMATY_PARENTS.size);
  });

  it('draws different people under a different seed, and the same counts', () => {
    const other = drawnRows(ALMATY_PARENTS, 7);

    expect(other).not.toStrictEqual([...EXPECTED_DRAWN_FIELDS]);
    // The shares are the audience's, so the tallies are the seed's to leave alone.
    expect(tally(other.map((row) => row.split('|')[1]))).toStrictEqual(
      tally([...EXPECTED_DRAWN_FIELDS].map((row) => row.split('|')[1])),
    );
  });
});

describe('the gender split is apportioned like the device mix', () => {
  it('gives a hundred people with a 54/46 split 54 and 46, and not 54 and 45', () => {
    expect(countsOf(genderApportionment(ALMATY_PARENTS))).toStrictEqual(
      new Map<Gender, number>([
        ['female', 54],
        ['male', 46],
      ]),
    );
  });

  it('hands out exactly that apportionment, with nobody left over and nobody twice', () => {
    const people = generatePersonas(ALMATY_PARENTS);

    expect(tally(people.map((person) => person.gender))).toStrictEqual(
      countsOf(genderApportionment(ALMATY_PARENTS)),
    );
    expect(people.filter((person) => person.gender === undefined)).toHaveLength(0);
  });

  it('is the device mix own largest-remainder rule, share for share', () => {
    const split = { male: 0.46, female: 0.54 };
    const audience = audienceWith({ size: 37, genderSplit: split });

    // Sorted, so `female` leads: the same two shares through the same function.
    expect([...countsOf(genderApportionment(audience)).values()]).toStrictEqual(
      largestRemainder(37, [split.female, split.male]),
    );
  });

  it.each([1, 2, 3, 4, 7, 12, 99, 100, 1000])('accounts for every one of %i people', (size) => {
    const counts = countsOf(
      genderApportionment(audienceWith({ size, genderSplit: { male: 0.46, female: 0.54 } })),
    );

    expect([...counts.values()].reduce((total, count) => total + count, 0)).toBe(size);
  });

  it('draws nobody as a gender the audience gave no share: a zero is a measurement', () => {
    const people = generatePersonas(
      audienceWith({ size: 24, genderSplit: { male: 1, female: 0 } }),
    );

    expect(tally(people.map((person) => person.gender))).toStrictEqual(
      new Map<Gender | undefined, number>([['male', 24]]),
    );
  });

  it('reads the two words off the split, whichever order the audience was written in', () => {
    const written = audienceWith({ size: 21, genderSplit: { female: 0.54, male: 0.46 } });
    const reversed = audienceWith({ size: 21, genderSplit: { male: 0.46, female: 0.54 } });

    expect(JSON.stringify(generatePersonas(reversed))).toBe(
      JSON.stringify(generatePersonas(written)),
    );
  });

  it('orders the two words itself, rather than taking whatever order it is handed', () => {
    // `generatePersonas` parses first, and zod happens to rebuild the split in the schema's
    // own order, so the case above would pass without the sort. This is the one that would
    // not: the apportionment reached directly, on an audience nobody normalised.
    const written = audienceWith({ size: 21, genderSplit: { female: 0.54, male: 0.46 } });
    const reversed = audienceWith({ size: 21, genderSplit: { male: 0.46, female: 0.54 } });

    expect(Object.keys(reversed.genderSplit ?? {})).not.toStrictEqual(
      Object.keys(written.genderSplit ?? {}),
    );
    expect(genderApportionment(reversed)).toStrictEqual(genderApportionment(written));
    // And the tie-break is stated rather than incidental: `female` leads, so the odd person
    // of a 50/50 split over 21 people is drawn as `female`.
    expect(
      countsOf(
        genderApportionment(audienceWith({ size: 21, genderSplit: { male: 0.5, female: 0.5 } })),
      ),
    ).toStrictEqual(
      new Map<Gender, number>([
        ['female', 11],
        ['male', 10],
      ]),
    );
  });
});

describe('the age groups', () => {
  const ages = drawnAges(ALMATY_PARENTS, ALMATY_PARENTS.generatedFrom.seed);

  it('draws each person from a group in proportion to its share', () => {
    expect(ages).not.toBeNull();
    expect(tally((ages ?? []).map((drawn) => drawn.group))).toStrictEqual(
      countsOf(ageGroupApportionment(ALMATY_PARENTS)),
    );
  });

  it('accounts for every person, and so the shares are the counts', () => {
    const counts = countsOf(ageGroupApportionment(ALMATY_PARENTS));

    expect([...counts.values()].reduce((total, count) => total + count, 0)).toBe(
      ALMATY_PARENTS.size,
    );
    expect(counts).toStrictEqual(
      new Map<AgeGroup, number>([
        ['25–34', 55],
        ['35–44', 45],
      ]),
    );
  });

  it('puts every person age inside the group they were drawn from', () => {
    for (const { group, age } of ages ?? []) {
      const bracket = ageBracket(ALMATY_PARENTS, group);

      expect(age).toBeGreaterThanOrEqual(bracket.min);
      expect(age).toBeLessThanOrEqual(bracket.max);
    }
  });

  it('keeps every age inside the audience own range as well as inside the bracket', () => {
    for (const { age } of ages ?? []) {
      expect(age).toBeGreaterThanOrEqual(ALMATY_PARENTS.ageRange.min);
      expect(age).toBeLessThanOrEqual(ALMATY_PARENTS.ageRange.max);
    }
  });

  it('spends the whole span of a bracket rather than one age in it', () => {
    const young = (ages ?? []).filter((drawn) => drawn.group === '25–34').map((drawn) => drawn.age);

    // 25-34 narrowed to an audience of 28 to 44 is 28 to 34: seven years, and 55 people.
    expect(Math.min(...young)).toBe(28);
    expect(Math.max(...young)).toBe(34);
  });

  it('draws nobody from a bracket the audience put nobody in', () => {
    const audience = audienceWith({
      size: 12,
      ageRange: { min: 30, max: 44 },
      ageGroups: [
        { group: '25–34', share: 0.5 },
        { group: '35–44', share: 0.5 },
        { group: '65+', share: 0 },
      ],
    });

    expect(tally((drawnAges(audience, 3) ?? []).map((drawn) => drawn.group))).toStrictEqual(
      new Map<AgeGroup, number>([
        ['25–34', 6],
        ['35–44', 6],
      ]),
    );
  });

  it('moves this person patience and scanning rather than the audience midpoint', () => {
    // One audience, so every other input to the centre is held still: the two cohorts
    // differ in the age each of them was drawn at and in nothing else.
    const spread = audienceWith({
      size: 40,
      ageRange: { min: 18, max: 64 },
      ageGroups: [
        { group: '18–24', share: 0.5 },
        { group: '55–64', share: 0.5 },
      ],
    });
    const people = generatePersonas(spread, { seed: 11 });
    const drawn = drawnAges(spread, 11) ?? [];
    const cohort = (group: AgeGroup, trait: 'patience' | 'scanningVsReading'): number[] =>
      people.flatMap((person, index) =>
        drawn[index]?.group === group ? [person.traits[trait]] : [],
      );

    // The two coefficients the mapping table already states, in the directions it states
    // them: an older person gives up later and reads more of the page. Medians, because an
    // archetype displaces an individual either way and the claim is about the cohort.
    expect(median(cohort('55–64', 'patience'))).toBeGreaterThan(
      median(cohort('18–24', 'patience')),
    );
    expect(median(cohort('55–64', 'scanningVsReading'))).toBeLessThan(
      median(cohort('18–24', 'scanningVsReading')),
    );
  });

  describe('what a bracket label means in years', () => {
    const everyGroup: Record<AgeGroup, { min: number; max: number | null }> = {
      '18–24': { min: 18, max: 24 },
      '25–34': { min: 25, max: 34 },
      '35–44': { min: 35, max: 44 },
      '45–54': { min: 45, max: 54 },
      '55–64': { min: 55, max: 64 },
      '65+': { min: 65, max: null },
    };

    it.each(Object.keys(everyGroup) as AgeGroup[])('reads %s off its own label', (group) => {
      expect(ageGroupYears(group)).toStrictEqual(everyGroup[group]);
    });

    it('takes the audience own range as the top of the open bracket', () => {
      const audience = audienceWith({
        ageRange: { min: 65, max: 80 },
        ageGroups: [{ group: '65+', share: 1 }],
      });

      expect(ageBracket(audience, '65+')).toStrictEqual({ min: 65, max: 80 });
    });

    it('narrows a bracket to the range, at both ends', () => {
      const audience = audienceWith({
        ageRange: { min: 28, max: 40 },
        ageGroups: [
          { group: '25–34', share: 0.5 },
          { group: '35–44', share: 0.5 },
        ],
      });

      expect(ageBracket(audience, '25–34')).toStrictEqual({ min: 28, max: 34 });
      expect(ageBracket(audience, '35–44')).toStrictEqual({ min: 35, max: 40 });
    });

    it('names the audience path when a bracket and the range leave no age at all', () => {
      // Reachable only for a bracket the contract does not hold the range against: one that
      // carries nobody. The refusal is an audience path either way, never a silent age.
      const audience = audienceWith({
        ageRange: { min: 28, max: 40 },
        ageGroups: [{ group: '25–34', share: 1 }],
      });

      expect(() => ageBracket(audience, '65+')).toThrow(AudienceValidationError);
      expect(() => ageBracket(audience, '65+')).toThrow(/ageGroups/);
    });
  });
});

describe('the language a person reads in', () => {
  it('apportions a list evenly, because nobody gave it shares', () => {
    expect(countsOf(languageApportionment(ALMATY_PARENTS))).toStrictEqual(
      new Map([
        ['Russian', 50],
        ['Kazakh', 50],
      ]),
    );
  });

  it('splits three languages over a hundred people as 34, 33 and 33', () => {
    const audience = audienceWith({ size: 100, languages: ['Russian', 'Kazakh', 'English'] });

    expect([...countsOf(languageApportionment(audience)).values()]).toStrictEqual([34, 33, 33]);
  });

  it('gives every person the one language of a one-language audience', () => {
    const people = generatePersonas(audienceWith({ size: 17, languages: ['Russian'] }));

    expect(people.map((person) => person.language)).toStrictEqual(
      Array.from({ length: 17 }, () => 'Russian'),
    );
  });

  it('gives every person exactly one language, and one the audience listed', () => {
    const people = generatePersonas(ALMATY_PARENTS);

    for (const person of people) {
      expect(ALMATY_PARENTS.languages).toContain(person.language);
    }
    expect(tally(people.map((person) => person.language))).toStrictEqual(
      countsOf(languageApportionment(ALMATY_PARENTS)),
    );
  });

  it.each([1, 2, 3, 5, 24, 100])(
    'accounts for every one of %i people over four languages',
    (size) => {
      const counts = countsOf(
        languageApportionment(audienceWith({ size, languages: ['a', 'b', 'c', 'd'] })),
      );

      expect([...counts.values()].reduce((total, count) => total + count, 0)).toBe(size);
    },
  );
});

describe('an audience that declares none of the three', () => {
  const plain = audienceWith({ size: 24 });

  it('draws people carrying neither a gender nor a language', () => {
    for (const person of generatePersonas(plain, { seed: 5 })) {
      expect(person.gender).toBeUndefined();
      expect(person.language).toBeUndefined();
      expect('gender' in person).toBe(false);
      expect('language' in person).toBe(false);
    }
  });

  it('draws no age at all, rather than one nobody asked for', () => {
    expect(drawnAges(plain, 5)).toBeNull();
    expect(genderApportionment(plain)).toBeNull();
    expect(languageApportionment(plain)).toBeNull();
    expect(ageGroupApportionment(plain)).toBeNull();
  });

  it('draws the same people as an audience that never heard of the three fields', () => {
    // The fields fire only on an audience that carries them, which is what lets
    // `GENERATOR_VERSION` stay where it is: a stored audience this build refuses is an
    // audience the platform cannot preview at all.
    const { genderSplit, ageGroups, languages, ...withoutTheFields } = {
      ...plain,
      genderSplit: undefined,
      ageGroups: undefined,
      languages: undefined,
    };
    void genderSplit;
    void ageGroups;
    void languages;

    expect(JSON.stringify(generatePersonas(withoutTheFields, { seed: 5 }))).toBe(
      JSON.stringify(generatePersonas(plain, { seed: 5 })),
    );
  });
});

describe('the three fields do not move each other', () => {
  const base = { size: 24, genderSplit: { male: 0.5, female: 0.5 } } as const;

  it('leaves the genders where they were when a language list is added', () => {
    const before = generatePersonas(audienceWith(base), { seed: 9 });
    const after = generatePersonas(audienceWith({ ...base, languages: ['Russian', 'Kazakh'] }), {
      seed: 9,
    });

    expect(after.map((person) => person.gender)).toStrictEqual(
      before.map((person) => person.gender),
    );
  });

  it('leaves the genders where they were when age groups are added', () => {
    const before = generatePersonas(audienceWith(base), { seed: 9 });
    const after = generatePersonas(
      audienceWith({
        ...base,
        ageRange: { min: 30, max: 44 },
        ageGroups: [
          { group: '25–34', share: 0.5 },
          { group: '35–44', share: 0.5 },
        ],
      }),
      { seed: 9 },
    );

    expect(after.map((person) => person.gender)).toStrictEqual(
      before.map((person) => person.gender),
    );
  });

  it('draws a gender that is not a reading of the archetype beside it', () => {
    // Dealt in the quota own order, or alternately, a two-value field over the four
    // round-robin archetypes would make the field a proxy for the behaviour. The deal is
    // shuffled precisely so it is not, and this is what that buys.
    const people = generatePersonas(
      audienceWith({ size: 100, genderSplit: { male: 0.5, female: 0.5 } }),
      { seed: 9 },
    );
    const perArchetype = tally(
      people
        .filter((person) => person.gender === 'female')
        .map((person) => person.id.replace(/-\d+$/, '')),
    );

    // Four archetypes, fifty women: a deal in order would give two archetypes 25 each and
    // the other two none.
    expect([...perArchetype.keys()]).toHaveLength(4);
    for (const count of perArchetype.values()) expect(count).toBeGreaterThan(0);
  });
});

describe('the holdout draws the same kind of person', () => {
  it('carries the audience own counts across all three fields', () => {
    const holdout = generateHoldout({ audience: ALMATY_PARENTS, spentSeeds: [1, 2, 3] });
    const quota = countsOf(
      genderApportionment({ ...ALMATY_PARENTS, size: holdout.personas.length }),
    );

    expect(holdout.personas).toHaveLength(20);
    expect(tally(holdout.personas.map((person) => person.gender))).toStrictEqual(quota);
    for (const person of holdout.personas) {
      expect(ALMATY_PARENTS.languages).toContain(person.language);
    }
  });
});

describe('the apportionment rule over the whole input space', () => {
  const random = createSeededRandom(278);
  const shares = (count: number): number[] => {
    const raw = Array.from({ length: count }, () => random() + 1e-9);
    const total = raw.reduce((running, share) => running + share, 0);
    const scaled = raw.map((share) => share / total);
    const residue = 1 - scaled.reduce((running, share) => running + share, 0);
    scaled[count - 1] = (scaled[count - 1] ?? 0) + residue;
    return scaled;
  };

  it.each([1, 2, 3, 4, 5, 7, 11, 24, 97, 100])(
    'accounts for every one of %i people over 1 to 6 random share vectors',
    (size) => {
      for (let count = 1; count <= 6; count += 1) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const quota = largestRemainder(size, shares(count));

          expect(quota.reduce((running, value) => running + value, 0)).toBe(size);
          expect(quota.every((value) => value >= 0)).toBe(true);
        }
      }
    },
  );

  it('is the function the device mix is built on, so one rule serves every share', () => {
    const audience = audienceWith({ size: 97 });

    // The device mix is this rule plus the representation floor, and at a size where no
    // declared device is short of a person the floor has nothing to do.
    expect(deviceQuota(audience)).toStrictEqual(
      largestRemainder(
        97,
        audience.devices.map((device) => device.share),
      ),
    );
  });
});

describe('an audience form reads the new fields problems at their own paths', () => {
  const issuesOf = (audience: unknown): Map<string, string> => {
    try {
      parseAudience(audience);
    } catch (error) {
      if (error instanceof AudienceValidationError) {
        return new Map(error.issues.map((issue) => [issue.path, issue.message]));
      }
      throw error;
    }
    throw new Error('this audience was expected to be refused');
  };

  it('names `genderSplit` when the split is not a distribution', () => {
    expect([
      ...issuesOf(audienceWith({ genderSplit: { male: 0.6, female: 0.6 } })).keys(),
    ]).toContain('genderSplit');
  });

  it('names `genderSplit.male` when a share is not a share', () => {
    expect([
      ...issuesOf({ ...audienceWith(), genderSplit: { male: 2, female: -1 } }).keys(),
    ]).toContain('genderSplit.male');
  });

  it('names `ageGroups` when the group shares are not a distribution', () => {
    expect([
      ...issuesOf(
        audienceWith({
          ageGroups: [
            { group: '25–34', share: 0.5 },
            { group: '35–44', share: 0.2 },
          ],
        }),
      ).keys(),
    ]).toContain('ageGroups');
  });

  it('names the offending group by index when one bracket carries two shares', () => {
    expect([
      ...issuesOf(
        audienceWith({
          ageRange: { min: 30, max: 34 },
          ageGroups: [
            { group: '25–34', share: 0.5 },
            { group: '25–34', share: 0.5 },
          ],
        }),
      ).keys(),
    ]).toContain('ageGroups[1].group');
  });

  it('names `ageGroups` when the brackets and `ageRange` disagree', () => {
    expect([
      ...issuesOf(
        audienceWith({ ageRange: { min: 18, max: 70 }, ageGroups: [{ group: '25–34', share: 1 }] }),
      ).keys(),
    ]).toContain('ageGroups');
  });

  it('names `languages` when the list is there but empty', () => {
    expect([...issuesOf(audienceWith({ languages: [] })).keys()]).toContain('languages');
  });

  it('names `languages[0]` when a language is an empty string', () => {
    expect([...issuesOf(audienceWith({ languages: [''] })).keys()]).toContain('languages[0]');
  });

  it('refuses nothing an audience that declares none of the three', () => {
    expect(() => parseAudience(audienceWith())).not.toThrow();
  });
});

describe('an age-group list that puts nobody in any bracket', () => {
  // The contract refuses it first — the shares have to sum to one — so this is about what
  // the derivation does when it is reached directly, which is where the crash would be.
  const empty = audienceWith({ ageGroups: [{ group: '25–34', share: 0 }] });

  it('is an audience path rather than a crash inside the apportionment', () => {
    expect(() => ageGroupApportionment(empty)).toThrow(AudienceValidationError);
    expect(() => ageGroupApportionment(empty)).toThrow(/ageGroups/);
  });

  it('is refused by `parseAudience` before generation ever reaches it', () => {
    expect(() => parseAudience(empty)).toThrow(AudienceValidationError);
    expect(() => generatePersonas(empty)).toThrow(/ageGroups/);
  });
});
