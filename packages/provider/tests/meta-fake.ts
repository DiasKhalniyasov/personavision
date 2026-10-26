import type {
  ModelHttpRequest,
  ModelHttpResponse,
  ModelTransport,
  TrajectoryRecord,
} from '../src/meta-model.js';
import type { ResponsesMessage } from '../src/meta-request.js';

/**
 * The injected transport the Meta Model API provider is tested through, and the record of
 * what it was handed.
 *
 * Nothing here opens a socket, so the whole suite — the shared provider contract included —
 * runs in CI with no key and no network. The fake answers the way the real protocol does:
 * one `output` array carrying a reasoning item and an assistant message, and a `usage` block
 * with the two "of which" details the owner's model reports.
 */

/** A key-shaped string that is not a key, so that a hygiene assertion has something to hunt. */
export const TEST_KEY = 'test-model-key-0123456789-not-real';

export const TEST_ENV = { MODEL_API_KEY: TEST_KEY } as const;

/** What one fake reply reports spending. Chosen so every figure is distinguishable. */
export const FAKE_TOKENS = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 400 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 150 },
} as const;

const lastUserText = (input: readonly ResponsesMessage[]): string => {
  const message = [...input].reverse().find((item) => item.role === 'user');
  const part = message?.content.find((item) => item.type === 'input_text');
  return part !== undefined && 'text' in part ? part.text : '';
};

/** The element ids this screen's message lists, in the order it lists them. */
export const listedElementIds = (input: readonly ResponsesMessage[]): readonly string[] =>
  [...lastUserText(input).matchAll(/^- (\S+) · /gm)].map((match) => match[1] ?? '');

export interface FakeTransport {
  readonly transport: ModelTransport;
  /** Every request it was handed, in order. */
  readonly requests: ModelHttpRequest[];
}

/**
 * A transport that reads the screen it was sent and answers like a cooperative model: it
 * acts on the first element the screen lists — which in the shared fixtures is the one that
 * answers the goal — and scrolls when the agent has looked at nothing.
 */
export const fakeTransport = (
  options: {
    readonly usage?: unknown;
    readonly reply?: (elementIds: readonly string[]) => unknown;
  } = {},
): FakeTransport => {
  const requests: ModelHttpRequest[] = [];
  let call = 0;

  const transport: ModelTransport = (request) => {
    requests.push(request);
    call += 1;
    const ids = listedElementIds(request.body.input);
    const reply =
      options.reply?.(ids) ??
      (ids[0] === undefined
        ? {
            intent: 'Nothing here yet; I will look further down.',
            action: { kind: 'scroll', targetElementId: null },
          }
        : {
            intent: 'That looks like the thing I came for.',
            action: { kind: 'click', targetElementId: ids[0] },
            relevanceHints: { [ids[0]]: 0.9 },
          });

    const response: ModelHttpResponse = {
      status: 200,
      body: {
        id: `resp-${call}`,
        status: 'completed',
        output: [
          { type: 'reasoning', summary: ['weighed the options'] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(reply) }],
          },
        ],
        usage: options.usage ?? FAKE_TOKENS,
      },
    };
    return Promise.resolve(response);
  };

  return { transport, requests };
};

/** A sink that keeps what it was given, so a test can read the trajectory back. */
export const recordingSink = (): {
  readonly sink: (record: TrajectoryRecord) => void;
  readonly records: TrajectoryRecord[];
} => {
  const records: TrajectoryRecord[] = [];
  return { sink: (record) => void records.push(record), records };
};
