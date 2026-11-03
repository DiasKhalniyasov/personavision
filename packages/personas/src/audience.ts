import { audienceSchema } from '@personavision/contract';
import type { AgeGroup, Audience, Gender, Persona } from '@personavision/contract';
import { largestRemainder } from './devices.js';

/**
 * The audience, and the centre of the trait space it describes.
 *
 * `docs/FLOW.md` section 1 declares the audience's shape and fixes, in outline, which
 * audience field moves which trait. The shape itself is `@personavision/contract`'s, because
 * a run artifact carries a copy of it; what lives here is the arithmetic.
 *
 * | Audience field     | What it moves                                                          |
 * | ------------------ | ---------------------------------------------------------------------- |
 * | `techSavviness`    | `interfaceFamiliarity` directly; higher also shifts towards scanning   |
 * | `priceSensitivity` | `detailOrientation` up; `patience` down                                |
 * | `ageRange`         | `patience` up with age; `scanningVsReading` up as the audience is younger |
 * | `goals`            | carried to the engine's top-down relevance — never a trait             |
 * | `devices`          | the device each person gets, by share — `devices.ts`                   |
 * | `roles`            | — see the README: the generated people are named for behaviour         |
 * | `size`             | how many people are generated                                          |
 * | `genderSplit`      | the `gender` each person is drawn as, by share                         |
 * | `ageGroups`        | the bracket each person is drawn from and the age they are drawn at, by share — and so their own `patience` and `scanningVsReading` rather than the audience's |
 * | `languages`        | the one `language` each person reads and types in — **apportioned evenly**, because a list declares no shares |
 *
 * The last three are `docs/FLOW.md` section 12's three new rows, and they fire only on an
 * audience that carries the field: an audience declaring none of them generates exactly the
 * people it generated before they existed, which is why `GENERATOR_VERSION` does not move
 * (`README.md`, "Why this is not a new generator version").
 *
 * `persistence` and `riskTolerance` are not in that table, so no audience field moves them:
 * they sit at the midpoint and get their spread from the archetype and the seed. Deriving
 * them from a field the contract does not connect them to would be this package inventing a
 * claim about people, which is the one thing a number the product reports must not rest on.
 */

/** The generator this package implements. An audience names the version that made it. */
export const GENERATOR_VERSION = 'persona-gen-1';

/**
 * The age at which the age-driven terms are neutral, and the distance from it at which they
 * saturate: a 40-year-old audience is the middle of the adult web-using range, and 15 and 65
 * are the ends of it. Beyond them the terms stop moving rather than running off the scale.
 */
const AGE_NEUTRAL = 40;
const AGE_SATURATION = 25;

/**
 * How far each audience field may move a centre, on the 0..1 trait scale, when it is at the
 * end of its own scale. Every one is short of the full range, so that a centre never lands on
 * 0 or 1: a centre on the boundary has no room on one side of it, every person the archetypes
 * displace that way arrives at the same boundary value, and an audience of one strong opinion
 * reports clones on that trait — which is exactly what the swarm exists to avoid.
 *
 * `interfaceFamiliarity` carries the largest coefficient of the five, because it is the trait
 * `techSavviness` is *about* — the contract's word is "directly", and nothing else moves it —
 * but it is not the identity, for the reason above.
 */
const TECH_ON_FAMILIARITY = 0.8;
const TECH_ON_SCANNING = 0.4;
const AGE_ON_SCANNING = 0.2;
const PRICE_ON_DETAIL = 0.5;
const PRICE_ON_PATIENCE = 0.3;
const AGE_ON_PATIENCE = 0.25;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Where the audience sits on each trait, before an archetype displaces a person from it.
 *
 * `age` is the age **this person** was drawn at, where the audience declared age groups to
 * draw one from. Without it the age terms read the midpoint of `ageRange`, which is one
 * centre for the whole audience and is what every audience that declares no age groups still
 * gets, to the last digit. With it they read the person's own age instead — the same two
 * coefficients in the same two directions the table above already states, applied to the age
 * the person is rather than to the average of the range they came from. That is the whole of
 * what an age group moves: an audience that is mostly in its thirties with a tail at fifty
 * generates people whose patience is their own age's rather than the tail's.
 */
export const traitCentre = (audience: Audience, age?: number): Persona['traits'] => {
  const techDeviation = audience.techSavviness - 0.5;
  const priceDeviation = audience.priceSensitivity - 0.5;
  const ageMidpoint = age ?? (audience.ageRange.min + audience.ageRange.max) / 2;
  // Positive is older. Saturating keeps a 90-year-old audience from asking for a patience
  // above the scale and losing its spread to the clamp.
  const ageSkew = Math.min(1, Math.max(-1, (ageMidpoint - AGE_NEUTRAL) / AGE_SATURATION));

  return {
    persistence: 0.5,
    scanningVsReading: clampUnit(
      0.5 + TECH_ON_SCANNING * techDeviation - AGE_ON_SCANNING * ageSkew,
    ),
    detailOrientation: clampUnit(0.5 + PRICE_ON_DETAIL * priceDeviation),
    interfaceFamiliarity: clampUnit(0.5 + TECH_ON_FAMILIARITY * techDeviation),
    patience: clampUnit(0.5 - PRICE_ON_PATIENCE * priceDeviation + AGE_ON_PATIENCE * ageSkew),
    riskTolerance: 0.5,
  };
};

/** One thing the audience got wrong, at the path in the audience it is wrong at. */
export interface AudienceIssue {
  /** `devices`, `ageRange`, `generatedFrom.generatorVersion` — the offending path. */
  readonly path: string;
  readonly message: string;
}

/**
 * An audience that cannot generate people, with every reason and where each one is.
 *
 * Generation validates before it samples, so a bad audience is a named path rather than a
 * set of people that look plausible and are not. The platform stores audiences a user typed,
 * so this is the error an audience form reports field by field.
 */
export class AudienceValidationError extends Error {
  readonly issues: readonly AudienceIssue[];

  constructor(issues: readonly AudienceIssue[]) {
    super(
      `this is not an audience personas can be generated from: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'AudienceValidationError';
    this.issues = issues;
  }
}

/** `devices[0].share` — a zod path as the audience's own field path. */
const pathOf = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '(the audience)'
    : path.reduce<string>(
        (text, key) =>
          typeof key === 'number'
            ? `${text}[${key}]`
            : text === ''
              ? String(key)
              : `${text}.${String(key)}`,
        '',
      );

/**
 * The audience as the contract declares it, or `AudienceValidationError`.
 *
 * The version check is the same promise the artifact's `schemaVersion` makes: an audience
 * generated by a generator this build does not implement is named as such rather than
 * silently generated from by different arithmetic, because its people were reproducible
 * against that version and would not be against this one.
 */
export const parseAudience = (audience: unknown): Audience => {
  const parsed = audienceSchema.safeParse(audience);
  if (!parsed.success) {
    throw new AudienceValidationError(
      parsed.error.issues.flatMap((issue) => {
        // A closed object reports every field it does not declare against itself, which
        // would name the audience rather than the field: the offending path is the key.
        const unrecognised = issue.code === 'unrecognized_keys' ? issue.keys : [];
        if (unrecognised.length > 0) {
          return unrecognised.map((key) => ({
            path: pathOf([...issue.path, key]),
            message: `the audience has no such field: a run artifact carries a copy of the audience, and it declares nothing a reader cannot name`,
          }));
        }
        return [{ path: pathOf(issue.path), message: issue.message }];
      }),
    );
  }
  const { generatorVersion } = parsed.data.generatedFrom;
  if (generatorVersion !== GENERATOR_VERSION) {
    throw new AudienceValidationError([
      {
        path: 'generatedFrom.generatorVersion',
        message: `this audience was generated from by "${generatorVersion}", and this build is "${GENERATOR_VERSION}": its people are reproducible against that version, not this one`,
      },
    ]);
  }
  return parsed.data;
};

/**
 * One value a drawn audience field can take, and how many of the audience's people take it.
 *
 * The three fields `docs/FLOW.md` section 12 adds — the gender split, the age groups and the
 * languages — are all read the same way: the audience declares the values and (for two of
 * the three) their shares, and the apportionment says how many people each value is worth.
 * Who then gets which is the generator's, in `generate.ts`, because that is the part a seed
 * decides.
 */
export interface Apportioned<Value> {
  readonly value: Value;
  readonly count: number;
}

/** The declared values and their counts, by the device mix's own largest-remainder rule. */
const apportion = <Value>(
  size: number,
  declared: readonly { readonly value: Value; readonly share: number }[],
): readonly Apportioned<Value>[] =>
  largestRemainder(
    size,
    declared.map((entry) => entry.share),
  ).map((count, index) => ({
    // `largestRemainder` returns one count per share, in the order the shares were given.
    value: (declared[index] as { readonly value: Value }).value,
    count,
  }));

/**
 * How many people are drawn as each of the gender split's two words, or `null` where the
 * audience declared no split.
 *
 * The two words are read off the split the people are drawn from rather than written out
 * here, so this file cannot spell a third — the same reason `genderSchema` reads them off
 * `genderSplitSchema` in the contract. They are then **sorted**, because reading them off
 * the object makes their order the object's, and that is not an order to inherit by
 * accident. As it happens zod rebuilds a parsed audience in the schema's own declaration
 * order, so an audience written `{ female, male }` and one written `{ male, female }` reach
 * this function identical — but that is an incidental property of the parser rather than
 * something the contract promises, and this function is reachable with an audience nobody
 * parsed. Sorting makes the order this file's own and the answer the same either way.
 *
 * Sorted, `female` is first, so a 50/50 split over an odd number of people gives the odd
 * person to `female`: arbitrary, and the same arbitrary answer every time, which is the
 * property that matters.
 *
 * Not floored. A share of zero here is a measurement the audience made, so nobody is drawn
 * as it; `devices.ts` states that difference where the floor is.
 */
export const genderApportionment = (audience: Audience): readonly Apportioned<Gender>[] | null => {
  const { genderSplit } = audience;
  if (genderSplit === undefined) return null;
  const words = (Object.keys(genderSplit) as Gender[]).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  return apportion(
    audience.size,
    words.map((value) => ({ value, share: genderSplit[value] })),
  );
};

/**
 * How many people are drawn from each age bracket **that carries somebody**, in the
 * audience's own order, or `null` where the audience declared no groups.
 *
 * A bracket with a share of zero is left out rather than given the floor the device mix has.
 * It is how an audience says nobody here is that age, and the contract holds `ageRange`
 * consistent only with the brackets that carry somebody — so a person floored into an empty
 * bracket could be an age the audience's own range excludes.
 */
export const ageGroupApportionment = (
  audience: Audience,
): readonly Apportioned<AgeGroup>[] | null => {
  const { ageGroups } = audience;
  if (ageGroups === undefined) return null;
  const carrying = ageGroups.filter((entry) => entry.share > 0);
  if (carrying.length === 0) {
    // The contract refuses this before generation reaches it — group shares have to sum to
    // one — so it is reachable only by calling this with an audience nobody parsed. It is
    // still an audience path rather than a crash, because that is what an audience form
    // renders and `peopleOf` reports on a card.
    throw new AudienceValidationError([
      {
        path: 'ageGroups',
        message: `this audience declares ${String(ageGroups.length)} age ${ageGroups.length === 1 ? 'group' : 'groups'} and puts nobody in any of them: there is no bracket to draw its ${String(audience.size)} people from`,
      },
    ]);
  }
  return apportion(
    audience.size,
    carrying.map((entry) => ({ value: entry.group, share: entry.share })),
  );
};

/**
 * How many people read in each language the audience lists, or `null` where it lists none.
 *
 * **Evenly**, because nobody gave shares: a list is a list, and reading a share into it
 * would be this package inventing a claim about the audience. So the same largest-remainder
 * rule runs over an equal share each — three languages over a hundred people are 34, 33 and
 * 33 — and the list's own order breaks the tie, which `README.md` section 4 states.
 */
export const languageApportionment = (
  audience: Audience,
): readonly Apportioned<string>[] | null => {
  const { languages } = audience;
  if (languages === undefined) return null;
  const even = 1 / languages.length;
  return apportion(
    audience.size,
    languages.map((value) => ({ value, share: even })),
  );
};

/**
 * What a bracket's label means in years: `18–24` is 18 to 24, and `65+` is 65 and open above.
 *
 * Read off the label, which is the bracket's own words — the contract's enumeration is "the
 * brackets a user actually thinks in", and 25–34 means 25 to 34 wherever it is printed. So a
 * bracket added to the contract needs no edit here.
 *
 * The contract keeps a table of the same years, which is what it holds `ageRange` against,
 * and it does not export it. This is therefore a **second reading of one fact** rather than
 * an import, and two readings can drift: a table that disagreed with its own label — say
 * `18–24` recorded as 18 to 25 — would have the contract accept an `ageRange` ending at 25
 * while this clamps the bracket at 24, and a share of the audience would silently be unable
 * to be the age the audience declared. So the two are pinned together by behaviour rather
 * than by hope. `tests/drawn-fields.test.ts` builds, for each of the six brackets, an
 * audience whose `ageRange` is exactly the years this function says the label means, and
 * asserts the contract accepts it and refuses a range one year outside it. A table that
 * disagreed with its own label fails that test, at the bracket it disagreed about.
 */
export const ageGroupYears = (
  group: AgeGroup,
): { readonly min: number; readonly max: number | null } => {
  if (group.endsWith('+')) return { min: Number.parseInt(group, 10), max: null };
  // The separator is the en dash the contract's own labels are written with.
  const [from, to] = group.split('–');
  const min = Number.parseInt(from ?? '', 10);
  const max = Number.parseInt(to ?? '', 10);
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`an age bracket is written "18–24" or "65+", and this one reads "${group}"`);
  }
  return { min, max };
};

/**
 * The years a person drawn from `group` may be: the bracket, narrowed to the audience's own
 * `ageRange`.
 *
 * The narrowing is what keeps the two facts the audience stated from contradicting each
 * other. An audience of 28 to 40 that declares 25–34 and 35–44 said nobody here is 27, so
 * the person drawn from 25–34 is 28 to 34 and the one drawn from 35–44 is 35 to 40. The open
 * bracket takes `ageRange.max` as its top for the same reason: `65+` is where a person stops
 * being asked their age, and the audience's own range is the only upper bound anybody stated.
 *
 * It is never empty for a bracket that carries somebody. The contract holds `ageRange` to
 * starting inside the lowest such bracket and ending inside the highest, so the range covers
 * every bracket between them whole; a range that does not is refused before this is reached,
 * and the refusal below says so by its path rather than by an age nobody can explain.
 */
export const ageBracket = (
  audience: Audience,
  group: AgeGroup,
): { readonly min: number; readonly max: number } => {
  const years = ageGroupYears(group);
  const min = Math.max(years.min, audience.ageRange.min);
  const max = Math.min(years.max ?? audience.ageRange.max, audience.ageRange.max);
  if (min > max) {
    throw new AudienceValidationError([
      {
        path: 'ageGroups',
        message: `age group "${group}" carries people this audience's own range of ${audience.ageRange.min}–${audience.ageRange.max} leaves no age for`,
      },
    ]);
  }
  return { min, max };
};
