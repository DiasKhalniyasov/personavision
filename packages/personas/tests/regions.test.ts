import type { Audience, Persona } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { regionApportionment } from '../src/audience.js';
import { generatePersonas } from '../src/generate.js';
import {
  BROWSING_REGIONS,
  LANGUAGE_SUBTAGS,
  browsingFor,
  browsingRegion,
  languageSubtag,
} from '../src/regions.js';
import { audienceWith } from './helpers.js';

/**
 * A session browses in its persona's region: the region a person is drawn, and the one table
 * that turns it into a locale, a time zone and a location (#421).
 *
 * Four different things are asserted here, and they fail for different reasons. That the
 * **table** is a table of real values — a time zone the platform can resolve, coordinates on
 * the earth, a region subtag of the right shape. That the **locale rule** is the one stated:
 * the person's language over the region's subtag, the region's own language where they were
 * drawn none, and the bare language with nothing else where the table does not know the
 * region. That the **draw** is the audience's apportionment and the seed's order, reproducibly.
 * And that adding it **moved nobody**: the devices, genders, ages and traits of a set
 * generated before regions existed are the ones it generates now.
 */

/** A person as the table reads them: only the two fields it looks at. */
const who = (region?: string, language?: string): Pick<Persona, 'region' | 'language'> => ({
  ...(region === undefined ? {} : { region }),
  ...(language === undefined ? {} : { language }),
});

const regionsOf = (
  audience: Audience,
  seed = audience.generatedFrom.seed,
): (string | undefined)[] => generatePersonas(audience, { seed }).map((person) => person.region);

const tally = (values: readonly (string | undefined)[]): Map<string | undefined, number> => {
  const seen = new Map<string | undefined, number>();
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);
  return seen;
};

/** The two the acceptance names: a UK and US audience, of a size that divides unevenly. */
const UK_AND_US = audienceWith({ size: 25, regions: ['United Kingdom', 'United States'] });

describe('the table from a region to a browser', () => {
  it.each(BROWSING_REGIONS.map((region) => [region.names[0] ?? '', region] as const))(
    '%s maps to a region subtag, a time zone the platform can resolve and a point on the earth',
    (_name, region) => {
      expect(region.subtag).toMatch(/^[A-Z]{2}$/);
      expect(region.names.length).toBeGreaterThan(0);
      // Not a string we hope is a time zone: the platform's own database has to know it.
      expect(() =>
        new Intl.DateTimeFormat('en', { timeZone: region.timeZone }).format(),
      ).not.toThrow();
      expect(region.latitude).toBeGreaterThanOrEqual(-90);
      expect(region.latitude).toBeLessThanOrEqual(90);
      expect(region.longitude).toBeGreaterThanOrEqual(-180);
      expect(region.longitude).toBeLessThanOrEqual(180);
    },
  );

  it('spells every main language the other table can spell, so neither can name what the other cannot', () => {
    const spellable = new Set(LANGUAGE_SUBTAGS.values());

    expect(BROWSING_REGIONS.filter((region) => !spellable.has(region.language))).toStrictEqual([]);
  });

  it('gives no name to two regions', () => {
    const names = BROWSING_REGIONS.flatMap((region) =>
      region.names.map((name) => name.toLowerCase()),
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it('matches a name whatever its case and whatever space is around it', () => {
    const uk = browsingRegion('United Kingdom');

    expect(uk?.subtag).toBe('GB');
    expect(browsingRegion('  UNITED KINGDOM  ')).toBe(uk);
    expect(browsingRegion('uk')).toBe(uk);
    expect(browsingRegion('GB')).toBe(uk);
  });

  it('knows the audiences this repository is written with, down to the city the worked example names', () => {
    expect(browsingRegion('Almaty')?.timeZone).toBe('Asia/Almaty');
    expect(browsingRegion('Ireland')?.timeZone).toBe('Europe/Dublin');
    expect(browsingRegion('United States')?.timeZone).toBe('America/New_York');
    // The country the IKEA run was wrongly served, so that the bug's own region is a row.
    expect(browsingRegion('United Arab Emirates')?.subtag).toBe('AE');
  });

  it('says nothing about a region nobody added', () => {
    expect(browsingRegion('Narnia')).toBeNull();
    expect(browsingRegion('')).toBeNull();
  });

  it('reads a language name, or a tag already written as one, and refuses to guess', () => {
    expect(languageSubtag('English')).toBe('en');
    expect(languageSubtag('  russian ')).toBe('ru');
    expect(languageSubtag('en-GB')).toBe('en');
    expect(languageSubtag('pt-BR')).toBe('pt');
    // "Kazakh" off its first two letters would be `ka`, which is Georgian.
    expect(languageSubtag('Kazakh')).toBe('kk');
    expect(languageSubtag('Klingon')).toBeNull();
    expect(languageSubtag('')).toBeNull();
  });
});

describe('what a session is opened with', () => {
  it('is the person language over the region subtag, with that region time zone and city', () => {
    expect(browsingFor(who('United Kingdom', 'English'))).toStrictEqual({
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
  });

  it('takes the region own main language where the person was drawn none', () => {
    expect(browsingFor(who('Germany'))?.locale).toBe('de-DE');
    expect(browsingFor(who('Kazakhstan'))?.locale).toBe('kk-KZ');
  });

  it('keeps the person language over the region where the two disagree', () => {
    // A Russian speaker in Almaty reads `ru-KZ`, not `ru-RU` and not `kk-KZ`: the language
    // is theirs and the country is the audience's.
    expect(browsingFor(who('Almaty', 'Russian'))).toStrictEqual({
      locale: 'ru-KZ',
      timezoneId: 'Asia/Almaty',
      geolocation: { latitude: 43.222, longitude: 76.8512 },
    });
  });

  it('is the bare language subtag, no time zone and no location, for a region nobody added', () => {
    expect(browsingFor(who('Narnia', 'Russian'))).toStrictEqual({
      locale: 'ru',
      timezoneId: null,
      geolocation: null,
    });
  });

  it('claims no country at all for a region and a language nobody added', () => {
    // The whole point of the fallback: an unrecognised region is visible in the artifact as
    // the absence it is, rather than quietly becoming somebody else's country.
    expect(browsingFor(who('Narnia', 'Klingon'))).toStrictEqual({
      locale: null,
      timezoneId: null,
      geolocation: null,
    });
  });

  it('is the language alone for a person drawn a language and no region', () => {
    expect(browsingFor(who(undefined, 'English'))).toStrictEqual({
      locale: 'en',
      timezoneId: null,
      geolocation: null,
    });
  });

  it('is nothing at all for a person drawn neither, so such a session opens as it always did', () => {
    expect(browsingFor(who())).toBeNull();
    expect(browsingFor(who(undefined, 'Klingon'))).toBeNull();
  });
});

describe('the region each person is drawn', () => {
  it('apportions the audience evenly over the regions it lists', () => {
    const apportioned = regionApportionment(UK_AND_US);

    expect(apportioned).toStrictEqual([
      { value: 'United Kingdom', count: 13 },
      { value: 'United States', count: 12 },
    ]);
  });

  it('declares none when the audience lists none, which is an empty list and not a missing field', () => {
    expect(regionApportionment(audienceWith({ regions: [] }))).toBeNull();
    expect(
      generatePersonas(audienceWith({ regions: [] })).map((person) => person.region),
    ).toStrictEqual(Array.from({ length: 12 }, () => undefined));
  });

  it('gives every person one of the audience regions, in the counts the audience declared', () => {
    expect(tally(regionsOf(UK_AND_US))).toStrictEqual(
      new Map([
        ['United Kingdom', 13],
        ['United States', 12],
      ]),
    );
  });

  it('draws the same regions from the same audience and seed', () => {
    expect(regionsOf(UK_AND_US)).toStrictEqual(regionsOf(UK_AND_US));
  });

  it('draws them in a different order under a different seed, and in the same counts', () => {
    const other = regionsOf(UK_AND_US, 77);

    expect(other).not.toStrictEqual(regionsOf(UK_AND_US));
    expect(tally(other)).toStrictEqual(tally(regionsOf(UK_AND_US)));
  });

  it('does not deal them alternately, which would make the region a proxy for the archetype', () => {
    const drawn = regionsOf(UK_AND_US);
    const alternating = Array.from({ length: UK_AND_US.size }, (_unused, index) =>
      index % 2 === 0 ? 'United Kingdom' : 'United States',
    );

    expect(drawn).not.toStrictEqual(alternating);
  });

  it('carries the audience own word, so a region the table does not know still reaches the person', () => {
    const people = generatePersonas(audienceWith({ size: 4, regions: ['Narnia'] }));

    expect(people.map((person) => person.region)).toStrictEqual([
      'Narnia',
      'Narnia',
      'Narnia',
      'Narnia',
    ]);
    expect(browsingFor(people[0] as Persona)).toStrictEqual({
      locale: null,
      timezoneId: null,
      geolocation: null,
    });
  });
});

describe('adding the region moved nobody', () => {
  const base = {
    size: 24,
    genderSplit: { male: 0.5, female: 0.5 },
    languages: ['Russian', 'Kazakh'],
    ageRange: { min: 30, max: 44 },
    ageGroups: [
      { group: '25–34' as const, share: 0.5 },
      { group: '35–44' as const, share: 0.5 },
    ],
  };

  /** Everything about a person except the region: who they are, and every number drawn for them. */
  const exceptTheRegion = (audience: Audience) =>
    generatePersonas(audience, { seed: 9 }).map(({ region, ...person }) => {
      void region;
      return person;
    });

  it('leaves the devices, genders, ages and traits where a region-less audience had them', () => {
    const one = exceptTheRegion(audienceWith({ ...base, regions: ['United Kingdom'] }));
    const two = exceptTheRegion(audienceWith({ ...base, regions: ['Almaty', 'Narnia', 'France'] }));
    const none = exceptTheRegion(audienceWith({ ...base, regions: [] }));

    expect(two).toStrictEqual(one);
    expect(none).toStrictEqual(one);
  });

  it('leaves the languages where they were when a second region is added', () => {
    const before = generatePersonas(audienceWith({ ...base, regions: ['United Kingdom'] }), {
      seed: 9,
    });
    const after = generatePersonas(
      audienceWith({ ...base, regions: ['United Kingdom', 'United States'] }),
      { seed: 9 },
    );

    expect(after.map((person) => person.language)).toStrictEqual(
      before.map((person) => person.language),
    );
    expect(after.map((person) => person.region)).not.toStrictEqual(
      before.map((person) => person.region),
    );
  });
});
