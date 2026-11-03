import { WONDER_MODEL_ID } from '../src/meta-pricing.js';
import type { ModelHttpResponse } from '../src/meta-model.js';
import type { WonderHttpRequest, WonderTransport } from '../src/wonder-model.js';

/**
 * The injected transport the Muse Wonder provider is tested through, and the record of what
 * it was handed.
 *
 * Nothing here opens a socket, so the whole package — the one-shot contract suite included —
 * runs in CI with no key and no network. The fake answers the way the real protocol does and
 * as `docs/meta-model-api.md` records it: an `output` array whose **first** item is the
 * reasoning one and whose second is the assistant `message`, the reply as one `output_text`
 * part holding JSON as a string, a `usage` block with the two "of which" details, and
 * `model: muse-wonder-1.0` — the real id, because the suite prices the reply at the rates of
 * the model it names.
 */

/** A key-shaped string that is not a key, so that a hygiene assertion has something to hunt. */
export const TEST_KEY = 'test-wonder-key-0123456789-not-real';

export const TEST_ENV = { MODEL_API_KEY: TEST_KEY } as const;

/** What one fake reply reports spending. Chosen so every figure is distinguishable. */
export const FAKE_TOKENS = {
  input_tokens: 400,
  input_tokens_details: { cached_tokens: 120 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 210 },
  total_tokens: 700,
} as const;

/** The probe shape the contract suite asks for, answered the way a cooperative model would. */
export const fakeProbeReply = (call: number): string =>
  JSON.stringify({ headline: `a fake Wonder reply (call ${call})`, confidence: 0.5 });

export interface FakeWonderTransport {
  readonly transport: WonderTransport;
  /** Every request it was handed, in order. */
  readonly requests: WonderHttpRequest[];
}

/**
 * A transport that answers every ask with one schema-shaped object.
 *
 * `replyText` is the reply as the protocol carries it — a string in an `output_text` part —
 * so a test can hand back something that will not parse as easily as something that will.
 * `response` replaces the whole envelope, which is how a non-2xx status, a refusal item or an
 * `incomplete` answer is tested. Both are given the request and the 1-based call number, so
 * a test can fail the first attempt and answer the second.
 */
export const fakeTransport = (
  options: {
    readonly replyText?: (call: number, request: WonderHttpRequest) => string;
    readonly usage?: unknown;
    readonly response?: (call: number, request: WonderHttpRequest) => ModelHttpResponse;
  } = {},
): FakeWonderTransport => {
  const requests: WonderHttpRequest[] = [];
  let calls = 0;

  const transport: WonderTransport = (request) => {
    requests.push(request);
    calls += 1;
    const call = calls;
    if (options.response !== undefined) {
      return Promise.resolve(options.response(call, request));
    }
    return Promise.resolve({
      status: 200,
      body: {
        id: `resp-${call}`,
        object: 'response',
        status: 'completed',
        model: WONDER_MODEL_ID,
        error: null,
        incomplete_details: null,
        reasoning: { effort: request.body.reasoning.effort },
        text: { format: { ...request.body.text.format } },
        output: [
          // The reasoning item comes first on every observed Wonder response, which is why
          // the reply is read from `message` items rather than from `output[0]`.
          { type: 'reasoning', id: `rs-${call}`, summary: [], status: 'completed' },
          {
            type: 'message',
            id: `msg-${call}`,
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: (options.replyText ?? fakeProbeReply)(call, request),
                annotations: [],
              },
            ],
          },
        ],
        usage: options.usage ?? FAKE_TOKENS,
      },
    });
  };

  return { transport, requests };
};
