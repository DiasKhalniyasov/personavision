import { createSeededRandom, personaSchema } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import { parseAudience } from './audience.js';
import { HOLDOUT_FLOOR, HOLDOUT_SHARE, generatePersonas, streamOfSeed } from './generate.js';

/**
 * The holdout: people from the same audience, on seeds the change was never chosen against.
 *
 * A path-2 comparison runs the baseline and the change with the **same audience and the same
 * seeds**, so the two sides differ only in the code (`docs/FLOW.md` section 15, point 4).
 * That alone is not enough to believe a gain. The change was chosen by reading those very
 * people, so they are the people it was fitted to; run it back over them and a swarm can
 * agree with itself. The holdout is the second reading that cannot: the same audience, the
 * same apportionment, the same arithmetic — and seeds that were not spent when the change was
 * chosen.
 *
 * This file is the generator's half of that, and nothing more. It knows what an audience is,
 * what a seed is and what a person is. It does not know what a pull request is, it never reads
 * a run, and it decides nothing about whether a holdout confirmed anything: running these
 * people is `@personavision/swarm`'s (#303) and recording them is the contract's (#296).
 *
 * **Disjoint by construction, not by hope.** The seeds are drawn from the audience's own
 * candidate sequence and every candidate already spent is stepped over, so the answer cannot
 * contain a spent seed — there is no path through this file that reuses one. A request that
 * cannot be met that way is refused with the reason instead.
 */

/** How many candidate seeds the search may walk per person before it refuses. */
const CANDIDATES_PER_PERSON = 16;

/** `createSeededRandom` reduces a seed into this many streams, and `draw()` divides by it. */
const SEED_SPACE = 2 ** 32;

/** FNV-1a, 32-bit: the audience's own sequence has to start somewhere stated. */
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/**
 * How many holdout people an audience of `participants` gets by default: `HOLDOUT_SHARE` of
 * them, floored at `HOLDOUT_FLOOR` and capped at the audience itself. A hundred participants
 * give the forty the design contract prints; the demo's four give four.
 *
 * It is exported because the loop and the Improve screen say how many holdout people a run
 * will have before anybody generates them, and two places computing 40 per cent of something
 * is how two places come to disagree about it.
 */
export const holdoutSize = (participants: number): number => {
  if (!Number.isSafeInteger(participants) || participants < 1) {
    throw new TypeError(
      `a participant count is a whole number of people, at least one: received ${String(participants)}`,
    );
  }
  return Math.min(participants, Math.max(HOLDOUT_FLOOR, Math.round(participants * HOLDOUT_SHARE)));
};

export interface GenerateHoldoutRequest {
  /**
   * The audience the main set came from — the same object, not one like it. Its segments, its
   * device mix and its trait centre are what make these people comparable with the people the
   * change was chosen on; a holdout that is a different kind of person is not a holdout.
   */
  readonly audience: Audience;
  /**
   * The seeds the change was chosen on. The audience's own `generatedFrom.seed` is spent by
   * definition — the main set is generated from it — so a caller never has to remember it.
   */
  readonly spentSeeds: readonly number[];
  /**
   * How many holdout people are wanted. Defaults to `holdoutSize(audience.size)`. The cap at
   * the participant count is that default's; a caller who names a size is taken at their word.
   */
  readonly size?: number;
}

export interface Holdout {
  /** The audience these people came from: the same audience as the main set. */
  readonly audienceId: string;
  /**
   * The seed each person was sampled on, in the people's own order, and the promise this
   * object exists to make: no seed here was spent when the change was chosen, and no two of
   * them are one seed.
   */
  readonly seeds: readonly number[];
  /** The people, in the same shape as any other person this package generates. */
  readonly personas: readonly Persona[];
}

/**
 * The seed the audience's candidate sequence starts from.
 *
 * It is derived from the audience and the size wanted, and **not** from the spent seeds: the
 * sequence a holdout walks is a property of the audience, so "this audience has no seeds left
 * that the change was never chosen against" is a statement that can be made, tested, and
 * refused on. Were the spent seeds mixed in here, every refusal would be a different sequence
 * and the generator could only ever say "not this time".
 */
const candidateSequenceSeed = (audience: Audience, size: number): number => {
  // The audience's own seed is in the text, so two audiences that differ only in the people
  // they generated get different holdouts rather than the same one twice.
  const stated = `${audience.id}\u0000${audience.size}\u0000${audience.generatedFrom.seed}\u0000${size}`;
  let hash = FNV_OFFSET;
  for (let index = 0; index < stated.length; index += 1) {
    hash = Math.imul(hash ^ stated.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return hash;
};

/**
 * The same person, named as one of the holdout.
 *
 * The id has to differ from the main set's, because a run carries the holdout people in its
 * own `personas` list and a persona id there names one simulated person: a holdout that
 * reused `rushed-buyer` would be two people under one id and the artifact would refuse it.
 * Everything that says what *kind* of person this is — the segment, the traits, the device,
 * the audience — is untouched, so a holdout groups with the people it is compared against
 * under every segment filter the product offers.
 */
const asHoldout = (persona: Persona): Persona =>
  personaSchema.parse({
    ...persona,
    id: `holdout-${persona.id}`,
    name: `${persona.name} (holdout)`,
  });

/**
 * `generateHoldout({ audience, spentSeeds })` — the holdout, generated.
 *
 * The same audience, the same spent seeds and the same size give the same holdout twice, like
 * every other generated thing in this package.
 */
export const generateHoldout = (request: GenerateHoldoutRequest): Holdout => {
  const audience = parseAudience(request.audience);
  const size = request.size ?? holdoutSize(audience.size);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError(
      `a holdout is a whole number of people, at least one: received ${String(size)}`,
    );
  }

  // Seeds are compared as the stream they name, not as the integer they were written as:
  // `createSeededRandom` starts from `seed >>> 0`, so a spent seed and a candidate that differ
  // only above the 32nd bit are the same people, and a holdout that called them two would hand
  // back a person it promised was new.
  const spent = new Set(request.spentSeeds.map(streamOfSeed));
  spent.add(streamOfSeed(audience.generatedFrom.seed));

  const draw = createSeededRandom(candidateSequenceSeed(audience, size));
  const limit = size * CANDIDATES_PER_PERSON;
  const seeds: number[] = [];
  for (let walked = 0; seeds.length < size; walked += 1) {
    if (walked === limit) {
      throw new Error(
        `this audience has no holdout of ${size} left: ${limit} candidate seeds from its own sequence yielded ${seeds.length}, because ${spent.size} seeds are already spent — a holdout that reused one of them would be the people the change was chosen on under another name`,
      );
    }
    const candidate = Math.floor(draw() * SEED_SPACE);
    if (spent.has(candidate)) continue;
    // Spent from here on, so the holdout cannot draw one of its own seeds twice either: two
    // people sampled from one seed are one person twice.
    spent.add(candidate);
    seeds.push(candidate);
  }

  // The same audience with the holdout's size, so the device mix, the segments and the trait
  // centre are the main set's rules at the holdout's size rather than a second apportionment.
  const personas = generatePersonas({ ...audience, size }, { seeds });

  return { audienceId: audience.id, seeds, personas: personas.map(asHoldout) };
};
