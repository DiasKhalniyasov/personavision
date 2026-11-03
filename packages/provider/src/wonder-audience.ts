import { audienceSchema, createSeededRandom } from '@personavision/contract';
import type { Audience, AudienceDevice } from '@personavision/contract';
import { z } from 'zod';
import type { WonderAsk, WonderEffort, WonderProvider, WonderReply } from './wonder.js';

/**
 * The first of the four things Muse Wonder answers: **one sentence in, one structured
 * audience out** (`docs/FLOW.md` section 12; step #219; #257).
 *
 * _"busy parents in Almaty who shop on their phones"_ goes in, and one `Audience` in the
 * artifact's own shape comes out — participants, age groups, gender split, regions,
 * languages, device mix, how tech-confident, how price-sensitive — or the ask's own
 * validator refuses it with the path it is wrong at. The screen that shows the result and
 * lets the user disagree with every field of it is #225's: the owner's decision on this flow
 * is that **what comes back fills the form**, so the free-text box is an input to the
 * Audience form and not an alternative to it, and nothing here launches anything.
 *
 * Four things are load-bearing, and all four are here rather than in a prompt, because
 * `docs/meta-model-api.md` is explicit that a schema-constrained reply is a guarantee about
 * JSON and not about truth:
 *
 * 1. **It is the same object the structured form produces.** The reply is held to the
 *    contract's own `audienceSchema` — not to a looser audience of this file's own — and the
 *    reply shape asked for is derived from that schema field by field, so the shape asked
 *    for cannot drift from the shape enforced.
 * 2. **The model writes what a sentence can describe, and nothing else.** Which audience id
 *    this is stored under and which generator its people are reproducible against are the
 *    caller's, stamped on after the parse; the device mix names a **class** out of the
 *    closed list it was given rather than inventing a viewport, because a reply that is
 *    schema-valid and names a device nobody offers is the exact failure the live change call
 *    produced.
 * 3. **Shares a hair off one are made a distribution; shares that are not one are refused.**
 *    A model writing three age brackets to two decimals can only sum to 0.99, and rejecting
 *    that would throw away a correct audience over arithmetic nobody can see. A mix summing
 *    to 0.8 is a different audience from the one asked for, and is refused with the sum
 *    named rather than quietly normalised into something nobody chose.
 * 4. **Nothing is half-filled.** A reply missing a field or carrying the wrong type is
 *    reported in words with the path, never patched with a default — the user is about to
 *    read this as what the model made of their sentence, and a field we invented would read
 *    as one the model wrote.
 */

/**
 * The reasoning effort this shape is worth, from the four calls timed in
 * `docs/meta-model-api.md` (2026-11-03): the structured audience was answered at `minimal`
 * in 7.9s for $0.0112, 371 input tokens and 487 output. It is a shape to fill in, not a
 * judgement to reach, and `minimal` is what it was measured at.
 */
export const AUDIENCE_EFFORT: WonderEffort = 'minimal';

/** The name the model is told the reply shape is called. */
export const AUDIENCE_REPLY_SCHEMA_NAME = 'wonder_audience';

/**
 * How many simulated people a test started on the platform runs with
 * (`docs/FLOW.md` section 12). It is what the model is told to answer with when the sentence
 * names no number of its own, and what the offline stand-in answers; the user edits it on
 * the form like every other field.
 *
 * `@personavision/platform` carries the same hundred as `DEFAULT_PARTICIPANTS`, which is
 * what a submitted audience that names no size is stored with (#348). The two are the
 * design contract's one number read in two layers rather than one package's default read by
 * the other: nothing in this package may import the platform, which imports this one.
 */
export const DEFAULT_AUDIENCE_SIZE = 100;

/**
 * How far off one a set of shares may be and still be rounding rather than a different
 * audience: **half a percentage point per share**.
 *
 * That is exactly what writing each share to two decimals can cost — three age brackets at
 * `0.33` sum to `0.99`, four devices at two decimals can miss by `0.02` — so the band is the
 * tolerance times the number of shares and not one flat number. Inside it the shares are
 * scaled to sum to one, which keeps the ratios the model chose. Outside it the reply is
 * refused with the sum named: a device mix summing to `0.8` is not a rounding error, and
 * normalising it would invent a mix nobody chose.
 */
export const SHARE_ROUNDING_TOLERANCE = 0.005;

/**
 * One device class the audience may be a mix of: the audience's own word for the class and
 * the class geometry, which is everything `audienceSchema` records about a device except the
 * share.
 *
 * It is handed in, like the files #263's change may touch, because the model is asked for a
 * class **name** out of a closed list and never for a viewport. The class whose name comes
 * back is expanded to this geometry, so a device mix out of Wonder is the same object the
 * Audience form's own chips produce.
 */
export type AudienceDeviceClass = Omit<AudienceDevice, 'share'>;

/**
 * The classes offered when the caller names none: the three the Audience screen draws, at
 * the class viewports it prints beside each (`docs/FLOW.md` section 3).
 *
 * The screen holds its own copy of this list — `apps/viewer`'s `DEVICE_CLASSES`, which is
 * what a user's chips are drawn from — and a caller that has it should hand it in rather
 * than lean on this one, which is why `deviceClasses` is on the input. A *concrete* device a
 * generated person runs on is a third thing again and the persona generator's business
 * (`packages/personas`' `CONCRETE_DEVICES`): a class viewport and the phone somebody holds
 * are allowed to differ, and nothing here reads a persona.
 */
export const AUDIENCE_DEVICE_CLASSES: readonly AudienceDeviceClass[] = [
  { name: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, touch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, touch: false },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, touch: true },
];

/** Everything one structured audience is written from. */
export interface AudienceAskInput {
  /** The user's own sentence, exactly as they typed it in the free-text box. */
  readonly sentence: string;
  /**
   * The id the audience is stored under. The caller's, never the model's: a new audience
   * gets a fresh one and an edited audience keeps the one it was stored under, so that
   * renaming it does not orphan the people of a test that ran for it.
   */
  readonly id: string;
  /** The run's or the request's seed, which is what makes the offline answer repeatable. */
  readonly seed: number;
  /**
   * The persona generator this audience's people are reproducible against, as the caller
   * will store it. Stamped on rather than asked for: this package generates nobody and so
   * cannot know it, and `@personavision/personas` refuses an audience labelled with a
   * version other than its own rather than hand it a different hundred people.
   */
  readonly generatorVersion: string;
  /** Overrides {@link AUDIENCE_DEVICE_CLASSES}: the classes this audience may be a mix of. */
  readonly deviceClasses?: readonly AudienceDeviceClass[];
  /** Overrides {@link AUDIENCE_EFFORT}; a caller may ask for more or less thinking. */
  readonly effort?: WonderEffort;
}

/** A refused reply, in the shape `parseWonderReply` reads issues out of. */
class AudienceReplyRefused extends Error {
  readonly issues: readonly { readonly path: readonly unknown[]; readonly message: string }[];

  constructor(issues: readonly { readonly path: readonly unknown[]; readonly message: string }[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'AudienceReplyRefused';
    this.issues = issues;
  }
}

/**
 * The contract's own audience, field by field. Everything the reply shape is built from is
 * read off here rather than restated, so the brackets a model may name, the scale a trait is
 * on and the width of a share are the artifact's and cannot drift from it.
 */
const described = audienceSchema.shape;

/** The six brackets a user thinks in, as `audienceSchema` enumerates them. */
const AGE_GROUPS = described.ageGroups.unwrap().element.shape.group.options;

/**
 * The three fields the artifact leaves optional that a Wonder audience always states.
 *
 * They are optional on `audienceSchema` because an audience described before they existed
 * declared none and says so by carrying nothing (`docs/FLOW.md` section 12). A *sentence*,
 * though, is read by someone of some age in some language: an audience out of Wonder that
 * leaves one out is half-filled, and the one thing this use may not do is fill it in itself.
 */
const ALWAYS_STATED = ['languages', 'genderSplit', 'ageGroups'] as const;

/** `18–24` to 18 and 24, `65+` to 65 and nothing above it: read off the bracket's own name. */
const yearsOf = (group: string): { readonly min: number; readonly max: number | null } => {
  const open = /^(\d+)\+$/u.exec(group);
  if (open !== null) return { min: Number(open[1]), max: null };
  const closed = /^(\d+)\D(\d+)$/u.exec(group);
  if (closed === null) {
    throw new TypeError(
      `age bracket "${group}" is neither "min–max" nor "min+": the brackets are read off the contract's own enumeration, and this build cannot read that one`,
    );
  }
  return { min: Number(closed[1]), max: Number(closed[2]) };
};

/** Shares that are a distribution, or the reason they are not one. */
type Distribution =
  | { readonly ok: true; readonly shares: readonly number[] }
  | { readonly ok: false; readonly refused: string };

/**
 * Holds one set of shares to being a distribution: scaled to sum to one where they are
 * within {@link SHARE_ROUNDING_TOLERANCE} per share of it, refused with the sum where they
 * are not.
 *
 * Scaling rather than adjusting the largest share keeps the ratios the reply chose — 33/33/33
 * stays three equal thirds — and the scaled shares sum to one well inside the contract's own
 * tolerance, so the audience that comes out of here is one `audienceSchema` accepts.
 */
const asDistribution = (shares: readonly number[], what: string): Distribution => {
  const total = shares.reduce((sum, share) => sum + share, 0);
  const band = SHARE_ROUNDING_TOLERANCE * shares.length;
  if (Math.abs(total - 1) > band) {
    return {
      ok: false,
      refused: `${what} are not a distribution: the ${shares.length} shares sum to ${total}, which is further than ${band} from one — shares within half a point each of one are rounding and are scaled to one, and shares this far off are refused rather than normalised into a mix nobody chose`,
    };
  }
  return { ok: true, shares: total === 1 ? shares : shares.map((share) => share / total) };
};

/**
 * The device entry the model answers with: a class out of the closed list it was given, and
 * the share of the audience on it. The share is the contract's own, read off
 * `audienceSchema`.
 */
const deviceEntrySchema = (classes: readonly AudienceDeviceClass[]) =>
  z.strictObject({
    class: z.enum(classes.map((device) => device.name) as [string, ...string[]]),
    share: described.devices.element.shape.share,
  });

/**
 * The reply shape: every field of the contract's audience that a sentence can describe, each
 * one required, with the device mix as class names.
 *
 * `id` and `generatedFrom` are left out because they are the caller's, and the three fields
 * the artifact leaves optional are required here — the strict subset the structured-reply
 * mechanism validates against wants every key of `properties` in `required` anyway
 * (`docs/meta-model-api.md`), and {@link ALWAYS_STATED} is the reason they are not simply
 * dropped instead.
 */
const audienceReplySchema = (classes: readonly AudienceDeviceClass[]) =>
  z.strictObject({
    name: described.name,
    ageRange: described.ageRange,
    roles: described.roles,
    regions: described.regions,
    languages: described.languages.unwrap(),
    genderSplit: described.genderSplit.unwrap(),
    ageGroups: described.ageGroups.unwrap(),
    goals: described.goals,
    devices: z.array(deviceEntrySchema(classes)).min(1),
    techSavviness: described.techSavviness,
    priceSensitivity: described.priceSensitivity,
    size: described.size,
  });

/** What one reply describes, before the caller's two fields are stamped on. */
type DescribedAudience = z.infer<ReturnType<typeof audienceReplySchema>>;

/** `z.toJSONSchema` labels its output; the structured-reply parameter takes the schema. */
const jsonSchemaOf = (schema: z.ZodType): Readonly<Record<string, unknown>> => {
  const schemaObject = z.toJSONSchema(schema) as Record<string, unknown>;
  delete schemaObject.$schema;
  return schemaObject;
};

/** The classes this ask offers, which is what the model may name and what a name expands to. */
const classesOf = (input: AudienceAskInput): readonly AudienceDeviceClass[] =>
  input.deviceClasses ?? AUDIENCE_DEVICE_CLASSES;

/**
 * The described audience as the artifact carries it: each class name expanded to the class
 * geometry it was offered under, and the caller's id and provenance stamped on.
 */
const stamp = (reply: DescribedAudience, input: AudienceAskInput): Audience => {
  const classes = classesOf(input);
  const { devices, ...rest } = reply;
  return {
    id: input.id,
    ...rest,
    // The enum the reply was parsed against is these classes' own names, so a name that
    // reached here names one of them.
    devices: devices.map((entry) => {
      const offered = classes.find((device) => device.name === entry.class);
      if (offered === undefined) {
        throw new TypeError(
          `device class "${entry.class}" is not one of the ${classes.length} this ask offered: the reply's own enumeration is built from them, so this cannot happen without one of the two being edited away from the other`,
        );
      }
      return { ...offered, share: entry.share };
    }),
    generatedFrom: { seed: input.seed, generatorVersion: input.generatorVersion },
  } satisfies Audience;
};

/**
 * Everything about an audience that the reply schema cannot say: that it states the three
 * fields the artifact leaves optional, and that its three sets of shares are distributions.
 *
 * Every failure is collected before any is thrown, so a reply that is wrong in three places
 * is reported in three places rather than one at a time. The repaired shares are what comes
 * out, which is why this runs on the stamped audience and not on the reply: one place reads
 * the device mix, the gender split and the age groups, whether a model or the offline
 * generator wrote them.
 */
const checkAudience = (audience: Audience): Audience => {
  const issues: { readonly path: readonly unknown[]; readonly message: string }[] = [];
  for (const field of ALWAYS_STATED) {
    if (audience[field] === undefined) {
      issues.push({
        path: [field],
        message: `the audience states no ${field}: a sentence is read by somebody of some age in some language, so a Wonder audience states all of ${ALWAYS_STATED.join(', ')} — and a field this use filled in itself would read as one the model wrote`,
      });
    }
  }

  const held = <T>(
    shares: readonly number[],
    what: string,
    path: readonly unknown[],
    rebuild: (shares: readonly number[]) => T,
    whole: T,
  ): T => {
    const distribution = asDistribution(shares, what);
    if (!distribution.ok) {
      issues.push({ path, message: distribution.refused });
      return whole;
    }
    return rebuild(distribution.shares);
  };

  const devices = held(
    audience.devices.map((device) => device.share),
    'the device mix',
    ['devices'],
    (shares) => audience.devices.map((device, index) => ({ ...device, share: shares[index] })),
    audience.devices,
  );
  const ageGroups =
    audience.ageGroups === undefined
      ? undefined
      : held(
          audience.ageGroups.map((group) => group.share),
          'the age groups',
          ['ageGroups'],
          (shares) =>
            (audience.ageGroups ?? []).map((group, index) => ({
              ...group,
              share: shares[index],
            })),
          audience.ageGroups,
        );
  const genderSplit =
    audience.genderSplit === undefined
      ? undefined
      : held(
          [audience.genderSplit.male, audience.genderSplit.female],
          'the gender split',
          ['genderSplit'],
          (shares) => ({ male: shares[0], female: shares[1] }),
          audience.genderSplit,
        );

  if (issues.length > 0) throw new AudienceReplyRefused(issues);
  return { ...audience, devices, ageGroups, genderSplit };
};

/**
 * The reply, held to the described shape, then to everything above it, then to the
 * contract's own audience — which is the last word on it, so that what a caller gets is the
 * same object the structured form saves and not an audience this file believes in.
 */
const parseAudience = (reply: unknown, input: AudienceAskInput): Audience => {
  // The model answers the described fields and never sees `id` or `generatedFrom`; the
  // offline generator answers the artifact's own shape, with both already stamped. Routing
  // on the provenance block rather than on two validators is also what makes this function
  // idempotent, which it has to be: `createOfflineWonderProvider` runs the generator's
  // answer through here, and a caller is free to run an audience through it twice.
  const stamped =
    typeof reply === 'object' && reply !== null && 'generatedFrom' in reply
      ? (reply as Audience)
      : stamp(audienceReplySchema(classesOf(input)).parse(reply), input);
  return audienceSchema.parse(checkAudience(stamped));
};

/** The sentence with the punctuation a person types at the end of one taken off. */
const trimmed = (text: string): string => text.trim().replace(/[\s.,;:!?]+$/u, '');

/** A label a form would print: the clause as it was typed, with a capital on the front. */
const labelled = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The sentence split at a marker: what came before it, and what came after. Both trimmed,
 * and `undefined` where the marker is not in the sentence at all.
 */
const splitAt = (text: string, marker: RegExp): readonly [string, string | undefined] => {
  const found = marker.exec(text);
  if (found === null) return [text, undefined];
  const after = trimmed(text.slice(found.index + found[0].length));
  return [trimmed(text.slice(0, found.index)), after === '' ? undefined : after];
};

/** Two decimals, which is how a person reads a share and how a model writes one. */
const round2 = (value: number): number => Number(value.toFixed(2));

/**
 * The audience when there is no model: the sentence's own clauses where a clause can be
 * lifted out of it honestly, and the seeded stream everywhere else.
 *
 * It is a stand-in and reads like one — what it is for is the demo, the tests and a fresh
 * clone with no key, all of which need the same sentence and the same seed to give the same
 * audience, field for field. _"busy parents in Almaty who shop on their phones"_ is written
 * the way a person writes one, so three of its fields are in the sentence and are taken from
 * it rather than guessed: the role before the place, the place after `in`, and what they are
 * doing after `who`. The device mix follows the sentence where it names a device. The age
 * brackets, the split and the two scales are the seed's, because a sentence that does not
 * say them cannot be read as saying them — and every one of them is a field the user is
 * shown and can disagree with before anything launches (`docs/FLOW.md` section 12).
 */
const offlineAudience = (input: AudienceAskInput, seed: number): Audience => {
  const random = createSeededRandom(seed);
  const sentence = trimmed(input.sentence);
  const [whoBefore, doing] = splitAt(sentence, /\s+(?:who|that|which)\s+/iu);
  const [role, place] = splitAt(whoBefore, /\s+(?:in|from|across)\s+/iu);

  const classes = classesOf(input);
  const named = (...words: readonly string[]): AudienceDeviceClass | undefined =>
    classes.find((device) => words.includes(device.name));
  const leading =
    (/phone|mobile/iu.test(sentence)
      ? named('mobile', 'phone')
      : /desktop|laptop|computer/iu.test(sentence)
        ? named('desktop')
        : undefined) ?? classes[0];
  const others = classes.filter((device) => device !== leading);
  // A majority on the device the sentence names, the rest of the audience on the next class
  // offered, and nobody on any class after it — which is the shape the Audience form's own
  // chips start in, and a share of zero is a class that carries nobody rather than one that
  // was left out.
  const share = others.length === 0 ? 1 : round2(0.6 + random() * 0.2);
  const devices = [
    { class: leading.name, share },
    ...others.map((device, index) => ({
      class: device.name,
      share: index === 0 ? round2(1 - share) : 0,
    })),
  ];

  // Two neighbouring brackets, so that the age range they derive to is one a person would
  // recognise rather than the whole adult population.
  const first = Math.floor(random() * (AGE_GROUPS.length - 1));
  const brackets = [AGE_GROUPS[first], AGE_GROUPS[first + 1]];
  const younger = round2(0.45 + random() * 0.2);
  const years = brackets.map((group) => yearsOf(group));
  const male = round2(0.35 + random() * 0.3);

  return stamp(
    {
      name: labelled(role === '' ? sentence : role),
      // Derived from the brackets that carry somebody, which is the rule `audienceSchema`
      // holds an age range to: it starts inside the lowest and ends inside the highest, and
      // the highest bracket is open above, where `65+` has no measured end to take.
      ageRange: { min: years[0].min, max: years[1].max ?? years[1].min + 9 },
      roles: role === '' ? [] : [role],
      regions: place === undefined ? [] : [place],
      // The language a sentence is written in is not something a regular expression can
      // read, and the stand-in says so by naming the one this repository is written in
      // rather than by inventing a second.
      languages: ['English'],
      genderSplit: { male, female: round2(1 - male) },
      ageGroups: [
        { group: brackets[0], share: younger },
        { group: brackets[1], share: round2(1 - younger) },
      ],
      goals: doing === undefined ? [] : [doing],
      devices,
      techSavviness: round2(random()),
      priceSensitivity: round2(random()),
      size: DEFAULT_AUDIENCE_SIZE,
    },
    input,
  );
};

/** The sentence and the closed lists it is to be read into, as the model reads them. */
const documentOf = (input: AudienceAskInput): string => {
  const classes = classesOf(input);
  return [
    'Read one sentence describing the people a website is for, and write the structured audience it describes.',
    '',
    '## The sentence, exactly as it was typed',
    '',
    input.sentence,
    '',
    '## What to answer',
    '',
    `- \`name\`: a short label for this audience, in the words of the sentence.`,
    `- \`roles\`, \`goals\`, \`regions\`: what these people are, what they are trying to do and where they are, as the sentence says them. A list may be empty where the sentence says nothing about it.`,
    `- \`languages\`: the languages these people read the page in, which is a different fact from where they are. At least one.`,
    `- \`ageGroups\`: the brackets these people fall into, out of ${AGE_GROUPS.join(', ')}, each with the share of the audience in it. One bracket appears once.`,
    `- \`ageRange\`: the ages these people run from and to. It is derived from the brackets that carry somebody: it starts inside the lowest of them and ends inside the highest.`,
    `- \`genderSplit\`: the share that is male and the share that is female.`,
    `- \`devices\`: the mix of devices these people are on. \`class\` is one of ${classes.map((device) => `"${device.name}"`).join(', ')} and nothing else — do not describe a screen, a viewport or a model of phone.`,
    `- The shares in \`devices\`, in \`ageGroups\`, and the two in \`genderSplit\` are each a distribution and each sum to 1.`,
    `- \`techSavviness\` and \`priceSensitivity\`: how tech-confident and how price-sensitive these people are, from 0 to 1.`,
    `- \`size\`: how many simulated people to generate — the number the sentence names, or ${DEFAULT_AUDIENCE_SIZE} where it names none.`,
    '- Every field above is required. A field left out, or carrying a type other than the one asked for, is refused with the path named rather than filled in for you.',
  ].join('\n');
};

/**
 * One ask for one structured audience. The use owns its words, its schema, its validation
 * and its offline answer; the seam and every implementation of it own none of the four
 * (`wonder.ts`).
 */
export const audienceAsk = (input: AudienceAskInput): WonderAsk<Audience> => {
  if (trimmed(input.sentence) === '') {
    throw new TypeError(
      'an audience is written from a sentence, and this ask carries none: an empty free-text box is a form the user has not filled in, not a hundred people to invent',
    );
  }
  if (classesOf(input).length === 0) {
    throw new TypeError(
      'an audience is a mix of device classes, and this ask offers none: the classes the audience may be a mix of are handed in, because the model names one of them and never a viewport',
    );
  }
  return {
    use: 'audience',
    document: documentOf(input),
    seed: input.seed,
    replySchema: {
      name: AUDIENCE_REPLY_SCHEMA_NAME,
      schema: jsonSchemaOf(audienceReplySchema(classesOf(input))),
    },
    effort: input.effort ?? AUDIENCE_EFFORT,
    parse: (reply) => parseAudience(reply, input),
    offline: (seed) => offlineAudience(input, seed),
  };
};

/**
 * The structured audience, through whichever implementation the caller selected. The reply
 * carries the five usage figures a decision reports, so an audience call adds to a run's
 * usage through the one `totalUsage` and there is no second block for it (#32).
 */
export const writeAudience = async (
  provider: WonderProvider,
  input: AudienceAskInput,
): Promise<WonderReply<Audience>> => provider.ask(audienceAsk(input));
