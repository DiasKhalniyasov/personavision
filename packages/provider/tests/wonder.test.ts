import { afterEach, describe, expect, it, vi } from 'vitest';
import { FREE_USAGE, totalUsage } from '../src/decision.js';
import { estimateCostUsd, WONDER_MODEL_ID } from '../src/meta-pricing.js';
import { createOfflineDeterministicProvider } from '../src/offline.js';
import {
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectWonderProvider,
} from '../src/select.js';
import { parseWonderProbe, wonderProbeAsk, wonderRefusal } from '../src/testing.js';
import type { WonderProbe } from '../src/testing.js';
import { parseWonderReply, WONDER_EFFORTS, WONDER_USES, WonderReplyError } from '../src/wonder.js';
import type { WonderAsk, WonderProvider } from '../src/wonder.js';
import {
  createOfflineWonderProvider,
  OFFLINE_WONDER_PROVIDER_NAME,
} from '../src/wonder-offline.js';
import { contextOf } from './fixtures.js';

/**
 * The one-shot seam: what the exported contract suite does not already hold every
 * implementation to.
 *
 * The suite (`wonder-contract-suite.test.ts`) covers the shape of a reply, the five usage
 * figures, the refusal and determinism for **any** implementation. What is here is what is
 * true of this implementation and this selection in particular: that the offline answer is
 * seeded by the document as well as the seed, that a Wonder reply and a decision add up
 * through the one total, that no call reaches the network, and that selection refuses what
 * it is specified to refuse.
 */

const SECRET = 'sk-not-a-real-key-0000';
const withKey = { [MODEL_API_KEY_ENV]: SECRET } as const;

const never = (): never => {
  throw new Error('the selection tests never call the implementation');
};

const fakeWonderProvider: WonderProvider = {
  name: 'fake-wonder',
  mode: 'model',
  modelId: WONDER_MODEL_ID,
  ask: never,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the vocabulary the seam publishes', () => {
  it('names the four uses `docs/FLOW.md` section 16 names, and no fifth', () => {
    // A fifth use would be a fifth shape in `@personavision/contract` first (#250).
    expect(WONDER_USES).toEqual(['audience', 'goal', 'analysis', 'change']);
  });

  it('names the six reasoning efforts the model behind it accepts, and not `none`', () => {
    // From the `400` the API returns for the one that is not: `reasoning_effort 'none' is
    // not supported for model 'muse-wonder-1.0'` (`docs/meta-model-api.md`, 2026-11-03).
    expect(WONDER_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(WONDER_EFFORTS).not.toContain('none');
  });
});

describe('the offline deterministic one-shot implementation', () => {
  it('is what a caller that asks for nothing gets, with no key and no network', () => {
    const selected = selectWonderProvider();

    expect(selected.mode).toBe('offline');
    expect(selected.provider.name).toBe(OFFLINE_WONDER_PROVIDER_NAME);
    expect(selected.modelId).toBeUndefined();
  });

  it('answers the same ask and seed with the same object, and reaches no network doing it', async () => {
    // Nothing offline may call: a `fetch` here is a failure of the promise this package
    // makes about a fresh clone, not a slow test.
    const fetchSpy = vi.fn(() => {
      throw new Error('the offline implementation reached the network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const provider = createOfflineWonderProvider();
    const ask = (): WonderAsk<WonderProbe> => wonderProbeAsk({ use: 'goal', seed: 42 });

    const first = await provider.ask(ask());
    const second = await createOfflineWonderProvider().ask(ask());

    expect(second.value).toEqual(first.value);
    expect(second.model).toBeNull();
    expect(second.usage).toEqual(FREE_USAGE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers two documents on one seed with two objects', async () => {
    const provider = createOfflineWonderProvider();

    const parents = await provider.ask(
      wonderProbeAsk({ seed: 3, document: 'busy parents in Almaty who shop on their phones' }),
    );
    const students = await provider.ask(
      wonderProbeAsk({ seed: 3, document: 'students in Astana who compare prices on a laptop' }),
    );

    // A seeded generator that ignored the document would make every audience on seed 3 the
    // same audience, and the demo a single sentence repeated.
    expect(students.value).not.toEqual(parents.value);
  });

  it('answers one document asked as two uses with two objects', async () => {
    const provider = createOfflineWonderProvider();
    const document = 'the new one-page checkout, reached from the basket';

    const asAudience = await provider.ask(wonderProbeAsk({ use: 'audience', seed: 8, document }));
    const asGoal = await provider.ask(wonderProbeAsk({ use: 'goal', seed: 8, document }));

    expect(asGoal.value).not.toEqual(asAudience.value);
  });

  it('holds nothing between asks: the fourth answer is the fourth asked in any order', async () => {
    const provider = createOfflineWonderProvider();
    const asks = WONDER_USES.map((use) => wonderProbeAsk({ use, seed: 11 }));

    const forwards = await Promise.all(asks.map(async (ask) => (await provider.ask(ask)).value));
    const backwards = await Promise.all(
      [...asks].reverse().map(async (ask) => (await provider.ask(ask)).value),
    );

    expect([...backwards].reverse()).toEqual(forwards);
  });

  it('refuses its own generator’s answer when that ask’s validator refuses it', async () => {
    // A use whose offline shape has drifted from the schema it validates against. The
    // generator is the one that is wrong here, and the refusal still names the path rather
    // than handing a screen an object it cannot read.
    const drifted = wonderProbeAsk({
      use: 'change',
      seed: 2,
      offline: () => ({ headline: 'a change', confidence: 7 }) as WonderProbe,
    });

    const refusal = await createOfflineWonderProvider()
      .ask(drifted)
      .then(
        (reply) => reply,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(WonderReplyError);
    expect((refusal as WonderReplyError).paths).toEqual(['confidence']);
    expect((refusal as WonderReplyError).message).toContain('confidence is on [0, 1]');
    expect((refusal as WonderReplyError).message).toContain('the offline generator');
    expect((refusal as WonderReplyError).use).toBe('change');
    expect((refusal as WonderReplyError).model).toBeNull();
  });
});

describe('a refused reply', () => {
  it('names every path the validator refused, and keeps the refusal as its cause', () => {
    const ask = wonderProbeAsk();

    const refusal = (() => {
      try {
        parseWonderReply(ask, { headline: '', confidence: 'high' }, null);
        return undefined;
      } catch (error) {
        return error as WonderReplyError;
      }
    })();

    expect(refusal).toBeInstanceOf(WonderReplyError);
    expect(refusal?.paths).toEqual(['headline', 'confidence']);
    expect(refusal?.message).toContain('headline');
    expect(refusal?.message).toContain('confidence');
    // Ours, never the person's (`docs/FLOW.md` section 8).
    expect(refusal?.attribution).toBe('automation');
    expect(refusal?.cause).toBeInstanceOf(Error);
  });

  it('names the model that produced it, where a model did', () => {
    const ask = wonderProbeAsk({ use: 'analysis' });
    const model = { mode: 'standard', modelId: WONDER_MODEL_ID } as const;

    expect(() => parseWonderReply(ask, { headline: 'ok', confidence: 2 }, model)).toThrow(
      new RegExp(`${WONDER_MODEL_ID}.*standard`),
    );
  });

  it('reports a refusal that names no path by its own words', () => {
    const ask = wonderProbeAsk({
      parse: () => {
        throw new Error('the reply was not JSON at all');
      },
    });

    const refusal = (() => {
      try {
        parseWonderReply(ask, 'nonsense', null);
        return undefined;
      } catch (error) {
        return error as WonderReplyError;
      }
    })();

    expect(refusal?.paths).toEqual([]);
    expect(refusal?.message).toContain('the reply was not JSON at all');
  });

  it('hands back the validator’s own value, not the reply it was given', () => {
    // A validator that narrows or strips is what the caller gets: an unknown field a model
    // added does not travel on into a screen.
    const value = parseWonderReply(
      wonderProbeAsk(),
      { headline: 'kept', confidence: 0.5, invented: 'dropped' },
      null,
    );

    expect(value).toEqual({ headline: 'kept', confidence: 0.5 });
  });

  it('is what the probe fixture refuses with, so the suite’s refusal is a real one', () => {
    expect(() => parseWonderProbe({ headline: 'ok' })).toThrow();
    expect(wonderRefusal(['a', 0, 'b'], 'nope')).toBeInstanceOf(Error);
  });
});

describe('a one-shot call in the run’s usage block', () => {
  it('adds up with a decision through the one total, with no second block', async () => {
    const decision = await createOfflineDeterministicProvider({ seed: 1 }).decide(contextOf());
    const reply = await createOfflineWonderProvider().ask(wonderProbeAsk({ seed: 1 }));

    const total = totalUsage([decision.usage, reply.usage]);

    // Two calls, five figures, one block: a Wonder call is a call.
    expect(total).toEqual({
      calls: 2,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it('adds a priced one-shot reply to a decision figure for figure', async () => {
    const tokens = { inputTokens: 371, cachedInputTokens: 0, outputTokens: 487 } as const;
    // What #255 will report, reported here by a stand-in: the usage of a real Wonder call of
    // 2026-11-03 (the audience, `docs/meta-model-api.md`), priced from the one table.
    const priced: WonderProvider = {
      name: 'priced-stand-in',
      mode: 'model',
      modelId: WONDER_MODEL_ID,
      ask: async (ask) => ({
        value: ask.parse(ask.offline(ask.seed)),
        model: { mode: 'standard', modelId: WONDER_MODEL_ID },
        usage: {
          ...tokens,
          reasoningTokens: 308,
          estimatedCostUsd: estimateCostUsd(WONDER_MODEL_ID, tokens),
        },
      }),
    };

    const decision = await createOfflineDeterministicProvider({ seed: 1 }).decide(contextOf());
    const reply = await priced.ask(wonderProbeAsk({ seed: 1 }));
    const total = totalUsage([decision.usage, reply.usage]);

    expect(total.calls).toBe(2);
    expect(total.inputTokens).toBe(371);
    expect(total.outputTokens).toBe(487);
    expect(total.reasoningTokens).toBe(308);
    // $0.011224, which is the $0.0112 `docs/meta-model-api.md` records for that call.
    expect(total.estimatedCostUsd).toBe(0.011224);
    // The same arithmetic a decision is costed by, from the same table.
    expect(total.estimatedCostUsd).toBe(estimateCostUsd(WONDER_MODEL_ID, tokens));
  });
});

describe('choosing the one-shot implementation', () => {
  it('stays offline when a key is in the environment but nothing was asked for', () => {
    const selected = selectWonderProvider({ env: withKey, createModelProvider: () => never() });

    expect(selected.mode).toBe('offline');
    expect(selected.reason).toContain('no cheap tier');
    expect(selected.reason).not.toContain(SECRET);
  });

  it('stays offline when offline was asked for, key or no key', () => {
    for (const requestedMode of ['offline', { mode: 'offline' }] as const) {
      const selected = selectWonderProvider({
        env: withKey,
        requestedMode,
        createModelProvider: () => never(),
      });

      expect(selected.mode).toBe('offline');
      expect(selected.reason).toContain('never upgraded implicitly');
    }
  });

  it('refuses a model request that names no model, rather than resolving one for it', () => {
    for (const requestedMode of ['model', { mode: 'model' }] as const) {
      const choose = (): unknown =>
        selectWonderProvider({
          env: withKey,
          requestedMode,
          createModelProvider: ({ modelId }) => ({ ...fakeWonderProvider, modelId }),
        });

      expect(choose).toThrow(ModelModeUnavailableError);
      expect(choose).toThrow(/named no model/);
      // It says what to name instead, so the refusal is actionable.
      expect(choose).toThrow(new RegExp(WONDER_MODEL_ID));
    }
  });

  it('refuses a model this package does not run one-shot', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: withKey,
        // There is no such model: the pricing page says contributor mode is not available
        // for Wonder, and the API answers `404 model_not_found`.
        requestedMode: { mode: 'model', modelId: `${WONDER_MODEL_ID}-contributor` as never },
        createModelProvider: () => never(),
      });

    expect(choose).toThrow(ModelModeUnavailableError);
    expect(choose).toThrow(/is not a model this package runs one-shot/);
  });

  it('refuses a named model with no key, rather than answering it offline', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: {},
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
        createModelProvider: () => fakeWonderProvider,
      });

    expect(choose).toThrow(ModelModeUnavailableError);
    expect(choose).toThrow(new RegExp(MODEL_API_KEY_ENV));
    // A simulated answer standing in for a model run is worse than a refusal.
    expect(choose).toThrow(/worse than a refusal/);
  });

  it('refuses a named model this process cannot build', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: withKey,
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      });

    expect(choose).toThrow(ModelModeUnavailableError);
    expect(choose).toThrow(/no implementation was supplied/);
  });

  it('builds the named model with the key, and records what ran', () => {
    const built: string[] = [];
    const selected = selectWonderProvider({
      env: withKey,
      requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      createModelProvider: ({ apiKey, modelId }) => {
        built.push(`${modelId}:${apiKey.length}`);
        return fakeWonderProvider;
      },
    });

    expect(selected.mode).toBe('model');
    expect(selected.modelId).toBe(WONDER_MODEL_ID);
    expect(selected.provider).toBe(fakeWonderProvider);
    expect(built).toEqual([`${WONDER_MODEL_ID}:${SECRET.length}`]);
  });

  it('refuses an implementation that runs another model', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: withKey,
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
        createModelProvider: () => ({ ...fakeWonderProvider, modelId: 'muse-spark-1.3' }),
      });

    expect(choose).toThrow(ModelModeUnavailableError);
    expect(choose).toThrow(/runs muse-spark-1\.3/);
  });

  it('refuses an implementation that is not in model mode', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: withKey,
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
        createModelProvider: () => createOfflineWonderProvider(),
      });

    expect(choose).toThrow(ModelModeUnavailableError);
    expect(choose).toThrow(/runs in "offline" mode/);
  });

  it('takes an implementation that will not name its model at its word', () => {
    const quiet: WonderProvider = { name: 'quiet', mode: 'model', ask: never };
    const selected = selectWonderProvider({
      env: withKey,
      requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      createModelProvider: () => quiet,
    });

    expect(selected.provider).toBe(quiet);
    expect(selected.modelId).toBe(WONDER_MODEL_ID);
  });

  it('never puts the key in what it returns or in what it refuses with', () => {
    const selected = selectWonderProvider({
      env: withKey,
      requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      createModelProvider: () => fakeWonderProvider,
    });

    expect(JSON.stringify({ ...selected, provider: selected.provider.name })).not.toContain(SECRET);

    const refusal = (() => {
      try {
        selectWonderProvider({ env: withKey, requestedMode: { mode: 'model' } });
        return '';
      } catch (error) {
        return `${(error as Error).message}${(error as Error).stack ?? ''}`;
      }
    })();

    expect(refusal).not.toContain(SECRET);
  });

  it('reads a key that is only whitespace as no key at all', () => {
    const choose = (): unknown =>
      selectWonderProvider({
        env: { [MODEL_API_KEY_ENV]: '   ' },
        requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
        createModelProvider: () => fakeWonderProvider,
      });

    expect(choose).toThrow(new RegExp(MODEL_API_KEY_ENV));
  });
});
