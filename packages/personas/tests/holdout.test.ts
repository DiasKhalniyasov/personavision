import { personaSchema } from '@personavision/contract';
import type { Audience, AudienceDevice } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { concreteDeviceFor, deviceQuota } from '../src/devices.js';
import { HOLDOUT_FLOOR, HOLDOUT_SHARE } from '../src/generate.js';
import { holdoutCandidates } from '../src/holdout.js';
import { GENERATOR_VERSION, generateHoldout, generatePersonas, holdoutSize } from '../src/index.js';
import { DESKTOP_CLASS, MOBILE_CLASS, audienceWith, withShare } from './helpers.js';

/**
 * The holdout: people from the same audience, on seeds the change was never chosen against.
 *
 * Two promises are asserted here over and over, because the holdout is worth nothing without
 * either. **The seeds do not intersect the spent ones** — that is the whole reason the holdout
 * exists, and a holdout that quietly reused a seed would be the people the change was fitted
 * to under another name. And **the people are the same kind of people** — same audience, same
 * segments, same device mix, same arithmetic — because a holdout drawn differently from the
 * main set would disagree with it for reasons that have nothing to do with the change.
 */

const TABLET_CLASS: AudienceDevice = {
  name: 'tablet',
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2,
  touch: true,
  share: 0.01,
};

const audienceOf = (what: string, size: number, overrides: Partial<Audience> = {}): Audience =>
  audienceWith({
    id: what,
    size,
    generatedFrom: { seed: size * 7 + 1, generatorVersion: GENERATOR_VERSION },
    ...overrides,
  });

/** Several audiences, so nothing here rests on the one mix the demo happens to use. */
const AUDIENCES = [
  ['the demo at four people', audienceOf('demo-four', 4)],
  ['twelve people over two devices', audienceOf('dozen', 12)],
  ['the hundred participants of the design contract', audienceOf('hundred', 100)],
  [
    'three devices, one of them barely declared',
    audienceOf('three-devices', 37, {
      devices: [withShare(MOBILE_CLASS, 0.55), withShare(DESKTOP_CLASS, 0.44), TABLET_CLASS],
    }),
  ],
  ['a single device', audienceOf('one-device', 23, { devices: [withShare(MOBILE_CLASS, 1)] })],
] as const satisfies readonly (readonly [string, Audience])[];

/** Sizes a holdout is plausibly asked for at, including one person and more than the audience. */
const SIZES = [1, 2, 10, 13, 40];

const CASES = AUDIENCES.flatMap(([what, audience]) =>
  SIZES.map((size) => [`${what}, ${size} held out`, audience, size] as const),
);

/** The seeds a change might have been chosen on: a run's seed groups, as the artifact holds them. */
const SPENT = [1, 2, 3, 7, 42, 1_000_003];

describe('generateHoldout: the seeds are disjoint by construction', () => {
  it.each(CASES)('%s: no seed of the holdout was spent', (_what, audience, size) => {
    const holdout = generateHoldout({ audience, spentSeeds: SPENT, size });
    const spent = new Set(SPENT);

    expect(holdout.seeds).toHaveLength(size);
    for (const seed of holdout.seeds) expect(spent.has(seed)).toBe(false);
    expect(Number.isSafeInteger(holdout.seeds[0])).toBe(true);
  });

  it.each(CASES)('%s: no two people share a seed', (_what, audience, size) => {
    const { seeds } = generateHoldout({ audience, spentSeeds: SPENT, size });

    // Two people sampled from one seed are one person twice, which would make a holdout look
    // more agreed with itself than it is.
    expect(new Set(seeds).size).toBe(size);
  });

  it.each(CASES)(
    "%s: the audience's own seed is spent whether or not the caller said so",
    (_what, audience, size) => {
      const holdout = generateHoldout({ audience, spentSeeds: [], size });

      // The main set is generated from it, so it is a seed the change was chosen on by
      // definition and no caller has to remember to pass it.
      expect(holdout.seeds).not.toContain(audience.generatedFrom.seed);
    },
  );

  it('steps over a spent seed written as another integer for the same stream', () => {
    const audience = audienceOf('same-stream', 16);
    const first = generateHoldout({ audience, spentSeeds: [], size: 10 });
    const reused = first.seeds[0];
    if (reused === undefined) throw new Error('a holdout of ten has a first seed');

    // `createSeededRandom` starts from `seed >>> 0`: this names the same stream, and so the
    // same person, as `reused` does. A holdout comparing the integers would hand it back.
    const second = generateHoldout({ audience, spentSeeds: [reused - 2 ** 32], size: 10 });

    expect(second.seeds).not.toContain(reused);
  });

  it('refuses a holdout it cannot draw disjointly, rather than reusing a seed', () => {
    const audience = audienceOf('exhausted', 20);
    const size = 10;
    // Every candidate this audience's sequence offers for a holdout of ten, spent but for
    // nine of them. There is no tenth seed left that the change was never chosen against, and
    // the one thing the generator may not do is make the tenth person up out of a spent one.
    const window = holdoutCandidates(audience, size);
    const spentSeeds = window.slice(0, window.length - (size - 1));

    expect(() => generateHoldout({ audience, spentSeeds, size })).toThrow(
      /without reusing a seed the change was chosen on/,
    );
    expect(() => generateHoldout({ audience, spentSeeds, size })).toThrow(/already spent/);
  });

  it('answers the same request the moment one more seed is free', () => {
    const audience = audienceOf('exhausted', 20);
    const size = 10;
    const window = holdoutCandidates(audience, size);
    const spentSeeds = window.slice(0, window.length - size);

    // One candidate more than the refusal above, and the holdout is generated from exactly
    // the seeds left: the refusal is the window running out, not a margin somebody guessed.
    expect(generateHoldout({ audience, spentSeeds, size }).seeds).toStrictEqual(
      window.slice(window.length - size),
    );
  });

  it('reuses no seed across rounds that spend everything it hands back', () => {
    const audience = audienceOf('rounds', 20);
    const size = 10;
    const spent = new Set<number>();

    // What a loop re-running a path-2 comparison does: every seed the last holdout spent is a
    // seed the next change may have been chosen on, so it is spent from then on.
    for (let round = 0; round < 8; round += 1) {
      for (const seed of generateHoldout({ audience, spentSeeds: [...spent], size }).seeds) {
        expect(spent.has(seed)).toBe(false);
        spent.add(seed);
      }
    }

    expect(spent.size).toBe(size * 8);
  });

  it.each([
    ['a seed that is not a whole number', [1, 2.5]],
    ['a value that is not a seed at all', [1, undefined as unknown as number]],
    ['a seed written as a string', [1, '3' as unknown as number]],
  ])('refuses %s among the spent seeds', (_what, spentSeeds) => {
    // `undefined >>> 0` is 0 and `"3" >>> 0` is 3, so a spent seed taken on trust would mark
    // the wrong stream as spent and the answer would quietly stop being a holdout.
    expect(() =>
      generateHoldout({ audience: audienceOf('bad-spent', 20), spentSeeds, size: 10 }),
    ).toThrow(/a seed is an integer/);
  });
});

describe('holdoutCandidates: the window the search walks', () => {
  it.each(CASES)('%s: offers the same candidates every time', (_what, audience, size) => {
    expect(holdoutCandidates(audience, size)).toStrictEqual(holdoutCandidates(audience, size));
  });

  it.each(CASES)(
    '%s: offers seeds that round-trip through the artifact',
    (_what, audience, size) => {
      for (const candidate of holdoutCandidates(audience, size)) {
        expect(Number.isSafeInteger(candidate)).toBe(true);
        expect(candidate).toBeGreaterThanOrEqual(0);
        expect(candidate).toBeLessThan(2 ** 32);
      }
    },
  );

  it('is the window a holdout is drawn from, in order', () => {
    const audience = audienceOf('in-order', 20);

    // Nothing is spent but the audience's own seed, so the holdout is the front of the window.
    expect(generateHoldout({ audience, spentSeeds: [], size: 10 }).seeds).toStrictEqual(
      holdoutCandidates(audience, 10)
        .filter((candidate) => candidate !== audience.generatedFrom.seed >>> 0)
        .slice(0, 10),
    );
  });
});

describe('generateHoldout: the same holdout twice', () => {
  it.each(CASES)('%s: the same request gives the same people', (_what, audience, size) => {
    const first = generateHoldout({ audience, spentSeeds: SPENT, size });
    const second = generateHoldout({ audience, spentSeeds: SPENT, size });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('gives a different holdout for a different size', () => {
    const audience = audienceOf('different-size', 30);
    const twelve = generateHoldout({ audience, spentSeeds: SPENT, size: 12 });
    const thirteen = generateHoldout({ audience, spentSeeds: SPENT, size: 13 });

    // The size is part of the sequence the candidates come from, so asking for one more
    // person is a holdout of its own rather than the same twelve with somebody appended.
    expect(thirteen.seeds.slice(0, 12)).not.toStrictEqual(twelve.seeds);
  });

  it('gives a different holdout for an audience that generated different people', () => {
    const base = audienceOf('same-everything', 24);
    const other: Audience = {
      ...base,
      generatedFrom: { seed: base.generatedFrom.seed + 1, generatorVersion: GENERATOR_VERSION },
    };

    expect(generateHoldout({ audience: other, spentSeeds: [], size: 10 }).seeds).not.toStrictEqual(
      generateHoldout({ audience: base, spentSeeds: [], size: 10 }).seeds,
    );
  });
});

describe('generateHoldout: the same kind of person', () => {
  it.each(CASES)('%s: people the contract recognises', (_what, audience, size) => {
    const holdout = generateHoldout({ audience, spentSeeds: SPENT, size });

    expect(holdout.personas).toHaveLength(size);
    expect(holdout.audienceId).toBe(audience.id);
    for (const persona of holdout.personas) {
      expect(personaSchema.safeParse(persona)).toMatchObject({ success: true });
      expect(persona.audienceId).toBe(audience.id);
      expect(persona.segment).toContain('·');
    }
    expect(new Set(holdout.personas.map((persona) => persona.id)).size).toBe(size);
    expect(new Set(holdout.personas.map((persona) => persona.name)).size).toBe(size);
  });

  it.each(CASES)(
    '%s: hands out exactly the quota the audience computes at that size',
    (_what, audience, size) => {
      const atSize: Audience = { ...audience, size };
      const holdout = generateHoldout({ audience, spentSeeds: SPENT, size });
      // A declared class and the concrete device it is run on may differ by name — `mobile`
      // is run on an iPhone 15 — so the people are counted against the device the class
      // resolves to, which is what a session records.
      const given = audience.devices.map(
        (device) =>
          holdout.personas.filter(
            (persona) => persona.device.name === concreteDeviceFor(device).name,
          ).length,
      );

      // The apportionment the main set is held to, at the holdout's size: a holdout on a
      // different device mix would disagree with the main set for reasons that are not the
      // change. `tests/apportionment.test.ts` is what `deviceQuota` itself is held to.
      expect(given).toStrictEqual(deviceQuota(atSize));
    },
  );

  it.each(CASES)(
    '%s: the same segments and devices as the main set drawn at that size',
    (_what, audience, size) => {
      const atSize: Audience = { ...audience, size };
      const holdout = generateHoldout({ audience, spentSeeds: SPENT, size });
      const main = generatePersonas(atSize, { seed: 9_001 });

      // Who exists is the audience's to decide and the seed has no say in it, so the holdout
      // is the same people in the same order at every corner, on the same devices.
      expect(holdout.personas.map((persona) => persona.segment)).toStrictEqual(
        main.map((persona) => persona.segment),
      );
      expect(holdout.personas.map((persona) => persona.device)).toStrictEqual(
        main.map((persona) => persona.device),
      );
    },
  );

  it('is not the main set: the traits are sampled on other seeds', () => {
    const audience = audienceOf('not-the-main-set', 40);
    const holdout = generateHoldout({ audience, spentSeeds: SPENT, size: 16 });
    const main = generatePersonas({ ...audience, size: 16 });

    expect(holdout.personas.map((persona) => persona.traits)).not.toStrictEqual(
      main.map((persona) => persona.traits),
    );
  });

  it('names its people apart from the main set, as a run carrying both requires', () => {
    const audience = audienceOf('named-apart', 100);
    const holdout = generateHoldout({ audience, spentSeeds: SPENT });
    const main = generatePersonas(audience);
    const mainIds = new Set(main.map((persona) => persona.id));

    // A run carries the holdout people in its own `personas` list, where a persona id names
    // one simulated person: a holdout reusing `rushed-buyer` would be two people under one id.
    for (const persona of holdout.personas) expect(mainIds.has(persona.id)).toBe(false);
  });
});

describe('holdoutSize: the default beside the generator in `src/generate.ts`', () => {
  it('is forty per cent, floored at ten, as one named value each', () => {
    expect([HOLDOUT_SHARE, HOLDOUT_FLOOR]).toStrictEqual([0.4, 10]);
  });

  it('holds a hundred participants to the forty the design contract prints', () => {
    expect(holdoutSize(100)).toBe(40);
  });

  it.each([
    [1, 1],
    [4, 4],
    [10, 10],
    [12, 10],
    [24, 10],
    [25, 10],
    [30, 12],
    [100, 40],
    [250, 100],
  ])('gives %i participants a holdout of %i', (participants, expected) => {
    expect(holdoutSize(participants)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s as a participant count', (participants) => {
    expect(() => holdoutSize(participants)).toThrow(/whole number of people/);
  });

  it('is what a holdout asked for without a size gets', () => {
    const audience = audienceOf('defaulted', 100);

    expect(generateHoldout({ audience, spentSeeds: SPENT }).personas).toHaveLength(40);
  });

  it('is overridable by the caller', () => {
    const audience = audienceOf('overridden', 100);

    expect(generateHoldout({ audience, spentSeeds: SPENT, size: 7 }).personas).toHaveLength(7);
  });

  it.each([0, -1, 2.5])('refuses a holdout of %s people', (size) => {
    expect(() =>
      generateHoldout({ audience: audienceOf('bad-size', 20), spentSeeds: SPENT, size }),
    ).toThrow(/whole number of people/);
  });
});

/**
 * One seed per person is the generator's half of the holdout: a set that has to name the seed
 * behind each person cannot be sampled from one shared stream. It is asserted here, beside the
 * holdout it exists for, rather than in `generate.test.ts`, which is the shared stream's.
 */
describe('generatePersonas: one seed per person', () => {
  const audience = audienceWith({ size: 6 });
  const seeds = [11, 22, 33, 44, 55, 66];

  it('generates the same people the audience would, on other traits', () => {
    const perPerson = generatePersonas(audience, { seeds });
    const shared = generatePersonas(audience, { seed: 11 });

    expect(perPerson.map((persona) => persona.id)).toStrictEqual(
      shared.map((persona) => persona.id),
    );
    expect(perPerson.map((persona) => persona.segment)).toStrictEqual(
      shared.map((persona) => persona.segment),
    );
    expect(perPerson.map((persona) => persona.traits)).not.toStrictEqual(
      shared.map((persona) => persona.traits),
    );
  });

  it('samples each person from their own seed and nobody else from it', () => {
    const before = generatePersonas(audience, { seeds });
    const after = generatePersonas(audience, {
      seeds: [...seeds.slice(0, 2), 999, ...seeds.slice(3)],
    });

    expect(after[2]?.traits).not.toStrictEqual(before[2]?.traits);
    expect(
      after.filter((_person, index) => index !== 2).map((persona) => persona.traits),
    ).toStrictEqual(
      before.filter((_person, index) => index !== 2).map((persona) => persona.traits),
    );
  });

  it('is deterministic, like every other generated thing here', () => {
    expect(JSON.stringify(generatePersonas(audience, { seeds }))).toBe(
      JSON.stringify(generatePersonas(audience, { seeds })),
    );
  });

  it('refuses one seed for the set and one per person together', () => {
    expect(() => generatePersonas(audience, { seed: 1, seeds })).toThrow(/not both/);
  });

  it.each([
    ['too few', [1, 2, 3]],
    ['too many', [1, 2, 3, 4, 5, 6, 7]],
  ])('refuses %s seeds for the people the audience generates', (_what, named) => {
    expect(() => generatePersonas(audience, { seeds: named })).toThrow(/one seed per person/);
  });

  it('refuses a seed that is not an integer', () => {
    expect(() => generatePersonas(audience, { seeds: [1, 2, 3.5, 4, 5, 6] })).toThrow(/seed/);
  });

  it.each([
    ['the same integer twice', [1, 2, 3, 4, 5, 1]],
    ['two integers naming one stream', [1, 2, 3, 4, 5, 1 + 2 ** 32]],
  ])('refuses %s, because that is one person twice', (_what, named) => {
    expect(() => generatePersonas(audience, { seeds: named })).toThrow(/one person twice/);
  });
});
