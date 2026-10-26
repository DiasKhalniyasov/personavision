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

/** The date the rates below were read from the pricing page, as the owner reported it. */
export const PRICES_READ_ON = '2026-10-27';

/** What one model costs per 1M tokens, and what else a call to it may carry. */
export interface ModelSpec {
  readonly inputPerMillionUsd: number;
  /** The rate for the part of the input the model served from its prompt cache. */
  readonly cachedInputPerMillionUsd: number;
  /** Reasoning tokens are billed at this rate, because they are output tokens. */
  readonly outputPerMillionUsd: number;
  /**
   * Whether the model takes image input. Neither of these two is confirmed to, so no
   * request this provider builds carries a screenshot and `readsImages` is false — the
   * swarm therefore omits the screenshot and the decision is made from the fixated elements
   * alone. #133 settles it live; when one of them does accept images, this flag is where it
   * is written down, and the request builder already honours it.
   */
  readonly acceptsImages: boolean;
  /** Whether `reasoning.effort` may be set. Off for both: contributor has no `"max"`. */
  readonly acceptsReasoningEffort: boolean;
}

/**
 * The price table, keyed by model id — not by mode — so that a record of a past call can be
 * costed from the model it names, whatever mode the run that made it was in.
 */
export const MODEL_SPEC_BY_ID: Readonly<Record<ModelId, ModelSpec>> = {
  'muse-spark-1.3': {
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.15,
    outputPerMillionUsd: 4.25,
    acceptsImages: false,
    acceptsReasoningEffort: false,
  },
  'muse-spark-1.3-contributor': {
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.002,
    outputPerMillionUsd: 0.2,
    acceptsImages: false,
    acceptsReasoningEffort: false,
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
export const estimateCostUsd = (modelId: ModelId, tokens: BilledTokens): number => {
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
