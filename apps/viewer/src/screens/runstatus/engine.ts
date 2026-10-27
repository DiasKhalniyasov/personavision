import type { Run } from '@personavision/contract';

/**
 * What ran a test, in the words a business reader uses: the engine part of the Running
 * screen's line, and the notice each of these two screens ends with.
 *
 * The run artifact records the mode it ran on — `engine.mode`, and `engine.modelMode`
 * beside it — so this module **reads those two fields and parses no model id**. A new model
 * id can therefore never quietly change what a screen says, and a cost figure can be
 * checked against the mode that produced it (the owner's decision of 2026-10-27, recorded
 * decision 11).
 *
 * The calls and the estimated cost come from `run.usage`, which the pipeline wrote, and
 * nothing here recomputes either.
 */

/**
 * The product's own name for the model a test runs on. It is copy, not data: the artifact
 * records the *mode*, and the two model ids behind it (`muse-spark-1.3` and
 * `muse-spark-1.3-contributor`) live in `packages/provider`, where the prices are. A screen
 * that read a name out of an id would start guessing the day a new id arrives.
 */
const MODEL_NAME = 'Muse Spark 1.3';

/** The words for the two modes a test can run on. */
const MODE_WORD: Readonly<Record<NonNullable<Run['engine']['modelMode']>, string>> = {
  contributor: 'contributor mode',
  standard: 'standard mode',
};

/** What a test that called no model reads, unchanged from the prototype. */
export const OFFLINE_ENGINE = 'offline deterministic engine';

/**
 * `Muse Spark 1.3 · contributor mode`, `· standard mode`, or the offline engine.
 *
 * A run that called a model always records which mode (the contract refuses one that does
 * not), so the mode is only ever missing on an artifact written before that field existed:
 * such a run is named without a mode rather than with a guessed one.
 */
export function enginePhrase(engine: Run['engine']): string {
  if (engine.mode === 'offline') return OFFLINE_ENGINE;
  const mode = engine.modelMode === undefined ? null : MODE_WORD[engine.modelMode];
  return mode === null ? MODEL_NAME : `${MODEL_NAME} · ${mode}`;
}

/** Whether this test's content may be used to train a model: contributor mode, and only it. */
export const ranOnContributorModel = (engine: Run['engine']): boolean =>
  engine.mode === 'model' && engine.modelMode === 'contributor';

/**
 * The one sentence a contributor test carries. A standard test carries none: it names its
 * mode and nothing more, which is how a paying customer sees which model ran their test.
 */
export const CONTRIBUTOR_NOTICE =
  'This test runs on the cheaper contributor model, so Meta may use its content to train its models. A paying workspace’s test always runs on the standard model.';

/** The prototype's `.notice info`, for a workspace with no model key configured. */
export const OFFLINE_NOTICE = `No model key is configured for this workspace, so the ${OFFLINE_ENGINE} was used. Simulated attention is unaffected; what each person says about their intent is terser than with a model.`;

/**
 * What the Test failed screen says about the engine: which model could not be used, and
 * that nothing stood in for it. A test that asked for a model and failed **never** reports
 * another engine's result in its place (#144), so the sentence names the model and states
 * the absence rather than mentioning any other engine at all.
 */
export const engineFailureNotice = (engine: Run['engine']): string =>
  engine.mode === 'offline'
    ? OFFLINE_NOTICE
    : `This test was to run on ${enginePhrase(engine)}. That model could not be used, so nobody was simulated and no other engine’s result was saved in its place.`;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whole = new Intl.NumberFormat('en-US');

/** What a test has spent so far, as the Running screen reads it out of `run.usage`. */
export interface UsageLine {
  /** `312 calls`. */
  readonly calls: string;
  /** `$0.42 so far`. A cost the formatter would round away says so instead. */
  readonly cost: string;
  /** The tokens behind the cost, for the line's tooltip. */
  readonly tokens: string;
}

/**
 * The calls and the estimated cost beside the engine, or `null` when there is no model bill
 * to report: an offline test reads `offline deterministic engine` and nothing else, as the
 * prototype has it, and a run from before the usage block records no spend to show.
 */
export function usageLine(run: Run): UsageLine | null {
  const { usage } = run;
  if (usage === undefined || run.engine.mode !== 'model') return null;

  const spent = usage.estimatedCostUsd;
  return {
    calls: `${whole.format(usage.calls)} ${usage.calls === 1 ? 'call' : 'calls'}`,
    cost:
      spent > 0 && spent < 0.01
        ? `under ${money.format(0.01)} so far`
        : `${money.format(spent)} so far`,
    tokens: `${whole.format(usage.inputTokens)} input tokens (${whole.format(usage.cachedInputTokens)} from the cache) · ${whole.format(usage.outputTokens)} output tokens (${whole.format(usage.reasoningTokens)} reasoning)`,
  };
}
