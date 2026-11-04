import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { validateDecision } from './decision.js';
import {
  assistantMessage,
  anonymousCacheKey,
  buildPrefix,
  buildRequestBody,
  buildScreenMessage,
  correctionMessage,
  promptCacheKey,
  readReply,
  readResponse,
  readTokens,
  sumTokens,
} from './meta-request.js';
import type {
  ReadReply,
  ReportedTokens,
  ResponsesMessage,
  ResponsesRequestBody,
} from './meta-request.js';
import { estimateCostUsd, MODEL_ID_BY_MODE, MODEL_SPEC_BY_ID } from './meta-pricing.js';
import type { ModelId, ModelMode } from './meta-pricing.js';
import { MODEL_API_KEY_ENV } from './select.js';
import { createDecisionSession } from './session.js';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionScreenshot,
  DecisionSessionIdentity,
  DecisionSessionScope,
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
 * 5. **An answer that carried no decision is asked again, once.** When the reply is not JSON
 *    the parse error goes back to the model with its own unreadable reply, in that one
 *    request body and not in the session's turns; when the envelope carried no reply at all
 *    there is nothing to quote, so the same request simply goes again. Both calls are billed
 *    into the decision's usage and both reach the trajectory (#420), as Muse Wonder's own ask
 *    already bills and retries (`wonder-model.ts`). A refusal, an answer our own output cap
 *    cut off, a non-2xx status and a timeout are each asked once — asking again for a cut-off
 *    answer would cut it off again — and so is a JSON object the interface rejects, which a
 *    model asked twice sends twice.
 */

/** As `run.json`'s `engine.provider` records it. */
/**
 * The screenshot as the person saw it: a full-page capture at device pixels runs to tens of
 * thousands of pixels, past what the API decodes, and shows what nobody had scrolled to.
 */
const screenImage = async (shot: DecisionScreenshot): Promise<Buffer> => {
  if (shot.view === undefined) return readFile(shot.path);
  const image = sharp(shot.path);
  const { width = 0, height = 0 } = await image.metadata();
  const scale = width / shot.view.width;
  const top = Math.min(Math.round(shot.view.top * scale), Math.max(0, height - 1));
  return image
    .extract({
      left: 0,
      top,
      width,
      height: Math.min(Math.round(shot.view.height * scale), height - top),
    })
    .resize({ width: shot.view.width })
    .png()
    .toBuffer();
};

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
 * A sink in this protocol's own terms: it is handed a {@link TrajectoryRecord} and nothing
 * else, so a caller can read `body.input` off what it was given without narrowing.
 *
 * The interface's `TrajectorySink` is the wider one — it takes any provider's record — and
 * one of those satisfies this, which is how the file the run opens per session arrives here
 * through `beginSession`'s scope (#139). What this provider owes either of them is every
 * request and every response, in order, including on a failure path, with the redaction
 * already done.
 */
export type MetaTrajectorySink = (record: TrajectoryRecord) => void | Promise<void>;

/** Every way a model call can fail us. Each one is the simulation's fault, never the product's. */
export const MODEL_FAILURE_KINDS = [
  'credential',
  'transport',
  'timeout',
  'http_status',
  'refusal',
  /** Our own output cap cut the answer off, which is our failure and not the model's. */
  'incomplete',
  'unparseable',
  'conversation',
  /** The trajectory could not be written, so the run would not be replayable from it. */
  'trajectory',
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

/**
 * The same, through a response body — which is not ours and may quote the key straight back:
 * a 401 page, a proxy that echoes the request, a gateway that logs what it received. The
 * trajectory is written to disk, so the body is redacted before it is recorded rather than
 * trusted because it came from the API.
 */
const redactBody = (body: unknown, apiKey: string): unknown => {
  if (apiKey === '') return body;
  if (typeof body === 'string') return redact(body, apiKey);
  const text = JSON.stringify(body);
  if (text === undefined || !text.includes(apiKey)) return body;
  return JSON.parse(redact(text, apiKey)) as unknown;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A timeout is told apart from a transport error, because they are different failures. */
const isTimeout = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.aborted) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError';
};

/**
 * What the API answers now and then (503) or over a rate limit (429), and a connection that
 * drops before any answer ("fetch failed"): asked again, after these waits.
 */
const RETRIED_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_WAITS_MS = [2000, 5000];

/** The default transport: `fetch`, and nothing a test ever reaches. */
const fetchTransport: ModelTransport = async (request) => {
  for (let attempt = 0; ; attempt += 1) {
    const wait = RETRY_WAITS_MS[attempt];
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: JSON.stringify(request.body),
        signal: request.signal,
      });
    } catch (error) {
      if (wait === undefined || request.signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const text = await response.text();
    if (RETRIED_STATUSES.has(response.status) && wait !== undefined && !request.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: the text itself is what came back, and the trajectory keeps it as it is.
    }
    return { status: response.status, body };
  }
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
  readonly trajectory?: MetaTrajectorySink;
  readonly timeoutMs?: number;
  /**
   * Real people's narrated eye-tracking sessions, sent after the tools in every session's
   * prefix so the model copies how eyes move. Absent sends nothing.
   */
  readonly gazeExamples?: string;
}

/**
 * One session's conversation: its cache key, the prefix frozen at its first screen, and the
 * turns it has completed. Append-only — a screen that failed leaves nothing behind, so the
 * next screen's request still opens with the bytes the last successful one did.
 */
interface Conversation {
  readonly promptCacheKey: string;
  /**
   * This session's trajectory, as `beginSession`'s scope lent it — one file per session, so
   * the sink cannot be a field of the provider that every session would share (#139).
   */
  readonly trajectory?: MetaTrajectorySink;
  prefix?: readonly ResponsesMessage[];
  readonly turns: ResponsesMessage[];
  calls: number;
  /**
   * One turn at a time. Two overlapping `decide` calls on one handle would both read `turns`
   * before either appended to it: two requests with the same prefix, then two appends in
   * whatever order they finished, and the session's append-only history — the thing its whole
   * cache entry rests on — would be wrong from then on. The engine drives one screen at a
   * time today; this makes the invariant the provider's own rather than the caller's.
   */
  queue: Promise<unknown>;
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

  const takeTurn = async (
    identity: DecisionSessionIdentity,
    conversation: Conversation,
    context: DecisionContext,
  ): Promise<Decision> => {
    const apiKey = readApiKey();
    /**
     * Which call of the session this is. Reassigned for the retry below, so that a screen
     * asked twice reaches the trajectory as the two calls it was rather than as one.
     */
    let call: TrajectoryCall = {
      mode,
      modelId,
      personaId: identity.personaId,
      seed: identity.seed,
      turn: (conversation.calls += 1),
      promptCacheKey: conversation.promptCacheKey,
    };

    const error = (kind: ModelFailureKind, message: string, status?: number): ModelDecisionError =>
      new ModelDecisionError({
        kind,
        message,
        mode,
        modelId,
        ...(status === undefined ? {} : { status }),
      });

    /**
     * Writes one record. A sink that rejects is a failure in its own right — a run is not
     * replayable from a trajectory with a hole in it — so it surfaces as `trajectory` rather
     * than as whatever I/O error the sink threw.
     */
    const record = async (entry: TrajectoryRecord): Promise<void> => {
      try {
        await conversation.trajectory?.(entry);
      } catch (thrown) {
        throw error('trajectory', redact(messageOf(thrown), apiKey));
      }
    };

    const fail = async (
      kind: ModelFailureKind,
      detail: string,
      status?: number,
    ): Promise<never> => {
      const message = redact(detail, apiKey);
      // A sink that cannot write never replaces the failure being recorded: the call failed
      // for the reason it failed, and that is the reason the run loop is given.
      await record({ ...call, kind: 'failure', failure: { kind, message } }).catch(() => undefined);
      throw error(kind, message, status);
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
    const prefix = buildPrefix(context, options.gazeExamples);
    if (conversation.prefix === undefined) {
      conversation.prefix = prefix;
    } else if (JSON.stringify(conversation.prefix) !== JSON.stringify(prefix)) {
      return fail(
        'conversation',
        'this session’s persona or task changed between screens, which would break its cached prefix',
      );
    }

    let imageUrl: string | undefined;
    if (spec.acceptsImages && context.screenshot !== undefined) {
      try {
        imageUrl = `data:image/png;base64,${(await screenImage(context.screenshot)).toString('base64')}`;
      } catch (thrown) {
        return fail('conversation', `the screenshot could not be read: ${messageOf(thrown)}`);
      }
    }
    const screen = buildScreenMessage(context, { acceptsImages: spec.acceptsImages, imageUrl });

    /**
     * What each call of this screen reported spending. A reply that could not be read was
     * still billed, so a screen asked twice reports both calls rather than the cheaper story
     * of one: a run's cost is only checkable against an invoice if nothing is left out.
     */
    const spent: ReportedTokens[] = [];

    /**
     * One call for this screen: the reply it could read, or why it could not and whether
     * asking again could help. `appended` goes after the screen in **this** request body and
     * nowhere else — it is how the retry below shows the model its own unreadable reply
     * without the session's turns ever carrying it.
     *
     * A refusal, an answer our own cap cut off, a non-2xx status and a timeout do not come
     * back from here: they fail the screen where they are found, because a second identical
     * ask answers none of them.
     */
    const attempt = async (
      appended: readonly ResponsesMessage[],
    ): Promise<
      | { readonly ok: true; readonly reply: ReadReply; readonly replyText: string }
      | {
          readonly ok: false;
          readonly detail: string;
          /** Whether a second ask could plausibly answer this. */
          readonly askAgain: boolean;
          /** The model's own reply, when there was one to replay back to it. */
          readonly replyText?: string;
        }
    > => {
      const body = buildRequestBody({
        modelId,
        input: [...prefix, ...conversation.turns, screen, ...appended],
        promptCacheKey: conversation.promptCacheKey,
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

      await record({
        ...call,
        kind: 'response',
        status: response.status,
        body: redactBody(response.body, apiKey),
      });

      if (response.status < 200 || response.status >= 300) {
        return fail('http_status', `the API answered ${response.status}`, response.status);
      }

      // Billed before it is read, and whatever becomes of it: an answer that arrived and
      // could not be read was still paid for, so the figures come off the response rather
      // than off the happy path. A response reporting nothing reports five zeroes.
      spent.push(readTokens((response.body as { usage?: unknown } | null)?.usage));

      const read = readResponse(response.body);
      if (!read.ok) {
        // A refusal and a cut-off answer are the screen's end here; an envelope that carried
        // no reply to read is the one the caller may ask again, with nothing to quote back.
        if (read.fault !== 'unparseable') return fail(read.fault, read.detail);
        return { ok: false, detail: read.detail, askAgain: true };
      }

      const reply = readReply(read.value.replyText);
      return reply.ok
        ? { ok: true, reply: reply.value, replyText: read.value.replyText }
        : {
            ok: false,
            detail: reply.detail,
            // Only a reply that is no JSON object at all: an object the interface rejects is
            // one the model meant to send, and it would send it again.
            askAgain: reply.fault === 'unreadable',
            replyText: read.value.replyText,
          };
    };

    let got = await attempt([]);

    if (!got.ok && got.askAgain) {
      // The same question again, carrying what came back and what was wrong with it — and
      // carrying nothing when no reply came back at all. The two messages belong to this
      // request only: a malformed reply left in the conversation would be re-sent and
      // re-billed on every later screen of the session (#138).
      const correction =
        got.replyText === undefined
          ? []
          : [assistantMessage(got.replyText), correctionMessage(got.detail)];
      call = { ...call, turn: (conversation.calls += 1) };
      const again = await attempt(correction);
      if (!again.ok) {
        return fail(
          'unparseable',
          `the reply could not be read as a decision, asked twice: ${again.detail}`,
        );
      }
      got = again;
    }

    if (!got.ok) {
      return fail('unparseable', `the reply could not be read as a decision: ${got.detail}`);
    }
    let { reply, replyText } = got;

    // An element id ends in its box (`…-144-684-125x29`), so the same link at another position
    // has another id, and the model sometimes names it by the id it had on the screen before.
    // The one element on this screen with the same role and name is that element.
    const onScreen = [...context.fixatedElements, ...(context.screenElements ?? [])].map(
      (element) => element.id,
    );
    const stem = (id: string): string => id.replace(/-\d+-\d+-\d+x\d+$/, '');
    const relocated = (read: ReadReply): ReadReply['action'] => {
      const target = read.action.targetElementId;
      if (typeof target !== 'string' || onScreen.includes(target)) return read.action;
      const same = onScreen.filter((id) => stem(id) === stem(target));
      return same.length === 1 ? { ...read.action, targetElementId: same[0] } : read.action;
    };

    const toDecision = (read: ReadReply): Decision => {
      const tokens = sumTokens(spent);
      const usage: DecisionUsage = {
        inputTokens: tokens.inputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        outputTokens: tokens.outputTokens,
        reasoningTokens: tokens.reasoningTokens,
        estimatedCostUsd: estimateCostUsd(modelId, tokens),
      };
      // A hint is advisory metadata, so one the interface would reject — an element from the
      // screen before, a score on a 0-to-100 scale — is dropped rather than allowed to throw
      // away a decision that has already been paid for.
      const fixated = new Set(context.fixatedElements.map((element) => element.id));
      const hints = Object.entries(read.relevanceHints ?? {}).filter(
        ([elementId, hint]) => fixated.has(elementId) && hint >= 0 && hint <= 1,
      );
      return {
        intent: read.intent,
        ...(read.looks === undefined ? {} : { looks: read.looks }),
        action: relocated(read),
        ...(hints.length === 0 ? {} : { relevanceHints: Object.fromEntries(hints) }),
        usage,
        model: { mode, modelId },
      };
    };

    let decision = toDecision(reply);
    let violations = validateDecision(context, decision);
    if (violations.length > 0) {
      // An element that is not on this screen at all is a decision worth one more ask: the
      // model is shown what was wrong and picks again from this screen's own elements.
      call = { ...call, turn: (conversation.calls += 1) };
      const again = await attempt([
        assistantMessage(replyText),
        correctionMessage(`${violations.join('; ')}. Choose again, from this screen.`),
      ]);
      if (again.ok) {
        ({ reply, replyText } = again);
        decision = toDecision(reply);
        violations = validateDecision(context, decision);
      }
    }
    if (violations.length > 0) {
      return fail(
        'unparseable',
        `the model’s decision does not fit the interface: ${violations.join('; ')}`,
      );
    }

    // Appended only now: a screen that failed is not a turn, so the next request opens with
    // exactly the bytes this session has already been charged for.
    conversation.turns.push(screen, assistantMessage(replyText));

    return decision;
  };

  /** One turn at a time per conversation, in the order it was asked for. */
  const decideOn = (
    identity: DecisionSessionIdentity,
    conversation: Conversation,
    context: DecisionContext,
  ): Promise<Decision> => {
    // A reply that could not be read is asked again inside the turn, where the parse error
    // is, rather than by repeating the whole turn blindly from out here (#420).
    const ask = (): Promise<Decision> => takeTurn(identity, conversation, context);
    const turn = conversation.queue.then(ask, ask);
    conversation.queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    name: META_MODEL_PROVIDER_NAME,
    mode: 'model',
    readsImages: spec.acceptsImages,
    modelId,
    /**
     * A decision belonging to no session: one request, one conversation of one turn, and a
     * cache key derived from the prefix rather than from a persona and a seed it has not
     * been given.
     */
    decide: (context) => {
      const conversation: Conversation = {
        promptCacheKey: anonymousCacheKey(buildPrefix(context, options.gazeExamples)),
        ...(options.trajectory === undefined ? {} : { trajectory: options.trajectory }),
        turns: [],
        calls: 0,
        queue: Promise.resolve(),
      };
      return decideOn({ personaId: 'anonymous', seed: 0 }, conversation, context);
    },
    beginSession: (identity, scope?: DecisionSessionScope) => {
      // One conversation, one cache key and one trajectory per handle, so two sessions share
      // none of the three — and the provider's own mode is inherited rather than passed in
      // per session. The run's sink wins over the provider's, because only the run knows
      // which session id this handle is writing as.
      const trajectory = scope?.trajectory ?? options.trajectory;
      const conversation: Conversation = {
        promptCacheKey: promptCacheKey(identity),
        ...(trajectory === undefined ? {} : { trajectory }),
        turns: [],
        calls: 0,
        queue: Promise.resolve(),
      };
      return createDecisionSession({
        personaId: identity.personaId,
        seed: identity.seed,
        decide: (context) => decideOn(identity, conversation, context),
      });
    },
  };
};
