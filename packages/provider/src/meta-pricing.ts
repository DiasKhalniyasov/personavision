/**
 * The two models the owner's Meta Model API account runs, and what a call to each costs.
 *
 * This file is the **only** place in the package where a rate appears. A price that moves
 * is a one-line change here and a one-line change in `docs/meta-model-api.md` (#133),
 * rather than a hunt through a request builder, a usage mapper and a run summary — and a
 * call is costed at the rates of the model that was actually called, because a contributor
 * call priced as standard overstates it twelvefold.
 *
 * The rates are the published per-1M-token prices from the dev.meta.ai pricing page as the
 * owner read it on `PRICES_READ_ON`. Reasoning tokens are billed output, so they are inside
 * `outputTokens` and are not a row of their own: `muse-spark-1.3` spent 172 of 182 output
 * tokens on reasoning for a one-word reply, and a run that counted only the visible reply
 * would understate its bill by an order of magnitude.
 *
 * Three models have rows: the two Muse Spark tiers a session decides in, and Muse Wonder,
 * the one-shot model behind the audience, the goal, the analysis and the change (#248).
 * Wonder is billed by the same three figures and costed by the same `estimateCostUsd`, so a
 * Wonder call lands in a run's usage block beside a decision and nothing adds a second
 * arithmetic for it.
 *
 * One published rate is deliberately **not** a row: web search grounding, $2.50 per 1,000
 * queries on top of a request's tokens, for the `web_search` tool on either model. Nothing
 * in this project sends that tool, and a rate nothing multiplies is a figure that goes
 * stale unnoticed. The ticket that first sends `web_search` adds it here, where it belongs.
 */

/**
 * Which tier a run decides in. It arrives with the run (#143) and this package never picks
 * one: a customer's run is never quietly answered by the model Meta may train on, and a
 * development run is never billed at twelve times what it should be.
 */
export type ModelMode = 'contributor' | 'standard';

/** The model id each mode calls. Asked for standard, nothing here answers with contributor. */
export const MODEL_ID_BY_MODE = {
  contributor: 'muse-spark-1.3-contributor',
  standard: 'muse-spark-1.3',
} as const;

export type ModelId = (typeof MODEL_ID_BY_MODE)[ModelMode];

/**
 * Muse Wonder: the one-shot, document-in/object-out model (#219). It has exactly **one**
 * id and no cheaper tier — `muse-wonder-1.0-contributor` answers `404 model_not_found`,
 * and the pricing page says plainly that contributor mode is not available for Wonder, so
 * every Wonder call in this project is billed at the standard rate (observed 2026-11-03).
 *
 * It is not a `ModelMode`: a mode is what a browsing session decides in, and Wonder decides
 * nothing. Keeping it out of `MODEL_ID_BY_MODE` is what stops a run being told to make its
 * decisions on Wonder.
 */
export const WONDER_MODEL_ID = 'muse-wonder-1.0';

export type WonderModelId = typeof WONDER_MODEL_ID;

/**
 * Every model this file holds a rate for: the decision models and Muse Wonder.
 *
 * `ModelId` stays the narrower of the two on purpose. A decision request, a selected
 * provider and a trajectory turn are all about a session's model, and a Wonder id in any of
 * them would be a bug that typed fine.
 */
export type PricedModelId = ModelId | WonderModelId;

/**
 * The date the **Muse Spark** rates below were read from the pricing page, as the owner
 * reported it. Each row carries its own `ratesReadOn`, because the rows were read on
 * different days and a table with one date for all of them would be wrong about two of
 * three the moment a third model was added.
 */
export const PRICES_READ_ON = '2026-10-27';

/** The date the **Muse Wonder** rates below were read from the same page (#248). */
export const WONDER_PRICES_READ_ON = '2026-11-03';

/** What one model costs per 1M tokens, and what else a call to it may carry. */
export interface ModelSpec {
  readonly inputPerMillionUsd: number;
  /** The rate for the part of the input the model served from its prompt cache. */
  readonly cachedInputPerMillionUsd: number;
  /** Reasoning tokens are billed at this rate, because they are output tokens. */
  readonly outputPerMillionUsd: number;
  /**
   * Whether the model takes image input. All three do, observed live — a `data:` URL in an
   * `input_image` content part was read correctly by each (#133, #248). The swarm still
   * omits the screenshot and decides from the fixated elements alone, because whether a
   * simulated person should read the pixels is a product question and not an API one; this
   * flag records only what the API accepts, and the request builder honours it.
   */
  readonly acceptsImages: boolean;
  /**
   * Whether `reasoning.effort` may be set on a request to this model.
   *
   * False for both Spark tiers, on the strength of the documentation — by the API it could
   * be true for both, which `docs/meta-model-api.md` records. True for Wonder, where it is
   * load-bearing rather than optional: Wonder's own default is `"max"`, and leaving it unset
   * spends seven times the output tokens of `"minimal"` on the same short answer.
   */
  readonly acceptsReasoningEffort: boolean;
  /** The date this row's rates were read from the pricing page. */
  readonly ratesReadOn: string;
}

/**
 * The price table, keyed by model id — not by mode — so that a record of a past call can be
 * costed from the model it names, whatever mode the run that made it was in.
 */
export const MODEL_SPEC_BY_ID: Readonly<Record<PricedModelId, ModelSpec>> = {
  'muse-spark-1.3': {
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.15,
    outputPerMillionUsd: 4.25,
    acceptsImages: true,
    acceptsReasoningEffort: false,
    ratesReadOn: PRICES_READ_ON,
  },
  'muse-spark-1.3-contributor': {
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.002,
    outputPerMillionUsd: 0.2,
    acceptsImages: true,
    acceptsReasoningEffort: false,
    ratesReadOn: PRICES_READ_ON,
  },
  // Standard mode only, and therefore the expensive one: 40× Spark contributor on input
  // and 100× on output, with no cheap tier to develop against. What keeps a Wonder call
  // affordable is that there is one per test rather than one per screen — and
  // `reasoning.effort`, which the row above says Wonder accepts.
  [WONDER_MODEL_ID]: {
    inputPerMillionUsd: 4.0,
    cachedInputPerMillionUsd: 0.2,
    outputPerMillionUsd: 20.0,
    acceptsImages: true,
    acceptsReasoningEffort: true,
    ratesReadOn: WONDER_PRICES_READ_ON,
  },
};

const PER_MILLION = 1_000_000;

/** What a call's token counts are priced from: the three figures the API reports. */
export interface BilledTokens {
  readonly inputTokens: number;
  /** Of `inputTokens`, the ones the model served from its cache. Zero when it reported none. */
  readonly cachedInputTokens: number;
  /** All of them, reasoning tokens included. */
  readonly outputTokens: number;
}

/**
 * What one call cost, in US dollars, at the rates of the model named:
 * `(input − cached) × input + cached × cached + output × output`, per 1M tokens.
 *
 * Rounded to ten decimal places, so that a figure added up over a run is the sum of the
 * calls rather than the sum of the calls plus floating-point dust.
 */
export const estimateCostUsd = (modelId: PricedModelId, tokens: BilledTokens): number => {
  const spec = MODEL_SPEC_BY_ID[modelId];
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const uncached = tokens.inputTokens - cached;
  const usd =
    (uncached * spec.inputPerMillionUsd +
      cached * spec.cachedInputPerMillionUsd +
      tokens.outputTokens * spec.outputPerMillionUsd) /
    PER_MILLION;
  return Number(usd.toFixed(10));
};
