import { describe, expect, it, vi } from 'vitest';
import { createOfflineDeterministicProvider } from '../src/offline.js';
import { createDecisionSession, DecisionSessionClosedError } from '../src/session.js';
import { validateDecision } from '../src/decision.js';
import type { Decision, DecisionContext } from '../src/types.js';
import {
  BARREN_SCREEN,
  contextOf,
  NAVIGATION_SCREEN,
  seedBand,
  SESSION_STEPS,
  traitsWith,
  walkSession,
} from './fixtures.js';

/**
 * The session handle, offline: that it is a pass-through and nothing more, that two of them
 * are two sessions, and that a closed one stops short of the policy rather than deciding
 * one last time.
 *
 * The contract suite asserts the same guarantees against the interface. What is here is the
 * thing only this provider can be held to — that going through a handle changed none of its
 * decisions.
 */

/** The screens a session is checked across: a matching one, a barren one, a navigation one. */
const SCREENS = [undefined, BARREN_SCREEN, NAVIGATION_SCREEN] as const;

const contexts = (): readonly DecisionContext[] =>
  SESSION_STEPS.flatMap((step) =>
    SCREENS.map((screen) =>
      contextOf({
        step,
        ...(screen === undefined ? {} : { fixatedElements: screen }),
        history: [{ step: 'land', kind: 'scroll', targetElementId: null, ok: true }],
      }),
    ),
  );

describe('the offline provider through a session handle', () => {
  it('carries the session’s persona and seed', () => {
    const session = createOfflineDeterministicProvider({ seed: 1 }).beginSession({
      personaId: 'p-anna',
      seed: 42,
    });

    expect(session.personaId).toBe('p-anna');
    expect(session.seed).toBe(42);
  });

  it('decides exactly what it decided before sessions existed', async () => {
    const provider = createOfflineDeterministicProvider({ seed: 0 });

    for (const seed of seedBand(16)) {
      const session = provider.beginSession({ personaId: `p-${seed}`, seed });

      for (const context of contexts()) {
        const throughHandle = await session.decide(context);
        // The call that #33 shipped: a provider built for this seed, decided directly.
        const asBefore = await createOfflineDeterministicProvider({ seed }).decide(context);

        expect(throughHandle).toEqual(asBefore);
      }

      await session.close();
    }
  });

  it('decides from the session’s seed, not the one the provider was built with', async () => {
    const context = contextOf();
    const provider = createOfflineDeterministicProvider({ seed: 0 });
    const session = provider.beginSession({ personaId: 'p-anna', seed: 7 });

    expect(await session.decide(context)).toEqual(
      await createOfflineDeterministicProvider({ seed: 7 }).decide(context),
    );
  });

  it('decides the same for two personas on one seed: offline derives nothing from the id', async () => {
    // The persona is already in the context, as its traits. Its id is identity for the
    // things a model provider derives from it — a cache key, a conversation, a file name —
    // and this policy has none of them.
    const provider = createOfflineDeterministicProvider({ seed: 0 });
    const context = contextOf();

    const anna = await provider.beginSession({ personaId: 'p-anna', seed: 4 }).decide(context);
    const boris = await provider.beginSession({ personaId: 'p-boris', seed: 4 }).decide(context);

    expect(boris).toEqual(anna);
  });

  it('decides differently for two personas whose traits differ', async () => {
    const provider = createOfflineDeterministicProvider({ seed: 0 });
    const identity = { personaId: 'p-anna', seed: 4 } as const;
    const stuck = Array.from({ length: 6 }, () => ({
      step: 'browse',
      kind: 'click' as const,
      targetElementId: 'el-home',
      ok: false,
    }));

    const impatient = await provider
      .beginSession(identity)
      .decide(contextOf({ traits: traitsWith({ patience: 0, persistence: 0 }), history: stuck }));
    const dogged = await provider
      .beginSession(identity)
      .decide(contextOf({ traits: traitsWith({ patience: 1, persistence: 1 }), history: stuck }));

    expect(impatient.action.kind).toBe('abandon');
    expect(dogged.action.kind).not.toBe('abandon');
  });

  it('runs two sessions at once without either seeing the other', async () => {
    const provider = createOfflineDeterministicProvider({ seed: 0 });
    const first = provider.beginSession({ personaId: 'p-anna', seed: 3 });
    const second = provider.beginSession({ personaId: 'p-boris', seed: 8 });

    const [firstWalk, secondWalk] = await Promise.all([walkSession(first), walkSession(second)]);

    expect(await walkSession(provider.beginSession({ personaId: 'p-anna', seed: 3 }))).toEqual(
      firstWalk,
    );
    expect(await walkSession(provider.beginSession({ personaId: 'p-boris', seed: 8 }))).toEqual(
      secondWalk,
    );

    await Promise.all([first.close(), second.close()]);
  });

  it('refuses a decision once the session is closed', async () => {
    const session = createOfflineDeterministicProvider({ seed: 0 }).beginSession({
      personaId: 'p-anna',
      seed: 3,
    });
    const context = contextOf();

    expect(validateDecision(context, await session.decide(context))).toEqual([]);
    await session.close();

    await expect(session.decide(context)).rejects.toThrow(DecisionSessionClosedError);
  });
});

describe('createDecisionSession', () => {
  const decision: Decision = {
    intent: 'I will click it.',
    action: { kind: 'click', targetElementId: 'el-jacket' },
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    },
  };

  const sessionWith = (overrides: { close?: () => Promise<void> | void } = {}) => {
    const decide = vi.fn(async (): Promise<Decision> => decision);
    const session = createDecisionSession({
      personaId: 'p-anna',
      seed: 5,
      decide,
      ...overrides,
    });
    return { decide, session };
  };

  it('forwards a decision to the provider’s own body', async () => {
    const { decide, session } = sessionWith();
    const context = contextOf();

    expect(await session.decide(context)).toEqual(decision);
    expect(decide).toHaveBeenCalledWith(context);
  });

  it('never reaches that body once the session is closed, so nothing is written', async () => {
    const { decide, session } = sessionWith();

    await session.close();
    await expect(session.decide(contextOf())).rejects.toBeInstanceOf(DecisionSessionClosedError);

    // The whole point of the guard: a trajectory sink downstream of this never ran.
    expect(decide).not.toHaveBeenCalled();
  });

  it('names the session in the refusal', async () => {
    const { session } = sessionWith();
    await session.close();

    await expect(session.decide(contextOf())).rejects.toMatchObject({
      name: 'DecisionSessionClosedError',
      personaId: 'p-anna',
      seed: 5,
    });
  });

  it('releases what the session held, once, however often it is closed', async () => {
    const close = vi.fn(async () => {});
    const { session } = sessionWith({ close });

    await session.close();
    await session.close();
    await session.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses a decision that arrives while the session is still closing', async () => {
    let release = (): void => {};
    const flushing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { decide, session } = sessionWith({ close: () => flushing });

    const closing = session.close();
    // The sink is mid-flush: a late turn must not append to the file behind it.
    await expect(session.decide(contextOf())).rejects.toBeInstanceOf(DecisionSessionClosedError);
    expect(decide).not.toHaveBeenCalled();

    release();
    await closing;
  });

  it('lets a decision already in flight finish', async () => {
    let settle = (value: Decision): void => void value;
    const inFlight = new Promise<Decision>((resolve) => {
      settle = resolve;
    });
    const session = createDecisionSession({
      personaId: 'p-anna',
      seed: 5,
      decide: () => inFlight,
    });

    const pending = session.decide(contextOf());
    await session.close();
    settle(decision);

    expect(await pending).toEqual(decision);
  });
});
