import { createSeededRandom, personaSchema } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import { ARCHETYPES, MAX_OFFSET, TRAIT_NAMES } from './archetypes.js';
import type { Archetype } from './archetypes.js';
import { parseAudience, traitCentre } from './audience.js';
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

export interface GeneratePersonasOptions {
  /**
   * The seed to sample with. Defaults to the audience's own `generatedFrom.seed`, so the
   * audience carries everything a default swarm needs; a run that compares seed groups
   * passes each group's seed instead.
   */
  readonly seed?: number;
}

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

/** `Rushed buyer`, then `Rushed buyer 2`: a sessions list has to name people apart. */
const numbered = (text: string, occurrence: number): string =>
  occurrence === 1 ? text : `${text} ${occurrence}`;

export const generatePersonas = (
  audience: Audience,
  options: GeneratePersonasOptions = {},
): Persona[] => {
  const parsed = parseAudience(audience);
  const seed = options.seed ?? parsed.generatedFrom.seed;
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError(
      `a seed is an integer, so that it round-trips through the run artifact: received ${String(seed)}`,
    );
  }

  const centre = traitCentre(parsed);
  // Round-robin, so a swarm covers the whole spread at every size rather than leaving a
  // corner out: 4 people are one of each, 24 are six of each.
  const people = Array.from(
    { length: parsed.size },
    (_unused, index) => ARCHETYPES[index % ARCHETYPES.length] as Archetype,
  );
  const deviceClasses = assignDeviceClasses(parsed, people);
  const random = createSeededRandom(seed);
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
    });
  });
};
