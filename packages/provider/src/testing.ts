import { describe, expect, it } from 'vitest';
import { validateDecision } from './decision.js';
import { estimateCostUsd, MODEL_SPEC_BY_ID } from './meta-pricing.js';
import type { PricedModelId } from './meta-pricing.js';
import { DecisionSessionClosedError } from './session.js';
import { WONDER_USES, WonderReplyError } from './wonder.js';
import type { WonderAsk, WonderModel, WonderProvider, WonderReply, WonderUse } from './wonder.js';
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
  /**
   * One decision per seed in the band, each **through its own session handle** — the path a
   * run actually takes. A provider whose `beginSession` body diverged from its session-less
   * `decide` — a second request builder that forgot `cachedInputTokens`, say — would pass a
   * suite that only ever called the latter, and then understate every run's cost (#32).
   */
  const decideAll = async (context: DecisionContext): Promise<readonly Decision[]> =>
    Promise.all(
      seeds.map(async (seed) => {
        const session = options
          .createProvider({ seed })
          .beginSession({ personaId: `p-${seed}`, seed });
        try {
          return await session.decide(context);
        } finally {
          await session.close();
        }
      }),
    );

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

      it('keeps two sessions’ screens apart when their turns interleave', async () => {
        const provider = options.createProvider({ seed: 11 });
        const anna = provider.beginSession({ personaId: 'p-anna', seed: 11 });
        const boris = provider.beginSession({ personaId: 'p-boris', seed: 12 });

        // Two sessions on two screens that share no element id, taking turns. A provider
        // that let one session's conversation, cache entry or buffer answer the other would
        // target an element that was never on this screen, and `validateDecision` names it.
        // Ungated, because a provider that holds session state is exactly the one that can
        // fail this — and the one that declares itself non-deterministic.
        const screens = [
          [anna, [element('el-jacket', 'Waterproof jacket — £129', 'link')]],
          [boris, [element('el-boots', 'Walking boots — £89', 'link')]],
        ] as const;

        for (const step of SESSION_STEPS) {
          for (const [session, fixatedElements] of screens) {
            const context = contextOf({ step, fixatedElements });
            const decision = await session.decide(context);

            expect(validateDecision(context, decision)).toEqual([]);
            expect([null, fixatedElements[0]?.id]).toContain(decision.action.targetElementId);
          }
        }

        await anna.close();

        // One session ending ends that session and no other: the second is still deciding
        // after the first has been closed, flushed and refused.
        await expect(anna.decide(contextOf())).rejects.toBeInstanceOf(DecisionSessionClosedError);
        expect(await walkSession(boris)).toHaveLength(SESSION_STEPS.length);

        await boris.close();
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

          const first = provider.beginSession(identity);
          const alone = await walkSession(first);
          await first.close();

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

/**
 * The **one-shot** contract suite: the tests a Wonder implementation inherits instead of
 * writing.
 *
 * Call `describeWonderProviderContract` from one test file and the implementation is held to
 * everything the seam promises — that the reply is the ask's own parsed shape or an error
 * naming the path, never a half-filled object; that all five usage figures are there and are
 * priced from the one table in `meta-pricing.ts`; that the model which answered travels with
 * the answer, or `null` where none did; and that an implementation claiming determinism is
 * held to it. #255's model implementation adds a file of about five lines and inherits the
 * lot.
 *
 * Every assertion runs over **all four uses** with one shape, because an implementation with
 * a case per use is the thing the seam exists to prevent: the ask carries its own validator
 * and its own generator, so no implementation has anything to branch on.
 *
 * **Nothing here asserts a prompt string, and nothing reads the ask's document.** A Wonder
 * implementation's wording is its own business and changes whenever its model does. What is
 * asserted is what a caller can see: the parsed object, the model, the cost, and the refusal.
 */

/**
 * The shape the suite asks for: small, and deliberately none of the four real ones. The four
 * uses declare their shapes in `@personavision/contract`, and a suite that asked for one of
 * them would be asserting that package's schemas rather than this seam's behaviour.
 */
export interface WonderProbe {
  readonly headline: string;
  readonly confidence: number;
}

/** One refused field, in the shape a schema library's thrown error carries them. */
interface ProbeIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

class ProbeRefusal extends Error {
  readonly issues: readonly ProbeIssue[];

  constructor(issues: readonly ProbeIssue[]) {
    super(issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    this.name = 'ProbeRefusal';
    this.issues = issues;
  }
}

/**
 * A refusal in the shape the seam reads paths out of — the same `issues` array a `zod` error
 * carries. Exported so that an implementation's own fake can refuse a reply the way a real
 * schema does, rather than throwing a bare `Error` and leaving the path unnamed.
 */
export const wonderRefusal = (path: readonly (string | number)[], message: string): Error =>
  new ProbeRefusal([{ path, message }]);

/** The JSON Schema the probe's reply is asked for with, in the strict subset. */
export const WONDER_PROBE_SCHEMA = {
  name: 'WonderProbe',
  schema: {
    type: 'object',
    properties: { headline: { type: 'string' }, confidence: { type: 'number' } },
    required: ['headline', 'confidence'],
    additionalProperties: false,
  },
} as const;

/**
 * The probe's validator: the shape, and that the confidence is on `[0, 1]`. It refuses by
 * throwing with the path named, which is what the four uses' contract schemas do.
 */
export const parseWonderProbe = (reply: unknown): WonderProbe => {
  if (typeof reply !== 'object' || reply === null) {
    throw wonderRefusal([], 'a probe is an object carrying a headline and a confidence');
  }
  const { headline, confidence } = reply as Partial<WonderProbe>;
  const issues: ProbeIssue[] = [];
  if (typeof headline !== 'string' || headline.trim() === '') {
    issues.push({ path: ['headline'], message: 'a probe states its headline in words' });
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    issues.push({ path: ['confidence'], message: 'a confidence is a number' });
  } else if (confidence < 0 || confidence > 1) {
    issues.push({ path: ['confidence'], message: 'a confidence is on [0, 1]' });
  }
  if (issues.length > 0) throw new ProbeRefusal(issues);
  return { headline: headline as string, confidence: confidence as number };
};

/** The probe's offline generator: it reads the seed, so a different seed is a different answer. */
export const wonderProbeOffline = (seed: number): WonderProbe => ({
  headline: `probe ${(seed >>> 0).toString(36)}`,
  confidence: ((seed >>> 0) % 1001) / 1000,
});

/** A probe ask, for the suite and for an implementation's own tests to build on. */
export const wonderProbeAsk = (
  overrides: Partial<WonderAsk<WonderProbe>> = {},
): WonderAsk<WonderProbe> => ({
  use: 'audience',
  document: 'busy parents in Almaty who shop on their phones',
  seed: 1,
  replySchema: WONDER_PROBE_SCHEMA,
  effort: 'minimal',
  parse: parseWonderProbe,
  offline: wonderProbeOffline,
  ...overrides,
});

const USAGE_KEYS = [
  'cachedInputTokens',
  'estimatedCostUsd',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
] as const;

export interface WonderProviderContractOptions {
  /** What to call the implementation in the test names. */
  readonly name: string;
  /**
   * A fresh implementation. It takes no seed: a one-shot call's seed is on the ask, because
   * the ask is the only thing a one-shot implementation is given.
   */
  readonly createProvider: () => WonderProvider;
  /**
   * Whether the same ask and seed must give an identical object. True for a seeded
   * implementation; one with a live sampler behind it says false and keeps the rest.
   */
  readonly deterministic: boolean;
  /** Whether a call costs nothing, so all five usage figures must be zero. */
  readonly free: boolean;
}

export const describeWonderProviderContract = (options: WonderProviderContractOptions): void => {
  const askAll = async (
    build: (use: WonderUse) => WonderAsk<WonderProbe>,
  ): Promise<readonly WonderReply<WonderProbe>[]> => {
    const provider = options.createProvider();
    return Promise.all(WONDER_USES.map(async (use) => provider.ask(build(use))));
  };

  describe(`the one-shot provider contract, against ${options.name}`, () => {
    it('declares the facts a run records about it', () => {
      const provider = options.createProvider();

      expect(provider.name).not.toBe('');
      expect(['offline', 'model']).toContain(provider.mode);
      if (provider.mode === 'offline') {
        // Offline means no model ran, so there is no model id to record. One here would be
        // a run attributing an answer to a model that was never called.
        expect(provider.modelId).toBeUndefined();
      }
      if (provider.modelId !== undefined) expect(provider.modelId).not.toBe('');
    });

    it('answers every one of the four uses with the shape the ask asked for', async () => {
      const replies = await askAll((use) => wonderProbeAsk({ use, seed: 4 }));

      expect(replies).toHaveLength(WONDER_USES.length);
      for (const reply of replies) {
        expect(typeof reply.value.headline).toBe('string');
        expect(reply.value.headline.trim()).not.toBe('');
        expect(typeof reply.value.confidence).toBe('number');
        // The value a caller gets is the validator's own: running it again changes nothing.
        expect(parseWonderProbe(reply.value)).toEqual(reply.value);
      }
    });

    it('reports all five usage figures on every reply', async () => {
      for (const reply of await askAll((use) => wonderProbeAsk({ use, seed: 5 }))) {
        expect(Object.keys(reply.usage).sort()).toEqual([...USAGE_KEYS]);
        for (const key of USAGE_KEYS) {
          const value = reply.usage[key];
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        // Both breakdowns are "of which", not extras, exactly as the API reports them.
        expect(reply.usage.cachedInputTokens).toBeLessThanOrEqual(reply.usage.inputTokens);
        expect(reply.usage.reasoningTokens).toBeLessThanOrEqual(reply.usage.outputTokens);
        if (options.free) {
          expect(reply.usage).toEqual({
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            estimatedCostUsd: 0,
          });
        }
      }
    });

    it('names the model that answered, or nothing where none did, and prices it from the one table', async () => {
      const provider = options.createProvider();

      for (const use of WONDER_USES) {
        const reply = await provider.ask(wonderProbeAsk({ use, seed: 6 }));

        if (provider.mode === 'offline') {
          expect(reply.model).toBeNull();
          expect(reply.usage.estimatedCostUsd).toBe(0);
          continue;
        }

        // A reply a model produced says which, because a run's cost can only be checked
        // against an invoice if each call says what it was priced at.
        expect(reply.model).not.toBeNull();
        const model = reply.model as WonderModel;
        expect(model.mode).not.toBe('');
        if (provider.modelId !== undefined) expect(model.modelId).toBe(provider.modelId);

        // Priced from the one table and by the one estimator: a second arithmetic for a
        // one-shot call is how a run's bill and its invoice drift apart.
        expect(Object.keys(MODEL_SPEC_BY_ID)).toContain(model.modelId);
        expect(reply.usage.estimatedCostUsd).toBe(
          estimateCostUsd(model.modelId as PricedModelId, {
            inputTokens: reply.usage.inputTokens,
            cachedInputTokens: reply.usage.cachedInputTokens,
            outputTokens: reply.usage.outputTokens,
          }),
        );
      }
    });

    it('refuses a reply its validator refuses, naming the path, and hands back no object at all', async () => {
      const provider = options.createProvider();

      for (const use of WONDER_USES) {
        // An ask whose validator refuses whatever it is given. Every implementation runs the
        // ask's validator over what it produced — the offline generator's object, a model's
        // reply — so this is one behaviour asserted once rather than two that agree today.
        const ask = wonderProbeAsk({
          use,
          seed: 7,
          parse: () => {
            throw wonderRefusal(['confidence'], 'a confidence is on [0, 1]');
          },
        });

        // Through `.then`'s second argument rather than `rejects`, so that an
        // implementation which threw **synchronously** instead of rejecting fails here: a
        // refusal a caller holding the promise never sees is not a refusal.
        const outcome = await provider.ask(ask).then(
          (reply) => reply,
          (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(WonderReplyError);
        const refusal = outcome as WonderReplyError;
        expect(refusal.message).toContain('confidence');
        expect(refusal.paths).toContain('confidence');
        expect(refusal.use).toBe(use);
        // Ours, never the person's: a goal that could not be written is our breakage.
        expect(refusal.attribution).toBe('automation');
      }
    });

    if (options.deterministic) {
      it('answers the same ask and seed with the same object, twice and from two providers', async () => {
        for (const use of WONDER_USES) {
          const build = (): WonderAsk<WonderProbe> => wonderProbeAsk({ use, seed: 99 });

          const first = await options.createProvider().ask(build());
          const again = await options.createProvider().ask(build());
          const onceMore = await options.createProvider().ask(build());

          expect(again.value).toEqual(first.value);
          expect(onceMore.value).toEqual(first.value);
        }
      });

      it('answers an ask that differs only in its seed, and keeps that answer stable too', async () => {
        const provider = options.createProvider();
        const seeds = seedBand(8);

        const answers = await Promise.all(
          seeds.map(async (seed) => (await provider.ask(wonderProbeAsk({ seed }))).value),
        );
        const again = await Promise.all(
          seeds.map(async (seed) => (await provider.ask(wonderProbeAsk({ seed }))).value),
        );

        expect(again).toEqual(answers);
      });
    }
  });
};
