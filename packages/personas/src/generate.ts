import { createSeededRandom, personaSchema } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import { ARCHETYPES, TRAIT_NAMES } from './archetypes.js';
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

const roundTrait = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * TRAIT_PRECISION) / TRAIT_PRECISION;

/**
 * The device class each person is on: the quota says how many of each, the archetype says
 * who gets first claim. A person whose own kind of device is used up takes the class with
 * the most people left to place, which keeps the counts exactly the declared shares.
 */
const assignDeviceClasses = (audience: Audience, people: readonly Archetype[]): number[] => {
  const remaining = deviceQuota(audience);
  const pickFrom = (wanted: readonly number[]): number =>
    wanted.reduce((best, index) =>
      (remaining[index] ?? 0) > (remaining[best] ?? 0) ? index : best,
    );
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

    // Six draws per person, in the contract's own trait order, so the draw order is stated
    // once and a person's traits do not depend on how many people come after them.
    const traits = Object.fromEntries(
      TRAIT_NAMES.map((trait) => [
        trait,
        roundTrait(centre[trait] + archetype.offsets[trait] + (random() - 0.5) * 2 * JITTER),
      ]),
    ) as Persona['traits'];

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
