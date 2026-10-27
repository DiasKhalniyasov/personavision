import { ENGINE_VERSION, resolveEngineConfig } from '@personavision/engine';
import {
  createMetaModelApiProvider,
  MODEL_ID_BY_MODE,
  selectDecisionProvider,
} from '@personavision/provider';
import type { Run, RunRequest } from '@personavision/contract';
import type { DecisionProvider, ModelMode } from '@personavision/provider';

/**
 * Which decision layer this run gets, and what the artifact records about it.
 *
 * The rules are `packages/provider`'s (#143) and are not restated here: offline whenever no
 * key is present, a mode never upgraded implicitly, and `standard` refused rather than
 * served by the cheaper model or by the offline policy. What this module adds is the
 * **record** — `engine.mode`, `engine.modelMode`, the provider's name, the model ids it
 * called and the weights the attention engine sampled with — so that a cost figure can be
 * checked against the price table that produced it and a customer can see which model their
 * content went to.
 *
 * The key is read from the environment by the selection and handed to the model provider's
 * factory. It is never returned, never put in a reason and never printed: the only place its
 * value appears is the argument to the factory that needs it.
 */

/** What the artifact names for a model nobody asked to do that job. */
const NO_MODEL = 'none';

export interface SelectedEngine {
  /** The decision layer the swarm runs through. */
  readonly provider: DecisionProvider;
  /** `run.json`'s whole engine block, as it actually ran. */
  readonly engine: Run['engine'];
  /** Why this mode, in words a run log can print. Never contains the key. */
  readonly reason: string;
  /** The tier that ran, and absent where no model did. */
  readonly modelMode?: ModelMode;
}

/**
 * The weights the run sampled with, and which engine sampled with them.
 *
 * `engine.weights` carries the three softmax weights a run artifact may hold, read off the
 * engine's own resolved configuration — the defaults, with `config/calibrated.json` over
 * them — rather than restated here, so a run records what it actually sampled with.
 *
 * `version` names the engine: `ENGINE_VERSION`, the engine package's own, which is the
 * string every row of the committed calibration report carries, so a run can be matched
 * against the row whose figures it quotes (#89, #92). It does **not** say whether that
 * configuration was fitted — `run.calibration` says that by being a block or by being
 * `null`, and nothing in this artifact is stated twice.
 */
const engineConfiguration = (): Pick<Run['engine'], 'weights' | 'version'> => {
  const { config } = resolveEngineConfig();
  return {
    weights: { alpha: config.alpha, beta: config.beta, gamma: config.gamma },
    version: ENGINE_VERSION,
  };
};

/**
 * The engine block a run that asked for a model records **before** it is known whether the
 * model can be served: the mode and the model that were asked for.
 *
 * It is what a run refused for want of that model carries, so that the Test failed screen
 * names the model that could not be used and states that nothing stood in for it (#144).
 */
export const requestedEngine = (request: RunRequest): Run['engine'] => {
  if (request.engineMode !== 'model' || request.modelMode === undefined) {
    return {
      mode: 'offline',
      provider: null,
      models: null,
      ...engineConfiguration(),
    };
  }
  return {
    mode: 'model',
    modelMode: request.modelMode,
    provider: null,
    models: {
      decision: MODEL_ID_BY_MODE[request.modelMode],
      segmentation: NO_MODEL,
      planning: NO_MODEL,
    },
    ...engineConfiguration(),
  };
};

/** How a model provider is built once a key is in hand: the Meta Model API's (#43). */
export type CreateModelProvider = (options: {
  readonly apiKey: string;
  readonly modelMode: ModelMode;
}) => DecisionProvider;

const metaModelApi: CreateModelProvider = ({ apiKey, modelMode }) =>
  createMetaModelApiProvider({ mode: modelMode, apiKey });

export interface SelectEngineOptions {
  readonly request: RunRequest;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Defaults to the Meta Model API provider. A test passes one of its own, because the
   * alternative is a suite that only covers a model run on a machine with a key and a
   * network — and what has to be covered is the **record**: that a model run names its
   * model and its mode and is costed at that mode's prices.
   */
  readonly createModelProvider?: CreateModelProvider;
}

/**
 * The decision layer and its record, or `ModelModeUnavailableError` for a run that asked for
 * a model this process cannot serve.
 *
 * The request is passed through as the caller stated it — the engine mode and, when it is a
 * model run, the tier — so the selection applies its own rules to it. Nothing here resolves
 * a missing tier or substitutes one.
 */
export const selectEngine = ({
  request,
  env,
  createModelProvider = metaModelApi,
}: SelectEngineOptions): SelectedEngine => {
  const selected = selectDecisionProvider({
    seed: request.seed,
    ...(env === undefined ? {} : { env }),
    requestedMode: {
      mode: request.engineMode,
      ...(request.modelMode === undefined ? {} : { modelMode: request.modelMode }),
    },
    createModelProvider,
  });

  const model = selected.mode === 'model' && selected.modelId !== undefined;
  return {
    provider: selected.provider,
    reason: selected.reason,
    ...(selected.modelMode === undefined ? {} : { modelMode: selected.modelMode }),
    engine: {
      mode: selected.mode,
      // Recorded only where a model actually ran: the contract refuses an offline run that
      // names a model mode, because such a run sent nothing anywhere and paid for nothing.
      ...(model && selected.modelMode !== undefined ? { modelMode: selected.modelMode } : {}),
      provider: selected.provider.name,
      models: model
        ? {
            decision: selected.modelId as string,
            // The areas of interest are the engine's own, built from the page's elements,
            // and nothing plans a run: neither job is a model's today.
            segmentation: NO_MODEL,
            planning: NO_MODEL,
          }
        : null,
      ...engineConfiguration(),
    },
  };
};
