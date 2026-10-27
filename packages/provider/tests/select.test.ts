import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_MODE,
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectDecisionProvider,
} from '../src/select.js';
import { MODEL_ID_BY_MODE } from '../src/meta-pricing.js';
import { createOfflineDeterministicProvider, OFFLINE_PROVIDER_NAME } from '../src/offline.js';
import { createDecisionSession } from '../src/session.js';
import type { DecisionProvider } from '../src/types.js';

const SECRET = 'sk-not-a-real-key-0000';

const never = (): never => {
  throw new Error('the selection tests never call the provider');
};

const fakeModelProvider: DecisionProvider = {
  name: 'fake-model',
  mode: 'model',
  readsImages: true,
  decide: never,
  beginSession: ({ personaId, seed }) => createDecisionSession({ personaId, seed, decide: never }),
};

describe('choosing the decision provider', () => {
  it('runs offline when no key is in the environment', () => {
    const selected = selectDecisionProvider({ seed: 1, env: {} });

    expect(selected.mode).toBe('offline');
    expect(selected.provider.name).toBe(OFFLINE_PROVIDER_NAME);
    expect(selected.reason).toContain(MODEL_API_KEY_ENV);
  });

  it('treats a blank key as no key', () => {
    expect(selectDecisionProvider({ seed: 1, env: { [MODEL_API_KEY_ENV]: '   ' } }).mode).toBe(
      'offline',
    );
  });

  it('stays offline when offline was asked for, key or no key', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: { [MODEL_API_KEY_ENV]: SECRET },
      requestedMode: 'offline',
      createModelProvider: () => fakeModelProvider,
    });

    expect(selected.mode).toBe('offline');
  });

  it('stays offline when a key is present but this process has no model provider', () => {
    const selected = selectDecisionProvider({ seed: 1, env: { [MODEL_API_KEY_ENV]: SECRET } });

    expect(selected.mode).toBe('offline');
    expect(selected.provider.name).toBe(OFFLINE_PROVIDER_NAME);
  });

  it('runs the model provider when a key and a provider are both there', () => {
    const createModelProvider = vi.fn(() => fakeModelProvider);

    const selected = selectDecisionProvider({
      seed: 1,
      env: { [MODEL_API_KEY_ENV]: SECRET },
      createModelProvider,
    });

    expect(selected.mode).toBe('model');
    expect(selected.provider).toBe(fakeModelProvider);
    expect(createModelProvider).toHaveBeenCalledWith({ apiKey: SECRET, modelMode: 'contributor' });
  });

  it('refuses model mode without a key rather than quietly running offline', () => {
    expect(() => selectDecisionProvider({ seed: 1, env: {}, requestedMode: 'model' })).toThrow(
      ModelModeUnavailableError,
    );
  });

  it('refuses model mode with a key but nothing to build the provider with', () => {
    expect(() =>
      selectDecisionProvider({
        seed: 1,
        env: { [MODEL_API_KEY_ENV]: SECRET },
        requestedMode: 'model',
      }),
    ).toThrow(ModelModeUnavailableError);
  });

  it('never puts the key in what it returns or in why it chose', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: { [MODEL_API_KEY_ENV]: SECRET },
      createModelProvider: () => fakeModelProvider,
    });

    expect(JSON.stringify({ mode: selected.mode, reason: selected.reason })).not.toContain(SECRET);
    expect(selected.reason).not.toContain(SECRET);
  });

  it('never leaks the key in the error it throws', () => {
    try {
      selectDecisionProvider({
        seed: 1,
        env: { [MODEL_API_KEY_ENV]: SECRET },
        requestedMode: 'model',
      });
      expect.unreachable('model mode without a provider is an error');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

describe('choosing which model tier a run decides on', () => {
  const withKey = { [MODEL_API_KEY_ENV]: SECRET };

  it('resolves a contributor request to the contributor model and says so', () => {
    const createModelProvider = vi.fn(() => fakeModelProvider);

    const selected = selectDecisionProvider({
      seed: 1,
      env: withKey,
      requestedMode: { mode: 'model', modelMode: 'contributor' },
      createModelProvider,
    });

    expect(selected.mode).toBe('model');
    expect(selected.modelMode).toBe('contributor');
    expect(selected.modelId).toBe('muse-spark-1.3-contributor');
    expect(createModelProvider).toHaveBeenCalledWith({
      apiKey: SECRET,
      modelMode: 'contributor',
    });
  });

  it('resolves a standard request to the standard model and says so', () => {
    const createModelProvider = vi.fn(() => fakeModelProvider);

    const selected = selectDecisionProvider({
      seed: 1,
      env: withKey,
      requestedMode: { mode: 'model', modelMode: 'standard' },
      createModelProvider,
    });

    expect(selected.mode).toBe('model');
    expect(selected.modelMode).toBe('standard');
    expect(selected.modelId).toBe('muse-spark-1.3');
    expect(createModelProvider).toHaveBeenCalledWith({ apiKey: SECRET, modelMode: 'standard' });
  });

  it('never resolves one tier to the other tier\u2019s model', () => {
    const idOf = (modelMode: 'contributor' | 'standard') =>
      selectDecisionProvider({
        seed: 1,
        env: withKey,
        requestedMode: { mode: 'model', modelMode },
        createModelProvider: () => fakeModelProvider,
      }).modelId;

    expect(idOf('contributor')).not.toBe(MODEL_ID_BY_MODE.standard);
    expect(idOf('standard')).not.toBe(MODEL_ID_BY_MODE.contributor);
  });

  it('refuses a standard request with no key, and returns no provider', () => {
    let selected: unknown = 'nothing was returned';
    try {
      selected = selectDecisionProvider({
        seed: 1,
        env: {},
        requestedMode: { mode: 'model', modelMode: 'standard' },
        createModelProvider: () => fakeModelProvider,
      });
      expect.unreachable('standard mode with no key is a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelModeUnavailableError);
      expect((error as Error).message).toContain(MODEL_API_KEY_ENV);
      expect((error as Error).message).toContain(MODEL_ID_BY_MODE.standard);
    }
    expect(selected).toBe('nothing was returned');
  });

  it('refuses a standard request with a key but no model provider to build', () => {
    try {
      selectDecisionProvider({
        seed: 1,
        env: withKey,
        requestedMode: { mode: 'model', modelMode: 'standard' },
      });
      expect.unreachable('standard mode with nothing to build the provider with is a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelModeUnavailableError);
      expect((error as Error).message).toContain('no model provider');
      expect((error as Error).message).toContain(MODEL_ID_BY_MODE.standard);
    }
  });

  it('refuses a standard request whose factory hands back a provider that is not a model', () => {
    expect(() =>
      selectDecisionProvider({
        seed: 1,
        env: withKey,
        requestedMode: { mode: 'model', modelMode: 'standard' },
        createModelProvider: () => createOfflineDeterministicProvider({ seed: 1 }),
      }),
    ).toThrow(ModelModeUnavailableError);
  });

  it('falls back to offline for a contributor request with no key, with a reason', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: {},
      requestedMode: { mode: 'model', modelMode: 'contributor' },
      createModelProvider: () => fakeModelProvider,
    });

    expect(selected.mode).toBe('offline');
    expect(selected.provider.name).toBe(OFFLINE_PROVIDER_NAME);
    expect(selected.reason).toContain(MODEL_API_KEY_ENV);
    expect(selected.modelMode).toBeUndefined();
    expect(selected.modelId).toBeUndefined();
  });

  it('falls back to offline for a contributor request with a key but no model provider', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: withKey,
      requestedMode: { mode: 'model', modelMode: 'contributor' },
    });

    expect(selected.mode).toBe('offline');
    expect(selected.modelMode).toBeUndefined();
  });

  it('names no model when it ran none, so an offline run records no tier', () => {
    const selected = selectDecisionProvider({ seed: 1, env: withKey, requestedMode: 'offline' });

    expect(selected.mode).toBe('offline');
    expect(selected.modelMode).toBeUndefined();
    expect(selected.modelId).toBeUndefined();
  });

  it('gives a tier-less model request the default tier', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: withKey,
      requestedMode: 'model',
      createModelProvider: () => fakeModelProvider,
    });

    expect(selected.modelMode).toBe(DEFAULT_MODEL_MODE);
    expect(selected.modelId).toBe(MODEL_ID_BY_MODE[DEFAULT_MODEL_MODE]);
  });

  it('keeps the key out of a tier result, its reason and a refusal', () => {
    const selected = selectDecisionProvider({
      seed: 1,
      env: withKey,
      requestedMode: { mode: 'model', modelMode: 'standard' },
      createModelProvider: () => fakeModelProvider,
    });

    expect(JSON.stringify(selected)).not.toContain(SECRET);
    try {
      selectDecisionProvider({
        seed: 1,
        env: withKey,
        requestedMode: { mode: 'model', modelMode: 'standard' },
      });
      expect.unreachable('a standard request with nothing to build the provider with throws');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify((error as Error).message)).not.toContain(SECRET);
    }
  });
});
