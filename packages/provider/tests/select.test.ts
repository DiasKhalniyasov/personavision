import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectDecisionProvider,
} from '../src/select.js';
import { OFFLINE_PROVIDER_NAME } from '../src/offline.js';
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
    expect(createModelProvider).toHaveBeenCalledWith({ apiKey: SECRET });
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
