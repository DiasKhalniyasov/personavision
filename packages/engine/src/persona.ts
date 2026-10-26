import type { Run } from '@personavision/contract';
import type { EngineConfig, TraitResponse } from './config.js';
import { defaultEngineConfig } from './config.js';

/**
 * The persona-trait table: the one mapping from a persona's six traits to the engine's
 * sampling parameters.
 *
 * This table is the persona contract the swarm step (#8) writes personas against, and it
 * lives only here: `packages/personas` keeps the traits as 0..1 data and precomputes
 * nothing. Each row below states the **direction** of its effect, and one test per row
 * holds that direction (`packages/engine/tests/persona.test.ts`). The numbers are in the
 * configuration object under `persona`, so the calibration step (#11) can fit them without
 * touching this file; `atZero` above `atOne` is how an inverse row is written.
 *
 * | Trait                  | Parameter                | Direction as the trait rises                            |
 * | ---------------------- | ------------------------ | ------------------------------------------------------- |
 * | `scanningVsReading`    | `fixationDurationScale`  | **falls** — a scanner's fixations are shorter            |
 * | `scanningVsReading`    | `fixationCountScale`     | **rises** — a scanner makes more fixations per screen    |
 * | `detailOrientation`    | `dwellScale`             | **rises** — detail work dwells longer in an area         |
 * | `patience`             | `dwellScale`             | **rises** — a patient agent dwells longer in an area     |
 * | `interfaceFamiliarity` | `rolePriorScale`         | **rises** — familiar eyes go to conventional controls    |
 * | `persistence`          | `screenPersistenceScale` | **rises** — a persistent agent stays on a screen longer  |
 * | `riskTolerance`        | `verificationScale`      | **falls** — a risk-taker re-checks less before acting    |
 *
 * `dwellScale` reads the mean of `detailOrientation` and `patience`, so raising either one
 * on its own raises it.
 */

/** The six traits, as `run.json` records them — 0..1 each, nothing precomputed. */
export type PersonaTraits = Run['personas'][number]['traits'];

/** What the samplers read instead of reading traits themselves. Every value is positive. */
export interface PersonaSamplingParams {
  /** Multiplies the median fixation duration. */
  readonly fixationDurationScale: number;
  /** Multiplies the number of fixations a screen gets. */
  readonly fixationCountScale: number;
  /** Multiplies how long the gaze stays within one area of interest. */
  readonly dwellScale: number;
  /** Multiplies the role prior of a conventional control (`rolePriorFor`). */
  readonly rolePriorScale: number;
  /** Multiplies how long the agent keeps looking at one screen before moving on. */
  readonly screenPersistenceScale: number;
  /** Multiplies how much re-checking the agent does before it acts. */
  readonly verificationScale: number;
}

/**
 * The roles a familiar user goes to without reading: buttons, links and form controls.
 *
 * Which roles are conventional controls is structure rather than a tunable number, so it
 * is code and not configuration; how strongly familiarity favours them is
 * `config.persona.rolePriorScale`.
 */
export const CONVENTIONAL_CONTROL_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'menuitem',
  'option',
  'tab',
]);

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Linear between the response's two ends, so the row is monotonic by construction. */
const respond = (response: TraitResponse, trait: number): number =>
  response.atZero + (response.atOne - response.atZero) * clampUnit(trait);

/** Pure: traits and configuration in, sampling parameters out. */
export const personaSamplingParams = (
  traits: PersonaTraits,
  config: EngineConfig = defaultEngineConfig,
): PersonaSamplingParams => {
  const rows = config.persona;
  return {
    fixationDurationScale: respond(rows.fixationDurationScale, traits.scanningVsReading),
    fixationCountScale: respond(rows.fixationCountScale, traits.scanningVsReading),
    dwellScale: respond(rows.dwellScale, (traits.detailOrientation + traits.patience) / 2),
    rolePriorScale: respond(rows.rolePriorScale, traits.interfaceFamiliarity),
    screenPersistenceScale: respond(rows.screenPersistenceScale, traits.persistence),
    verificationScale: respond(rows.verificationScale, traits.riskTolerance),
  };
};

/**
 * The median fixation duration for this persona, in milliseconds, clamped to the
 * configured bounds — so no trait combination can ask for a duration of zero or less.
 *
 * `fixationDurationScale` only: `dwellScale` is how long the gaze stays *in an area*, and
 * the sampler (#67) applies it where dwell accumulates. Multiplying it in here too would
 * count `detailOrientation` and `patience` twice and could cancel the documented row that
 * a scanner's fixations are shorter.
 */
export const fixationDurationMedianMsFor = (
  traits: PersonaTraits,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { fixationDurationScale } = personaSamplingParams(traits, config);
  const { medianMs, minMs, maxMs } = config.fixationDuration;
  return clamp(medianMs * fixationDurationScale, minMs, maxMs);
};

/**
 * How many fixations this persona's screen gets, clamped to the configured bounds — so no
 * trait combination can ask for a screen with no fixations on it at all.
 *
 * `fixationCountScale` only: `screenPersistenceScale` is how long the agent keeps looking
 * at one screen *before moving on*, which the run loop spends on the decision to leave,
 * not on the count drawn here.
 */
export const fixationCountFor = (
  traits: PersonaTraits,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const { fixationCountScale } = personaSamplingParams(traits, config);
  const { mean, min, max } = config.fixationsPerScreen;
  return Math.round(clamp(mean * fixationCountScale, min, max));
};

/**
 * The role prior for one element, with the persona's familiarity applied.
 *
 * A relative weight, not a 0..1 share: the salience module (#65) normalises it together
 * with the other terms. A role the table does not name, and an element with no role, get
 * the table's `other` value; only a conventional control is scaled by familiarity, so a
 * paragraph's prior is the same for every persona.
 */
export const rolePriorFor = (
  role: string | null,
  traits: PersonaTraits,
  config: EngineConfig = defaultEngineConfig,
): number => {
  const priors = config.salience.rolePriors;
  const isControl = role !== null && CONVENTIONAL_CONTROL_ROLES.has(role);
  /**
   * `Object.hasOwn`, because a role is whatever a page's markup says: a `role="toString"`
   * would otherwise resolve to `Object.prototype.toString` and put a `NaN` into the
   * salience sum. A control role the table does not name falls back to `control`, not to
   * `other` — the table's lowest value — so a search box never scores below a paragraph.
   */
  const named = role !== null && Object.hasOwn(priors, role) ? priors[role] : undefined;
  const prior = named ?? (isControl ? priors.control : priors.other);
  if (!isControl) return prior;
  return prior * personaSamplingParams(traits, config).rolePriorScale;
};
