/**
 * The holdout, as the swarm drives it: more people, on seeds of their own, through both sides.
 *
 * A path-2 run tests one change by driving the **same people on the same seeds** through the
 * baseline and the pull request's version, so that the only difference between the two sides
 * is the code. That alone is not enough to believe a gain: the change was chosen by reading
 * those very people, so a swarm run back over them can agree with itself. The holdout is the
 * second reading that cannot — the same audience, seeds the change was never chosen against
 * (`docs/FLOW.md` section 15, point 4).
 *
 * What this file owns, and what it leaves to others:
 *
 * - **It drives, it does not generate.** The people and the seed each was sampled on arrive
 *   as a value, from `generateHoldout` in `@personavision/personas` (#298), whose answer is
 *   this module's `SwarmHoldout` without conversion. Nothing here knows how a holdout is
 *   drawn, what an audience is, or what makes a seed unspent.
 * - **It judges nothing.** Whether the holdout confirmed the gain is
 *   `@personavision/scoring`'s (#304), read off the holdout's figures once the run is scored.
 *   The swarm's whole part is that those figures have people behind them.
 * - **It refuses rather than guesses.** A holdout that is not the people the change was never
 *   chosen against — one of the main set under another name, two people on one seed, a seed
 *   the change *was* chosen on — is refused with the reason, before a run is written. "A run
 *   whose two variants were driven by different seeds is a run whose comparison means
 *   nothing", and the same is true of a holdout that is not held out.
 * - **It is not a second kind of session.** A holdout session is numbered, run, written and
 *   read like any other (`run-swarm.ts`); what marks it is the run's holdout list, which
 *   `improve.holdout.personaIds` records and `SwarmResult` hands back.
 *
 * Ticket #303; `docs/FLOW.md` section 15, point 4.
 */

import type { Persona } from '@personavision/contract';
import type { SwarmSession } from './run-swarm.js';

/**
 * The holdout a run is driven with: the people, and the seed each of them was sampled on.
 *
 * `generateHoldout`'s answer satisfies this structurally — it carries an `audienceId`
 * besides, which the swarm has no use for — so the loop hands it straight over and no layer
 * in between restates the shape. The two lists are **pairwise**: `seeds[i]` is the seed
 * `personas[i]` was sampled on, which is also the seed that person is driven on, so the
 * sessions of a holdout person are run on a seed the change was never chosen against at the
 * session level too and not only when the people were drawn.
 */
export interface SwarmHoldout {
  readonly personas: readonly Persona[];
  readonly seeds: readonly number[];
}

/** No holdout: a path-1 run, and every run the swarm has driven until now. */
export const NO_HOLDOUT: SwarmHoldout = { personas: [], seeds: [] };

/** Whether a run is driving a holdout at all. An empty holdout is no holdout. */
export const hasHoldout = (holdout: SwarmHoldout): boolean => holdout.personas.length > 0;

/**
 * The run's holdout list, in the order the generator drew them: exactly the people this run
 * drove as the holdout, which is what `improve.holdout.personaIds` records.
 */
export const holdoutPersonaIds = (holdout: SwarmHoldout): readonly string[] =>
  holdout.personas.map((persona) => persona.id);

/**
 * The holdout's people paired with their own seeds — one session per person per variant,
 * rather than the main set's person × every seed group.
 *
 * A holdout person's seed is the one they were sampled on and the one unspent thing about
 * them; driving them on the run's seed groups instead would put the holdout back on the seeds
 * the change was chosen on, which is the whole of what a holdout is not. A pair with no seed
 * is left out rather than driven on `undefined`: `holdoutRefusal` is what reports it, and
 * this function stays a projection.
 */
export const holdoutDrives = (
  holdout: SwarmHoldout,
): ReadonlyArray<{ readonly persona: Persona; readonly seed: number }> =>
  holdout.personas.flatMap((persona, index) => {
    const seed = holdout.seeds[index];
    return seed === undefined ? [] : [{ persona, seed }];
  });

/**
 * `createSeededRandom` starts from `seed >>> 0`, so two seeds that differ only above the
 * 32nd bit name one stream and are one seed. The generator compares spent seeds this way
 * (`@personavision/personas`), and so does the swarm, or a holdout seed could be "unspent"
 * here and the same people there.
 */
const streamOf = (seed: number): number => seed >>> 0;

/**
 * Why this holdout may not be driven, or `null` when it may.
 *
 * Every reason here is about the holdout being the people the change was **never chosen
 * against**. It is checked before the run is opened, so a refusal costs no session and
 * leaves no half-written run: the alternative is a directory whose holdout figures are
 * about the main set under another name, and nothing downstream could tell.
 */
export const holdoutRefusal = (
  holdout: SwarmHoldout,
  main: { readonly personas: readonly Persona[]; readonly seedGroups: readonly number[] },
): string | null => {
  if (!hasHoldout(holdout)) {
    // Seeds with nobody to drive them: a caller that meant no holdout passes neither.
    if (holdout.seeds.length > 0) {
      return `this holdout carries ${holdout.seeds.length} ${holdout.seeds.length === 1 ? 'seed' : 'seeds'} and nobody to drive on ${holdout.seeds.length === 1 ? 'it' : 'them'}: a holdout is people, on the seeds they were sampled on`;
    }
    return null;
  }
  if (holdout.personas.length !== holdout.seeds.length) {
    return `this holdout carries ${holdout.personas.length} ${holdout.personas.length === 1 ? 'person' : 'people'} and ${holdout.seeds.length} ${holdout.seeds.length === 1 ? 'seed' : 'seeds'}: a holdout person is driven on the one seed they were sampled on, so the two are pairwise`;
  }
  // A holdout is read *beside* the people the change was chosen on. With nobody to compare
  // them against there is no comparison to confirm, and every check below — the ids they
  // must not collide with, the audience they must share, the seeds they must not reuse — is
  // a check against an empty set and passes by saying nothing.
  if (main.personas.length === 0) {
    return `this run holds out ${holdout.personas.length} ${holdout.personas.length === 1 ? 'person' : 'people'} and drives nobody else: a holdout is read beside the people the change was chosen on, and on its own it confirms nothing`;
  }

  const inMainSet = new Set(main.personas.map((persona) => persona.id));
  const held = new Set<string>();
  for (const persona of holdout.personas) {
    if (inMainSet.has(persona.id)) {
      return `"${persona.id}" is in the main set and in the holdout: the holdout is the people the change was never chosen against, and holding out somebody the change was fitted to is the swarm agreeing with itself`;
    }
    if (held.has(persona.id)) {
      return `persona "${persona.id}" is held out more than once: the ids are how many people the holdout is`;
    }
    held.add(persona.id);
  }

  // The same audience, or the holdout is a different kind of person and not a holdout at all.
  const audienceId = main.personas[0]?.audienceId;
  const stranger = holdout.personas.find(
    (persona) => audienceId !== undefined && persona.audienceId !== audienceId,
  );
  if (stranger !== undefined) {
    return `holdout persona "${stranger.id}" was generated from audience "${stranger.audienceId}" and the main set from "${String(audienceId)}": a holdout is the same audience on other seeds, and a different audience is a different test`;
  }

  const spent = new Set(main.seedGroups.map(streamOf));
  const drawn = new Set<number>();
  for (const seed of holdout.seeds) {
    if (!Number.isInteger(seed)) {
      return `this holdout names ${String(seed)} as a seed: a seed is a whole number, and anything else names a stream nobody drew`;
    }
    if (spent.has(streamOf(seed))) {
      return `the holdout's seed ${seed} is one of the seeds the change was chosen on (${main.seedGroups.join(', ')}): a holdout driven on a spent seed is the reading the change was fitted to`;
    }
    if (drawn.has(streamOf(seed))) {
      return `the holdout draws seed ${seed} twice: two people sampled from one seed are one person twice`;
    }
    drawn.add(streamOf(seed));
  }
  return null;
};

/**
 * Why this plan is not a comparison, or `null` when it is.
 *
 * The one promise a path-2 run rests on: **both sides are the same people on the same
 * seeds**, so the only difference between them is the code (`docs/FLOW.md` section 15,
 * point 4). `planSwarm` crosses one list of people and one list of seeds with the variants
 * and so cannot break it, which is exactly why it is checked here rather than assumed — a
 * caller that plans its own sessions, or a later change to the planner, can, and a run whose
 * two variants were driven by different seeds is a comparison nobody can believe. It is
 * cheaper to refuse than to explain.
 *
 * The holdout is held to it too: it is more people on both sides, not a side of its own.
 */
export const sameSeedsOnBothSides = (planned: readonly SwarmSession[]): string | null => {
  const sides = new Map<string, Map<string, number[]>>();
  for (const plan of planned) {
    const side = sides.get(plan.variant.id) ?? new Map<string, number[]>();
    side.set(plan.persona.id, [...(side.get(plan.persona.id) ?? []), plan.seed]);
    sides.set(plan.variant.id, side);
  }
  const [first, ...rest] = [...sides.entries()];
  if (first === undefined) return null;
  const [firstVariant, firstSide] = first;
  const seedsOf = (side: Map<string, number[]>, personaId: string): string =>
    [...(side.get(personaId) ?? [])].sort((a, b) => a - b).join(', ');

  for (const [variant, side] of rest) {
    const everyone = new Set([...firstSide.keys(), ...side.keys()]);
    for (const personaId of everyone) {
      const ours = seedsOf(side, personaId);
      const theirs = seedsOf(firstSide, personaId);
      if (ours === theirs) continue;
      if (ours === '' || theirs === '') {
        const [driven, missing] = ours === '' ? [firstVariant, variant] : [variant, firstVariant];
        return `variant "${driven}" drives "${personaId}" and variant "${missing}" does not: the two sides of a comparison are the same people, so that the only difference between them is the code`;
      }
      return `variant "${variant}" drives "${personaId}" on seeds ${ours} and variant "${firstVariant}" drives them on ${theirs}: the two sides of a comparison are the same people on the same seeds, so that the only difference between them is the code`;
    }
  }
  return null;
};
