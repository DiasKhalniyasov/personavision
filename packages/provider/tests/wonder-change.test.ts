import { changeSchema } from '@personavision/contract';
import type { Change, Recommendation } from '@personavision/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { WonderReplyError } from '../src/wonder.js';
import {
  applyUnifiedPatch,
  CHANGE_EFFORT,
  CHANGE_REPLY_SCHEMA_NAME,
  changeAsk,
  decideChange,
  SIMULATED_LABEL,
} from '../src/wonder-change.js';
import type { ChangeAskInput } from '../src/wonder-change.js';
import { createMetaWonderProvider, WONDER_PROVIDER_MODE } from '../src/wonder-model.js';
import { createOfflineWonderProvider } from '../src/wonder-offline.js';
import { fakeTransport, FAKE_TOKENS, TEST_ENV } from './wonder-fake.js';

/**
 * The one change Muse Wonder decides (#263): one change out of ranked recommendations and
 * the files it was handed, refused with the path when it names anything it was not given,
 * when its patch does not apply, or when its pull-request body does not say its numbers are
 * simulated.
 *
 * Nothing here reaches the network, reads the repository or talks to GitHub: the offline
 * implementation is the default, the model implementation is driven by the recorded
 * transport the whole package is tested through, and the files the change may touch are
 * literals in this file.
 */

const citation = { kind: 'session', sessionId: 'S-01', offsetMs: 1_200 } as const;

const recommendation = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  id: 'R-01',
  rank: 1,
  sentence: 'Show the delivery cost on the basket screen instead of at the last step.',
  evidence: 'Fourteen of twenty people looked for a delivery cost on the basket and left.',
  findingIds: ['F-01'],
  citations: [citation],
  peopleAffected: 14,
  step: 'basket',
  ...overrides,
});

const SECOND = recommendation({
  id: 'R-02',
  rank: 2,
  sentence: 'Name the delivery window on the product page.',
  evidence: 'Six of twenty people hesitated on the product page before adding to the basket.',
  peopleAffected: 6,
  step: 'product',
});

const BASKET_HTML = '<h1>Your basket</h1>\n<p>Total: 12 000 ₸</p>\n';

const input = (overrides: Partial<ChangeAskInput> = {}): ChangeAskInput => ({
  recommendations: [recommendation(), SECOND],
  files: [{ path: 'src/basket.html', text: BASKET_HTML }],
  seed: 7,
  ...overrides,
});

/** A change as a cooperative model would answer it, with one field made wrong at a time. */
const reply = (overrides: Partial<Change> = {}, count = 1): string => {
  const given = input();
  const one: Change = {
    recommendationId: 'R-01',
    changedFile: 'src/basket.html',
    patch:
      '--- a/src/basket.html\n+++ b/src/basket.html\n@@ -1,2 +1,3 @@\n <h1>Your basket</h1>\n+<p>Delivery: 1 500 ₸</p>\n <p>Total: 12 000 ₸</p>\n',
    pullRequest: {
      title: 'Show the delivery cost on the basket',
      body: `Answers ${given.recommendations[0].id}: ${given.recommendations[0].sentence}\n\nEvidence: ${given.recommendations[0].evidence}\n\nThe numbers behind it are ${SIMULATED_LABEL}.`,
    },
    ...overrides,
  };
  return JSON.stringify({ changes: Array.from({ length: count }, () => one) });
};

const refusalOf = async (promise: Promise<unknown>): Promise<WonderReplyError> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WonderReplyError);
  return error as WonderReplyError;
};

/** The model implementation, answering one recorded reply. */
const throughModel = (replyText: string, usage: unknown = FAKE_TOKENS) =>
  createMetaWonderProvider({
    env: TEST_ENV,
    transport: fakeTransport({ replyText: () => replyText, usage }).transport,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the ask one change is decided through', () => {
  it('is the change use, at the effort the live call was answered at', () => {
    const ask = changeAsk(input());

    expect(ask.use).toBe('change');
    expect(ask.effort).toBe(CHANGE_EFFORT);
    expect(CHANGE_EFFORT).toBe('low');
    expect(ask.replySchema.name).toBe(CHANGE_REPLY_SCHEMA_NAME);
  });

  it('asks for the contract’s own shape, in the strict subset the protocol requires', () => {
    const schema = changeAsk(input()).replySchema.schema as Record<string, unknown>;

    // Derived from `changeSchema`, so the shape asked for cannot drift from the shape
    // enforced: a plain object at the root, `additionalProperties: false` everywhere and
    // `required` listing every key (`docs/meta-model-api.md`).
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['changes']);
    expect(schema.$schema).toBeUndefined();
    const change = (schema.properties as Record<string, Record<string, unknown>>).changes
      .items as Record<string, unknown>;
    expect(change.additionalProperties).toBe(false);
    expect(change.required).toEqual(['recommendationId', 'changedFile', 'patch', 'pullRequest']);
  });

  it('refuses to be built with no recommendation to answer or no file to touch', () => {
    expect(() => changeAsk(input({ recommendations: [] }))).toThrow(/recommendation/);
    expect(() => changeAsk(input({ files: [] }))).toThrow(/file/);
  });

  it('shows the model the ids, the paths and the files it may name, and nothing else', () => {
    const document = changeAsk(input()).document;

    expect(document).toContain('R-01');
    expect(document).toContain('R-02');
    expect(document).toContain('src/basket.html');
    expect(document).toContain('<p>Total: 12 000 ₸</p>');
  });
});

describe('one change, offline', () => {
  it('answers with exactly one change in the contract’s shape, with no key and no network', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the offline change reaches no network');
    });

    const { value, model, usage } = await decideChange(createOfflineWonderProvider(), input());

    expect(() => changeSchema.parse(value)).not.toThrow();
    expect(value.recommendationId).toBe('R-01');
    expect(value.changedFile).toBe('src/basket.html');
    expect(model).toBeNull();
    expect(usage.estimatedCostUsd).toBe(0);
  });

  it('answers the best-ranked recommendation, whatever order the input is in', async () => {
    const shuffled = input({ recommendations: [SECOND, recommendation()] });

    const { value } = await decideChange(createOfflineWonderProvider(), shuffled);

    expect(value.recommendationId).toBe('R-01');
  });

  it('gives the same change twice for the same input and the same seed', async () => {
    const asked = async (given: ChangeAskInput): Promise<Change> =>
      (await decideChange(createOfflineWonderProvider(), given)).value;

    expect(await asked(input())).toEqual(await asked(input()));
    // A fresh provider, and a provider that has already answered, answer alike: the seed is
    // on the ask and nothing is kept between calls.
    const provider = createOfflineWonderProvider();
    await decideChange(provider, input({ seed: 99 }));
    expect((await decideChange(provider, input())).value).toEqual(await asked(input()));
  });

  it('writes a patch that applies to the file it was given', async () => {
    const given = input();
    const { value } = await decideChange(createOfflineWonderProvider(), given);

    const patched = applyUnifiedPatch(given.files[0], value.patch);

    expect(patched).toContain('<h1>Your basket</h1>');
    expect(patched).toContain('R-01');
    expect(patched.endsWith('\n')).toBe(true);
  });

  it('writes a body naming the recommendation, its evidence and the simulated label', async () => {
    const { value } = await decideChange(createOfflineWonderProvider(), input());

    expect(value.pullRequest.body).toContain(recommendation().sentence);
    expect(value.pullRequest.body).toContain(recommendation().evidence);
    expect(value.pullRequest.body.toLowerCase()).toContain(SIMULATED_LABEL);
  });
});

describe('a reply that is not one change', () => {
  const asked = (replyText: string, given: ChangeAskInput = input()): Promise<unknown> =>
    decideChange(throughModel(replyText), given);

  it('refuses two changes with the count, rather than keeping the first', async () => {
    const error = await refusalOf(asked(reply({}, 2)));

    expect(error.message).toContain('2 changes');
    expect(error.message).toContain('truncated');
    expect(error.paths).toContain('changes');
  });

  it('refuses a reply carrying no change at all', async () => {
    const error = await refusalOf(asked(reply({}, 0)));

    expect(error.message).toContain('no change');
    expect(error.paths).toContain('changes');
  });

  it('refuses a recommendation it was not given, with the path named', async () => {
    const error = await refusalOf(asked(reply({ recommendationId: 'R-99' })));

    expect(error.paths).toContain('changes[0].recommendationId');
    expect(error.message).toContain('R-99');
    expect(error.message).toContain('"R-01"');
  });

  it('refuses a file it was not given, with the path named', async () => {
    // The failure the live call actually produced: a file named after nothing in the request
    // (`docs/meta-model-api.md`).
    const error = await refusalOf(
      asked(reply({ changedFile: 'patches/startup-project-asteria-ksa.md' })),
    );

    expect(error.paths).toContain('changes[0].changedFile');
    expect(error.message).toContain('patches/startup-project-asteria-ksa.md');
    expect(error.message).toContain('src/basket.html');
  });

  it('refuses a patch that does not apply, with the reason', async () => {
    const error = await refusalOf(
      asked(
        reply({
          patch:
            '--- a/src/basket.html\n+++ b/src/basket.html\n@@ -1,2 +1,3 @@\n <h1>Your bag</h1>\n+<p>Delivery: 1 500 ₸</p>\n <p>Total: 12 000 ₸</p>\n',
        }),
      ),
    );

    expect(error.paths).toContain('changes[0].patch');
    expect(error.message).toContain('does not apply');
    expect(error.message).toContain('line 1');
  });

  it('refuses a patch that touches a second file', async () => {
    const error = await refusalOf(
      asked(
        reply({
          patch:
            '--- a/src/checkout.html\n+++ b/src/checkout.html\n@@ -1,1 +1,2 @@\n+<p>Delivery</p>\n <h1>Your basket</h1>\n',
        }),
      ),
    );

    expect(error.paths).toContain('changes[0].patch');
    expect(error.message).toContain('src/checkout.html');
  });

  it('refuses a body with no simulated label', async () => {
    const error = await refusalOf(
      asked(
        reply({
          pullRequest: {
            title: 'Show the delivery cost on the basket',
            body: `Answers R-01: ${recommendation().sentence}\n\nEvidence: ${recommendation().evidence}`,
          },
        }),
      ),
    );

    expect(error.paths).toContain('changes[0].pullRequest');
    expect(error.message).toContain(SIMULATED_LABEL);
  });

  it('refuses a body that states neither the recommendation nor its evidence', async () => {
    const error = await refusalOf(
      asked(
        reply({
          pullRequest: {
            title: 'A change',
            body: `Trust me. The numbers are ${SIMULATED_LABEL}.`,
          },
        }),
      ),
    );

    expect(error.message).toContain('does not state the recommendation');
    expect(error.message).toContain('does not state the evidence');
  });

  it('refuses a reply whose change is the wrong shape, naming the field', async () => {
    const error = await refusalOf(asked(JSON.stringify({ changes: [{ patch: '' }] })));

    expect(error.paths).toContain('changes[0].recommendationId');
    expect(error.paths).toContain('changes[0].patch');
  });
});

describe('the same change through the model implementation', () => {
  it('reads the documented envelope into the change, and counts what it cost', async () => {
    const { value, model, usage } = await decideChange(throughModel(reply()), input());

    expect(value.changedFile).toBe('src/basket.html');
    expect(value.pullRequest.title).toBe('Show the delivery cost on the basket');
    expect(model).toEqual({ mode: WONDER_PROVIDER_MODE, modelId: WONDER_MODEL_ID });

    const tokens = {
      inputTokens: FAKE_TOKENS.input_tokens,
      cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens,
      outputTokens: FAKE_TOKENS.output_tokens,
      reasoningTokens: FAKE_TOKENS.output_tokens_details.reasoning_tokens,
    };
    expect(usage).toEqual({
      ...tokens,
      estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokens),
    });
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('unwraps the Markdown fence the live call put round its diff, and stores the patch that applies', async () => {
    const given = input();
    const fenced = reply({
      patch: `\`\`\`diff\n--- a/src/basket.html\n+++ b/src/basket.html\n@@ -1,1 +1,2 @@\n+<p>Delivery: 1 500 ₸</p>\n <h1>Your basket</h1>\n\`\`\``,
    });

    const { value } = await decideChange(throughModel(fenced), given);

    expect(value.patch.startsWith('---')).toBe(true);
    expect(applyUnifiedPatch(given.files[0], value.patch)).toContain('Delivery: 1 500 ₸');
  });
});

describe('the patch reader', () => {
  const file = { path: 'a.txt', text: 'one\ntwo\nthree\n' };

  it('applies a hunk in the middle of a file', () => {
    expect(
      applyUnifiedPatch(file, '--- a/a.txt\n+++ b/a.txt\n@@ -2,1 +2,2 @@\n two\n+two and a half\n'),
    ).toBe('one\ntwo\ntwo and a half\nthree\n');
  });

  it('applies a removal, and keeps a file that ends in no newline ending in none', () => {
    expect(
      applyUnifiedPatch(
        { path: 'a.txt', text: 'one\ntwo' },
        '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n one\n-two\n',
      ),
    ).toBe('one');
  });

  it('adds the first line of an empty file', () => {
    expect(
      applyUnifiedPatch(
        { path: 'a.txt', text: '' },
        '--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+one\n',
      ),
    ).toBe('one');
  });

  it('reads `diff --git` and `index` lines, and ignores a no-newline marker', () => {
    expect(
      applyUnifiedPatch(
        file,
        'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -3,1 +3,1 @@\n-three\n+four\n\\ No newline at end of file\n',
      ),
    ).toBe('one\ntwo\nfour\n');
  });

  it('refuses a hunk whose counts do not match its body', () => {
    expect(() =>
      applyUnifiedPatch(file, '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n'),
    ).toThrow(/covered 1 of the 3 lines/);
  });

  it('refuses a hunk past the end of the file, and one with no hunk at all', () => {
    expect(() =>
      applyUnifiedPatch(file, '--- a/a.txt\n+++ b/a.txt\n@@ -9,1 +9,1 @@\n nine\n'),
    ).toThrow(/has 3 lines/);
    expect(() => applyUnifiedPatch(file, '--- a/a.txt\n+++ b/a.txt\n')).toThrow(/no hunk/);
  });

  it('refuses hunks out of order, and prose where a header belongs', () => {
    expect(() =>
      applyUnifiedPatch(
        file,
        '--- a/a.txt\n+++ b/a.txt\n@@ -3,1 +3,1 @@\n three\n@@ -1,1 +1,1 @@\n one\n',
      ),
    ).toThrow(/out of order/);
    expect(() =>
      applyUnifiedPatch(file, 'Here is the patch you asked for:\n--- a/a.txt\n+++ b/a.txt\n'),
    ).toThrow(/cannot place/);
  });

  it('removes a line that itself begins with two dashes', () => {
    // A removed `-- a comment` reads as `--- a comment`, which is a header's spelling. The
    // hunk's own counts are what keep the two apart.
    expect(
      applyUnifiedPatch(
        { path: 'a.txt', text: '-- a comment\nkeep\n' },
        '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n--- a comment\n keep\n',
      ),
    ).toBe('keep\n');
  });
});
