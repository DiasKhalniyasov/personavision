import { describe, expect, it } from 'vitest';
import { META_RESPONSES_ENDPOINT } from '../src/meta-model.js';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { MODEL_API_KEY_ENV, selectWonderProvider } from '../src/select.js';
import { wonderRefusal } from '../src/testing.js';
import type { WonderAsk } from '../src/wonder.js';
import { createMetaWonderProvider, WONDER_PROVIDER_MODE } from '../src/wonder-model.js';

/**
 * The one test in this package that calls **Muse Wonder** (#248).
 *
 * It runs when `MODEL_API_KEY` is in the environment and skips — visibly, with the reason in
 * its name — when it is not, so a fresh clone and CI have nothing to configure and make no
 * call. There is no cheaper tier to run it on: `muse-wonder-1.0-contributor` does not exist
 * (`404 model_not_found`), so this test is deliberately the smallest Wonder call that still
 * proves the envelope — one short document in, one small object out, at
 * `reasoning.effort: "minimal"`. That is what keeps it at about half a cent: observed
 * 2026-11-03, 67 input tokens and 213 output of which 187 were reasoning, $0.0045. At
 * Wonder's own default effort of `"max"` the same question costs several times that.
 *
 * What it is here to hold still is `docs/meta-model-api.md`'s Muse Wonder section: that a
 * schema in `text.format` comes back as parseable JSON matching it, that the reply is read
 * from `output` items of type `message` and not from `output[0]`, and that all five usage
 * paths the document names are present and are numbers the existing estimator prices. If
 * the API moves, this test fails and the document is what gets corrected.
 *
 * It prints what it observed, so the figures written down can be checked against a run of
 * it rather than taken on trust.
 */

const apiKey = process.env[MODEL_API_KEY_ENV]?.trim() ?? '';
const live = apiKey === '' ? it.skip : it;
const skipped = apiKey === '' ? ` — skipped: no ${MODEL_API_KEY_ENV} in the environment` : '';

/** The reply is read from `message` items only: `output[0]` is the reasoning item. */
const replyText = (body: unknown): string => {
  const output = (body as { output?: readonly Record<string, unknown>[] }).output ?? [];
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content ?? []) as readonly Record<string, unknown>[])
    .filter((part) => part.type === 'output_text')
    .map((part) => String(part.text))
    .join('');
};

describe('the live Muse Wonder API', () => {
  live(
    `answers a document with a schema-constrained object and reports the five usage figures${skipped}`,
    async () => {
      // The smallest call of the four shapes the step needs: a document in, a structured
      // object out. The schema is the request's own `text.format` — the Responses
      // protocol's structured-output parameter. `response_format`, the Chat Completions
      // spelling, is rejected here with `400 unknown parameter`.
      const request = {
        model: WONDER_MODEL_ID,
        input: [
          {
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'You read one sentence about an audience and answer with the object asked for. The share of phone users is a number between 0 and 1.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'busy parents in Almaty who shop on their phones' },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'AudienceProbe',
            schema: {
              type: 'object',
              properties: {
                region: { type: 'string' },
                phoneShare: { type: 'number' },
              },
              required: ['region', 'phoneShare'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
        // Wonder's own default is `"max"`, which spends several hundred reasoning tokens on
        // a question this short. The test asks for the floor instead.
        reasoning: { effort: 'minimal' },
        // The provider sends this for every Spark call and this test does the same: nothing
        // of ours is kept server-side for retrieval.
        store: false,
        max_output_tokens: 2048,
      };

      const response = await fetch(META_RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const raw = await response.text();

      expect(response.status).toBe(200);

      const body = JSON.parse(raw) as Record<string, unknown>;

      // The envelope: an HTTP 200 still says in the body whether it finished, and the two
      // statuses are separate figures.
      expect(body.object).toBe('response');
      expect(body.status).toBe('completed');
      expect(body.model).toBe(WONDER_MODEL_ID);
      expect(body.error).toBeNull();
      expect(body.incomplete_details).toBeNull();

      // `output` is an array holding more than the reply, which is why the reply is read by
      // filtering for `message` rather than by taking `output[0]`. The *order* is only ever
      // an observation — every observed response put the `reasoning` item first — so this
      // asserts what the read rule needs and not an ordering the API never promised.
      const output = body.output as readonly Record<string, unknown>[];
      expect(output.map((item) => item.type)).toContain('reasoning');
      expect(output.map((item) => item.type)).toContain('message');

      // The structured reply: schema-constrained, so it parses and it has the two fields.
      const text = replyText(body);
      expect(text).not.toBe('');
      const parsed = JSON.parse(text) as { region?: unknown; phoneShare?: unknown };
      expect(typeof parsed.region).toBe('string');
      expect(typeof parsed.phoneShare).toBe('number');
      expect(Object.keys(parsed).sort()).toEqual(['phoneShare', 'region']);

      // The five usage paths the document names, each present and a number.
      const usage = body.usage as {
        input_tokens: number;
        input_tokens_details: { cached_tokens: number };
        output_tokens: number;
        output_tokens_details: { reasoning_tokens: number };
        total_tokens: number;
      };
      expect(typeof usage.input_tokens).toBe('number');
      expect(typeof usage.input_tokens_details.cached_tokens).toBe('number');
      expect(typeof usage.output_tokens).toBe('number');
      expect(typeof usage.output_tokens_details.reasoning_tokens).toBe('number');
      expect(typeof usage.total_tokens).toBe('number');
      expect(usage.input_tokens).toBeGreaterThan(0);
      expect(usage.output_tokens).toBeGreaterThan(0);
      expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);

      // Both breakdowns are "of which", not extras.
      expect(usage.input_tokens_details.cached_tokens).toBeLessThanOrEqual(usage.input_tokens);
      expect(usage.output_tokens_details.reasoning_tokens).toBeLessThanOrEqual(usage.output_tokens);

      // And a Wonder call is costed by the estimator every other call is costed by: the
      // rates are rows in `meta-pricing.ts` and there is no second arithmetic for Wonder.
      const estimatedCostUsd = estimateCostUsd(WONDER_MODEL_ID, {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details.cached_tokens,
        outputTokens: usage.output_tokens,
      });
      expect(estimatedCostUsd).toBeGreaterThan(0);

      // What it observed, so the figures in `docs/meta-model-api.md` can be checked against
      // a run of this test. The reply and the usage object only — never a request header.
      console.info(
        'live Muse Wonder',
        JSON.stringify({
          model: body.model,
          bodyStatus: body.status,
          outputItems: output.map((item) => item.type),
          reply: parsed,
          usage,
          estimatedCostUsd,
        }),
      );

      // The key is in one header and nowhere else: not in the response, not in what this
      // test logged, not in the request it built.
      expect(raw).not.toContain(apiKey);
      expect(JSON.stringify(request)).not.toContain(apiKey);
    },
    180_000,
  );
});

/**
 * The same API, walked through the provider rather than through `fetch` (#255).
 *
 * The case above is the record of the protocol; this one is the implementation held to it.
 * It asks for the model **by name**, because a Wonder request that names nothing is offline
 * even on a machine with a key — there is no cheap tier to default into — and it goes through
 * `selectWonderProvider` so that the one path a run takes is the path this test takes. It
 * skips, visibly and with the reason in its name, when the key is absent.
 *
 * What it holds still is the documented envelope as the provider reads it: that one ask
 * becomes one schema-constrained object the ask's own validator accepts, that the model and
 * its tier travel with the answer, and that the five usage figures come back priced by the
 * one estimator. It costs about half a cent, at `reasoning.effort: "minimal"`.
 */

interface AudiencePlace {
  readonly region: string;
  readonly phoneShare: number;
}

const audiencePlaceAsk: WonderAsk<AudiencePlace> = {
  use: 'audience',
  document: [
    'You read one sentence about an audience and answer with the object asked for.',
    'The share of phone users is a number between 0 and 1.',
    '',
    'busy parents in Almaty who shop on their phones',
  ].join('\n'),
  seed: 7,
  replySchema: {
    name: 'AudiencePlace',
    schema: {
      type: 'object',
      properties: { region: { type: 'string' }, phoneShare: { type: 'number' } },
      required: ['region', 'phoneShare'],
      additionalProperties: false,
    },
  },
  effort: 'minimal',
  // The content, after the parse: a schema guarantees JSON and not truth, so a share outside
  // `[0, 1]` is refused with its path rather than accepted.
  parse: (reply) => {
    const { region, phoneShare } = (reply ?? {}) as Partial<AudiencePlace>;
    if (typeof region !== 'string' || region.trim() === '') {
      throw wonderRefusal(['region'], 'an audience names the place it is in');
    }
    if (typeof phoneShare !== 'number' || !(phoneShare >= 0 && phoneShare <= 1)) {
      throw wonderRefusal(['phoneShare'], 'a share of phone users is on [0, 1]');
    }
    return { region, phoneShare };
  },
  offline: () => ({ region: 'Almaty', phoneShare: 0.5 }),
};

describe('the live Muse Wonder provider', () => {
  live(
    `answers one ask with the object its validator accepts, and prices it from the one table${skipped}`,
    async () => {
      // Named, not defaulted: asked for nothing, selection is offline even with a key.
      const selected = selectWonderProvider({
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
        createModelProvider: createMetaWonderProvider,
      });

      expect(selected.mode).toBe('model');
      expect(selected.modelId).toBe(WONDER_MODEL_ID);

      const reply = await selected.provider.ask(audiencePlaceAsk);

      // The ask's own validator ran, so this is its object and not the raw reply.
      expect(typeof reply.value.region).toBe('string');
      expect(reply.value.phoneShare).toBeGreaterThanOrEqual(0);
      expect(reply.value.phoneShare).toBeLessThanOrEqual(1);

      // The model that answered, in the one tier Muse Wonder has.
      expect(reply.model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });

      // The five figures, from the paths `docs/meta-model-api.md` names, priced by the one
      // estimator at the rates of the model actually called.
      expect(reply.usage.inputTokens).toBeGreaterThan(0);
      expect(reply.usage.outputTokens).toBeGreaterThan(0);
      expect(reply.usage.cachedInputTokens).toBeLessThanOrEqual(reply.usage.inputTokens);
      expect(reply.usage.reasoningTokens).toBeLessThanOrEqual(reply.usage.outputTokens);
      expect(reply.usage.estimatedCostUsd).toBe(
        estimateCostUsd(WONDER_MODEL_ID, {
          inputTokens: reply.usage.inputTokens,
          cachedInputTokens: reply.usage.cachedInputTokens,
          outputTokens: reply.usage.outputTokens,
        }),
      );

      // The reply and what it cost, so the figures written down can be checked against a run
      // of this test. Never a request header.
      console.info(
        'live Muse Wonder through the provider',
        JSON.stringify({ value: reply.value, model: reply.model, usage: reply.usage }),
      );
      expect(JSON.stringify(reply)).not.toContain(apiKey);
    },
    180_000,
  );
});
