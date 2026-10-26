import { validateDecision } from './decision.js';
import {
  assistantMessage,
  anonymousCacheKey,
  buildPrefix,
  buildRequestBody,
  buildScreenMessage,
  promptCacheKey,
  readReply,
  readResponse,
} from './meta-request.js';
import type { ResponsesMessage, ResponsesRequestBody } from './meta-request.js';
import { estimateCostUsd, MODEL_ID_BY_MODE, MODEL_SPEC_BY_ID } from './meta-pricing.js';
import type { ModelId, ModelMode } from './meta-pricing.js';
import { MODEL_API_KEY_ENV } from './select.js';
import { createDecisionSession } from './session.js';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionSessionIdentity,
  DecisionUsage,
} from './types.js';

/**
 * The Meta Model API decision provider: the model-mode implementation of the decision
 * layer.
 *
 * It turns one agent's context into one request per screen, sends it to the responses
 * protocol, and returns the same intent-plus-one-action decision every provider returns. It
 * is the first provider that costs money and the first that can be made to say anything, so
 * four things are load-bearing and all four are tested rather than documented:
 *
 * 1. **The transport is injected.** Nothing in the contract suite or in this package's own
 *    tests reaches the network, so CI runs the whole of it with no key and no network. The
 *    default transport is `fetch`, built only when no other is given.
 * 2. **The key never leaves the closure it is read in.** It is read from
 *    `process.env.MODEL_API_KEY` at call time, put in one `Authorization` header, and
 *    redacted out of every message this module emits. No record handed to the trajectory
 *    sink carries a request header at all, so there is no path by which a header could
 *    reach a run's files — not on the happy path and not on a thrown error.
 * 3. **The mode arrives with the run and is honoured exactly.** Asked for standard, it calls
 *    `muse-spark-1.3` or fails; it never substitutes the contributor model on an error or a
 *    retry, and every decision and every trajectory record names the mode and the model id
 *    that produced it.
 * 4. **Our own failures stay ours.** A transport error, a timeout, a refusal, a non-2xx
 *    status and a reply that will not parse each come back as a `ModelDecisionError` the run
 *    loop attributes to automation. No failure path invents a decision: a screen the model
 *    could not answer is an automation failure, not a hesitation the agent never had.
 */

/** As `run.json`'s `engine.provider` records it. */
export const META_MODEL_PROVIDER_NAME = 'meta-model-api';

/** The responses protocol: https://dev.meta.ai/docs/protocols/responses */
export const META_RESPONSES_ENDPOINT = 'https://api.meta.ai/v1/responses';

/** How long one screen's call may take before it is our own timeout rather than a wait. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One HTTP call, as the provider hands it to whatever sends it. The headers are here because
 * the sender needs them and nowhere else: they are not part of a trajectory record.
 */
export interface ModelHttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ResponsesRequestBody;
  /** Aborted when the provider's own timeout runs out. */
  readonly signal: AbortSignal;
}

export interface ModelHttpResponse {
  readonly status: number;
  /** The parsed body, or the raw text when it was not JSON — whatever came back, verbatim. */
  readonly body: unknown;
}

/**
 * How a request is sent. A test passes a function and asserts against what it was given; a
 * run passes nothing and gets `fetch`.
 */
export type ModelTransport = (request: ModelHttpRequest) => Promise<ModelHttpResponse>;

/** Which call a trajectory record belongs to, and what produced it. */
export interface TrajectoryCall {
  readonly mode: ModelMode;
  readonly modelId: ModelId;
  readonly personaId: string;
  readonly seed: number;
  /** Counted from 1, in the order the session made its calls — failed calls included. */
  readonly turn: number;
  readonly promptCacheKey: string;
}

/**
 * One line of an agent's LLM trajectory: a request sent, a response received, or a failure.
 * Enough on its own to replay and audit a run (#139) — and carrying no key, no
 * `Authorization` header and no request header of any kind.
 */
export type TrajectoryRecord =
  | (TrajectoryCall & {
      readonly kind: 'request';
      readonly url: string;
      readonly body: ResponsesRequestBody;
    })
  | (TrajectoryCall & {
      readonly kind: 'response';
      readonly status: number;
      readonly body: unknown;
    })
  | (TrajectoryCall & {
      readonly kind: 'failure';
      readonly failure: { readonly kind: ModelFailureKind; readonly message: string };
    });

/**
 * Where the trajectory goes. Injected, because the file, its format and its replay belong to
 * #139; what this provider owes them is every request and every response, in order,
 * including on a failure path, with the redaction already done.
 */
export type TrajectorySink = (record: TrajectoryRecord) => void | Promise<void>;

/** Every way a model call can fail us. Each one is the simulation's fault, never the product's. */
export const MODEL_FAILURE_KINDS = [
  'credential',
  'transport',
  'timeout',
  'http_status',
  'refusal',
  'unparseable',
  'conversation',
] as const;

export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

/**
 * A model call that did not produce a decision.
 *
 * It carries `attribution: 'automation'` because that is the one thing the run loop has to
 * know: a screen lost to a timeout or a refusal is our breakage, and recording it as a
 * person who abandoned the task would put our own failure in the product's column
 * (`docs/FLOW.md` section 8). It names the mode and the model id that failed, so that a run
 * which refused to downgrade can be read as such afterwards.
 */
export class ModelDecisionError extends Error {
  readonly kind: ModelFailureKind;
  readonly attribution = 'automation' as const;
  readonly mode: ModelMode;
  readonly modelId: ModelId;
  /** The HTTP status, when the call got far enough to have one. */
  readonly status?: number;

  constructor(options: {
    readonly kind: ModelFailureKind;
    readonly message: string;
    readonly mode: ModelMode;
    readonly modelId: ModelId;
    readonly status?: number;
  }) {
    super(options.message);
    this.name = 'ModelDecisionError';
    this.kind = options.kind;
    this.mode = options.mode;
    this.modelId = options.modelId;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * Takes the key out of a string, whatever it is embedded in. The last line of defence rather
 * than the only one: a message this provider composes never contains the key in the first
 * place, and a message thrown by `fetch` or by an injected transport is not ours to trust.
 */
const redact = (text: string, apiKey: string): string =>
  apiKey === '' ? text : text.split(apiKey).join('[redacted]');

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A timeout is told apart from a transport error, because they are different failures. */
const isTimeout = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.aborted) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError';
};

/** The default transport: `fetch`, and nothing a test ever reaches. */
const fetchTransport: ModelTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: JSON.stringify(request.body),
    signal: request.signal,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the text itself is what came back, and the trajectory keeps it as it is.
  }
  return { status: response.status, body };
};

export interface MetaModelApiProviderOptions {
  /**
   * The run's mode. Required and never defaulted: a provider that picked one for itself
   * could bill a customer's run at contributor prices, or spend twelve times what a
   * development run meant to.
   */
  readonly mode: ModelMode;
  /**
   * The key, when the caller already read it — `selectDecisionProvider` does, so that the
   * decision about whether this machine can run model mode is made in one place. Omitted,
   * the key is read from the environment at call time.
   */
  readonly apiKey?: string;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How the request is sent. Defaults to `fetch`. */
  readonly transport?: ModelTransport;
  /** Where every request and response is recorded (#139). Absent records nothing. */
  readonly trajectory?: TrajectorySink;
  readonly timeoutMs?: number;
}

/**
 * One session's conversation: its cache key, the prefix frozen at its first screen, and the
 * turns it has completed. Append-only — a screen that failed leaves nothing behind, so the
 * next screen's request still opens with the bytes the last successful one did.
 */
interface Conversation {
  readonly promptCacheKey: string;
  prefix?: readonly ResponsesMessage[];
  readonly turns: ResponsesMessage[];
  previousResponseId?: string;
  calls: number;
}

export const createMetaModelApiProvider = (
  options: MetaModelApiProviderOptions,
): DecisionProvider => {
  const { mode } = options;
  const modelId = MODEL_ID_BY_MODE[mode];
  const spec = MODEL_SPEC_BY_ID[modelId];
  const transport = options.transport ?? fetchTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Read at call time, never stored on the provider and never returned to a caller. */
  const readApiKey = (): string => {
    const env = options.env ?? process.env;
    return (options.apiKey ?? env[MODEL_API_KEY_ENV] ?? '').trim();
  };

  const decideOn = async (
    identity: DecisionSessionIdentity,
    conversation: Conversation,
    context: DecisionContext,
  ): Promise<Decision> => {
    const apiKey = readApiKey();
    conversation.calls += 1;
    const call: TrajectoryCall = {
      mode,
      modelId,
      personaId: identity.personaId,
      seed: identity.seed,
      turn: conversation.calls,
      promptCacheKey: conversation.promptCacheKey,
    };

    const record = async (entry: TrajectoryRecord): Promise<void> => {
      await options.trajectory?.(entry);
    };

    const fail = async (
      kind: ModelFailureKind,
      detail: string,
      status?: number,
    ): Promise<never> => {
      const message = redact(detail, apiKey);
      await record({ ...call, kind: 'failure', failure: { kind, message } });
      throw new ModelDecisionError({
        kind,
        message,
        mode,
        modelId,
        ...(status === undefined ? {} : { status }),
      });
    };

    if (apiKey === '') {
      return fail(
        'credential',
        `${MODEL_API_KEY_ENV} is not in the environment, so this call was never made`,
      );
    }

    // The prefix is built from the session's first screen and then frozen: rebuilding it
    // per turn would be the one change that throws the whole session's cache away, and a
    // caller that changes a session's persona or task halfway through is a bug we refuse
    // rather than silently pay for.
    const prefix = buildPrefix(context);
    if (conversation.prefix === undefined) {
      conversation.prefix = prefix;
    } else if (JSON.stringify(conversation.prefix) !== JSON.stringify(prefix)) {
      return fail(
        'conversation',
        'this session’s persona or task changed between screens, which would break its cached prefix',
      );
    }

    const screen = buildScreenMessage(context, { acceptsImages: spec.acceptsImages });
    const body = buildRequestBody({
      modelId,
      input: [...conversation.prefix, ...conversation.turns, screen],
      promptCacheKey: conversation.promptCacheKey,
      ...(conversation.previousResponseId === undefined
        ? {}
        : { previousResponseId: conversation.previousResponseId }),
    });

    await record({ ...call, kind: 'request', url: META_RESPONSES_ENDPOINT, body });

    const signal = AbortSignal.timeout(timeoutMs);
    let response: ModelHttpResponse;
    try {
      response = await transport({
        url: META_RESPONSES_ENDPOINT,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal,
      });
    } catch (error) {
      const detail = messageOf(error);
      return isTimeout(error, signal)
        ? fail('timeout', `the call did not answer within ${timeoutMs}ms: ${detail}`)
        : fail('transport', `the call could not be made: ${detail}`);
    }

    await record({ ...call, kind: 'response', status: response.status, body: response.body });

    if (response.status < 200 || response.status >= 300) {
      return fail('http_status', `the API answered ${response.status}`, response.status);
    }

    const read = readResponse(response.body);
    if (!read.ok) {
      return fail(read.refusal ? 'refusal' : 'unparseable', read.detail);
    }

    const reply = readReply(read.value.replyText);
    if (!reply.ok) {
      return fail('unparseable', `the reply could not be read as a decision: ${reply.detail}`);
    }

    const usage: DecisionUsage = {
      inputTokens: read.value.tokens.inputTokens,
      cachedInputTokens: read.value.tokens.cachedInputTokens,
      outputTokens: read.value.tokens.outputTokens,
      reasoningTokens: read.value.tokens.reasoningTokens,
      estimatedCostUsd: estimateCostUsd(modelId, read.value.tokens),
    };
    const decision: Decision = {
      intent: reply.value.intent,
      action: reply.value.action,
      ...(reply.value.relevanceHints === undefined
        ? {}
        : { relevanceHints: reply.value.relevanceHints }),
      usage,
      model: { mode, modelId },
    };

    const violations = validateDecision(context, decision);
    if (violations.length > 0) {
      return fail(
        'unparseable',
        `the model’s decision does not fit the interface: ${violations.join('; ')}`,
      );
    }

    // Appended only now: a screen that failed is not a turn, so the next request opens with
    // exactly the bytes this session has already been charged for.
    conversation.turns.push(screen, assistantMessage(read.value.replyText));
    if (read.value.responseId !== undefined) {
      conversation.previousResponseId = read.value.responseId;
    }

    return decision;
  };

  return {
    name: META_MODEL_PROVIDER_NAME,
    mode: 'model',
    readsImages: spec.acceptsImages,
    /**
     * A decision belonging to no session: one request, one conversation of one turn, and a
     * cache key derived from the prefix rather than from a persona and a seed it has not
     * been given.
     */
    decide: (context) => {
      const conversation: Conversation = {
        promptCacheKey: anonymousCacheKey(buildPrefix(context)),
        turns: [],
        calls: 0,
      };
      return decideOn({ personaId: 'anonymous', seed: 0 }, conversation, context);
    },
    beginSession: (identity) => {
      // One conversation and one cache key per handle, so two sessions share neither — and
      // the provider's own mode is inherited rather than passed in per session.
      const conversation: Conversation = {
        promptCacheKey: promptCacheKey(identity),
        turns: [],
        calls: 0,
      };
      return createDecisionSession({
        personaId: identity.personaId,
        seed: identity.seed,
        decide: (context) => decideOn(identity, conversation, context),
      });
    },
  };
};
