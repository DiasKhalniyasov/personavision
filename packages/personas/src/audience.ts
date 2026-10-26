import { audienceSchema } from '@personavision/contract';
import type { Audience, Persona } from '@personavision/contract';

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
 * end of its own scale. They are deliberately short of the full range: a centre that reached
 * 0 or 1 would leave the archetypes and the seeded jitter nothing to spread into, and an
 * audience of one opinion would generate `size` identical people. `interfaceFamiliarity` is
 * the exception — the contract says `techSavviness` moves it *directly*, so it is the field.
 */
const TECH_ON_SCANNING = 0.4;
const AGE_ON_SCANNING = 0.2;
const PRICE_ON_DETAIL = 0.5;
const PRICE_ON_PATIENCE = 0.3;
const AGE_ON_PATIENCE = 0.25;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/** Where the audience sits on each trait, before an archetype displaces a person from it. */
export const traitCentre = (audience: Audience): Persona['traits'] => {
  const techDeviation = audience.techSavviness - 0.5;
  const priceDeviation = audience.priceSensitivity - 0.5;
  const ageMidpoint = (audience.ageRange.min + audience.ageRange.max) / 2;
  // Positive is older. Saturating keeps a 90-year-old audience from asking for a patience
  // above the scale and losing its spread to the clamp.
  const ageSkew = Math.min(1, Math.max(-1, (ageMidpoint - AGE_NEUTRAL) / AGE_SATURATION));

  return {
    persistence: 0.5,
    scanningVsReading: clampUnit(
      0.5 + TECH_ON_SCANNING * techDeviation - AGE_ON_SCANNING * ageSkew,
    ),
    detailOrientation: clampUnit(0.5 + PRICE_ON_DETAIL * priceDeviation),
    interfaceFamiliarity: audience.techSavviness,
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
