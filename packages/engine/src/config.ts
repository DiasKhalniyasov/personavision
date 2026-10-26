/**
 * The engine's one configuration object.
 *
 * Every weight, distribution parameter and prior the engine uses lives here. The
 * calibration step (#11) fits *this object* against UEyes and commits the result as data,
 * so a tunable number written inline in a sampler or a salience term is a defect rather
 * than a detail: it is a number calibration cannot reach.
 *
 * `defaultEngineConfig` holds the **uncalibrated** starting values — plausible, taken from
 * published ranges where one exists, and not claimed to be fitted. `resolveEngineConfig`
 * layers the calibrated values (when #11 has committed them) and then a run's
 * `engine.weights` over them, and reports whether what came back was calibrated.
 *
 * A run artifact can only carry `alpha`, `beta` and `gamma`: `runSchema.engine.weights` in
 * `packages/contract` is those three and zod strips the rest. The deeper layers of
 * `EngineConfigOverrides` are reachable from the calibrated file and from an in-process
 * caller — a test, the benchmark — and widening what a run may carry is a change to the
 * contract's schema, to be asked for on #7.
 *
 * Purity is a hard requirement of this step: nothing here reads a file or opens a socket.
 * The calibrated values arrive as a build-time import, never as a runtime read.
 */

/**
 * A trait's response curve: the value of a sampling parameter when the trait is 0 and when
 * it is 1, interpolated linearly in between. `atZero` above `atOne` is how an inverse
 * effect is written — see `packages/engine/src/persona.ts` for the direction of each row.
 */
export interface TraitResponse {
  readonly atZero: number;
  readonly atOne: number;
}

/**
 * The role prior per element role, used by the salience term. `other` is the fallback for
 * a role the table does not name and for an element with no role at all; the index
 * signature lets a later ticket name more roles as data rather than as code.
 */
export interface RolePriors {
  /** The fallback for a conventional control the table does not name. */
  readonly control: number;
  /** The fallback for everything else, and for an element with no role at all. */
  readonly other: number;
  readonly [role: string]: number;
}

/** How much a goal verb favours each class of element. Role classes are fixed in code. */
export interface GoalVerbRoleWeights {
  /** Buttons, links and form controls — things that advance a task. */
  readonly control: number;
  /** Text that reads like a value: a price, a total, a quantity. */
  readonly value: number;
  /** Headings, paragraphs and other prose. */
  readonly prose: number;
}

export interface EngineConfig {
  /** `P(area) ∝ exp(alpha·salience + beta·relevance + gamma·history)` — #7, user story 7. */
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;

  readonly salience: {
    /** The bottom-up terms, each weighted separately so each can be fitted separately. */
    readonly weights: {
      readonly luminanceContrast: number;
      readonly colourContrast: number;
      readonly relativeArea: number;
      readonly centreBias: number;
      readonly topBias: number;
      readonly rolePrior: number;
    };
    readonly rolePriors: RolePriors;
    /**
     * The ring of pixels an area's contrast is measured against — "local" is this
     * thickness and nothing else, so what counts as the surroundings of a button is a
     * number calibration can fit rather than one the salience module writes down.
     */
    readonly surround: {
      /** The ring's thickness as a share of the area's shorter side. */
      readonly ringShare: number;
      /** …and at least this many pixels, so a one-pixel rule still has a surround. */
      readonly minRingPx: number;
    };
  };

  readonly relevance: {
    /** A goal word found in the accessible name counts for more than one in the text. */
    readonly nameMatchWeight: number;
    readonly textMatchWeight: number;
    /** How much the goal verb's role weight contributes next to the lexical match. */
    readonly roleWeight: number;
    /** How far a model-supplied relevance hint pulls the offline value toward itself. */
    readonly hintWeight: number;
    /** An area that matches nothing scores this, never a negative that would dominate. */
    readonly floor: number;
    readonly goalVerbRoleWeights: {
      readonly complete: GoalVerbRoleWeights;
      readonly find: GoalVerbRoleWeights;
      readonly compare: GoalVerbRoleWeights;
      readonly other: GoalVerbRoleWeights;
    };
  };

  /** Log-normal, in the published 200–300 ms region before persona scaling. */
  readonly fixationDuration: {
    readonly medianMs: number;
    readonly logSigma: number;
    readonly minMs: number;
    readonly maxMs: number;
  };

  readonly saccade: {
    readonly amplitude: {
      readonly medianPx: number;
      readonly logSigma: number;
    };
    /** A longer jump takes longer: `baseMs + msPerPixel · amplitude`, clamped. */
    readonly duration: {
      readonly baseMs: number;
      readonly msPerPixel: number;
      readonly minMs: number;
      readonly maxMs: number;
    };
  };

  /** The gap between the end of one fixation and the start of the next. */
  readonly interFixation: {
    readonly gapMs: number;
    readonly gapSigmaMs: number;
    readonly minGapMs: number;
  };

  /** Where inside an area the gaze lands: centre-weighted, never the centre itself. */
  readonly landing: {
    /** Standard deviation as a share of the box's half-extent. */
    readonly spreadShare: number;
    /** A landing point stays at least this far inside the box, so a 1×1 box still works. */
    readonly minInsetPx: number;
  };

  readonly inhibitionOfReturn: {
    /** Subtracted from the history term of an area just fixated. */
    readonly penalty: number;
    /** The share of the penalty that survives each further fixation. */
    readonly decayPerFixation: number;
    /** How many consecutive fixations one area may hold before the penalty applies. */
    readonly immediateRepeatAllowance: number;
    /** A deliberate return needs at least this many fixations since the last one. */
    readonly deliberateReturnAfterFixations: number;
    /** …and a relevance at least this high, or it is an accident, not a return. */
    readonly deliberateReturnRelevance: number;
  };

  /** How many fixations a screen gets before the agent moves on, before persona scaling. */
  readonly fixationsPerScreen: {
    readonly mean: number;
    readonly logSigma: number;
    readonly min: number;
    readonly max: number;
  };

  /** The persona-trait table's numbers; the direction of each row is in `persona.ts`. */
  readonly persona: {
    readonly fixationDurationScale: TraitResponse;
    readonly fixationCountScale: TraitResponse;
    readonly dwellScale: TraitResponse;
    readonly rolePriorScale: TraitResponse;
    readonly screenPersistenceScale: TraitResponse;
    readonly verificationScale: TraitResponse;
  };
}

/** A partial configuration, to any depth: what a run's `engine.weights` is one of. */
export type EngineConfigOverrides = DeepPartial<EngineConfig>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends number | string | boolean ? T[K] : DeepPartial<T[K]>;
};

/** What `resolveEngineConfig` answers: the configuration, and whether it was fitted. */
export interface ResolvedEngineConfig {
  readonly config: EngineConfig;
  /**
   * `true` only when `config/calibrated.json` is in the build. Defaults never claim to be
   * calibrated, and an absent file means defaults rather than a fabricated number.
   */
  readonly calibrated: boolean;
}

export const defaultEngineConfig: EngineConfig = {
  alpha: 1,
  beta: 1,
  gamma: 1,

  salience: {
    weights: {
      luminanceContrast: 0.25,
      colourContrast: 0.2,
      relativeArea: 0.15,
      centreBias: 0.15,
      topBias: 0.1,
      rolePrior: 0.15,
    },
    rolePriors: {
      button: 1,
      link: 0.85,
      textbox: 0.7,
      searchbox: 0.7,
      combobox: 0.7,
      menuitem: 0.7,
      tab: 0.7,
      checkbox: 0.6,
      radio: 0.6,
      switch: 0.6,
      slider: 0.6,
      option: 0.55,
      heading: 0.55,
      img: 0.4,
      text: 0.3,
      control: 0.6,
      other: 0.25,
    },
    surround: { ringShare: 0.5, minRingPx: 8 },
  },

  relevance: {
    nameMatchWeight: 1,
    textMatchWeight: 0.5,
    roleWeight: 0.4,
    hintWeight: 0.5,
    floor: 0.05,
    goalVerbRoleWeights: {
      complete: { control: 1, value: 0.4, prose: 0.2 },
      find: { control: 0.4, value: 1, prose: 0.3 },
      compare: { control: 0.3, value: 1, prose: 0.3 },
      other: { control: 0.6, value: 0.6, prose: 0.4 },
    },
  },

  fixationDuration: { medianMs: 250, logSigma: 0.45, minMs: 80, maxMs: 1200 },

  saccade: {
    amplitude: { medianPx: 180, logSigma: 0.6 },
    duration: { baseMs: 20, msPerPixel: 0.025, minMs: 20, maxMs: 120 },
  },

  interFixation: { gapMs: 40, gapSigmaMs: 15, minGapMs: 10 },

  landing: { spreadShare: 0.25, minInsetPx: 1 },

  inhibitionOfReturn: {
    penalty: 1.5,
    decayPerFixation: 0.5,
    immediateRepeatAllowance: 1,
    deliberateReturnAfterFixations: 3,
    deliberateReturnRelevance: 0.6,
  },

  fixationsPerScreen: { mean: 9, logSigma: 0.35, min: 2, max: 40 },

  persona: {
    fixationDurationScale: { atZero: 1.25, atOne: 0.75 },
    fixationCountScale: { atZero: 0.8, atOne: 1.3 },
    dwellScale: { atZero: 0.75, atOne: 1.3 },
    rolePriorScale: { atZero: 0.8, atOne: 1.4 },
    screenPersistenceScale: { atZero: 0.7, atOne: 1.5 },
    verificationScale: { atZero: 1.4, atOne: 0.7 },
  },
};

/**
 * The calibrated-configuration seam.
 *
 * `packages/engine/config/calibrated.json` is the path the calibration step (#11) commits
 * its fitted values to. TypeScript cannot import a file that is not there, so the import
 * lands here in one place and #11 turns it on by replacing the two lines below with:
 *
 * ```ts
 * import calibratedJson from '../config/calibrated.json' with { type: 'json' };
 * const calibratedOverrides: EngineConfigOverrides | null = calibratedJson;
 * ```
 *
 * That is a build-time import: the engine still reads no file and opens no socket at run
 * time. Until #11 lands, this is `null`, the resolved configuration is the defaults, and
 * `calibrated` is `false` — never a fabricated number.
 */
const calibratedOverrides: EngineConfigOverrides | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A key that would write through a prototype rather than into the configuration. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Copies on the way down: neither argument is touched. */
const mergeRecords = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    const current = merged[key];
    merged[key] = isRecord(value) && isRecord(current) ? mergeRecords(current, value) : value;
  }
  return merged;
};

/**
 * Defaults, then the calibrated values, then this run's overrides — later layers win, key
 * by key, to any depth. Pure: the same overrides always produce a deeply equal result and
 * no input object is mutated, so a caller may hand in `run.engine.weights` directly.
 */
export const resolveEngineConfig = (overrides?: EngineConfigOverrides): ResolvedEngineConfig => {
  const layers = [calibratedOverrides, overrides].filter(
    (layer): layer is EngineConfigOverrides => layer !== null && layer !== undefined,
  );
  /**
   * The defaults are cloned first, so no sub-object of the answer is the module-level
   * default itself: `readonly` is a type, and one mutation through a cast or from a
   * JavaScript caller would otherwise change the defaults for every later call.
   */
  const config = layers.reduce(
    (merged, layer) => mergeRecords(merged, layer as Record<string, unknown>),
    structuredClone(defaultEngineConfig) as unknown as Record<string, unknown>,
  ) as unknown as EngineConfig;

  return { config, calibrated: calibratedOverrides !== null };
};
