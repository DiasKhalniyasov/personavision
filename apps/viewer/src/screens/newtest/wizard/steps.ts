/**
 * The steps of `/new`, and the one in the query.
 *
 * `docs/FLOW.md` section 13 makes `/new` one screen with a step in the query, and names the
 * parameters `audience|feature|goal|estimate`. `docs/design/prototype.html` draws a **Path**
 * screen and a single **Audience & feature** screen. Both readings are kept:
 *
 * - `path` is the default — no step, and a step the vocabulary does not know, mean the path
 *   chooser, which is what a first visit to `/new` is;
 * - `feature` is an **alias** of `audience`, because the audience and the feature are one
 *   screen in the prototype and the prototype is the screen contract;
 * - `variants` is the two-URL A/B form, which is now a step of this wizard and is offered by
 *   no screen (decision 78): a path-2 test starts it, and the committed demo run was started
 *   from it.
 *
 * Nothing else is a step. A request for anything else is canonicalised rather than rendered
 * as a not-found, because a wizard whose URL is mistyped has a first step to fall back to.
 */

/** The four steps the breadcrumb names, in the prototype's order. */
export const CRUMB_STEPS = ['path', 'audience', 'goal', 'estimate'] as const;

export type CrumbStep = (typeof CRUMB_STEPS)[number];

/** Every step `?step=` is allowed to name, the A/B form's included. */
export const WIZARD_STEPS = [...CRUMB_STEPS, 'variants'] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The step a request with no step, or one nobody knows, lands on. */
export const DEFAULT_STEP: WizardStep = 'path';

/** Section 13's own parameter names that are another step's second name. */
const ALIASES: Readonly<Record<string, WizardStep>> = { feature: 'audience' };

/** The step a `?step=` value means. Unknown values are the default, never a not-found. */
export const resolveStep = (raw: string | null): WizardStep => {
  if (raw === null) return DEFAULT_STEP;
  const known = (WIZARD_STEPS as readonly string[]).includes(raw);
  return known ? (raw as WizardStep) : (ALIASES[raw] ?? DEFAULT_STEP);
};

/** Whether the URL already names the step it resolves to, which is what canonical means. */
export const isCanonical = (raw: string | null, step: WizardStep): boolean => raw === step;

/**
 * The four steps of the prototype's `.breadcrumb`, in its order and its wording — `Path /
 * Audience & feature / Goal / Launch`. The last step is **Launch** because that is what the
 * estimate screen is called where a user reads it.
 *
 * Each step carries the column it is drawn in, so the width is a fact about the step rather
 * than a condition in the frame: `#screen-newtest-paths` lays its two path cards side by
 * side in `.wrap`, and the three form screens take `.wrap-narrow`.
 */
export const CRUMBS: readonly {
  readonly step: CrumbStep;
  readonly label: string;
  readonly wrap: 'wrap' | 'wrap-narrow';
}[] = [
  { step: 'path', label: 'Path', wrap: 'wrap' },
  { step: 'audience', label: 'Audience & feature', wrap: 'wrap-narrow' },
  { step: 'goal', label: 'Goal', wrap: 'wrap-narrow' },
  { step: 'estimate', label: 'Launch', wrap: 'wrap-narrow' },
];

/** One step's crumb: its label and its column. */
export const crumbOf = (step: CrumbStep): (typeof CRUMBS)[number] =>
  CRUMBS.find((crumb) => crumb.step === step) ?? CRUMBS[0];
