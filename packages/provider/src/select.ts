import { MODEL_ID_BY_MODE } from './meta-pricing.js';
import type { ModelId, ModelMode } from './meta-pricing.js';
import { createOfflineDeterministicProvider } from './offline.js';
import type { DecisionProvider, ProviderMode } from './types.js';

/**
 * Which decision layer a run gets, and on which model tier, decided once and recorded.
 *
 * Three rules, and they are the reason this is a function rather than an `if` in the run
 * loop:
 *
 * - **Offline whenever no key is present.** A cold clone of this repository with no
 *   environment has a working decision layer, so the build, the tests and the demo are
 *   green with no key and no network.
 * - **A mode is never upgraded implicitly.** Offline does not quietly become model because
 *   a key happens to be in the environment of the machine that re-ran a test: a run that
 *   says `model` in `engine.mode` ran a model, and one that says `offline` did not.
 * - **A tier is never substituted, and `standard` is never downgraded.** A request naming
 *   one of the owner's two models resolves to that model or to nothing: asked for
 *   `standard`, this throws rather than hand back the contributor model Meta may train on,
 *   or the offline policy dressed as a test of a paying customer's own site (#143). A
 *   `contributor` request keeps the offline fall-back, because that is what keeps
 *   development, CI and the demo green with no key.
 *
 * The key is read from the environment at call time and handed to the model provider's
 * factory. It is never returned, never put in the selection's `reason`, and never logged
 * — the only place its value appears is the argument to the factory that needs it.
 */

/** The environment variable the model credential is read from (step #8). */
export const MODEL_API_KEY_ENV = 'MODEL_API_KEY';

/**
 * The tier a model request that names none decides on: the cheap one, because our own
 * development, tests, demos and example audiences are what asks without naming a tier, and
 * the content they send is ours to give (step #8). A customer's run names `standard`.
 */
export const DEFAULT_MODEL_MODE: ModelMode = 'contributor';

/** A request for the model layer on a named tier — the shape a run's `mode` setting takes. */
export interface ModelModeRequest {
  readonly mode: 'model';
  readonly modelMode: ModelMode;
}

/**
 * What a caller may ask for: `offline`, a named tier, or bare `'model'` — #33's shape, kept
 * for a caller that insists on a model but has no tier of its own to name, and which
 * therefore gets {@link DEFAULT_MODEL_MODE} while keeping bare `'model'`'s refusal to run
 * offline. A run that cares which model it is billed at names the tier.
 */
export type RequestedProviderMode = ProviderMode | ModelModeRequest;

export interface SelectDecisionProviderOptions {
  /**
   * The seed the selected provider's session-less `decide` works from. A run begins a
   * session per persona and seed on the provider this returns, and each of those decides
   * from the seed its handle was begun with (#138) — not from this one.
   */
  readonly seed: number;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The mode the caller asked for. Omitted — the default — means "model if this machine
   * can, offline otherwise", on {@link DEFAULT_MODEL_MODE}. `'offline'` stays offline even
   * where a key is present.
   */
  readonly requestedMode?: RequestedProviderMode;
  /**
   * How to build the model provider for a tier once a key is in hand (#43). Absent — as it
   * is wherever that provider is not wired up — means this process cannot run model mode at
   * all. It is told which tier to build, so that nothing can hand back a provider on the
   * other model and have this report the one that was asked for.
   */
  readonly createModelProvider?: (options: {
    readonly apiKey: string;
    readonly modelMode: ModelMode;
  }) => DecisionProvider;
}

export interface SelectedDecisionProvider {
  /** What `run.json`'s `engine.mode` records. */
  readonly mode: ProviderMode;
  readonly provider: DecisionProvider;
  /** Why this mode, in words a run log can print. Never contains the key. */
  readonly reason: string;
  /**
   * The tier that ran, as `run.json`'s `engine.modelMode` records it (#142) and the screens
   * name it (#18, #107). Absent offline, where no model ran and the contract records none.
   */
  readonly modelMode?: ModelMode;
  /** The model that ran, never one substituted for it. Absent offline, with `modelMode`. */
  readonly modelId?: ModelId;
}

/** Thrown when model mode was asked for and this process cannot honour it. */
export class ModelModeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelModeUnavailableError';
  }
}

const offline = (seed: number, reason: string): SelectedDecisionProvider => ({
  mode: 'offline',
  provider: createOfflineDeterministicProvider({ seed }),
  reason,
});

export const selectDecisionProvider = (
  options: SelectDecisionProviderOptions,
): SelectedDecisionProvider => {
  const env = options.env ?? process.env;
  const apiKey = env[MODEL_API_KEY_ENV]?.trim() ?? '';
  const requested = options.requestedMode;

  if (requested === 'offline') {
    return offline(options.seed, 'offline was asked for, and a mode is never upgraded implicitly');
  }

  const namedTier = typeof requested === 'object' ? requested.modelMode : undefined;
  const modelMode = namedTier ?? DEFAULT_MODEL_MODE;
  const modelId = MODEL_ID_BY_MODE[modelMode];
  /**
   * Whether a model is the only acceptable answer. `standard` is: its caller is a paying
   * customer's run, and a simulated result presented as theirs is worse than a refusal.
   * Bare `'model'` is, because #33 made it so. A `contributor` request is not.
   */
  const modelOrNothing = requested === 'model' || namedTier === 'standard';

  const unavailable = (missing: string): ModelModeUnavailableError =>
    new ModelModeUnavailableError(
      `${modelMode} model mode (${modelId}) was asked for, but ${missing}: a run on a model is refused rather than quietly downgraded`,
    );

  if (apiKey === '') {
    if (modelOrNothing) {
      throw unavailable(`${MODEL_API_KEY_ENV} is not in the environment`);
    }
    return offline(options.seed, `no ${MODEL_API_KEY_ENV} in the environment, so offline it is`);
  }

  if (options.createModelProvider === undefined) {
    if (modelOrNothing) {
      throw unavailable('no model provider was supplied to build it with');
    }
    return offline(
      options.seed,
      `${MODEL_API_KEY_ENV} is present, but this process has no model provider to run, so offline it is`,
    );
  }

  const provider = options.createModelProvider({ apiKey, modelMode });
  if (provider.mode !== 'model') {
    // A factory that answers a model request with the offline policy is the silent
    // downgrade this function exists to prevent, whichever tier asked.
    throw unavailable(`what was built for it runs in "${provider.mode}" mode`);
  }

  return {
    mode: 'model',
    provider,
    reason: `${modelMode} model mode was asked for, ${MODEL_API_KEY_ENV} is present, and ${modelId} was built`,
    modelMode,
    modelId,
  };
};
