import { META_RESPONSES_ENDPOINT } from './meta-model.js';
import type { ModelHttpResponse } from './meta-model.js';
import { estimateCostUsd, WONDER_MODEL_ID } from './meta-pricing.js';
import type { WonderModelId } from './meta-pricing.js';
import { MAX_OUTPUT_TOKENS, readResponse, readTokens } from './meta-request.js';
import type { ReportedTokens, ResponsesMessage } from './meta-request.js';
import { MODEL_API_KEY_ENV } from './select.js';
import type { DecisionUsage } from './types.js';
import { parseWonderReply } from './wonder.js';
import type {
  WonderAsk,
  WonderEffort,
  WonderModel,
  WonderProvider,
  WonderReply,
  WonderUse,
} from './wonder.js';

/**
 * Muse Wonder behind the one-shot seam: the model implementation of {@link WonderProvider}.
 *
 * It is the other half of `wonder-offline.ts` — the project's default is the offline
 * generator, and this is what a caller that *named* a model gets (`selectWonderProvider`,
 * #251). One ask becomes one `POST /v1/responses`: the ask's document is the request's one
 * message, the ask's `replySchema` is the structured-reply parameter the protocol takes, and
 * the reply is read from the documented path and handed to the ask's own validator. It is
 * built field for field against `docs/meta-model-api.md`'s Muse Wonder section, which is a
 * record of 18 live calls rather than of a documentation page.
 *
 * Four things are load-bearing, and all four are tested rather than documented:
 *
 * 1. **The transport is injected.** The default is `fetch`, built only when no other is
 *    given, so this package's own tests and the contract suite reach no network and need no
 *    key. The same rule the decision provider follows, for the same reason.
 * 2. **The key never leaves the closure it is read in.** It is read from the environment at
 *    call time, put in one `Authorization` header, and redacted out of every message this
 *    module emits. Nothing here keeps a record, writes a file or logs a line, so there is no
 *    path by which a header could reach a run's files — not on the happy path, and not on a
 *    thrown error.
 * 3. **A malformed reply is reported in words.** A missing field, a wrong type or a citation
 *    naming a session the run does not have is the ask's validator refusing, and it comes
 *    back as a `WonderReplyError` naming the path, through the one `parseWonderReply` both
 *    implementations go through. A reply that will not parse *at all* is asked for once more
 *    and then refused with the reason. No path here turns a bad reply into an empty
 *    recommendation list or a defaulted object: `docs/meta-model-api.md` is blunt about why
 *    — a schema-constrained reply is a guarantee about JSON and not about truth.
 * 4. **The call is priced from the one table.** Usage is read from the five paths the
 *    document names and priced by `estimateCostUsd` at `muse-wonder-1.0`'s own rates, so a
 *    Wonder call and a decision add up through the one `totalUsage` and no second
 *    arithmetic can drift from the invoice.
 */

/** As a run or a log line records it. */
export const WONDER_PROVIDER_NAME = 'meta-wonder-api';

/**
 * This implementation's own word for the tier it calls, as `WonderModel.mode` takes it.
 * `standard` is the only true one: there is no `muse-wonder-1.0-contributor` — it answers
 * `404 model_not_found` — so every call here is billed at the standard rate.
 */
export const WONDER_PROVIDER_MODE = 'standard';

/**
 * The reasoning effort sent when the ask names none.
 *
 * It exists because **omitting `reasoning` is not a neutral default on Wonder**: the API's
 * own default is `max`, which spent 357 reasoning tokens of 381 output on a one-word answer
 * (observed 2026-11-03). An implementation that let that stand would charge every ask the
 * most expensive setting there is. `low` is what the two harder of the four shapes — the
 * ranked recommendations and the one change — were answered at live, so it is the deliberate
 * floor for an ask that expressed no preference; the two cheap shapes name `minimal`
 * themselves.
 */
export const DEFAULT_WONDER_EFFORT: WonderEffort = 'low';

/**
 * How long one ask may take before it is our own timeout rather than a wait. Longer than the
 * decision provider's 60s on purpose: the four live shapes took 5.1s to 22.1s at `minimal`
 * and `low`, and Wonder's own `max` is multiples of that — a one-shot call is the slow part
 * of a test, not the expensive part.
 */
export const DEFAULT_WONDER_TIMEOUT_MS = 180_000;

/**
 * How a structured reply is asked for: a JSON Schema in `text.format`. It is the Responses
 * protocol's structured-output parameter and the only one of the protocol's three mechanisms
 * that constrains decoding. `response_format`, the Chat Completions spelling, is rejected
 * outright here (`400 unknown parameter`), and `strict: true` is sent because it turns a
 * schema this project got wrong into a failure at the first call rather than a field that
 * silently never arrives.
 */
export interface WonderReplyFormat {
  readonly type: 'json_schema';
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

/** The body of one Wonder `POST /v1/responses`. */
export interface WonderRequestBody {
  readonly model: WonderModelId;
  readonly input: readonly ResponsesMessage[];
  readonly text: { readonly format: WonderReplyFormat };
  /** Always present: Wonder's own default is the most expensive setting there is. */
  readonly reasoning: { readonly effort: WonderEffort };
  /** Nothing of ours is kept server-side for retrieval, exactly as on every decision call. */
  readonly store: false;
  readonly max_output_tokens: number;
}

/**
 * One HTTP call, as this provider hands it to whatever sends it. The headers are here
 * because the sender needs them and nowhere else.
 */
export interface WonderHttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: WonderRequestBody;
  /** Aborted when this provider's own timeout runs out. */
  readonly signal: AbortSignal;
}

/**
 * How a Wonder request is sent. A test passes a function and asserts against what it was
 * given; a run passes nothing and gets `fetch`.
 */
export type WonderTransport = (request: WonderHttpRequest) => Promise<ModelHttpResponse>;

/** Every way one ask can fail us. Each is the simulation's fault, never the product's. */
export const WONDER_FAILURE_KINDS = [
  'credential',
  'transport',
  'timeout',
  'http_status',
  'refusal',
  /** Our own output cap cut the answer off, which is our failure and not the model's. */
  'incomplete',
  'unparseable',
] as const;

export type WonderFailureKind = (typeof WONDER_FAILURE_KINDS)[number];

/**
 * An ask that produced no object at all — as against {@link WonderReplyError}, which is a
 * reply the ask's own validator refused.
 *
 * The two are kept apart because they send a reader to two different places: a refusal names
 * the path the model was wrong at, and this names what stopped a reply arriving. Both carry
 * `attribution: 'automation'`, because a goal that could not be written is our breakage and
 * never a person who gave up (`docs/FLOW.md` section 8).
 */
export class WonderCallError extends Error {
  readonly kind: WonderFailureKind;
  readonly attribution = 'automation' as const;
  readonly use: WonderUse;
  readonly modelId: WonderModelId;
  /** The HTTP status, when the call got far enough to have one. */
  readonly status?: number;

  constructor(options: {
    readonly kind: WonderFailureKind;
    readonly message: string;
    readonly use: WonderUse;
    readonly status?: number;
  }) {
    super(options.message);
    this.name = 'WonderCallError';
    this.kind = options.kind;
    this.use = options.use;
    this.modelId = WONDER_MODEL_ID;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * Takes the key out of a string, whatever it is embedded in. The last line of defence rather
 * than the only one: a message this module composes never contains the key in the first
 * place, and a message thrown by `fetch` or by an injected transport is not ours to trust.
 *
 * `meta-model.ts` keeps its own copy of these two lines, private to that file. What the two
 * seams share is the *protocol* — the endpoint, the request's message shape, the envelope
 * reader and the token paths all come from `meta-request.ts` and from `meta-model.ts`'s
 * published constants — and what they do not share is each other's machinery
 * (`docs/adr/0003-the-one-shot-wonder-seam.md`). A one-line defence belongs on the side that
 * needs it, as `wonder-offline.ts` restates its own hash rather than importing the decision
 * policy's, and a change to either copy is correct on its own.
 */
const redact = (text: string, apiKey: string): string =>
  apiKey === '' ? text : text.split(apiKey).join('[redacted]');

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Why a 4xx was a 4xx, read from the one shape both models answer with:
 * `{"error": {"type", "message", "param", "code"}}`. `docs/meta-model-api.md` records that
 * body byte for byte on Wonder and on Spark — "so a single error reader serves both models"
 * — and the reason is the whole value of it: `model_not_found`, `unknown parameter
 * response_format`, and the strict-subset complaint that names the key a schema of ours
 * forgot are each a mistake of ours that a bare status would leave us guessing at.
 *
 * It is capped, because a gateway that answers HTML rather than the API's JSON would
 * otherwise put a page in an error message, and it is redacted by the caller like every
 * other string this module did not compose itself.
 */
const errorReason = (body: unknown): string => {
  if (typeof body === 'string') return body.trim().slice(0, 200);
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null) return '';
  const { type, code, param, message } = error as Record<string, unknown>;
  const named = [
    typeof type === 'string' ? type : '',
    typeof code === 'string' ? code : '',
    typeof param === 'string' ? `param ${param}` : '',
  ].filter((part) => part !== '');
  return [
    typeof message === 'string' ? message.slice(0, 200) : '',
    named.length === 0 ? '' : `(${named.join(', ')})`,
  ]
    .filter((part) => part !== '')
    .join(' ');
};

/** A timeout is told apart from a transport error, because they are different failures. */
const isTimeout = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.aborted) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError';
};

/**
 * The default transport: `fetch`, and nothing a test ever reaches.
 *
 * One attempt, where the decision provider's own `fetch` waits and asks again on a 429 or a
 * 503. A Wonder ask is a handful per test rather than one per screen per persona, and what
 * waits on it is a person in front of a screen rather than a run loop: a rate limit comes
 * back as `http_status` carrying the API's own reason, for the use to report, and the one
 * retry this implementation makes on its own is the one the seam asked for — a reply that
 * would not parse.
 */
const fetchTransport: WonderTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: JSON.stringify(request.body),
    signal: request.signal,
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    // Not JSON: the text itself is what came back, and the reader says so in words.
    return { status: response.status, body: text };
  }
};

export interface MetaWonderProviderOptions {
  /**
   * The key, when the caller already read it — `selectWonderProvider` does, so that the
   * decision about whether this process can call Wonder at all is made in one place.
   * Omitted, the key is read from the environment at call time.
   */
  readonly apiKey?: string;
  /**
   * Accepted so that this factory fits the shape `selectWonderProvider` calls it with, which
   * tells an implementation which model it was asked for rather than letting it close over
   * one. There is exactly one Wonder model, and the selection checks the provider's own
   * `modelId` against what it asked for, so a substitution is refused there (#143).
   */
  readonly modelId?: WonderModelId;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How the request is sent. Defaults to `fetch`. */
  readonly transport?: WonderTransport;
  readonly timeoutMs?: number;
}

/**
 * The schema as the strict structured-reply mode takes it. `z.toJSONSchema` writes a
 * discriminated union as `oneOf`, which that mode refuses with a `400` ("'oneOf' is not
 * permitted"); every union a use declares has branches of different shapes, so `anyOf` says
 * the same thing, and `parse` still holds the reply to the use's own schema.
 */
export const strictSubset = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(strictSubset);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key === 'oneOf' ? 'anyOf' : key,
      strictSubset(value),
    ]),
  );
};

/** The request one ask becomes: the document, the schema, the effort, and nothing else. */
const buildWonderRequest = (ask: WonderAsk<unknown>): WonderRequestBody => ({
  model: WONDER_MODEL_ID,
  // One turn. The use's own wording travels inside the document, because a prompt is the
  // use's business and this file holds none (`wonder.ts`).
  input: [{ role: 'user', content: [{ type: 'input_text', text: ask.document }] }],
  text: {
    format: {
      type: 'json_schema',
      name: ask.replySchema.name,
      schema: strictSubset(ask.replySchema.schema) as Readonly<Record<string, unknown>>,
      strict: true,
    },
  },
  reasoning: { effort: ask.effort ?? DEFAULT_WONDER_EFFORT },
  store: false,
  max_output_tokens: MAX_OUTPUT_TOKENS,
});

/** What several attempts at one ask spent together, as the five figures a reply reports. */
const billedUsage = (spent: readonly ReportedTokens[]): DecisionUsage => {
  const total = spent.reduce<ReportedTokens>(
    (sum, tokens) => ({
      inputTokens: sum.inputTokens + tokens.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + tokens.cachedInputTokens,
      outputTokens: sum.outputTokens + tokens.outputTokens,
      reasoningTokens: sum.reasoningTokens + tokens.reasoningTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
  return { ...total, estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, total) };
};

/**
 * Muse Wonder behind the seam, with its transport injected.
 *
 * It holds no prompt, knows nothing about any of the four uses and has no case per use: the
 * ask carries its document, its schema, its validator and its offline generator, so the four
 * uses after this file are written independently of it and of each other.
 */
export const createMetaWonderProvider = (
  options: MetaWonderProviderOptions = {},
): WonderProvider => {
  const transport = options.transport ?? fetchTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WONDER_TIMEOUT_MS;
  /** What every reply this provider produces is attributed to, and costed at. */
  const model: WonderModel = { mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID };

  /** Read at call time, never stored on the provider and never returned to a caller. */
  const readApiKey = (): string => {
    const env = options.env ?? process.env;
    return (options.apiKey ?? env[MODEL_API_KEY_ENV] ?? '').trim();
  };

  return {
    name: WONDER_PROVIDER_NAME,
    mode: 'model',
    modelId: WONDER_MODEL_ID,
    // `async`, so that every refusal is a rejected promise: a caller holding the promise
    // never sees one thrown synchronously, and the contract suite refuses through `.then`'s
    // second argument on purpose.
    ask: async <T>(ask: WonderAsk<T>): Promise<WonderReply<T>> => {
      const apiKey = readApiKey();

      const fail = (kind: WonderFailureKind, detail: string, status?: number): WonderCallError =>
        new WonderCallError({
          kind,
          // The key is redacted out of every message, including the ones an injected
          // transport or `fetch` composed and this module only passes on.
          message: redact(detail, apiKey),
          use: ask.use,
          ...(status === undefined ? {} : { status }),
        });

      if (apiKey === '') {
        throw fail(
          'credential',
          `${MODEL_API_KEY_ENV} is not in the environment, so the ${ask.use} ask was never sent`,
        );
      }

      const body = buildWonderRequest(ask);
      /**
       * What each attempt reported spending. A reply that could not be read was still
       * billed, so an asked-twice ask reports both calls rather than the cheaper story of
       * one: a run's cost is only checkable against an invoice if nothing is left out.
       */
      const spent: ReportedTokens[] = [];

      /** One request, one reading of the reply — or the failure that stopped it. */
      const attempt = async (): Promise<unknown> => {
        const signal = AbortSignal.timeout(timeoutMs);
        let response: ModelHttpResponse;
        try {
          response = await transport({
            url: META_RESPONSES_ENDPOINT,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // The one place the key appears, and it is never part of the body, the reply,
              // an error or anything this module records.
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal,
          });
        } catch (error) {
          const detail = messageOf(error);
          throw isTimeout(error, signal)
            ? fail('timeout', `the ${ask.use} ask did not answer within ${timeoutMs}ms: ${detail}`)
            : fail('transport', `the ${ask.use} ask could not be made: ${detail}`);
        }

        if (response.status < 200 || response.status >= 300) {
          const reason = errorReason(response.body);
          throw fail(
            'http_status',
            `the API answered ${response.status} to the ${ask.use} ask${reason === '' ? '' : `: ${reason}`}`,
            response.status,
          );
        }

        // Billed before it is read, and whatever becomes of it: an answer that arrived and
        // could not be read was still paid for, so the figures are taken off the response
        // rather than off the happy path — which is what makes an asked-twice ask report
        // both calls however the first one failed. A response reporting nothing reports five
        // zeroes.
        spent.push(readTokens((response.body as { usage?: unknown } | null)?.usage));

        const read = readResponse(response.body);
        if (!read.ok)
          throw fail(read.fault, `the ${ask.use} reply could not be read: ${read.detail}`);

        try {
          return JSON.parse(read.value.replyText) as unknown;
        } catch (error) {
          throw fail(
            'unparseable',
            `the ${ask.use} reply was not the JSON the schema constrains it to: ${messageOf(error)}`,
          );
        }
      };

      // Asked once more, and once only, when the reply could not be read at all — the one
      // failure a second identical request plausibly answers. A refusal, a timeout, a
      // non-2xx status and a reply the ask's own validator refused are not retried: the
      // first three are not a reply, and the last one is a reply that arrived and was wrong,
      // which is reported with its path rather than asked for again.
      const reply = await attempt().catch((thrown: unknown) => {
        if (!(thrown instanceof WonderCallError) || thrown.kind !== 'unparseable') throw thrown;
        return attempt().catch((again: unknown) => {
          if (!(again instanceof WonderCallError)) throw again;
          throw fail(
            again.kind,
            `${again.message} — asked twice, and refused rather than answered with an empty or defaulted object`,
            again.status,
          );
        });
      });

      return {
        // The ask's own validator, through the one place that behaviour lives for both
        // implementations: the parsed object, or an error naming the path.
        value: parseWonderReply(ask, reply, model),
        model,
        usage: billedUsage(spent),
      };
    },
  };
};
