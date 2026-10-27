import { MODEL_ID_BY_MODE } from './meta-pricing.js';
import type { ModelId, ModelMode } from './meta-pricing.js';
import { createOfflineDeterministicProvider } from './offline.js';
import type { DecisionProvider, ProviderMode } from './types.js';

/**
 * Which decision layer a run gets, and on which model, decided once and recorded.
 *
 * Four rules, and they are the reason this is a function rather than an `if` in the run
 * loop:
 *
 * - **Offline whenever no key is present.** A cold clone of this repository with no
 *   environment has a working decision layer, so the build, the tests and the demo are
 *   green with no key and no network.
 * - **A mode is never upgraded implicitly.** Offline does not quietly become model because
 *   a key happens to be in the environment of the machine that re-ran a test: a run that
 *   says `model` in `engine.mode` ran a model, and one that says `offline` did not.
 * - **A model request names its model.** Asking for model mode without naming a tier is
 *   refused, not resolved to the cheap one — the same rule the run request carries
 *   (`runRequestSchema`, #142), because a caller that forgot to say `standard` is a paying
 *   customer whose content would reach the model Meta may train on.
 * - **A tier is never substituted, and `standard` is never downgraded.** A named tier
 *   resolves to that tier's model or to nothing: asked for `standard`, this throws rather
 *   than hand back the contributor model, or the offline policy dressed as a test of a
 *   customer's own site (#143). A `contributor` request keeps the offline fall-back,
 *   because that is what keeps development, CI and the demo green with no key.
 *
 * The key is read from the environment at call time and handed to the model provider's
 * factory. It is never returned, never put in the selection's `reason`, and never logged
 * — the only place its value appears is the argument to the factory that needs it.
 */

/** The environment variable the model credential is read from (step #8). */
export const MODEL_API_KEY_ENV = 'MODEL_API_KEY';

/**
 * The tier this picks when the caller expressed no preference at all — no `requestedMode`,
 * the "model if this machine can, offline otherwise" default #33 shipped, which is what our
 * own development, tests, demos and example audiences run through and whose content is ours
 * to give (step #8). A caller that *asks* for model mode names its tier instead; it is only
 * the absence of a request that lands here, and a run that named nothing was never a
 * customer's.
 */
export const DEFAULT_MODEL_MODE: ModelMode = 'contributor';

const MODEL_MODES = Object.keys(MODEL_ID_BY_MODE) as readonly ModelMode[];

/**
 * A mode request in the shape a run carries it: the engine mode, and the model for a run
 * that is to call one. `{ mode: 'offline' }` may carry a `modelMode` and simply not spend
 * it, exactly as `runRequestSchema` permits, so a parsed run request maps straight onto
 * this with no branch at the call site.
 */
export interface ProviderModeRequest {
  readonly mode: ProviderMode;
  readonly modelMode?: ModelMode;
}

/**
 * What a caller may ask for: `'offline'`, a request object, or the bare `'model'` string
 * #33 published — which is now a refusal, because it names no model.
 */
export type RequestedProviderMode = ProviderMode | ProviderModeRequest;

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
   * all.
   *
   * It is told which tier to build rather than closing over one, and what it returns is
   * checked against that tier: a provider naming another model id is a substitution and is
   * refused, so a factory cannot build the cheap model while a run records the expensive
   * one, or the other way about.
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

/**
 * The request as an object, or `undefined` for "no preference" — which a `null` from an
 * untyped caller means too, rather than a `TypeError` three lines further down.
 */
const asRequest = (
  requested: RequestedProviderMode | undefined,
): ProviderModeRequest | undefined => {
  if (requested === undefined || requested === null) {
    return undefined;
  }
  return typeof requested === 'string' ? { mode: requested } : requested;
};

export const selectDecisionProvider = (
  options: SelectDecisionProviderOptions,
): SelectedDecisionProvider => {
  const env = options.env ?? process.env;
  const apiKey = env[MODEL_API_KEY_ENV]?.trim() ?? '';
  const request = asRequest(options.requestedMode);

  if (request?.mode === 'offline') {
    return offline(options.seed, 'offline was asked for, and a mode is never upgraded implicitly');
  }

  const namedTier = request?.modelMode;
  if (
    request !== undefined &&
    (namedTier === undefined || MODEL_ID_BY_MODE[namedTier] === undefined)
  ) {
    throw new ModelModeUnavailableError(
      `model mode was asked for, but ${
        namedTier === undefined
          ? 'it named no model'
          : `"${String(namedTier)}" is not a model this provider runs`
      }: name ${MODEL_MODES.join(' or ')} — a request that names none is refused rather than resolved to the cheap one, because a run is never quietly downgraded`,
    );
  }

  const modelMode = namedTier ?? DEFAULT_MODEL_MODE;
  const modelId = MODEL_ID_BY_MODE[modelMode];
  /**
   * Whether a model is the only acceptable answer. `standard` is: its caller is a paying
   * customer's run, and a simulated result presented as theirs is worse than a refusal.
   * `contributor` is not, and neither is the absence of a request.
   */
  const modelOrNothing = namedTier === 'standard';
  /** What a fall-back's reason opens with, so an offline run says which model it wanted. */
  const asked =
    namedTier === undefined ? '' : `${modelMode} model mode (${modelId}) was asked for; `;

  const unavailable = (missing: string): ModelModeUnavailableError =>
    new ModelModeUnavailableError(
      `${modelMode} model mode (${modelId}) was asked for, but ${missing}: a run on a model is refused rather than quietly downgraded`,
    );

  if (apiKey === '') {
    if (modelOrNothing) {
      throw unavailable(`${MODEL_API_KEY_ENV} is not in the environment`);
    }
    return offline(
      options.seed,
      `${asked}no ${MODEL_API_KEY_ENV} in the environment, so offline it is`,
    );
  }

  if (options.createModelProvider === undefined) {
    if (modelOrNothing) {
      throw unavailable('no model provider was supplied to build it with');
    }
    return offline(
      options.seed,
      `${asked}${MODEL_API_KEY_ENV} is present, but this process has no model provider to run, so offline it is`,
    );
  }

  const provider = options.createModelProvider({ apiKey, modelMode });

  // A provider that names another model is the substitution this function exists to
  // prevent, whichever tier asked: contributor billed at standard overstates a run
  // twelvefold, and standard served by contributor sends a customer's content to the model
  // Meta may train on. A provider that names no model at all is taken at its word.
  if (provider.modelId !== undefined && provider.modelId !== modelId) {
    throw unavailable(`what was built for it runs ${provider.modelId}`);
  }

  if (provider.mode !== 'model') {
    if (modelOrNothing) {
      throw unavailable(`what was built for it runs in "${provider.mode}" mode`);
    }
    // A factory answering "I cannot run a model here" with the offline policy: a
    // contributor run may have that, and the reason says it happened.
    return {
      mode: provider.mode,
      provider,
      reason: `${asked}what was built for it runs in "${provider.mode}" mode, so ${provider.mode} it is`,
    };
  }

  return {
    mode: 'model',
    provider,
    reason: `${modelMode} model mode was asked for, ${MODEL_API_KEY_ENV} is present, and ${modelId} was built`,
    modelMode,
    modelId,
  };
};
