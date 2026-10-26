import { createOfflineDeterministicProvider } from './offline.js';
import type { DecisionProvider, ProviderMode } from './types.js';

/**
 * Which decision layer a run gets, decided once and recorded.
 *
 * Two rules, and they are the reason this is a function rather than an `if` in the run
 * loop:
 *
 * - **Offline whenever no key is present.** A cold clone of this repository with no
 *   environment has a working decision layer, so the build, the tests and the demo are
 *   green with no key and no network.
 * - **A mode is never upgraded implicitly.** Offline does not quietly become model because
 *   a key happens to be in the environment of the machine that re-ran a test, and asking
 *   for model mode without a key is an error rather than a silent fall back to offline: a
 *   run that says `model` in `engine.mode` ran a model, and one that says `offline` did
 *   not.
 *
 * The key is read from the environment at call time and handed to the model provider's
 * factory. It is never returned, never put in the selection's `reason`, and never logged
 * — the only place its value appears is the argument to the factory that needs it.
 */

/** The environment variable the model credential is read from (step #8). */
export const MODEL_API_KEY_ENV = 'MODEL_API_KEY';

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
   * can, offline otherwise". `'offline'` stays offline even where a key is present.
   */
  readonly requestedMode?: ProviderMode;
  /**
   * How to build the model provider once a key is in hand (#43). Absent — as it is until
   * that provider exists — means this process cannot run model mode at all.
   */
  readonly createModelProvider?: (options: { readonly apiKey: string }) => DecisionProvider;
}

export interface SelectedDecisionProvider {
  /** What `run.json`'s `engine.mode` records. */
  readonly mode: ProviderMode;
  readonly provider: DecisionProvider;
  /** Why this mode, in words a run log can print. Never contains the key. */
  readonly reason: string;
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

  if (requested === 'model') {
    if (apiKey === '') {
      throw new ModelModeUnavailableError(
        `model mode was asked for, but ${MODEL_API_KEY_ENV} is not in the environment: set it, or ask for offline mode — a run is never quietly downgraded`,
      );
    }
    if (options.createModelProvider === undefined) {
      throw new ModelModeUnavailableError(
        'model mode was asked for, but no model provider was supplied to build it with',
      );
    }
    return {
      mode: 'model',
      provider: options.createModelProvider({ apiKey }),
      reason: `model mode was asked for and ${MODEL_API_KEY_ENV} is present`,
    };
  }

  if (apiKey === '') {
    return offline(options.seed, `no ${MODEL_API_KEY_ENV} in the environment, so offline it is`);
  }
  if (options.createModelProvider === undefined) {
    return offline(
      options.seed,
      `${MODEL_API_KEY_ENV} is present, but this process has no model provider to run, so offline it is`,
    );
  }
  return {
    mode: 'model',
    provider: options.createModelProvider({ apiKey }),
    reason: `${MODEL_API_KEY_ENV} is present and a model provider was supplied`,
  };
};
