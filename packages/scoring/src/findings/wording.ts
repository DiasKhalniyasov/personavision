/**
 * The words a finding is made of.
 *
 * One formatter per rule writes that rule's claim and evidence, and every one of them is
 * built from the phrases here, so the same situation is always worded the same way instead
 * of drifting between runs (`docs/FLOW.md` section 6, #9's wording decision).
 *
 * **A claim is for a business reader**: the thing on the page, what their audience did
 * about it, and the consequence — and none of the product's own vocabulary. `JARGON` is
 * the list the claims are held to, and `test/findings.test.ts` asserts it over every claim
 * every rule generates rather than leaving it to review. An **evidence** sentence is
 * allowed a number and a unit, and may name a technical quantity where it has to.
 *
 * The level of numeric detail is the prototype's: seconds to one decimal, a first look in
 * whole milliseconds, a share as a whole percent, and a count always said as "k of n
 * people" so the population is never left off a figure.
 */

/**
 * The words a claim may not contain, from `docs/FLOW.md` section 6 and #106. The same six
 * `tests/seed-example-run.test.ts` holds the committed example run's claims to, so a claim
 * generated here and a claim authored there are refused for the same words.
 */
export const JARGON = ['fixation', 'fixated', 'dwell', 'saccade', 'aoi', 'area of interest'];

/** "1 person", "9 people" — a figure is never printed without the people behind it. */
export const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;

/** "9 of 10 people". */
export const outOf = (k: number, n: number): string =>
  `${k} of ${n} ${n === 1 ? 'person' : 'people'}`;

/** Seconds to one decimal, as the prototype prints them: "2.3 s". */
export const secondsSaid = (value: number): string => `${value.toFixed(1)} s`;

/** A first look is short enough to be said in whole milliseconds: "610 ms". */
export const millisecondsSaid = (value: number): string => `${Math.round(value)} ms`;

/** A share as a whole percent: "33%". */
export const percentSaid = (share: number): string => `${Math.round(share * 100)}%`;

/** "once", "4 times" — how often the gaze came back to something. */
export const timesSaid = (n: number): string => (n === 1 ? 'once' : `${n} times`);

/** An element is quoted by its own label, in the typographic quotes the prototype uses. */
export const quoted = (label: string): string => `“${label}”`;

/**
 * Which version a finding is about.
 *
 * The variant **id** and nothing else: `findings()` is given the sessions, the areas, the
 * aggregates and the scores, and not one of them carries a variant's display name — so a
 * sentence naming the version "the redesign", as the prototype's own prose does, would be
 * copy this function invented rather than a fact of the run (decision 16). The Attention
 * screen's isolate sentence names a version the same way, which is the phrasing the
 * Screen contract on #28 settles on for the never-looked-at claim.
 */
export const onVariant = (variant: string): string => `on variant ${variant}`;

/** "the review step" — a step is named by the id the sessions and the areas both carry. */
export const stepSaid = (step: string): string => `the ${step} step`;

/**
 * What a control that advances the task is called in a claim.
 *
 * The control on the **last** step that has one completes the task, and is "the button
 * that completes the order" — the wording `docs/FLOW.md` section 6 and the Screen contract
 * on #28 fix for it. Anywhere earlier it moves the journey on rather than finishing it,
 * and is named by the step it leaves, because two steps' controls would otherwise read as
 * the same thing.
 */
export const primaryActionSaid = (step: string, completesTheTask: boolean): string =>
  completesTheTask
    ? 'the button that completes the order'
    : `the button that moves on from ${stepSaid(step)}`;

/** "one person on each version", or "2 on variant B" — who an exclusion cost us. */
export const perVariantSaid = (counts: ReadonlyMap<string, number>): string => {
  const entries = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 1 && entries.every(([, n]) => n === 1)) return 'one person on each version';
  return entries.map(([variant, n]) => `${people(n)} on variant ${variant}`).join(', ');
};
