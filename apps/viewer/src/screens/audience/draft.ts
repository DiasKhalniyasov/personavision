import type { Audience } from '@personavision/contract';
import type { AudienceIssue } from './store';

/**
 * What the audience form holds while it is being typed, and the audience it becomes.
 *
 * A form is text and toggles; an audience is the contract's object. This module is the one
 * place the two are converted, so neither the screen nor a test has to know that an age is
 * typed as a string or that a device share is typed in whole percentage points.
 *
 * The checks here are the **form's own**, and they exist so that the two invariants a
 * reader can see — the age range runs forwards, and the device shares add up — are stated
 * against the field they concern rather than silently repaired. Nothing is normalised: an
 * audience whose shares come to 95% is refused and the form says so, because quietly
 * rewriting what somebody typed makes the mix they thought they described a guess
 * (`docs/FLOW.md` section 1 — the shares are what the device mix of a test is drawn from).
 * The server validates the same audience again through `@personavision/personas`, and its
 * messages land on the same paths, so a refusal from either side renders the same way.
 */

/** A device class an audience can be a mix of: the three the prototype's chips offer. */
export interface DeviceClass {
  /** The audience's own word for it, which is what a run artifact carries. */
  readonly name: string;
  /** What the chip reads. */
  readonly label: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly touch: boolean;
}

/**
 * The classes the form offers, with the geometry `#screen-audience` prints beside each —
 * mobile 390 × 844, desktop 1280 × 800 — and the tablet the design contract names without
 * drawing. These are the *class* viewports an audience declares; the concrete device a
 * generated person runs on is the generator's business and may differ (decision 3 on
 * #105/#106), which is why nothing here is read back from a persona.
 */
export const DEVICE_CLASSES: readonly DeviceClass[] = [
  {
    name: 'mobile',
    label: 'Mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    touch: true,
  },
  {
    name: 'desktop',
    label: 'Desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    touch: false,
  },
  {
    name: 'tablet',
    label: 'Tablet',
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    touch: true,
  },
];

/** How many people an audience generates. People, never sessions (decision 1 on #105). */
export const SIZE_CHOICES: readonly number[] = [2, 4, 8];

/** The roles, goals and regions the prototype's chips offer before anything is typed. */
export const ROLE_SUGGESTIONS: readonly string[] = [
  'First-time buyer',
  'Returning customer',
  'Gift buyer',
  'Trade buyer',
];

export const GOAL_SUGGESTIONS: readonly string[] = [
  'Buy one item quickly',
  'Compare prices first',
  'Check delivery before buying',
  'Browse without buying',
];

export const REGION_SUGGESTIONS: readonly string[] = ['United Kingdom', 'Ireland'];

/** One chip group: what is on offer, and what of it is pressed. */
export interface ChipChoice {
  /** The suggestions, plus anything the user has added, in the order they are drawn. */
  readonly offered: readonly string[];
  readonly chosen: readonly string[];
}

export interface DraftDevice extends DeviceClass {
  readonly chosen: boolean;
  /** Whole percentage points, as typed. A share of the audience, not of a test. */
  readonly percent: string;
}

export interface AudienceDraft {
  /**
   * The audience's own id, which a run artifact carries and every generated person names.
   * `null` on a new audience, where it is derived from the name on save; an audience that
   * already exists keeps the id it was stored under, so renaming it does not orphan the
   * people of a test that ran for it.
   */
  readonly audienceId: string | null;
  readonly name: string;
  readonly ageMin: string;
  readonly ageMax: string;
  readonly size: number;
  readonly roles: ChipChoice;
  readonly goals: ChipChoice;
  readonly regions: ChipChoice;
  readonly devices: readonly DraftDevice[];
  readonly techSavviness: number;
  readonly priceSensitivity: number;
  /** Same audience, same seed, same people — so it is shown and never silently changed. */
  readonly seed: number;
}

/**
 * The generator a new audience is described for.
 *
 * `@personavision/personas` declares it as `GENERATOR_VERSION`, and that package is not in
 * the browser bundle — the people are generated on the server and read from there, never
 * here. `tests/audience/draft.test.ts` asserts this string against the committed example
 * run's own audience, so a generator the project bumps fails there rather than in a user's
 * first save.
 */
export const GENERATOR_VERSION = 'persona-gen-1';

const chipChoice = (suggestions: readonly string[], chosen: readonly string[]): ChipChoice => ({
  offered: [...suggestions, ...chosen.filter((value) => !suggestions.includes(value))],
  chosen,
});

/** The seed a new audience is given: the day it was described, as the demo preset's is. */
export const seedForDay = (day: Date): number =>
  day.getFullYear() * 10_000 + (day.getMonth() + 1) * 100 + day.getDate();

/** A fresh form: nothing chosen, and the one device mix the prototype's chips start on. */
export const emptyDraft = (day: Date): AudienceDraft => ({
  audienceId: null,
  name: '',
  ageMin: '',
  ageMax: '',
  size: 4,
  roles: chipChoice(ROLE_SUGGESTIONS, []),
  goals: chipChoice(GOAL_SUGGESTIONS, []),
  regions: chipChoice(REGION_SUGGESTIONS, []),
  devices: DEVICE_CLASSES.map((device) => ({
    ...device,
    chosen: device.name !== 'tablet',
    percent: device.name === 'mobile' ? '60' : device.name === 'desktop' ? '40' : '0',
  })),
  techSavviness: 0.5,
  priceSensitivity: 0.5,
  seed: seedForDay(day),
});

/** The form, filled in from an audience that already exists. */
export const draftOf = (audience: Audience): AudienceDraft => ({
  audienceId: audience.id,
  name: audience.name,
  ageMin: String(audience.ageRange.min),
  ageMax: String(audience.ageRange.max),
  size: audience.size,
  roles: chipChoice(ROLE_SUGGESTIONS, audience.roles),
  goals: chipChoice(GOAL_SUGGESTIONS, audience.goals),
  regions: chipChoice(REGION_SUGGESTIONS, audience.regions),
  // A device the audience declares that the form does not offer keeps its own geometry, so
  // an audience written elsewhere is edited rather than quietly converted to a known class.
  devices: [
    ...DEVICE_CLASSES.map((offered) => {
      const declared = audience.devices.find((device) => device.name === offered.name);
      return {
        ...offered,
        ...(declared === undefined ? {} : { ...declared, label: offered.label }),
        chosen: declared !== undefined,
        percent: declared === undefined ? '0' : String(Math.round(declared.share * 100)),
      };
    }),
    ...audience.devices
      .filter((device) => !DEVICE_CLASSES.some((offered) => offered.name === device.name))
      .map((device) => ({
        ...device,
        label: device.name,
        chosen: true,
        percent: String(Math.round(device.share * 100)),
      })),
  ],
  techSavviness: audience.techSavviness,
  priceSensitivity: audience.priceSensitivity,
  seed: audience.generatedFrom.seed,
});

/** `Outdoor-gear shoppers` → `outdoor-gear-shoppers`: the id a new audience is saved under. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const WHOLE_NUMBER = /^\d+$/;

const age = (typed: string): number | null =>
  WHOLE_NUMBER.test(typed.trim()) ? Number(typed.trim()) : null;

/** Whole percentage points, which is what the share field takes. */
const percent = (typed: string): number | null =>
  WHOLE_NUMBER.test(typed.trim()) ? Number(typed.trim()) : null;

export type DraftResult =
  | { readonly ok: true; readonly audience: Audience }
  | { readonly ok: false; readonly issues: readonly AudienceIssue[] };

/** The shares of the devices in the mix, in whole points, as the form has them. */
export const chosenPercentTotal = (draft: AudienceDraft): number =>
  draft.devices
    .filter((device) => device.chosen)
    .reduce((total, device) => total + (percent(device.percent) ?? 0), 0);

/**
 * The audience this form describes, or every reason it describes none, each at the path of
 * the field it is wrong at — the same paths the server's refusal carries.
 */
export const audienceOf = (draft: AudienceDraft): DraftResult => {
  const issues: AudienceIssue[] = [];
  const name = draft.name.trim();
  const id = draft.audienceId ?? slugOf(name);

  if (name === '') {
    issues.push({ path: 'name', message: 'give this group of customers a name' });
  } else if (id === '') {
    issues.push({
      path: 'name',
      message: 'a name needs a letter or a number in it: it becomes the id a test records',
    });
  }

  const min = age(draft.ageMin);
  const max = age(draft.ageMax);
  if (min === null) issues.push({ path: 'ageRange.min', message: 'give an age to start from' });
  if (max === null) issues.push({ path: 'ageRange.max', message: 'give an age to run to' });
  if (min !== null && max !== null && min > max) {
    issues.push({
      path: 'ageRange',
      message: `an age range runs from min to max: found ${String(min)}–${String(max)}`,
    });
  }

  const chosen = draft.devices.filter((device) => device.chosen);
  if (chosen.length === 0) {
    issues.push({ path: 'devices', message: 'choose at least one device your customers are on' });
  } else if (chosen.some((device) => percent(device.percent) === null)) {
    issues.push({
      path: 'devices',
      message: 'a device share is a whole number of percentage points',
    });
  } else {
    const total = chosenPercentTotal(draft);
    if (total !== 100) {
      issues.push({
        path: 'devices',
        message: `the device shares are a mix of one audience: they must add up to 100%, and these add up to ${String(total)}%`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    audience: {
      id,
      name,
      ageRange: { min: min as number, max: max as number },
      roles: [...draft.roles.chosen],
      regions: [...draft.regions.chosen],
      goals: [...draft.goals.chosen],
      devices: chosen.map((device) => ({
        name: device.name,
        viewport: device.viewport,
        deviceScaleFactor: device.deviceScaleFactor,
        touch: device.touch,
        share: (percent(device.percent) as number) / 100,
      })),
      techSavviness: draft.techSavviness,
      priceSensitivity: draft.priceSensitivity,
      size: draft.size,
      generatedFrom: { seed: draft.seed, generatorVersion: GENERATOR_VERSION },
    },
  };
};

/** The chip group with one value pressed or released. */
export const withChip = (choice: ChipChoice, value: string, pressed: boolean): ChipChoice => ({
  offered: choice.offered.includes(value) ? choice.offered : [...choice.offered, value],
  chosen: pressed
    ? choice.chosen.includes(value)
      ? choice.chosen
      : [...choice.chosen, value]
    : choice.chosen.filter((chosen) => chosen !== value),
});
