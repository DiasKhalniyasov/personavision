import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMetaModelApiProvider,
  META_RESPONSES_ENDPOINT,
  ModelDecisionError,
} from '../src/meta-model.js';
import type { ModelTransport, TrajectoryRecord } from '../src/meta-model.js';
import { buildScreenMessage, INSTRUCTIONS, readTokens, TOOLS } from '../src/meta-request.js';
import type { ResponsesMessage, ResponsesRequestBody } from '../src/meta-request.js';
import { estimateCostUsd, MODEL_ID_BY_MODE } from '../src/meta-pricing.js';
import {
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectDecisionProvider,
} from '../src/select.js';
import { OFFLINE_PROVIDER_NAME } from '../src/offline.js';
import { contextOf, element, SESSION_STEPS, walkSession } from './fixtures.js';
import { fakeTransport, FAKE_TOKENS, recordingSink, TEST_ENV, TEST_KEY } from './meta-fake.js';

/**
 * The Meta Model API provider's own tests: everything the shared contract suite cannot know
 * to ask for — the endpoint and the auth header, the mode a run asked for, the append-only
 * conversation the owner's caching depends on, the five usage figures and their price, the
 * trajectory hand-off, the typed failures, and the key never appearing anywhere.
 *
 * Every one of them injects a transport. Nothing here reaches the network, and the key in
 * play is a fake, so CI runs the lot with no credential of any kind.
 */

const anna = { personaId: 'p-anna', seed: 7 } as const;

/** A provider wired to a fresh fake, so a test can read what was sent. */
const withFake = (
  options: {
    readonly mode?: 'contributor' | 'standard';
    readonly usage?: unknown;
    readonly reply?: (ids: readonly string[]) => unknown;
  } = {},
) => {
  const fake = fakeTransport({
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.reply === undefined ? {} : { reply: options.reply }),
  });
  const sink = recordingSink();
  const provider = createMetaModelApiProvider({
    mode: options.mode ?? 'contributor',
    env: TEST_ENV,
    transport: fake.transport,
    trajectory: sink.sink,
  });
  return { provider, fake, sink };
};

/** A transport that answers 200 with whatever body a test wants to hand back. */
const answering =
  (body: unknown, status = 200): ModelTransport =>
  () =>
    Promise.resolve({ status, body });

const inputOf = (body: ResponsesRequestBody): readonly ResponsesMessage[] => body.input;

const textOf = (message: ResponsesMessage | undefined): string => {
  const part = message?.content.find((item) => item.type === 'input_text');
  return part !== undefined && 'text' in part ? part.text : '';
};

describe('the Meta Model API provider', () => {
  describe('the call it makes', () => {
    it('posts to the responses endpoint with a bearer header and the run’s model id', async () => {
      const { provider, fake } = withFake({ mode: 'standard' });

      await provider.beginSession(anna).decide(contextOf());

      const request = fake.requests[0];
      expect(request?.url).toBe(META_RESPONSES_ENDPOINT);
      expect(request?.method).toBe('POST');
      expect(request?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
      expect(request?.body.model).toBe('muse-spark-1.3');
    });

    it('sends the contributor model id in contributor mode', async () => {
      const { provider, fake } = withFake({ mode: 'contributor' });

      const decision = await provider.beginSession(anna).decide(contextOf());

      expect(fake.requests[0]?.body.model).toBe('muse-spark-1.3-contributor');
      expect(decision.model).toEqual({
        mode: 'contributor',
        modelId: 'muse-spark-1.3-contributor',
      });
    });

    it('reads the key from the environment at call time', async () => {
      vi.stubEnv(MODEL_API_KEY_ENV, TEST_KEY);
      const fake = fakeTransport();
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        transport: fake.transport,
      });

      await provider.decide(contextOf());

      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
      vi.unstubAllEnvs();
    });

    it('fails rather than calling when no key is in the environment', async () => {
      const fake = fakeTransport();
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        env: {},
        transport: fake.transport,
      });

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'credential' });
      expect(fake.requests).toHaveLength(0);
    });

    it('sets no reasoning effort, in either mode', async () => {
      for (const mode of ['contributor', 'standard'] as const) {
        const { provider, fake } = withFake({ mode });

        await provider.beginSession(anna).decide(contextOf());

        const body = fake.requests[0]?.body;
        expect(body === undefined ? 'missing' : 'reasoning' in body).toBe(false);
        expect(JSON.stringify(body)).not.toContain('effort');
      }
    });

    it('sends no screenshot to a model that does not accept image input', async () => {
      const { provider, fake } = withFake();
      expect(provider.readsImages).toBe(false);

      await provider
        .beginSession(anna)
        .decide(contextOf({ screenshot: { path: 'screenshots/a-browse.png' } }));

      expect(JSON.stringify(fake.requests[0]?.body)).not.toContain('a-browse.png');
      expect(JSON.stringify(fake.requests[0]?.body)).not.toContain('input_image');
    });

    it('sends the screenshot to a model that does accept image input', () => {
      const message = buildScreenMessage(
        contextOf({ screenshot: { path: 'screenshots/a-browse.png' } }),
        { acceptsImages: true },
      );

      expect(message.content).toContainEqual({
        type: 'input_image',
        image_url: 'screenshots/a-browse.png',
      });
    });
  });

  describe('one conversation per session, sent whole every turn', () => {
    it('carries the instructions, the persona and the tools in that order, every turn', async () => {
      const { provider, fake } = withFake();

      await walkSession(provider.beginSession(anna));

      expect(fake.requests).toHaveLength(SESSION_STEPS.length);
      for (const request of fake.requests) {
        const input = inputOf(request.body);
        expect(textOf(input[0])).toBe(INSTRUCTIONS);
        expect(textOf(input[1])).toContain('What you came to do');
        expect(textOf(input[2])).toBe(TOOLS);
      }
    });

    it('carries the history itself and never hands it to previous_response_id', async () => {
      const { provider, fake } = withFake();

      await walkSession(provider.beginSession(anna));

      for (const request of fake.requests) {
        // Sending the id as well would have the protocol prepend the stored turns and then
        // append ours: every earlier turn billed twice, which is the cost the whole caching
        // protocol exists to avoid.
        expect(JSON.stringify(request.body)).not.toContain('previous_response_id');
      }
      // Three messages of prefix, the first screen, its reply, and this screen.
      const second = fake.requests[1]?.body as ResponsesRequestBody;
      expect(inputOf(second)).toHaveLength(6);
      expect(textOf(inputOf(second)[0])).toBe(INSTRUCTIONS);
      expect(textOf(inputOf(second)[2])).toBe(TOOLS);
    });

    it('takes one turn at a time, however the caller overlaps them', async () => {
      const { provider, fake } = withFake();
      const session = provider.beginSession(anna);

      // Two screens asked for at once. Unserialised, both would be built from the same
      // conversation and the session's append-only history would be wrong from then on.
      await Promise.all([
        session.decide(contextOf({ step: SESSION_STEPS[0] })),
        session.decide(contextOf({ step: SESSION_STEPS[1] })),
      ]);

      const [first, second] = fake.requests.map((request) => inputOf(request.body));
      expect(first).toHaveLength(4);
      expect(second).toHaveLength(6);
      expect(JSON.stringify(second?.slice(0, 4))).toBe(JSON.stringify(first));
    });

    it('makes turn N’s input a byte-exact prefix of turn N+1’s across three screens', async () => {
      const { provider, fake } = withFake();

      await walkSession(provider.beginSession(anna));

      expect(fake.requests).toHaveLength(3);
      for (let turn = 1; turn < fake.requests.length; turn += 1) {
        const earlier = inputOf(fake.requests[turn - 1]?.body as ResponsesRequestBody);
        const later = inputOf(fake.requests[turn]?.body as ResponsesRequestBody);

        expect(later.length).toBeGreaterThan(earlier.length);
        expect(JSON.stringify(later.slice(0, earlier.length))).toBe(JSON.stringify(earlier));
      }
    });

    it('builds the same session twice into byte-identical requests', async () => {
      const first = withFake();
      const second = withFake();

      await walkSession(first.provider.beginSession(anna));
      await walkSession(second.provider.beginSession(anna));

      expect(JSON.stringify(second.fake.requests.map((request) => request.body))).toBe(
        JSON.stringify(first.fake.requests.map((request) => request.body)),
      );
    });

    it('refuses rather than re-rendering the prefix when a session’s task changes', async () => {
      const { provider } = withFake();
      const session = provider.beginSession(anna);

      await session.decide(contextOf());

      await expect(
        session.decide(contextOf({ goal: { text: 'Something else entirely' } })),
      ).rejects.toMatchObject({ kind: 'conversation' });
    });

    it('keeps a failed screen out of the conversation', async () => {
      const requests: ResponsesRequestBody[] = [];
      let call = 0;
      const transport: ModelTransport = (request) => {
        requests.push(request.body);
        call += 1;
        if (call === 2) return Promise.reject(new Error('the socket went away'));
        return fakeTransport().transport(request);
      };
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        env: TEST_ENV,
        transport,
      });
      const session = provider.beginSession(anna);

      await session.decide(contextOf({ step: SESSION_STEPS[0] }));
      await expect(session.decide(contextOf({ step: SESSION_STEPS[1] }))).rejects.toBeInstanceOf(
        ModelDecisionError,
      );
      await session.decide(contextOf({ step: SESSION_STEPS[2] }));

      // The third call opens with the first screen's turn, not with the one that failed:
      // the prefix and the one completed turn, then this screen.
      expect(requests[2]?.input).toHaveLength(6);
      expect(JSON.stringify(requests[2]?.input.slice(0, 5))).toBe(
        JSON.stringify(requests[1]?.input.slice(0, 5)),
      );
    });
  });

  describe('the prompt cache', () => {
    it('shares one cache key across the screens of a session and never between two', async () => {
      const { provider, fake } = withFake();

      await walkSession(provider.beginSession(anna));
      await walkSession(provider.beginSession({ personaId: 'p-boris', seed: 8 }));

      const keys = fake.requests.map((request) => request.body.prompt_cache_key);
      expect(new Set(keys.slice(0, 3)).size).toBe(1);
      expect(new Set(keys.slice(3)).size).toBe(1);
      expect(keys[0]).not.toBe(keys[3]);
    });

    it('asks for 24h retention on every call', async () => {
      const { provider, fake } = withFake();

      await walkSession(provider.beginSession(anna));

      for (const request of fake.requests) {
        expect(request.body.prompt_cache_retention).toBe('24h');
      }
    });

    it('derives the key from persona and seed, not from the conversation', async () => {
      const first = withFake();
      const second = withFake();

      await first.provider.beginSession(anna).decide(contextOf());
      await second.provider
        .beginSession(anna)
        .decide(contextOf({ fixatedElements: [element('el-other', 'Something else', 'link')] }));

      expect(second.fake.requests[0]?.body.prompt_cache_key).toBe(
        first.fake.requests[0]?.body.prompt_cache_key,
      );
    });
  });

  describe('what the call cost', () => {
    it('reports the five figures the response carries', async () => {
      const { provider } = withFake({ mode: 'standard' });

      const decision = await provider.beginSession(anna).decide(contextOf());

      expect(decision.usage).toEqual({
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 200,
        reasoningTokens: 150,
        estimatedCostUsd: 0.00166,
      });
    });

    it('prices the same usage at the rates of the model actually called', async () => {
      const standard = await withFake({ mode: 'standard' })
        .provider.beginSession(anna)
        .decide(contextOf());
      const contributor = await withFake({ mode: 'contributor' })
        .provider.beginSession(anna)
        .decide(contextOf());

      // (1000 − 400) × $1.25 + 400 × $0.15 + 200 × $4.25, per 1M.
      expect(standard.usage.estimatedCostUsd).toBe(0.00166);
      // (1000 − 400) × $0.10 + 400 × $0.002 + 200 × $0.20, per 1M.
      expect(contributor.usage.estimatedCostUsd).toBe(0.0001008);
      expect(standard.usage.estimatedCostUsd / contributor.usage.estimatedCostUsd).toBeCloseTo(
        16.468,
        3,
      );
    });

    it('counts reasoning tokens as billed output', () => {
      // The owner's measurement: 172 of 182 output tokens were reasoning on a one-word reply.
      const reasoning = estimateCostUsd('muse-spark-1.3', {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 182,
      });

      expect(reasoning).toBe(Number(((182 * 4.25) / 1_000_000).toFixed(10)));
    });

    it('records zero for a figure the response does not report, and fabricates none', async () => {
      const { provider } = withFake({
        mode: 'standard',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const decision = await provider.beginSession(anna).decide(contextOf());

      expect(decision.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        estimatedCostUsd: Number(((10 * 1.25 + 5 * 4.25) / 1_000_000).toFixed(10)),
      });
    });

    it('reads a missing usage block as five zeroes rather than as a guess', () => {
      expect(readTokens(undefined)).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      });
    });

    it('never reports more cached input, or more reasoning output, than there was', () => {
      expect(
        readTokens({
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 99 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 99 },
        }),
      ).toEqual({
        inputTokens: 10,
        cachedInputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 4,
      });
    });
  });

  describe('our own failures stay ours', () => {
    const failing = (transport: ModelTransport) => {
      const sink = recordingSink();
      return {
        sink,
        provider: createMetaModelApiProvider({
          mode: 'standard',
          env: TEST_ENV,
          transport,
          trajectory: sink.sink,
          timeoutMs: 20,
        }),
      };
    };

    it('surfaces a transport error as a typed automation failure', async () => {
      const { provider } = failing(() => Promise.reject(new Error('ECONNRESET')));

      const error = await provider.decide(contextOf()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ModelDecisionError);
      expect(error).toMatchObject({ kind: 'transport', attribution: 'automation' });
    });

    it('surfaces a timeout as a timeout, not as a transport error', async () => {
      const { provider } = failing(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason as Error));
          }),
      );

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('surfaces a refusal as a refusal', async () => {
      const { provider } = failing(
        answering({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
        }),
      );

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'refusal' });
    });

    it('surfaces an answer cut off by our own output cap as incomplete, not as a refusal', async () => {
      const { provider } = failing(
        answering({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', summary: [] }],
        }),
      );

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'incomplete' });
    });

    it('reads the reply off the assistant’s message and not off a reasoning item', async () => {
      const { provider } = failing(
        answering({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'output_text', text: 'I should probably click something.' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    intent: 'That is the jacket.',
                    action: { kind: 'click', targetElementId: 'el-jacket' },
                  }),
                },
              ],
            },
          ],
        }),
      );

      // Concatenating the reasoning item's text in front of the JSON would lose the screen,
      // and would replay into the conversation something the model never said.
      const decision = await provider.decide(contextOf());

      expect(decision.action).toEqual({ kind: 'click', targetElementId: 'el-jacket' });
    });

    it('drops a relevance hint it cannot use rather than the decision', async () => {
      const { provider } = withFake({
        reply: () => ({
          intent: 'That is the jacket.',
          action: { kind: 'click', targetElementId: 'el-jacket' },
          // One score on the wrong scale, one element from the screen before, one usable.
          relevanceHints: { 'el-jacket': 90, 'el-elsewhere': 0.5, 'el-home': 0.2 },
        }),
      });

      const decision = await provider.beginSession(anna).decide(contextOf());

      expect(decision.action).toEqual({ kind: 'click', targetElementId: 'el-jacket' });
      expect(decision.relevanceHints).toEqual({ 'el-home': 0.2 });
    });

    it('surfaces an unparseable reply as unparseable', async () => {
      const { provider } = failing(
        answering({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'I clicked it!' }] }],
        }),
      );

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'unparseable' });
    });

    it('surfaces a non-2xx answer with its status', async () => {
      const { provider } = failing(answering({ error: { message: 'overloaded' } }, 503));

      await expect(provider.decide(contextOf())).rejects.toMatchObject({
        kind: 'http_status',
        status: 503,
      });
    });

    it('refuses a decision that names an element the agent never looked at', async () => {
      const { provider } = failing(
        answering({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    intent: 'I will click the checkout button.',
                    action: { kind: 'click', targetElementId: 'el-never-seen' },
                  }),
                },
              ],
            },
          ],
        }),
      );

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'unparseable' });
    });
  });

  describe('the mode a run asked for', () => {
    it('never substitutes the contributor model, not on an error and not on a retry', async () => {
      const models: string[] = [];
      let call = 0;
      const transport: ModelTransport = (request) => {
        models.push(request.body.model);
        call += 1;
        if (call === 1) return Promise.reject(new Error('ECONNRESET'));
        return fakeTransport().transport(request);
      };
      const provider = createMetaModelApiProvider({
        mode: 'standard',
        env: TEST_ENV,
        transport,
      });
      const session = provider.beginSession(anna);

      await expect(session.decide(contextOf())).rejects.toMatchObject({ kind: 'transport' });
      const retried = await session.decide(contextOf());

      expect(models).toEqual(['muse-spark-1.3', 'muse-spark-1.3']);
      expect(models).not.toContain(MODEL_ID_BY_MODE.contributor);
      expect(retried.model).toEqual({ mode: 'standard', modelId: 'muse-spark-1.3' });
    });

    it('names the mode and the model id on every decision and every record', async () => {
      const { provider, sink } = withFake({ mode: 'standard' });

      const decision = await provider.beginSession(anna).decide(contextOf());

      expect(decision.model).toEqual({ mode: 'standard', modelId: 'muse-spark-1.3' });
      expect(sink.records).not.toHaveLength(0);
      for (const record of sink.records) {
        expect(record.mode).toBe('standard');
        expect(record.modelId).toBe('muse-spark-1.3');
      }
    });

    it('keeps the offline provider when no key is present, and never upgrades a run', () => {
      const createModelProvider = ({
        apiKey,
        modelMode,
      }: {
        readonly apiKey: string;
        readonly modelMode: 'contributor' | 'standard';
      }) => createMetaModelApiProvider({ mode: modelMode, apiKey });

      expect(selectDecisionProvider({ seed: 1, env: {}, createModelProvider }).provider.name).toBe(
        OFFLINE_PROVIDER_NAME,
      );
      expect(() =>
        selectDecisionProvider({
          seed: 1,
          env: {},
          requestedMode: { mode: 'model', modelMode: 'standard' },
          createModelProvider,
        }),
      ).toThrow(ModelModeUnavailableError);
      expect(
        selectDecisionProvider({
          seed: 1,
          env: { [MODEL_API_KEY_ENV]: TEST_KEY },
          createModelProvider,
        }).mode,
      ).toBe('model');
    });
  });

  describe('the trajectory hand-off', () => {
    it('hands over the request and the response, in order, on the happy path', async () => {
      const { provider, sink } = withFake();

      await provider.beginSession(anna).decide(contextOf());

      expect(sink.records.map((record) => record.kind)).toEqual(['request', 'response']);
      const [request, response] = sink.records;
      expect(request).toMatchObject({ kind: 'request', url: META_RESPONSES_ENDPOINT, turn: 1 });
      expect((request as Extract<TrajectoryRecord, { kind: 'request' }>).body.model).toBe(
        MODEL_ID_BY_MODE.contributor,
      );
      // The response verbatim: the reasoning item and the usage block included.
      expect(JSON.stringify(response)).toContain('"type":"reasoning"');
      expect(JSON.stringify(response)).toContain(
        String(FAKE_TOKENS.output_tokens_details.reasoning_tokens),
      );
    });

    it('hands over every turn of a session in order', async () => {
      const { provider, sink } = withFake();

      await walkSession(provider.beginSession(anna));

      expect(sink.records.map((record) => `${record.turn}:${record.kind}`)).toEqual([
        '1:request',
        '1:response',
        '2:request',
        '2:response',
        '3:request',
        '3:response',
      ]);
    });

    it('records the error on a transport error, a timeout and an unparseable reply', async () => {
      const cases: readonly [string, ModelTransport][] = [
        ['transport', () => Promise.reject(new Error('ECONNRESET'))],
        [
          'timeout',
          (request) =>
            new Promise((_resolve, reject) => {
              request.signal.addEventListener('abort', () =>
                reject(request.signal.reason as Error),
              );
            }),
        ],
        [
          'unparseable',
          answering({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }],
          }),
        ],
      ];

      for (const [kind, transport] of cases) {
        const sink = recordingSink();
        const provider = createMetaModelApiProvider({
          mode: 'contributor',
          env: TEST_ENV,
          transport,
          trajectory: sink.sink,
          timeoutMs: 20,
        });

        await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind });

        const kinds = sink.records.map((record) => record.kind);
        expect(kinds[0]).toBe('request');
        expect(kinds.at(-1)).toBe('failure');
        expect(sink.records.at(-1)).toMatchObject({ failure: { kind } });
      }
    });
  });

  describe('secret hygiene', () => {
    beforeEach(() => {
      vi.stubEnv(MODEL_API_KEY_ENV, TEST_KEY);
      return () => vi.unstubAllEnvs();
    });

    it('puts the key in no trajectory record, and no request header either', async () => {
      const sink = recordingSink();
      const fake = fakeTransport();
      const provider = createMetaModelApiProvider({
        mode: 'standard',
        transport: fake.transport,
        trajectory: sink.sink,
      });

      await walkSession(provider.beginSession(anna));

      const written = JSON.stringify(sink.records);
      expect(written).not.toContain(TEST_KEY);
      expect(written.toLowerCase()).not.toContain('authorization');
      expect(written.toLowerCase()).not.toContain('bearer');
      for (const record of sink.records) {
        expect(Object.keys(record)).not.toContain('headers');
      }
      // The transport did get the header: the redaction is of what is written, not of the call.
      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    });

    it('keeps the key out of a thrown error, its records and anything logged', async () => {
      const logs: unknown[] = [];
      for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => void logs.push(args));
      }
      const sink = recordingSink();
      const provider = createMetaModelApiProvider({
        mode: 'standard',
        // A transport whose own error quotes the key, as a careless client library would.
        transport: () => Promise.reject(new Error(`401 from https://api.meta.ai?key=${TEST_KEY}`)),
        trajectory: sink.sink,
      });

      const error = await provider
        .beginSession(anna)
        .decide(contextOf())
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ModelDecisionError);
      expect((error as Error).message).not.toContain(TEST_KEY);
      expect((error as Error).message).toContain('[redacted]');
      expect(JSON.stringify(sink.records)).not.toContain(TEST_KEY);
      expect(JSON.stringify(logs)).not.toContain(TEST_KEY);
      vi.restoreAllMocks();
    });

    it('redacts a response body that quotes the key back at us', async () => {
      const sink = recordingSink();
      const provider = createMetaModelApiProvider({
        mode: 'standard',
        // A 401 page that echoes the request, as a gateway or a proxy will.
        transport: () =>
          Promise.resolve({
            status: 401,
            body: { error: { message: `invalid key ${TEST_KEY}`, header: `Bearer ${TEST_KEY}` } },
          }),
        trajectory: sink.sink,
      });

      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'http_status' });

      const written = JSON.stringify(sink.records);
      expect(written).not.toContain(TEST_KEY);
      expect(written).toContain('[redacted]');
    });

    it('carries no credential and no credential path in its source', () => {
      const dir = fileURLToPath(new URL('../src/', import.meta.url));

      for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts'))) {
        const source = readFileSync(`${dir}${name}`, 'utf8');

        expect(source).not.toMatch(/\.config\/personavision/);
        expect(source).not.toMatch(/(?:sk|key)-[A-Za-z0-9]{12,}/);
      }
    });
  });

  describe('a trajectory sink that cannot write', () => {
    it('reports the write as its own failure when the call itself was fine', async () => {
      const fake = fakeTransport();
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        env: TEST_ENV,
        transport: fake.transport,
        trajectory: () => Promise.reject(new Error('ENOSPC: no space left on device')),
      });

      await expect(provider.decide(contextOf())).rejects.toMatchObject({
        kind: 'trajectory',
        attribution: 'automation',
      });
    });

    it('never replaces the failure it was asked to record', async () => {
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        env: TEST_ENV,
        transport: () => Promise.reject(new Error('ECONNRESET')),
        trajectory: (record) => {
          if (record.kind === 'failure') throw new Error('EBADF: the file is already closed');
        },
      });

      // The run loop is told the call failed on the transport, not that a file was shut.
      await expect(provider.decide(contextOf())).rejects.toMatchObject({ kind: 'transport' });
    });
  });

  describe('the price table', () => {
    it('is the only place in the package where a rate appears', () => {
      const dir = fileURLToPath(new URL('../src/', import.meta.url));
      const rates = ['1.25', '4.25', '0.002'];

      for (const name of readdirSync(dir).filter(
        (file) => file.endsWith('.ts') && file !== 'meta-pricing.ts',
      )) {
        const source = readFileSync(`${dir}${name}`, 'utf8');

        for (const rate of rates) {
          expect(source.includes(rate), `${name} restates the rate ${rate}`).toBe(false);
        }
      }
    });
  });
});
