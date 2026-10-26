import { describe, expect, it } from 'vitest';
import { validateDecision } from './decision.js';
import { DecisionSessionClosedError } from './session.js';
import type {
  Decision,
  DecisionContext,
  DecisionProvider,
  DecisionSession,
  DecisionStep,
  FixatedElement,
  PastAction,
  PersonaTraits,
} from './types.js';

/**
 * The provider-contract suite: the tests a decision provider inherits instead of writing.
 *
 * Call `describeDecisionProviderContract` from one test file and the provider is held to
 * everything the interface promises — the action set, the knowledge boundary, the five
 * usage figures, the way one agent session behaves on its one handle, and the behaviour
 * that makes it a decision layer rather than a dice roll. A new provider (#43's model
 * provider, anything after it) adds a file of about five lines and inherits the lot; what
 * it may not do is weaken one of these.
 *
 * The session guarantees are here rather than in each provider's own tests because they are
 * what the rest of the system is built on: #139's trajectory file is opened and closed on a
 * handle, and a handle that leaked state into another session, or wrote one more line after
 * being closed, would corrupt a run's audit trail rather than fail a test.
 *
 * **Nothing here asserts a prompt string.** A provider's prompt is its own business and
 * changes whenever its model does. What is asserted is what a run can see: which element
 * was targeted, what kind of action it was, what the call cost.
 */

/**
 * The fixtures, exported: a provider's own tests build on the same screen the contract
 * suite scores, so the two never drift apart.
 */

/** Mid-scale on every trait, so a fixture persona has no opinion of its own. */
export const MIDDLING: PersonaTraits = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

export const element = (
  id: string,
  text: string,
  role: string | null,
  overrides: Partial<FixatedElement> = {},
): FixatedElement => ({ id, text, role, fixationCount: 2, dwellMs: 400, ...overrides });

/** A shopping screen whose primary control answers the goal and whose others do not. */
export const GOAL = { text: 'Find the price of the waterproof jacket' } as const;

export const MATCHING_SCREEN: readonly FixatedElement[] = [
  element('el-jacket', 'Waterproof jacket — £129', 'link'),
  element('el-newsletter', 'Newsletter signup', 'button'),
  element('el-home', 'Home', 'link'),
];

export const contextOf = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  goal: GOAL,
  traits: MIDDLING,
  step: { id: 'browse', index: 1, label: 'Browse the catalogue' },
  fixatedElements: MATCHING_SCREEN,
  history: [],
  ...overrides,
});

/**
 * Three screens of one session, in order, so that a handle is exercised the way a session
 * uses it: more than one turn, and a growing action history behind each one.
 */
export const SESSION_STEPS: readonly DecisionStep[] = [
  { id: 'land', index: 0, label: 'Land on the page' },
  { id: 'browse', index: 1, label: 'Browse the catalogue' },
  { id: 'product', index: 2, label: 'Open the product' },
];

/**
 * Walks a session through `SESSION_STEPS` on its one handle, carrying its own history
 * forward, and returns what it decided. Every screen is checked against the knowledge
 * boundary as it goes, because a handle that remembered the wrong session would show up
 * first as a decision aimed at an element of someone else's screen.
 */
export const walkSession = async (
  session: DecisionSession,
  steps: readonly DecisionStep[] = SESSION_STEPS,
): Promise<readonly Decision[]> => {
  const history: PastAction[] = [];
  const decisions: Decision[] = [];

  for (const step of steps) {
    const context = contextOf({ step, history: [...history] });
    const decision = await session.decide(context);

    expect(validateDecision(context, decision)).toEqual([]);
    decisions.push(decision);
    history.push({
      step: step.id,
      kind: decision.action.kind,
      targetElementId: decision.action.targetElementId,
      ok: true,
    });
  }

  return decisions;
};

/** A band of seeds, fixed, so that every assertion over it is reproducible, never flaky. */
export const seedBand = (size: number): readonly number[] =>
  Array.from({ length: size }, (_, index) => index);

export interface DecisionProviderContractOptions {
  /** What to call the provider in the test names. */
  readonly name: string;
  /** A fresh provider for one session seed. */
  readonly createProvider: (options: { readonly seed: number }) => DecisionProvider;
  /**
   * Whether the same context and seed must give an identical decision. True for a
   * deterministic provider; a model provider with a live sampler says false and keeps the
   * rest of the suite.
   */
  readonly deterministic: boolean;
  /** Whether the provider costs nothing, so all five usage figures must be zero. */
  readonly free: boolean;
  /** How many seeds the behavioural assertions run over. Fixed, not random. */
  readonly seedBand?: number;
}

export const describeDecisionProviderContract = (
  options: DecisionProviderContractOptions,
): void => {
  const seeds = seedBand(options.seedBand ?? 32);
  const decideAll = async (context: DecisionContext): Promise<readonly Decision[]> =>
    Promise.all(seeds.map((seed) => options.createProvider({ seed }).decide(context)));

  describe(`the decision provider contract, against ${options.name}`, () => {
    it('declares the three facts a run records about it', () => {
      const provider = options.createProvider({ seed: 1 });

      expect(provider.name).not.toBe('');
      expect(['offline', 'model']).toContain(provider.mode);
      expect(typeof provider.readsImages).toBe('boolean');
    });

    it('returns a well-formed decision for every seed in the band', async () => {
      const context = contextOf();

      for (const decision of await decideAll(context)) {
        expect(validateDecision(context, decision)).toEqual([]);
        expect(decision.intent.trim()).not.toBe('');
      }
    });

    it('carries exactly one action, from the published set', async () => {
      const kinds = (await decideAll(contextOf())).map((decision) => decision.action.kind);

      for (const kind of kinds) {
        expect(['click', 'scroll', 'read', 'hesitate', 'backtrack', 'abandon']).toContain(kind);
      }
    });

    it('never targets an element the agent did not fixate on this screen', async () => {
      const context = contextOf({
        // The distractor is gone from this screen: a provider that remembers it from the
        // fixture above, or that invents an id, is caught here.
        fixatedElements: [element('el-jacket', 'Waterproof jacket — £129', 'link')],
        history: [{ step: 'browse', kind: 'read', targetElementId: 'el-newsletter', ok: true }],
      });

      for (const decision of await decideAll(context)) {
        expect(validateDecision(context, decision)).toEqual([]);
        expect([null, 'el-jacket']).toContain(decision.action.targetElementId);
      }
    });

    it('decides without a target when the agent has looked at nothing', async () => {
      const context = contextOf({ fixatedElements: [] });

      for (const decision of await decideAll(context)) {
        expect(decision.action.targetElementId).toBeNull();
        expect(validateDecision(context, decision)).toEqual([]);
      }
    });

    it('reports usage with all five figures on every decision', async () => {
      for (const decision of await decideAll(contextOf())) {
        expect(Object.keys(decision.usage).sort()).toEqual([
          'cachedInputTokens',
          'estimatedCostUsd',
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
        ]);
        if (options.free) {
          expect(decision.usage).toEqual({
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            estimatedCostUsd: 0,
          });
        }
      }
    });

    it('goes for what answers the goal more often than for a distractor', async () => {
      const targeted = (await decideAll(contextOf()))
        .map((decision) => decision.action.targetElementId)
        .filter((id): id is string => id !== null);

      const onMatch = targeted.filter((id) => id === 'el-jacket').length;
      const onDistractor = targeted.filter((id) => id !== 'el-jacket').length;

      expect(targeted.length).toBeGreaterThan(0);
      expect(onMatch).toBeGreaterThan(onDistractor);
    });

    describe('one agent session, one handle', () => {
      it('hands back a handle that carries the session’s persona and seed', async () => {
        const session = options
          .createProvider({ seed: 3 })
          .beginSession({ personaId: 'p-anna', seed: 3 });

        expect(session.personaId).toBe('p-anna');
        expect(session.seed).toBe(3);

        await session.close();
      });

      it('decides every screen of the session through that one handle', async () => {
        const session = options
          .createProvider({ seed: 5 })
          .beginSession({ personaId: 'p-anna', seed: 5 });

        // `walkSession` checks each decision against the screen it was made on.
        const decisions = await walkSession(session);

        expect(decisions).toHaveLength(SESSION_STEPS.length);
        // The handle is the session's for its whole life: a provider that re-derived its
        // identity per turn — from a fresh cache key, say — would drift from it here.
        expect(session.personaId).toBe('p-anna');
        expect(session.seed).toBe(5);

        await session.close();
      });

      it('keeps two handles with a different persona or seed independent', async () => {
        const provider = options.createProvider({ seed: 11 });
        const first = provider.beginSession({ personaId: 'p-anna', seed: 11 });
        const second = provider.beginSession({ personaId: 'p-boris', seed: 12 });

        expect(first.personaId).not.toBe(second.personaId);
        expect(first.seed).not.toBe(second.seed);

        await walkSession(first);
        await first.close();

        // One session ending ends that session and no other: the second is still deciding
        // after the first has been closed, flushed and refused.
        await expect(first.decide(contextOf())).rejects.toBeInstanceOf(DecisionSessionClosedError);
        expect(await walkSession(second)).toHaveLength(SESSION_STEPS.length);

        await second.close();
      });

      it('refuses to decide once the session is closed, and names the session', async () => {
        const session = options
          .createProvider({ seed: 2 })
          .beginSession({ personaId: 'p-anna', seed: 2 });

        await session.decide(contextOf());
        await session.close();

        const refusal = await session.decide(contextOf()).then(
          (decision) => decision,
          (error: unknown) => error,
        );

        expect(refusal).toBeInstanceOf(DecisionSessionClosedError);
        expect(refusal).toMatchObject({ personaId: 'p-anna', seed: 2 });
      });

      it('closes a session as often as asked without complaining', async () => {
        const session = options
          .createProvider({ seed: 2 })
          .beginSession({ personaId: 'p-anna', seed: 2 });

        await expect(session.close()).resolves.toBeUndefined();
        await expect(session.close()).resolves.toBeUndefined();
      });

      if (options.deterministic) {
        it('decides a session the same whether or not another session is running', async () => {
          const provider = options.createProvider({ seed: 9 });
          const identity = { personaId: 'p-anna', seed: 9 } as const;

          const alone = await walkSession(provider.beginSession(identity));

          // The same session again, turn for turn, with a second session's turns in
          // between. Any state the two shared — a conversation, a cache key, a counter —
          // would land in the wrong one and show up as a different decision here.
          const watched = provider.beginSession(identity);
          const other = provider.beginSession({ personaId: 'p-boris', seed: 10 });
          const interleaved: Decision[] = [];
          const watchedHistory: PastAction[] = [];
          const otherHistory: PastAction[] = [];

          for (const step of SESSION_STEPS) {
            const otherContext = contextOf({ step, history: [...otherHistory] });
            const otherDecision = await other.decide(otherContext);
            otherHistory.push({
              step: step.id,
              kind: otherDecision.action.kind,
              targetElementId: otherDecision.action.targetElementId,
              ok: true,
            });

            const context = contextOf({ step, history: [...watchedHistory] });
            const decision = await watched.decide(context);
            interleaved.push(decision);
            watchedHistory.push({
              step: step.id,
              kind: decision.action.kind,
              targetElementId: decision.action.targetElementId,
              ok: true,
            });
          }

          expect(interleaved).toEqual(alone);

          await watched.close();
          await other.close();
        });
      }
    });

    if (options.deterministic) {
      it('decides identically for the same context and seed', async () => {
        const context = contextOf();
        const first = await options.createProvider({ seed: 7 }).decide(context);
        const second = await options.createProvider({ seed: 7 }).decide(context);

        expect(second).toEqual(first);
      });

      it('decides the same with and without a screenshot when it cannot read images', async () => {
        const provider = options.createProvider({ seed: 7 });
        if (provider.readsImages) return;

        const blind = await provider.decide(contextOf());
        const withImage = await provider.decide(
          contextOf({ screenshot: { path: 'screenshots/a-browse.png' } }),
        );

        expect(withImage).toEqual(blind);
      });
    }
  });
};
