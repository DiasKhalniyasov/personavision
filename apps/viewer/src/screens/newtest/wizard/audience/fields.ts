import { DEVICE_CLASSES } from '@/screens/audience/draft';
import { deviceShares, NOTHING, techWords } from '@/screens/audience/words';
import type { AgeGroup, Audience, AudienceDevice } from '@personavision/contract';
import type { AudienceIssue } from '@/screens/audience/store';

/**
 * The six fields of *"What we read from that sentence — edit anything"*, and the audience
 * they come to.
 *
 * `#screen-newtest-feature` of `docs/design/prototype.html` draws the structured audience as
 * **six lines of ordinary text** — `18–24 30% · 25–34 45% · 35–44 25%`, `72% mobile · 28%
 * desktop` — because this screen's job is to show a user what their one sentence became and
 * let them disagree with any of it. This module is the one place those six lines and the
 * contract's `Audience` are converted, so neither the screen nor a test has to know that a
 * share is written in percentage points or that an age bracket is one of six named ones.
 *
 * Three things here are load-bearing:
 *
 * 1. **A field nobody edited contributes the audience's own value, untouched.** A line is
 *    parsed only when its text differs from the line this module wrote for it. Formatting
 *    rounds — three brackets at a third each read `33%` — and re-reading that text would
 *    hand the platform a mix summing to 0.99 and have it refuse an audience the user never
 *    touched. What the user did not change is not re-read, so it cannot be re-rounded.
 * 2. **No share is checked here.** Decision 22 settled that a refused audience reads the
 *    contract's own message at the field it concerns, and the platform validates the whole
 *    audience on the way in (`@personavision/personas`). A second sum check in the browser
 *    would be a second set of words for the same fault. What *is* checked here is only
 *    whether a line can be read at all, which the platform cannot say for a line it never
 *    sees.
 * 3. **`ageRange` is derived, never typed.** `audienceSchema` holds the range to agreeing
 *    with the brackets that carry somebody, so editing the brackets recomputes it from the
 *    bracket labels themselves — they are the user's own words for the years, and reading
 *    them is what keeps this file from carrying a second table of what each one means.
 */

/** The six fields, in the order `#screen-newtest-feature` draws them. */
export const FIELD_KEYS = ['size', 'age', 'gender', 'region', 'devices', 'tech'] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** Each field's label, in the prototype's own words. */
export const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  size: 'Participants',
  age: 'Age groups',
  gender: 'Gender split',
  region: 'Region and language',
  devices: 'Device mix',
  tech: 'How tech-confident',
};

/** The six lines as they stand, one per field. */
export type FieldTexts = Readonly<Record<FieldKey, string>>;

/** What separates two readings on one line, as the prototype writes it. */
const SEP = ' · ';

/**
 * The three answers the tech-confidence field takes, in the product's own words for them.
 *
 * The words are `screens/audience/words`' — the Audiences screen and this step describe the
 * same audience, so neither writes its own vocabulary — and the values are one representative
 * of each band. A band the user does not touch keeps the audience's own figure; see the note
 * above.
 */
export const TECH_CHOICES: readonly { readonly value: number; readonly text: string }[] = [
  0.2, 0.5, 0.9,
].map((value) => ({ value, text: techWords(value) }));

/** The prototype says *phone*; an audience's device class is called `mobile`. Both are read. */
const DEVICE_ALIASES: Readonly<Record<string, string>> = { phone: 'mobile' };

/** `30%`, the way a reader counts to a hundred. */
const share = (value: number): string => `${String(Math.round(value * 100))}%`;

const ageText = (audience: Audience): string =>
  audience.ageGroups === undefined
    ? `${String(audience.ageRange.min)}–${String(audience.ageRange.max)}`
    : audience.ageGroups.map((group) => `${group.group} ${share(group.share)}`).join(SEP);

const genderText = (audience: Audience): string =>
  audience.genderSplit === undefined
    ? NOTHING
    : `${share(audience.genderSplit.female)} female${SEP}${share(audience.genderSplit.male)} male`;

const regionText = (audience: Audience): string =>
  [
    audience.regions.length === 0 ? NOTHING : audience.regions.join(', '),
    audience.languages === undefined ? NOTHING : audience.languages.join(', '),
  ].join(SEP);

const devicesText = (audience: Audience): string =>
  deviceShares(audience.devices)
    .map((device) => `${String(device.percent)}% ${device.name}`)
    .join(SEP);

/** The audience as the six lines read it. */
export const textsOf = (audience: Audience): FieldTexts => ({
  size: String(audience.size),
  age: ageText(audience),
  gender: genderText(audience),
  region: regionText(audience),
  devices: devicesText(audience),
  tech: techWords(audience.techSavviness),
});

/** The readings on one line: `72% mobile · 28% desktop` is two. */
const readings = (text: string): readonly string[] =>
  text
    .split('·')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** Whether a line says *the audience declares none of this*. */
const declaresNothing = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed === '' || trimmed === NOTHING;
};

/** `Kazakhstan, Uzbekistan` → the two of them. */
const list = (text: string): string[] =>
  declaresNothing(text)
    ? []
    : text
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

const WHOLE = /^\d+$/;
/** A share as it is written on the line: `30%`, or `33.5%`. */
const SHARE = /^(\d+(?:\.\d+)?)%$/;
/** `18–24 30%`: the bracket, then its share. A hyphen is read as the en dash it means. */
const BRACKET_SHARE = /^(\S+)\s+(\d+(?:\.\d+)?%)$/;
/** `18–24`, or `65+` for the open one, which is what each bracket means in years. */
const BRACKET_YEARS = /^(\d+)(?:\s*[–-]\s*(\d+)|\+)$/;
/** `54% female`, either way round on the line. */
const SHARE_GENDER = /^(\d+(?:\.\d+)?%)\s+(female|male)$/i;
/** `72% mobile`: the share, then the class it is a share of. */
const SHARE_DEVICE = /^(\d+(?:\.\d+)?%)\s+(.+)$/;
/** `18–65`: an age range for an audience that declares no brackets. */
const RANGE = /^(\d+)\s*[–-]\s*(\d+)$/;

const percentOf = (written: string | undefined): number | null => {
  const matched = written === undefined ? null : SHARE.exec(written.trim());
  return matched === null ? null : Number(matched[1]) / 100;
};

/** One bracket as the enum spells it: the hyphen a keyboard has becomes the en dash. */
const bracketOf = (written: string): string => written.replace(/\s*-\s*/, '–');

/** What a bracket label means in years, read off the label itself. */
const yearsOf = (bracket: string): { readonly min: number; readonly max: number | null } | null => {
  const matched = BRACKET_YEARS.exec(bracket);
  if (matched === null) return null;
  const min = Number(matched[1]);
  const top: string | undefined = matched[2];
  return { min, max: top === undefined ? null : Number(top) };
};

/**
 * The range the brackets that carry somebody come to — `audienceSchema`'s own rule, so that
 * an edit to the brackets is never refused for a range the user was never shown. The open
 * bracket ends where it begins: `65+` has no measured top, and a range needs one.
 */
const rangeOf = (
  groups: readonly { readonly group: string; readonly share: number }[],
): { readonly min: number; readonly max: number } | null => {
  const years = groups
    .filter((group) => group.share > 0)
    .map((group) => yearsOf(group.group))
    .filter((found): found is { min: number; max: number | null } => found !== null);
  if (years.length === 0) return null;
  const lowest = years.reduce((left, right) => (right.min < left.min ? right : left));
  const highest = years.reduce((left, right) => (right.min > left.min ? right : left));
  return { min: lowest.min, max: highest.max ?? highest.min };
};

/** What this module can be asked for: the audience, or every line it could not read. */
export type EditResult =
  | { readonly ok: true; readonly audience: Audience }
  | { readonly ok: false; readonly issues: readonly AudienceIssue[] };

/**
 * The audience with the user's edits on it, or the lines that could not be read — each at
 * the path in the audience it belongs to, which is where the platform reports its own
 * refusals, so either lands on the same field (`byField` below).
 */
export const audienceWithEdits = (original: Audience, texts: FieldTexts): EditResult => {
  const was = textsOf(original);
  const issues: AudienceIssue[] = [];
  const edited: { -readonly [K in keyof Audience]?: Audience[K] } = {};

  if (texts.size !== was.size) {
    const typed = texts.size.trim();
    if (WHOLE.test(typed) && Number(typed) > 0) edited.size = Number(typed);
    else issues.push({ path: 'size', message: 'how many people take part is a whole number' });
  }

  if (texts.age !== was.age) {
    if (original.ageGroups === undefined) {
      const matched = RANGE.exec(texts.age.trim());
      if (matched === null) {
        issues.push({
          path: 'ageRange',
          message: 'an age range runs from one age to another, as in 25–45',
        });
      } else {
        edited.ageRange = { min: Number(matched[1]), max: Number(matched[2]) };
      }
    } else {
      const groups: { group: AgeGroup; share: number }[] = [];
      let readable = true;
      for (const reading of readings(texts.age)) {
        const matched = BRACKET_SHARE.exec(reading);
        const found = matched === null ? null : percentOf(matched[2]);
        const bracket = matched === null ? '' : bracketOf(matched[1]);
        if (found === null || yearsOf(bracket) === null) {
          readable = false;
          issues.push({
            path: 'ageGroups',
            message: `an age group is a bracket and its share of the audience, as in 25–34 45%: "${reading}" is not one`,
          });
          break;
        }
        // The bracket is handed on as the user wrote it. One the six named brackets do not
        // hold is the contract's to refuse, at this same path, in its own words.
        groups.push({ group: bracket as AgeGroup, share: found });
      }
      if (readable && groups.length === 0) {
        issues.push({
          path: 'ageGroups',
          message: 'give the age brackets this audience falls into, as in 25–34 45%',
        });
      } else if (readable) {
        edited.ageGroups = groups;
        // Brackets that all carry nobody derive no range, and the stored one then stands
        // rather than being invented from brackets holding no one.
        const range = rangeOf(groups);
        if (range !== null) edited.ageRange = range;
      }
    }
  }

  if (texts.gender !== was.gender) {
    if (declaresNothing(texts.gender)) {
      edited.genderSplit = undefined;
    } else {
      const split = { male: 0, female: 0 };
      let readable = true;
      for (const reading of readings(texts.gender)) {
        const matched = SHARE_GENDER.exec(reading);
        const found = matched === null ? null : percentOf(matched[1]);
        if (matched === null || found === null) {
          readable = false;
          issues.push({
            path: 'genderSplit',
            message: `a gender split is two shares of the audience, as in 54% female · 46% male: "${reading}" is not one`,
          });
          break;
        }
        split[matched[2].toLowerCase() === 'male' ? 'male' : 'female'] = found;
      }
      // A split naming one of the two leaves the other at nothing, and shares that do not
      // come to one whole audience are refused by the platform in its own words.
      if (readable) edited.genderSplit = split;
    }
  }

  if (texts.region !== was.region) {
    const halves = texts.region.split('·');
    edited.regions = list(halves[0] ?? '');
    const languages = list(halves.slice(1).join('·'));
    // An audience that declares no language leaves the field out rather than empty, which
    // is the contract's own spelling of "none declared".
    edited.languages = languages.length === 0 ? undefined : languages;
  }

  if (texts.devices !== was.devices) {
    const devices: AudienceDevice[] = [];
    let readable = true;
    for (const reading of readings(texts.devices)) {
      const matched = SHARE_DEVICE.exec(reading);
      const found = matched === null ? null : percentOf(matched[1]);
      const written = matched === null ? '' : matched[2].trim().toLowerCase();
      const named = DEVICE_ALIASES[written] ?? written;
      // The audience's own class first, so a mix authored elsewhere stays editable here
      // rather than being quietly converted to one of the three this app offers.
      const known =
        original.devices.find((device) => device.name === named) ??
        DEVICE_CLASSES.find((device) => device.name === named);
      if (found === null || known === undefined) {
        readable = false;
        issues.push({
          path: 'devices',
          message: `a device mix is a share and a device, as in 72% mobile: "${reading}" is not one${
            found === null
              ? ''
              : ` — this audience is a mix of ${DEVICE_CLASSES.map((device) => device.name).join(', ')}`
          }`,
        });
        break;
      }
      devices.push({
        name: known.name,
        viewport: known.viewport,
        deviceScaleFactor: known.deviceScaleFactor,
        touch: known.touch,
        share: found,
      });
    }
    if (readable && devices.length === 0) {
      issues.push({ path: 'devices', message: 'give the devices this audience is a mix of' });
    } else if (readable) {
      edited.devices = devices;
    }
  }

  if (texts.tech !== was.tech) {
    const chosen = TECH_CHOICES.find((choice) => choice.text === texts.tech.trim().toLowerCase());
    if (chosen === undefined) {
      issues.push({
        path: 'techSavviness',
        message: `how tech-confident they are is one of: ${TECH_CHOICES.map((choice) => choice.text).join(', ')}`,
      });
    } else {
      edited.techSavviness = chosen.value;
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // `undefined` for `genderSplit` and `languages` means **declared none**, and the two
  // fields are the only ones that can say it, so they are set from the edit rather than
  // spread over: a spread would drop the key and leave the stored value standing.
  const audience: Audience = { ...original, ...edited };
  if (Object.hasOwn(edited, 'genderSplit') && edited.genderSplit === undefined) {
    delete audience.genderSplit;
  }
  if (Object.hasOwn(edited, 'languages') && edited.languages === undefined) {
    delete audience.languages;
  }
  return { ok: true, audience };
};

/**
 * Where a refusal is rendered: the field whose line the offending path is written on.
 *
 * Both validators report at the path in the audience — this module's and the platform's —
 * so a refusal from either lands on the same one of the six lines. A path none of them
 * owns goes above the card rather than being dropped, because a refusal a reader cannot
 * see is a save that looks like a bug (`screens/audience/issues.ts` does the same).
 */
export type IssuesByField = Readonly<Partial<Record<FieldKey | 'form', string>>>;

const FIELD_OF: Readonly<Record<string, FieldKey>> = {
  size: 'size',
  ageGroups: 'age',
  ageRange: 'age',
  genderSplit: 'gender',
  regions: 'region',
  languages: 'region',
  devices: 'devices',
  techSavviness: 'tech',
};

const fieldOf = (path: string): FieldKey | 'form' => {
  const head = path.split(/[.[]/)[0] ?? path;
  return Object.hasOwn(FIELD_OF, head) ? (FIELD_OF[head] as FieldKey) : 'form';
};

/** The first message per field, which is what a line has room to say. */
export const byField = (issues: readonly AudienceIssue[]): IssuesByField => {
  const byKey: Partial<Record<FieldKey | 'form', string>> = {};
  for (const issue of issues) {
    const key = fieldOf(issue.path);
    byKey[key] ??= key === 'form' ? `${issue.path}: ${issue.message}` : issue.message;
  }
  return byKey;
};
