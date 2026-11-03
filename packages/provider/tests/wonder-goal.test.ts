import { goalSchema } from '@personavision/contract';
import type { Goal } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  readCriterion as readCriterionFromIndex,
  writeGoal as writeGoalFromIndex,
} from '../src/index.js';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import {
  CRITERION_KINDS,
  GOAL_EFFORT,
  GOAL_REPLY_SCHEMA_NAME,
  goalAsk,
  GoalCriterionError,
  readCriterion,
  writeGoal,
} from '../src/wonder-goal.js';
import type { GoalAskInput } from '../src/wonder-goal.js';
import { createMetaWonderProvider } from '../src/wonder-model.js';
import { createOfflineWonderProvider } from '../src/wonder-offline.js';
import { fakeTransport, FAKE_TOKENS, TEST_ENV } from './wonder-fake.js';

/**
 * The goal Muse Wonder writes from a URL and a feature description (#259): the task, the
 * success criterion that has to be observable in the page, the model recorded as last
 * author — and the one send-back, after which an unobservable criterion refuses the goal
 * rather than being accepted or invented.
 *
 * Nothing here reaches the network or reads a key: the offline implementation is the default
 * and the model implementation is driven by the recorded transport the whole package is
 * tested through.
 */

const SITE = 'https://wonderstudio.ai/create';
const FEATURE = 'generating a video from a text prompt';

const input = (overrides: Partial<GoalAskInput> = {}): GoalAskInput => ({
  url: SITE,
  feature: FEATURE,
  seed: 7,
  ...overrides,
});

const TASK = 'A person tries to turn a text prompt into a video.';

/** A reply as a cooperative model answers it: the two sentences, and no author. */
const observableReply = JSON.stringify({
  task: TASK,
  successCriterion: 'A video preview is visible next to the prompt box.',
});

const judgementReply = JSON.stringify({
  task: TASK,
  successCriterion: 'The page feels trustworthy.',
});

const secondJudgementReply = JSON.stringify({
  task: TASK,
  successCriterion: 'The person understands what the video will cost.',
});

/** A model implementation answering each call in turn, with the transport's record kept. */
const throughModel = (
  replies: readonly string[],
): {
  readonly provider: ReturnType<typeof createMetaWonderProvider>;
  readonly documents: () => readonly string[];
} => {
  const fake = fakeTransport({
    replyText: (call) => replies[Math.min(call, replies.length) - 1],
  });
  return {
    provider: createMetaWonderProvider({ env: TEST_ENV, transport: fake.transport }),
    documents: () => fake.requests.map((request) => JSON.stringify(request.body.input)),
  };
};

const offline = async (given: GoalAskInput = input()): Promise<Goal> =>
  (await writeGoal(createOfflineWonderProvider(), given)).value;

const thrownBy = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    (value) => value,
    (error: unknown) => error,
  );

describe('the observability check, on its own', () => {
  it('accepts a visible element', () => {
    for (const criterion of [
      'A video preview is visible next to the prompt box.',
      'The download button appears under the finished video.',
      'A spinner is shown while the video renders.',
    ]) {
      expect(readCriterion(criterion)).toEqual({ observable: true, kind: 'element' });
    }
  });

  it('accepts a URL', () => {
    for (const criterion of [
      'The address bar reads /create/result after the render finishes.',
      'The person ends up on https://wonderstudio.ai/create/result.',
      'The URL carries the id of the finished video.',
    ]) {
      expect(readCriterion(criterion)).toEqual({ observable: true, kind: 'url' });
    }
  });

  it('reads a control named by its own label as the element it is about', () => {
    expect(readCriterion('The “Create video” button is visible.')).toEqual({
      observable: true,
      kind: 'element',
    });
  });

  it('accepts a piece of text', () => {
    for (const criterion of [
      'The page shows the text “Your video is ready”.',
      'The confirmation message says the render has finished.',
    ]) {
      expect(readCriterion(criterion)).toEqual({ observable: true, kind: 'text' });
    }
  });

  it('covers all three kinds and nothing else', () => {
    const kinds = [
      'A video preview is visible.',
      'The address bar reads /create/result.',
      'The page shows the text “Your video is ready”.',
    ].map((criterion) => {
      const reading = readCriterion(criterion);
      return reading.observable ? reading.kind : null;
    });

    expect(new Set(kinds)).toEqual(new Set(CRITERION_KINDS));
  });

  it('refuses a judgement, and says what was asked for instead', () => {
    const reading = readCriterion('The page feels trustworthy.');

    expect(reading.observable).toBe(false);
    if (reading.observable) throw new Error('unreachable');
    expect(reading.reason).toContain('The page feels trustworthy.');
    expect(reading.reason).toContain('a visible element');
    expect(reading.reason).toContain('a URL');
    expect(reading.reason).toContain('a piece of text');
  });

  it('refuses a judgement even where it names an element, because the opinion is the half nobody can score', () => {
    expect(readCriterion('The Buy button looks trustworthy.').observable).toBe(false);
    expect(
      readCriterion('The person is satisfied with the preview that is visible.').observable,
    ).toBe(false);
  });

  it('refuses a sentence naming none of the three, and an empty one', () => {
    for (const criterion of ['Checkout is quick.', 'The flow works end to end.', '  ']) {
      const reading = readCriterion(criterion);
      expect(reading.observable).toBe(false);
      if (reading.observable) throw new Error('unreachable');
      expect(reading.reason).toContain('a visible element');
    }
  });

  it('reads page copy as text even where the copy itself is a judgement', () => {
    // What is inside quotation marks is quoted, not written: a criterion naming the words a
    // page shows is observable however the page words them.
    expect(readCriterion('The page shows the text “A friendly studio you can trust”.')).toEqual({
      observable: true,
      kind: 'text',
    });
  });
});

describe('the ask one goal is written through', () => {
  it('is the goal use, at the effort the live call was answered at', () => {
    const ask = goalAsk(input());

    expect(ask.use).toBe('goal');
    expect(ask.effort).toBe(GOAL_EFFORT);
    expect(GOAL_EFFORT).toBe('minimal');
    expect(ask.replySchema.name).toBe(GOAL_REPLY_SCHEMA_NAME);
    expect(ask.seed).toBe(7);
  });

  it('asks for the two sentences and never for who wrote them', () => {
    const schema = goalAsk(input()).replySchema.schema as Record<string, unknown>;

    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([
      'successCriterion',
      'task',
    ]);
    expect(schema.required).toEqual(['task', 'successCriterion']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
  });

  it('carries the site and the feature in the words they were given in', () => {
    const document = goalAsk(input()).document;

    expect(document).toContain(SITE);
    expect(document).toContain(FEATURE);
    expect(document).not.toContain('sent back');
  });

  it('says what was sent back and why on the second ask', () => {
    const document = goalAsk(
      input({
        sentBack: { criterion: 'The page feels trustworthy.', reason: 'because it is a judgement' },
      }),
    ).document;

    expect(document).toContain('The page feels trustworthy.');
    expect(document).toContain('because it is a judgement');
  });

  it('refuses an empty feature and an address no client can ask for', () => {
    expect(() => goalAsk(input({ feature: '   ' }))).toThrow(TypeError);
    expect(() => goalAsk(input({ url: 'not a url' }))).toThrow(/not a web address/u);
    expect(() => goalAsk(input({ url: 'javascript:alert(1)' }))).toThrow(/http or https/u);
  });
});

describe('the goal, through the offline implementation', () => {
  it('writes the task, an observable criterion and the model as last author, with no key and no network', async () => {
    const goal = await offline();

    expect(goalSchema.parse(goal)).toEqual(goal);
    expect(goal.lastWrittenBy).toBe('model');
    expect(goal.task).toContain('wonderstudio.ai');
    expect(readCriterion(goal.successCriterion).observable).toBe(true);
  });

  it('gives the same goal twice for the same URL, feature and seed', async () => {
    expect(await offline()).toEqual(await offline());
  });

  it('gives a different goal for another feature, and another site', async () => {
    // Not for another seed: a goal is read off the URL and the feature, and the seed chooses
    // only which of the three kinds the criterion states — so two seeds state the same goal
    // one time in three, by construction and not by accident. There is nothing in a goal to
    // sample the way an audience samples a device mix.
    const goal = await offline();

    expect(await offline(input({ feature: 'editing a video somebody else made' }))).not.toEqual(
      goal,
    );
    expect(await offline(input({ url: 'https://example.com/create' }))).not.toEqual(goal);
  });

  it('writes an observable criterion of each kind across seeds, and never an unobservable one', async () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const goal = await offline(input({ seed }));
      const reading = readCriterion(goal.successCriterion);
      expect(reading.observable).toBe(true);
      if (reading.observable) kinds.add(reading.kind);
    }

    expect(kinds).toEqual(new Set(CRITERION_KINDS));
  });

  it('writes one sentence each from a feature description that is two', async () => {
    const goal = await offline(
      input({ feature: 'Generating a video from a prompt. The one on the home page.' }),
    );

    expect(goalSchema.parse(goal)).toEqual(goal);
    expect(goal.task).not.toContain('home page');
  });
});

describe('the one send-back, through the model implementation', () => {
  const tokensOf = (calls: number): Record<string, number> => ({
    inputTokens: FAKE_TOKENS.input_tokens * calls,
    cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens * calls,
    outputTokens: FAKE_TOKENS.output_tokens * calls,
    reasoningTokens: FAKE_TOKENS.output_tokens_details.reasoning_tokens * calls,
  });

  it('asks once and bills once where the first criterion is observable', async () => {
    const { provider, documents } = throughModel([observableReply]);

    const reply = await writeGoal(provider, input());

    expect(documents()).toHaveLength(1);
    expect(reply.value.successCriterion).toBe('A video preview is visible next to the prompt box.');
    expect(reply.value.lastWrittenBy).toBe('model');
    expect(reply.usage).toEqual({
      ...tokensOf(1),
      estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokensOf(1)),
    });
  });

  it('sends a judgement back once, accepts the observable second, and counts both calls', async () => {
    const { provider, documents } = throughModel([judgementReply, observableReply]);

    const reply = await writeGoal(provider, input());

    const sent = documents();
    expect(sent).toHaveLength(2);
    // The first ask sends none of this back — it names a judgement only as an example of what
    // not to write — and the second sends back the criterion that came back, with the
    // sentence saying what was asked for instead. Nothing invents a criterion either time.
    expect(sent[0]).not.toContain('sent back');
    expect(sent[1]).toContain('sent back');
    expect(sent[1]).toContain('The page feels trustworthy.');
    expect(sent[1]).toContain('a visible element');

    expect(reply.value.successCriterion).toBe('A video preview is visible next to the prompt box.');
    expect(reply.model).toEqual({ mode: expect.any(String), modelId: WONDER_MODEL_ID });
    expect(reply.usage).toEqual({
      ...tokensOf(2),
      estimatedCostUsd: expect.closeTo(estimateCostUsd(WONDER_MODEL_ID, tokensOf(2)), 10),
    });
    expect(reply.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('refuses the goal after a second unobservable criterion, with the reason and both receipts', async () => {
    const { provider, documents } = throughModel([judgementReply, secondJudgementReply]);

    const error = await thrownBy(writeGoal(provider, input()));

    expect(error).toBeInstanceOf(GoalCriterionError);
    if (!(error instanceof GoalCriterionError)) throw new Error('unreachable');
    // Two calls and no third: the rule is one send-back, not a loop until something passes.
    expect(documents()).toHaveLength(2);
    expect(error.attribution).toBe('automation');
    expect(error.refused).toEqual([
      'The page feels trustworthy.',
      'The person understands what the video will cost.',
    ]);
    // A sentence a screen can show unchanged: both criteria, and what was asked for instead.
    expect(error.message).toBe(error.reason);
    expect(error.reason).toContain('The page feels trustworthy.');
    expect(error.reason).toContain('The person understands what the video will cost.');
    expect(error.reason).toContain('a visible element');
    expect(error.reason).toContain('a URL');
    expect(error.reason).toContain('a piece of text');
    expect(error.usage).toEqual({
      ...tokensOf(2),
      estimatedCostUsd: expect.closeTo(estimateCostUsd(WONDER_MODEL_ID, tokensOf(2)), 10),
    });
  });
});

describe('the package index', () => {
  it('publishes the goal use and its observability check', () => {
    expect(writeGoalFromIndex).toBe(writeGoal);
    expect(readCriterionFromIndex).toBe(readCriterion);
  });
});
