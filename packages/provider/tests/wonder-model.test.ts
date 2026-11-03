import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_RESPONSES_ENDPOINT } from '../src/meta-model.js';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { MAX_OUTPUT_TOKENS } from '../src/meta-request.js';
import { MODEL_API_KEY_ENV, selectWonderProvider } from '../src/select.js';
import { wonderProbeAsk, wonderRefusal } from '../src/testing.js';
import type { WonderProbe } from '../src/testing.js';
import { WONDER_EFFORTS, WonderReplyError } from '../src/wonder.js';
import type { WonderAsk, WonderProvider } from '../src/wonder.js';
import {
  createMetaWonderProvider,
  DEFAULT_WONDER_EFFORT,
  WONDER_PROVIDER_MODE,
  WONDER_PROVIDER_NAME,
  WonderCallError,
} from '../src/wonder-model.js';
import type { MetaWonderProviderOptions } from '../src/wonder-model.js';
import { fakeTransport, FAKE_TOKENS, TEST_ENV, TEST_KEY } from './wonder-fake.js';

/**
 * Muse Wonder behind the seam: what the exported one-shot contract suite does not already
 * hold every implementation to.
 *
 * The suite (`wonder-contract-suite.test.ts`) runs against this implementation with the same
 * fake transport and covers the shape of a reply, the five usage figures, the refusal with
 * its path and the facts a run records. What is here is what is true of **this**
 * implementation in particular: the request one ask becomes, the effort it sends when the ask
 * names none, the retry and its exact count, the credential it reads at call time and never
 * emits, and that no failure path hands back an object.
 *
 * Nothing in this file reaches the network: the transport is injected in every test, and the
 * environment is a literal rather than the process's own.
 */

/** An ask the fake answers, with a key-bearing environment behind the provider. */
const provider = (overrides: MetaWonderProviderOptions = {}): WonderProvider =>
  createMetaWonderProvider({ env: TEST_ENV, ...overrides });

const outcomeOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => value,
    (error: unknown) => error,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the facts a run records about the Muse Wonder provider', () => {
  it('names itself, runs in model mode and declares the one model it calls', () => {
    const wonder = provider();

    expect(wonder.name).toBe(WONDER_PROVIDER_NAME);
    expect(wonder.mode).toBe('model');
    // The selection checks this against the model it asked for, so a substitution is caught
    // there rather than costed at the wrong rates here.
    expect(wonder.modelId).toBe(WONDER_MODEL_ID);
  });

  it('is what `selectWonderProvider` builds when a caller names the model', () => {
    const selected = selectWonderProvider({
      env: TEST_ENV,
      requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      createModelProvider: ({ apiKey, modelId }) =>
        createMetaWonderProvider({ apiKey, modelId, transport: fakeTransport().transport }),
    });

    expect(selected.mode).toBe('model');
    expect(selected.modelId).toBe(WONDER_MODEL_ID);
    expect(selected.provider.name).toBe(WONDER_PROVIDER_NAME);
    // The reason a run log prints never carries the key it was selected with.
    expect(selected.reason).not.toContain(TEST_KEY);
  });
});

describe('one ask becomes one request', () => {
  it('sends the document, the ask’s schema as the structured-reply parameter, and nothing kept server-side', async () => {
    const fake = fakeTransport();
    const ask = wonderProbeAsk({ use: 'goal', document: 'a site and a feature under test' });

    await provider({ transport: fake.transport }).ask(ask);

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.url).toBe(META_RESPONSES_ENDPOINT);
    expect(request?.method).toBe('POST');

    const body = request?.body;
    expect(body?.model).toBe(WONDER_MODEL_ID);
    // One turn, carrying the document as the ask handed it over: the use's own wording
    // travels inside it, and this file holds no prompt of its own.
    expect(body?.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: ask.document }] },
    ]);
    // The protocol's structured-output parameter, with `strict: true` — the Chat Completions
    // spelling `response_format` is a `400` on this endpoint.
    expect(body?.text.format).toEqual({
      type: 'json_schema',
      name: ask.replySchema.name,
      schema: ask.replySchema.schema,
      strict: true,
    });
    expect(body && 'response_format' in body).toBe(false);
    expect(body?.store).toBe(false);
    expect(body?.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('sends the effort the ask asked for', async () => {
    const fake = fakeTransport();

    await provider({ transport: fake.transport }).ask(wonderProbeAsk({ effort: 'minimal' }));

    expect(fake.requests[0]?.body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('still sends an effort when the ask names none, rather than letting the model’s own default stand', async () => {
    const fake = fakeTransport();
    const asked = wonderProbeAsk();
    // The ask as a use that expressed no preference builds it: every field but the effort.
    const noEffort: WonderAsk<WonderProbe> = {
      use: asked.use,
      document: asked.document,
      seed: asked.seed,
      replySchema: asked.replySchema,
      parse: asked.parse,
      offline: asked.offline,
    };

    await provider({ transport: fake.transport }).ask(noEffort);

    const sent = fake.requests[0]?.body.reasoning.effort;
    expect(WONDER_EFFORTS).toContain(sent);
    expect(sent).toBe(DEFAULT_WONDER_EFFORT);
    // Omitting `reasoning` is the most expensive setting there is on this model: its own
    // default is `max`, which spent 357 reasoning tokens of 381 on a one-word answer.
    expect(sent).not.toBe('max');
  });

  it('makes one request per ask and keeps nothing between them', async () => {
    const fake = fakeTransport();
    const wonder = provider({ transport: fake.transport });

    await wonder.ask(wonderProbeAsk({ use: 'audience', seed: 1 }));
    await wonder.ask(wonderProbeAsk({ use: 'analysis', seed: 2 }));

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.body.input).toEqual(fake.requests[0]?.body.input);
  });
});

describe('what a reply reports spending', () => {
  it('reads the five figures from the documented paths and prices them from the one table', async () => {
    const reply = await provider({ transport: fakeTransport().transport }).ask(wonderProbeAsk());

    const tokens = {
      inputTokens: FAKE_TOKENS.input_tokens,
      cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens,
      outputTokens: FAKE_TOKENS.output_tokens,
      reasoningTokens: FAKE_TOKENS.output_tokens_details.reasoning_tokens,
    };
    expect(reply.usage).toEqual({
      ...tokens,
      estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokens),
    });
    // And the model that answered travels with the answer, in this implementation's own word
    // for the one tier Muse Wonder has.
    expect(reply.model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });
  });

  it('reports a figure the response does not as zero, never as a guess', async () => {
    const fake = fakeTransport({ usage: { input_tokens: 90, output_tokens: 40 } });

    const reply = await provider({ transport: fake.transport }).ask(wonderProbeAsk());

    expect(reply.usage.inputTokens).toBe(90);
    expect(reply.usage.cachedInputTokens).toBe(0);
    expect(reply.usage.reasoningTokens).toBe(0);
  });
});

describe('a reply the ask’s own validator refuses', () => {
  const refusals: readonly {
    readonly what: string;
    readonly replyText: string;
    readonly path: string;
  }[] = [
    {
      what: 'a missing field',
      replyText: JSON.stringify({ headline: 'no confidence came back' }),
      path: 'confidence',
    },
    {
      what: 'a field of the wrong type',
      replyText: JSON.stringify({ headline: 'a confidence as prose', confidence: 'high' }),
      path: 'confidence',
    },
  ];

  for (const refusal of refusals) {
    it(`reports ${refusal.what} as an error naming the path, and hands back no object`, async () => {
      const fake = fakeTransport({ replyText: () => refusal.replyText });

      const outcome = await outcomeOf(
        provider({ transport: fake.transport }).ask(wonderProbeAsk({ use: 'analysis' })),
      );

      expect(outcome).toBeInstanceOf(WonderReplyError);
      const error = outcome as WonderReplyError;
      expect(error.paths).toContain(refusal.path);
      expect(error.message).toContain(refusal.path);
      expect(error.use).toBe('analysis');
      // The model that produced the refused reply, so a reader knows what to re-ask.
      expect(error.model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });
      expect(error.attribution).toBe('automation');
      // Asked once: a reply that arrived and was wrong is reported with its path, not asked
      // for again in the hope of a better one.
      expect(fake.requests).toHaveLength(1);
    });
  }

  it('reports a citation naming a session the run does not have as an error naming the path', async () => {
    // What `docs/meta-model-api.md` warns about: a schema-valid reply that is simply not
    // true — the live change call named a file that was in no request. The ask validates the
    // content, and this implementation runs that validator over the reply like any other.
    const sessionsInTheRun = new Set(['S-01', 'S-02']);
    const ask = wonderProbeAsk({
      use: 'analysis',
      parse: (reply) => {
        const cited = (reply as { sessionId?: string }).sessionId ?? '';
        if (!sessionsInTheRun.has(cited)) {
          throw wonderRefusal(
            ['citations', 0, 'sessionId'],
            `${cited === '' ? 'no session' : cited} is not a session this run holds`,
          );
        }
        return { headline: 'cited', confidence: 1 };
      },
    });
    const fake = fakeTransport({
      replyText: () => JSON.stringify({ headline: 'cited', confidence: 1, sessionId: 'S-99' }),
    });

    const outcome = await outcomeOf(provider({ transport: fake.transport }).ask(ask));

    expect(outcome).toBeInstanceOf(WonderReplyError);
    expect((outcome as WonderReplyError).paths).toContain('citations[0].sessionId');
    expect((outcome as WonderReplyError).message).toContain('S-99');
  });
});

describe('a reply that will not parse', () => {
  it('is asked for exactly once more and then refused with the reason', async () => {
    const fake = fakeTransport({ replyText: () => 'Sure! Here is the object: {oops' });

    const outcome = await outcomeOf(
      provider({ transport: fake.transport }).ask(wonderProbeAsk({ use: 'change' })),
    );

    // Exactly twice: once, and once more. Not three times, and not once.
    expect(fake.requests).toHaveLength(2);
    expect(outcome).toBeInstanceOf(WonderCallError);
    const error = outcome as WonderCallError;
    expect(error.kind).toBe('unparseable');
    expect(error.use).toBe('change');
    expect(error.attribution).toBe('automation');
    expect(error.modelId).toBe(WONDER_MODEL_ID);
    // The reason travels in the message, rather than an empty answer travelling instead.
    expect(error.message).toContain('asked twice');
    expect(error.message.toLowerCase()).toMatch(/json/);
  });

  it('takes the second reply when the second one parses, and bills both calls', async () => {
    const fake = fakeTransport({
      replyText: (call) =>
        call === 1
          ? 'not JSON at all'
          : JSON.stringify({ headline: 'the second attempt', confidence: 0.25 }),
    });

    const reply = await provider({ transport: fake.transport }).ask(wonderProbeAsk());

    expect(fake.requests).toHaveLength(2);
    expect(reply.value).toEqual({ headline: 'the second attempt', confidence: 0.25 });
    // A reply that could not be read was still billed, so an asked-twice ask reports both
    // calls: a run's cost is only checkable against an invoice if nothing is left out.
    expect(reply.usage.inputTokens).toBe(FAKE_TOKENS.input_tokens * 2);
    expect(reply.usage.estimatedCostUsd).toBe(
      estimateCostUsd(WONDER_MODEL_ID, {
        inputTokens: FAKE_TOKENS.input_tokens * 2,
        cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens * 2,
        outputTokens: FAKE_TOKENS.output_tokens * 2,
      }),
    );
  });
});

describe('what a failed attempt still cost', () => {
  it('bills an answer that arrived and could not be read, not only the one that could', async () => {
    const fake = fakeTransport({
      response: (call, request) =>
        call === 1
          ? // An envelope with nothing to read a reply from — the one failure asked again —
            // and a usage block, because the call was made and therefore billed.
            { status: 200, body: { status: 'completed', output: [], usage: FAKE_TOKENS } }
          : {
              status: 200,
              body: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({ headline: `read on call ${call}`, confidence: 0.5 }),
                      },
                    ],
                  },
                ],
                usage: FAKE_TOKENS,
                model: request.body.model,
              },
            },
    });

    const reply = await provider({ transport: fake.transport }).ask(wonderProbeAsk());

    expect(fake.requests).toHaveLength(2);
    expect(reply.usage.inputTokens).toBe(FAKE_TOKENS.input_tokens * 2);
    expect(reply.usage.outputTokens).toBe(FAKE_TOKENS.output_tokens * 2);
  });
});

describe('a call that produced no reply at all', () => {
  const broken: readonly {
    readonly what: string;
    readonly kind: string;
    readonly transport: Parameters<typeof fakeTransport>[0];
    readonly asked: number;
    readonly says: string;
  }[] = [
    {
      what: 'a non-2xx status',
      kind: 'http_status',
      transport: {
        response: () => ({ status: 429, body: { error: { message: 'slow down' } } }),
      },
      asked: 1,
      says: '429',
    },
    {
      // The one shape both models answer an error with, which is why one reader serves both:
      // the status alone would leave a schema this project got wrong looking like weather.
      what: 'the reason the API gave for refusing the request',
      kind: 'http_status',
      transport: {
        response: () => ({
          status: 400,
          body: {
            error: {
              type: 'invalid_request_error',
              code: null,
              message: 'unknown parameter `response_format`',
              param: 'response_format',
            },
          },
        }),
      },
      asked: 1,
      says: 'unknown parameter `response_format`',
    },
    {
      what: 'a refusal, which is an item on an HTTP 200',
      kind: 'refusal',
      transport: {
        response: () => ({
          status: 200,
          body: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I will not' }] }],
          },
        }),
      },
      asked: 1,
      says: 'I will not',
    },
    {
      what: 'an answer our own output cap cut off',
      kind: 'incomplete',
      transport: {
        response: () => ({
          status: 200,
          body: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          },
        }),
      },
      asked: 1,
      says: 'max_output_tokens',
    },
    {
      what: 'an envelope carrying no reply to read',
      kind: 'unparseable',
      transport: {
        response: () => ({ status: 200, body: { status: 'completed', output: [] } }),
      },
      // The one failure a second identical request plausibly answers.
      asked: 2,
      says: 'no output text',
    },
  ];

  for (const shape of broken) {
    it(`reports ${shape.what} as a ${shape.kind} failure and no object`, async () => {
      const fake = fakeTransport(shape.transport);

      const outcome = await outcomeOf(
        provider({ transport: fake.transport }).ask(wonderProbeAsk()),
      );

      expect(outcome).toBeInstanceOf(WonderCallError);
      expect((outcome as WonderCallError).kind).toBe(shape.kind);
      expect((outcome as WonderCallError).message).toContain(shape.says);
      expect(fake.requests).toHaveLength(shape.asked);
    });
  }

  it('tells a transport error and a timeout apart, and retries neither', async () => {
    let calls = 0;
    const dropped = await outcomeOf(
      provider({
        transport: () => {
          calls += 1;
          return Promise.reject(new Error('fetch failed'));
        },
      }).ask(wonderProbeAsk()),
    );

    expect((dropped as WonderCallError).kind).toBe('transport');
    expect(calls).toBe(1);

    const timedOut = await outcomeOf(
      provider({
        transport: () =>
          Promise.reject(Object.assign(new Error('the signal fired'), { name: 'AbortError' })),
      }).ask(wonderProbeAsk()),
    );

    expect((timedOut as WonderCallError).kind).toBe('timeout');
  });

  it('refuses an ask with no key in the environment without making a request, and rejects rather than throwing', async () => {
    let calls = 0;
    const outcome = await outcomeOf(
      createMetaWonderProvider({
        env: {},
        transport: () => {
          calls += 1;
          return Promise.reject(new Error('never reached'));
        },
      }).ask(wonderProbeAsk()),
    );

    expect(outcome).toBeInstanceOf(WonderCallError);
    expect((outcome as WonderCallError).kind).toBe('credential');
    expect((outcome as WonderCallError).message).toContain(MODEL_API_KEY_ENV);
    expect(calls).toBe(0);
  });

  it('hands back no object on any of them: a failure is never an empty or defaulted answer', async () => {
    const outcomes = await Promise.all(
      [
        fakeTransport({ replyText: () => '{' }),
        fakeTransport({ response: () => ({ status: 500, body: 'bad gateway' }) }),
        fakeTransport({ replyText: () => JSON.stringify({ headline: '', confidence: 7 }) }),
      ].map(async (fake) =>
        outcomeOf(provider({ transport: fake.transport }).ask(wonderProbeAsk())),
      ),
    );

    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toHaveProperty('value');
    }
  });
});

describe('the key never leaves the closure it is read in', () => {
  it('puts it in one header and in nothing else', async () => {
    const fake = fakeTransport();

    await provider({ transport: fake.transport }).ask(wonderProbeAsk());

    const request = fake.requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.stringify(request?.body)).not.toContain(TEST_KEY);
    const headers = { ...request?.headers };
    delete headers.authorization;
    expect(JSON.stringify(headers)).not.toContain(TEST_KEY);
  });

  it('reads it at call time, so a key that arrives after the provider was built is the one used', async () => {
    const env: Record<string, string | undefined> = {};
    const fake = fakeTransport();
    const wonder = createMetaWonderProvider({ env, transport: fake.transport });

    expect((await outcomeOf(wonder.ask(wonderProbeAsk()))) instanceof WonderCallError).toBe(true);

    Object.assign(env, TEST_ENV);
    await wonder.ask(wonderProbeAsk());

    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('redacts it out of every error it throws, and logs nothing at all', async () => {
    const logs = (['debug', 'error', 'info', 'log', 'warn'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );

    // Three ways the key could come back out at us, and all three travel through a message
    // of ours: a transport whose own error quotes it, a model refusal that reads it straight
    // back, and the API's own error body — a 401 page, a proxy that logs what it received.
    const thrown = await outcomeOf(
      provider({
        transport: () => Promise.reject(new Error(`401 for Bearer ${TEST_KEY}`)),
      }).ask(wonderProbeAsk()),
    );
    const refused = await outcomeOf(
      provider({
        transport: () =>
          Promise.resolve({
            status: 200,
            body: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'refusal', refusal: `I saw Bearer ${TEST_KEY}` }],
                },
              ],
            },
          }),
      }).ask(wonderProbeAsk()),
    );
    // And a body that echoes it — a 401 page, a proxy that logs what it received: the status
    // is all our message carries, and the body it came from never joins it.
    const echoed = await outcomeOf(
      provider({
        transport: () =>
          Promise.resolve({
            status: 401,
            body: {
              error: {
                type: 'invalid_request_error',
                message: `Bearer ${TEST_KEY} is not a valid key`,
                param: null,
                code: null,
              },
            },
          }),
      }).ask(wonderProbeAsk()),
    );

    for (const outcome of [thrown, refused, echoed]) {
      expect((outcome as Error).message).toContain('[redacted]');
    }
    for (const outcome of [thrown, refused, echoed]) {
      expect(outcome).toBeInstanceOf(Error);
      const error = outcome as Error;
      expect(error.message).not.toContain(TEST_KEY);
      // Every own property of the error, not only its message: a key on a field would reach
      // a log line that printed the error rather than read it.
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TEST_KEY);
    }

    // Nothing here writes a record, a file or a log line, so there is no fourth place to
    // check: the module emits none.
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
