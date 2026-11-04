import { createSeededRandom, personaSchema } from '@personavision/contract';
import type { AgeGroup, Audience, Gender, Persona } from '@personavision/contract';
import { ARCHETYPES, MAX_OFFSET, TRAIT_NAMES } from './archetypes.js';
import type { Archetype } from './archetypes.js';
import {
  ageBracket,
  ageGroupApportionment,
  genderApportionment,
  languageApportionment,
  parseAudience,
  regionApportionment,
  traitCentre,
} from './audience.js';
import type { Apportioned } from './audience.js';
import { concreteDeviceFor, deviceQuota } from './devices.js';

/**
 * `generatePersonas(audience, { seed })` — the audience, turned into people.
 *
 * The audience decides **who exists**: how many people, at which corner of its behaviour,
 * on which device. The seed decides **who they are**: the exact traits each person is
 * sampled with. So the same audience always reports the same device mix and the same
 * segments — two tests of one audience under different seeds compare like with like — while
 * the same audience under one seed is the same people down to the last digit.
 *
 * Nothing here is precomputed for the engine. A persona leaves this package as the six
 * traits on the 0..1 scale the contract declares, and the engine's own table (#56) is what
 * turns them into sampling parameters.
 */

/**
 * How far the seed may move one person from their corner, on the 0..1 scale.
 *
 * It is what separates two people at the same corner — a swarm of 24 is not four people
 * repeated six times — and it is small, because a corner is a claim about behaviour and the
 * jitter is the individual variation around it, not a second source of spread.
 */
const JITTER = 0.1;

/** The largest displacement an archetype and the jitter together can ask for. */
const MAX_DISPLACEMENT = MAX_OFFSET + JITTER;

/** Three decimals: enough to tell two sampled people apart, few enough to read. */
const TRAIT_PRECISION = 1000;

/**
 * The holdout's default size: a fixed twenty people, whatever the participant count, and never
 * more than the audience itself.
 *
 * It was a share — forty per cent of the participants, floored at ten — which is what
 * auto-decision 83 picked and what `docs/design/prototype.html` `#screen-improve` printed. On
 * 2026-11-03 the owner overrode that with option b of the same decision, **a fixed 20, whatever
 * the participant count**, on the ground that it costs the same at every size (#318). A share
 * made a path-2 test more expensive the larger the audience; the holdout is a second reading
 * rather than a second audience, and twenty people on seeds the change was never chosen against
 * either move with it or they do not.
 *
 * The cap at the audience is the one part of the share rule that survives, and `holdoutSize`
 * applies it. The holdout is drawn from the audience's own apportionment, so a default larger
 * than the set it checks would be the comparison the wrong way round: the demo's four
 * participants get four holdout people, not twenty to check four.
 *
 * Twenty is a cheap reading and an often inconclusive one. At a hundred participants the bands
 * frequently cannot separate on twenty people, so *"the holdout could not judge"* — `null` with
 * the reason, never `false` — is a common answer rather than a rare one. That is the decision
 * working and not a defect; `tests/holdout.test.ts` names the case, and the answer itself
 * belongs to the verdict rather than to this package.
 *
 * `holdoutSize` in `holdout.ts` is the rule this makes, and a caller who wants another number
 * passes one: nothing but that function reads it.
 */
export const HOLDOUT_DEFAULT_SIZE = 20;

/**
 * The stream a seed names. `createSeededRandom` starts from `seed >>> 0`, so two seeds that
 * differ only above the 32nd bit are one seed to it, and they sample one person twice.
 * Everything here that compares seeds compares the stream they name.
 */
export const streamOfSeed = (seed: number): number => seed >>> 0;

export interface GeneratePersonasOptions {
  /**
   * The seed to sample with. Defaults to the audience's own `generatedFrom.seed`, so the
   * audience carries everything a default swarm needs; a run that compares seed groups
   * passes each group's seed instead.
   */
  readonly seed?: number;
  /**
   * One seed per person, in the people's own order, in place of one seed for the whole set:
   * person *i* is sampled from `seeds[i]`'s own stream. `seed` and `seeds` together are
   * refused, because together they leave it unsaid who was sampled from what.
   *
   * The holdout is generated this way and nothing else is (`holdout.ts`). A set whose seeds
   * provably do not intersect the ones a change was chosen on has to be able to name the seed
   * behind each person, and a shared stream can only name one for all of them.
   *
   * The seeds decide who the people **are** and nothing about who exists: how many people, at
   * which corner of the audience's behaviour, on which device stays the audience's to decide.
   * So a set generated from `seeds` has the same segments and the same device mix as the same
   * audience generated from one seed — which is what makes a holdout comparable with the
   * people the change was chosen on rather than a different kind of person.
   */
  readonly seeds?: readonly number[];
}

/**
 * A seed is an integer, so that it round-trips through the run artifact.
 *
 * Exported because the holdout holds the seeds a change was *chosen* on to the same rule: a
 * spent seed that is not an integer silently names a stream nobody spent — `undefined >>> 0`
 * is 0 — and the holdout would then hand back seeds the change was chosen on.
 */
export const checkSeed = (seed: number): number => {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError(
      `a seed is an integer, so that it round-trips through the run artifact: received ${String(seed)}`,
    );
  }
  return seed;
};

/**
 * The per-person seeds, checked: one for each person, every one an integer, and no two of them
 * naming one stream.
 *
 * The last is the one that matters. Two people sampled from the same seed are the same person
 * twice — same corner, same draws, same traits — and a swarm reporting one person several
 * times over is the one thing it exists to avoid. The holdout promises its caller that no seed
 * was reused; this is where that promise is kept rather than hoped for.
 */
const checkSeedsPerPerson = (
  seeds: readonly number[],
  size: number,
  seed: number | undefined,
): readonly number[] => {
  if (seed !== undefined) {
    throw new TypeError(
      'a call names one seed for the set or one seed per person, and not both: together they leave it unsaid which people were sampled from what',
    );
  }
  if (seeds.length !== size) {
    throw new TypeError(
      `one seed per person means ${size} ${size === 1 ? 'seed' : 'seeds'} for this audience, and ${seeds.length} ${seeds.length === 1 ? 'was' : 'were'} named`,
    );
  }
  seeds.forEach(checkSeed);
  if (new Set(seeds.map(streamOfSeed)).size !== seeds.length) {
    throw new TypeError(
      'two people sampled from one seed are one person twice: the seeds named here are not all distinct',
    );
  }
  return seeds;
};

/**
 * A person's trait: the audience's centre, displaced towards whichever end of the scale the
 * archetype and the jitter point at.
 *
 * The displacement is read as a **fraction of the room left** on that side rather than added
 * outright, so it cannot run off the scale and never has to be clamped flat. That matters
 * because a clamp makes clones: with a centre near 1, every person an archetype pushes upwards
 * would arrive at exactly 1, and the swarm would report one person several times over on that
 * trait — the one thing a swarm exists to avoid.
 *
 * The fraction is measured against the furthest corner the table holds, so a centre at the
 * middle of the scale works out as the plain sum and only a centre near an end bends. The
 * clamp below is the last word and, by construction, never has anything left to do.
 */
const displace = (centre: number, displacement: number): number => {
  const fraction = Math.min(1, Math.max(-1, displacement / MAX_DISPLACEMENT));
  const room = fraction >= 0 ? 1 - centre : centre;
  const value = centre + fraction * room;
  return Math.round(Math.min(1, Math.max(0, value)) * TRAIT_PRECISION) / TRAIT_PRECISION;
};

/**
 * The device class each person is on: the quota says how many of each, the archetype says
 * who gets first claim. A person whose own kind of device is used up takes the class with
 * the most people left to place, which keeps the counts exactly the declared shares.
 */
const assignDeviceClasses = (audience: Audience, people: readonly Archetype[]): number[] => {
  const remaining = deviceQuota(audience);
  // The quota accounts for every person, so there is always a class with somebody left to
  // place. Saying so by name beats a `reduce` over an empty array saying it for us.
  const pickFrom = (wanted: readonly number[]): number => {
    const best = wanted.reduce<number | null>(
      (chosen, index) =>
        chosen === null || (remaining[index] ?? 0) > (remaining[chosen] ?? 0) ? index : chosen,
      null,
    );
    if (best === null) {
      throw new Error(
        `the device quota accounts for all ${audience.size} people, so one of them cannot be left without a device`,
      );
    }
    return best;
  };
  const withPeopleLeft = (test: (index: number) => boolean): number[] =>
    remaining.flatMap((count, index) => (count > 0 && test(index) ? [index] : []));

  return people.map((archetype) => {
    const preferred = withPeopleLeft(
      (index) => audience.devices[index]?.touch === archetype.prefersTouch,
    );
    const available = preferred.length > 0 ? preferred : withPeopleLeft(() => true);
    const chosen = pickFrom(available);
    remaining[chosen] = (remaining[chosen] ?? 0) - 1;
    return chosen;
  });
};

/**
 * The streams the four drawn audience fields are dealt and sampled on, as salts the set's
 * own seed is mixed with.
 *
 * Each field gets a stream of its own, and none of them is the stream the traits are drawn
 * from. Both halves of that matter:
 *
 * - **the traits' stream is untouched**, so an audience that declares none of these fields
 *   draws exactly the people it drew before they existed — byte for byte, which is what
 *   lets `GENERATOR_VERSION` stay where it is;
 * - **the four do not share a stream**, so adding a language list to an audience does not
 *   move the genders of the people it already generated, and adding a region to this
 *   generator moved nobody's device, age group, gender or language. A field a user has not
 *   edited is a field whose people do not change under them, and that is a property of the
 *   streams rather than a promise.
 *
 * The first three salts are the mixing constants of the contract's own generator, used here
 * for what they are: arbitrary, well-separated 32-bit numbers. The region's is a fourth of
 * the same kind, and the separation is what `tests/regions.test.ts` holds.
 * `createSeededRandom` reads a seed as `seed >>> 0`, so a salt is mixed in with `^` on the
 * same 32 bits it keeps.
 */
const GENDER_STREAM = 0x9e37_79b9;
const AGE_STREAM = 0x85eb_ca6b;
const LANGUAGE_STREAM = 0xc2b2_ae35;
const REGION_STREAM = 0x27d4_eb2f;

/**
 * The apportioned values dealt out one per person, in a seeded order.
 *
 * The apportionment says **how many** people take each value and is the audience's, so a
 * declared 54/46 is 54 and 46 at every seed. This says **who**, and is the seed's, because
 * the order has to be shuffled rather than taken as it comes: people are placed at the four
 * archetypes round-robin, so handing the values out in order — or alternately — would make
 * the field a proxy for the behaviour beside it. Two languages dealt in order over four
 * people would put both phone-shaped behaviours in one language and both desk-shaped ones in
 * the other, and every result grouped by language would then be reporting the archetype.
 *
 * Fisher–Yates, one draw per person after the first, so the deal costs the same whatever the
 * values are and no value's position depends on how many values there are.
 */
const dealt = <Value>(
  apportioned: readonly Apportioned<Value>[],
  random: () => number,
): Value[] => {
  const deck = apportioned.flatMap(({ value, count }) =>
    Array.from({ length: count }, () => value),
  );
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = deck[index] as Value;
    deck[index] = deck[swap] as Value;
    deck[swap] = held;
  }
  return deck;
};

/** The bracket a person was drawn from, and the age they were drawn at inside it. */
export interface DrawnAge {
  readonly group: AgeGroup;
  readonly age: number;
}

/**
 * The age each person is drawn at, or `null` where the audience declares no age groups.
 *
 * Two steps, on one stream: the brackets are dealt out so that each one takes the share of
 * the audience it declared, and then each person's year is drawn uniformly inside the
 * bracket they were dealt, narrowed to the audience's own range (`ageBracket`). The bracket
 * is the audience's claim and the year is this person's, which is the same division of
 * labour the device mix has.
 *
 * Reached by module rather than exported from the package: it is the derivation, like the
 * trait centres and the device apportionment, and `tests/drawn-fields.test.ts` holds it to
 * every person's age lying inside the bracket they came from.
 */
export const drawnAges = (audience: Audience, seed: number): readonly DrawnAge[] | null => {
  const apportioned = ageGroupApportionment(audience);
  if (apportioned === null) return null;
  const random = createSeededRandom(seed ^ AGE_STREAM);
  return dealt(apportioned, random).map((group) => {
    const { min, max } = ageBracket(audience, group);
    // Uniform over the whole-year span, both ends included: a bracket of one year is that
    // year, and `65+` narrowed to a range ending at 65 is 65 rather than a division by zero.
    return { group, age: min + Math.floor(random() * (max - min + 1)) };
  });
};

/** The gender each person is drawn as, or `null` where the audience declares no split. */
const drawnGenders = (audience: Audience, seed: number): readonly Gender[] | null => {
  const apportioned = genderApportionment(audience);
  return apportioned === null ? null : dealt(apportioned, createSeededRandom(seed ^ GENDER_STREAM));
};

/** The language each person reads in, or `null` where the audience lists none. */
const drawnLanguages = (audience: Audience, seed: number): readonly string[] | null => {
  const apportioned = languageApportionment(audience);
  return apportioned === null
    ? null
    : dealt(apportioned, createSeededRandom(seed ^ LANGUAGE_STREAM));
};

/**
 * The region each person browses from, or `null` where the audience lists none.
 *
 * Dealt the way the language is — evenly apportioned, shuffled on a stream of its own — and
 * for the same reason: handing two regions out in order over four people placed round-robin
 * at the archetypes would make the region a proxy for the behaviour beside it, and every
 * result grouped by region would be reporting the archetype.
 *
 * What the region then becomes in a browser is `regions.ts`' table to say. This draws the
 * audience's own word and nothing else, so a region the table does not know still reaches
 * the person and is visible in the run.
 */
const drawnRegions = (audience: Audience, seed: number): readonly string[] | null => {
  const apportioned = regionApportionment(audience);
  return apportioned === null ? null : dealt(apportioned, createSeededRandom(seed ^ REGION_STREAM));
};

/**
 * Person `index`'s share of a dealt field, or `undefined` where the audience declared no
 * such field for anybody to be dealt from.
 *
 * The apportionment accounts for every person, so a deal that was made has a value here.
 * Saying so by name is what keeps the two cases apart: a field the audience never declared
 * is left off the person, and a value the deal failed to produce would otherwise be spread
 * on as `gender: undefined` — a key the contract reads as present and a reader reads as a
 * person who was drawn as nothing.
 */
const dealtTo = <Value>(
  dealtValues: readonly Value[] | null,
  index: number,
  what: string,
): Value | undefined => {
  if (dealtValues === null) return undefined;
  const value = dealtValues[index];
  if (value === undefined) {
    throw new Error(
      `the ${what} apportionment accounts for every person, so person ${index + 1} has one`,
    );
  }
  return value;
};

/** `Rushed buyer`, then `Rushed buyer 2`: a sessions list has to name people apart. */
const numbered = (text: string, occurrence: number): string =>
  occurrence === 1 ? text : `${text} ${occurrence}`;

export const generatePersonas = (
  audience: Audience,
  options: GeneratePersonasOptions = {},
): Persona[] => {
  const parsed = parseAudience(audience);
  const perPerson =
    options.seeds === undefined
      ? undefined
      : checkSeedsPerPerson(options.seeds, parsed.size, options.seed);
  const seed = checkSeed(options.seed ?? parsed.generatedFrom.seed);

  // Round-robin, so a swarm covers the whole spread at every size rather than leaving a
  // corner out: 4 people are one of each, 24 are six of each.
  const people = Array.from(
    { length: parsed.size },
    (_unused, index) => ARCHETYPES[index % ARCHETYPES.length] as Archetype,
  );
  const deviceClasses = assignDeviceClasses(parsed, people);
  // The four drawn fields are the audience's and the seed's together — how many of each is
  // the audience's, who gets which is the seed's — so they are settled for the whole set
  // before anybody's traits are sampled, exactly as the device quota is.
  const ages = drawnAges(parsed, seed);
  const genders = drawnGenders(parsed, seed);
  const languages = drawnLanguages(parsed, seed);
  const regions = drawnRegions(parsed, seed);
  // One centre for the audience, or one per person where an age was drawn for them. The two
  // are the same arithmetic on a different age, and an audience with no age groups takes the
  // first — which is what keeps its people byte-identical to the ones it generated before
  // age groups existed.
  const audienceCentre = traitCentre(parsed);
  const centres =
    ages === null
      ? people.map(() => audienceCentre)
      : ages.map(({ age }) => traitCentre(parsed, age));
  // One stream for the whole set — what the audience carries and what every committed run was
  // written on — or one stream per person when the caller named a seed for each.
  const shared = createSeededRandom(seed);
  const streams = perPerson?.map((value) => createSeededRandom(value));
  const seen = new Map<string, number>();

  return people.map((archetype, index) => {
    const occurrence = (seen.get(archetype.id) ?? 0) + 1;
    seen.set(archetype.id, occurrence);
    const deviceClass = parsed.devices[deviceClasses[index] ?? 0];
    if (deviceClass === undefined) {
      throw new Error('the audience declares a device mix, so a person always has a device');
    }

    // One draw per trait, in the contract's own trait order, so the draw order is stated once
    // and a person's traits do not depend on how many people come after them. Starting from
    // the archetype's own offsets gives the object every trait the contract declares without
    // a cast that would survive a trait being added to it.
    const traits = { ...archetype.offsets };
    const gender = dealtTo(genders, index, 'gender split');
    const language = dealtTo(languages, index, 'language');
    const region = dealtTo(regions, index, 'region');
    const centre = centres[index];
    if (centre === undefined) {
      throw new Error(
        `a centre is computed for each of the ${parsed.size} people, so person ${index + 1} has one`,
      );
    }
    // The per-person seeds are checked to be one for each person, so a list always has a
    // stream here. Saying so by name matters more here than anywhere else in this file: a
    // fallback to the shared stream would sample this person from the audience's own seed —
    // a seed the holdout was asked to avoid — and hand back somebody it promised was new.
    const random = streams === undefined ? shared : streams[index];
    if (random === undefined) {
      throw new Error(
        `a seed was named for each of the ${parsed.size} people, so person ${index + 1} has a stream of their own`,
      );
    }
    for (const trait of TRAIT_NAMES) {
      traits[trait] = displace(
        centre[trait],
        archetype.offsets[trait] + (random() - 0.5) * 2 * JITTER,
      );
    }

    return personaSchema.parse({
      id: occurrence === 1 ? archetype.id : `${archetype.id}-${occurrence}`,
      name: numbered(archetype.name, occurrence),
      audienceId: parsed.id,
      segment: `${deviceClass.name.toLowerCase()} · ${archetype.segmentClause}`,
      traits,
      device: concreteDeviceFor(deviceClass),
      // Absent rather than empty where the audience declared nothing to draw from: a person
      // drawn from an audience that named no language reads in none in particular, and the
      // contract's own word for that is the field not being there.
      ...(gender === undefined ? {} : { gender }),
      ...(language === undefined ? {} : { language }),
      ...(region === undefined ? {} : { region }),
    });
  });
};
