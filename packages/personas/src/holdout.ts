import { createSeededRandom, personaSchema } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';
import { parseAudience } from './audience.js';
import { HOLDOUT_DEFAULT_SIZE, checkSeed, generatePersonas, streamOfSeed } from './generate.js';

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
 *
 * That promise is about the **seed**, which is where a stream starts, and it is the promise
 * the product rests on: these people were not read when the change was chosen. It is worth
 * being exact about what it does not cover. `createSeededRandom` advances its state by a fixed
 * step per draw, so a seed a fixed multiple of that step above a spent one starts part-way
 * through the run of draws that spent seed consumed; a holdout seed could in principle land
 * there and sample a person the main set already holds. The chance is the main set's draws
 * over the 2³² streams — about one in ten million for a hundred people — and closing it would
 * mean restating `@personavision/contract`'s generator step in this file, where a later change
 * to that generator would leave it quietly wrong. The seed-level promise is enforced; this
 * paragraph is the part that is arithmetic rather than construction.
 */

/**
 * How many candidates the audience's sequence offers per person wanted — the window the
 * search walks before it refuses.
 *
 * There has to be a window. Without one, "there is no holdout left here" could only be said
 * after walking 2³² candidates, so a request that cannot be met disjointly would hang rather
 * than say so. With one, the refusal is a statement about a stated window.
 *
 * The window is also the ceiling on one audience: the sequence is the audience's own, so a
 * caller that hands back every seed it has *ever* spent on this audience — rather than the
 * seeds the change in front of it was chosen on — can spend the window, and gets the refusal
 * when it does. 256 per person means 256 holdouts of a given size with no seed repeated
 * between them, which is far more path-2 comparisons than one audience will see; the loop
 * (#306) passes a run's own seed groups, which is a handful.
 */
const CANDIDATES_PER_PERSON = 256;

/** `createSeededRandom` reduces a seed into this many streams, and `draw()` divides by it. */
const SEED_SPACE = 2 ** 32;

/** FNV-1a, 32-bit: the audience's own sequence has to start somewhere stated. */
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/**
 * How many holdout people an audience of `participants` gets by default:
 * `HOLDOUT_DEFAULT_SIZE` of them, capped at the audience itself.
 *
 * The figure does not scale with the audience — a hundred participants get twenty and so do
 * forty — because the owner's choice on decision 83 is a fixed twenty whatever the participant
 * count (#318). The cap is what the audience below that size gets instead: the holdout is drawn
 * from the audience's own apportionment, so the demo's four participants get four holdout
 * people rather than twenty to check four. `HOLDOUT_DEFAULT_SIZE` in `generate.ts` says why
 * twenty, and what it costs in holdouts that cannot judge.
 *
 * It is exported because the loop and the Improve screen say how many holdout people a run will
 * have before anybody generates them, and two places carrying the same rule is how two places
 * come to disagree about it.
 */
export const holdoutSize = (participants: number): number => {
  if (!Number.isSafeInteger(participants) || participants < 1) {
    throw new TypeError(
      `a participant count is a whole number of people, at least one: received ${String(participants)}`,
    );
  }
  return Math.min(participants, HOLDOUT_DEFAULT_SIZE);
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
 * The candidates this audience's sequence offers for a holdout of `size`, in the order the
 * search walks them: `size * CANDIDATES_PER_PERSON` of them, each a seed in `[0, 2³²)`.
 *
 * `generateHoldout` is the only caller. It is exported so that `tests/` can hold the window
 * itself to what this file claims about it — that it is the same window every time, and that
 * a spent set covering it is refused rather than answered with a reused seed — without having
 * to rediscover the sequence by generating holdouts until one runs out.
 */
export const holdoutCandidates = (audience: Audience, size: number): number[] => {
  const draw = createSeededRandom(candidateSequenceSeed(audience, size));
  return Array.from({ length: size * CANDIDATES_PER_PERSON }, () =>
    Math.floor(draw() * SEED_SPACE),
  );
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

  // Every spent seed is held to being an integer, like every other seed here. A spent seed
  // that is not one names a stream nobody spent — `undefined >>> 0` and `{} >>> 0` are both 0,
  // and `"3"` is 3 — and the holdout would step over the wrong candidates and hand back seeds
  // the change was chosen on, which is the one thing this file exists not to do.
  //
  // Seeds are compared as the stream they name rather than as the integer they were written
  // as: `createSeededRandom` starts from `seed >>> 0`, so a spent seed and a candidate that
  // differ only above the 32nd bit are the same people.
  const spent = new Set(request.spentSeeds.map((seed) => streamOfSeed(checkSeed(seed))));
  spent.add(streamOfSeed(audience.generatedFrom.seed));

  const candidates = holdoutCandidates(audience, size);
  const seeds: number[] = [];
  for (const candidate of candidates) {
    if (seeds.length === size) break;
    if (spent.has(candidate)) continue;
    // Spent from here on, so the holdout cannot draw one of its own seeds twice either: two
    // people sampled from one seed are one person twice.
    spent.add(candidate);
    seeds.push(candidate);
  }
  if (seeds.length < size) {
    throw new Error(
      `this audience cannot answer a holdout of ${size} without reusing a seed the change was chosen on: of the ${candidates.length} candidates its own sequence offers for a holdout of this size, all but ${seeds.length} are already spent, and a holdout that reused one of them would be the people the change was chosen on under another name`,
    );
  }

  // The same audience with the holdout's size, so the device mix, the segments and the trait
  // centre are the main set's rules at the holdout's size rather than a second apportionment.
  const personas = generatePersonas({ ...audience, size }, { seeds });

  return { audienceId: audience.id, seeds, personas: personas.map(asHoldout) };
};
