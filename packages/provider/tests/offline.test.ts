import { describe, expect, it } from 'vitest';
import { createOfflineDeterministicProvider } from '../src/offline.js';
import { validateDecision } from '../src/decision.js';
import type {
  DecisionActionKind,
  DecisionContext,
  PastAction,
  PersonaTraits,
} from '../src/types.js';
import {
  BARREN_SCREEN,
  contextOf,
  element,
  GOAL,
  MATCHING_SCREEN,
  NAVIGATION_SCREEN,
  seedBand,
  traitsWith,
} from './fixtures.js';

const decide = (context: DecisionContext, seed: number) =>
  createOfflineDeterministicProvider({ seed }).decide(context);

/**
 * One agent, one screen, over and over: what it decides, in order, when every click it
 * tries comes back having changed nothing. This is how a session gets stuck, and it is
 * where patience and persistence show.
 */
const walkWhileStuck = async (
  traits: PersonaTraits,
  seed: number,
  screen = MATCHING_SCREEN,
  limit = 24,
): Promise<readonly DecisionActionKind[]> => {
  const provider = createOfflineDeterministicProvider({ seed });
  const history: PastAction[] = [];
  const kinds: DecisionActionKind[] = [];

  for (let turn = 0; turn < limit; turn += 1) {
    const { action } = await provider.decide({
      goal: GOAL,
      traits,
      step: { id: 'browse', index: 1 },
      fixatedElements: screen,
      history,
    });
    kinds.push(action.kind);
    history.push({
      step: 'browse',
      kind: action.kind,
      targetElementId: action.targetElementId,
      // A click that advanced nothing: the agent is stuck, which is the point of the walk.
      ok: action.kind !== 'click',
    });
    if (action.kind === 'abandon') break;
  }

  return kinds;
};

describe('the offline deterministic provider', () => {
  it('is free, offline and blind, and says so', () => {
    const provider = createOfflineDeterministicProvider({ seed: 1 });

    expect(provider.mode).toBe('offline');
    expect(provider.readsImages).toBe(false);
  });

  it('decides identically for the same context and seed', async () => {
    const context = contextOf();

    expect(await decide(context, 11)).toEqual(await decide(context, 11));
  });

  it('decides differently for a different seed', async () => {
    const context = contextOf();
    const decisions = await Promise.all(seedBand(32).map((seed) => decide(context, seed)));
    const distinct = new Set(decisions.map((decision) => JSON.stringify(decision)));

    expect(distinct.size).toBeGreaterThan(1);
  });

  it('decides the same screen the same way whatever order it was asked in', async () => {
    const provider = createOfflineDeterministicProvider({ seed: 3 });
    const first = contextOf();
    const second = contextOf({ step: { id: 'cart', index: 2 }, fixatedElements: BARREN_SCREEN });

    const fresh = await provider.decide(first);
    await provider.decide(second);
    await provider.decide(second);

    expect(await provider.decide(first)).toEqual(fresh);
  });

  it('goes for what answers the goal far more often than for a distractor', async () => {
    const context = contextOf();
    const seeds = seedBand(200);
    const targets = await Promise.all(
      seeds.map(async (seed) => (await decide(context, seed)).action.targetElementId),
    );

    const onJacket = targets.filter((id) => id === 'el-jacket').length;
    const onDistractor = targets.filter((id) => id !== null && id !== 'el-jacket').length;

    // A fixed band of seeds and a fixed tolerance: this test cannot flake, and it still
    // leaves the policy the seeded noise that makes a swarm a spread.
    expect(onJacket / seeds.length).toBeGreaterThanOrEqual(0.7);
    expect(onJacket).toBeGreaterThan(3 * onDistractor);
  });

  it('never targets an element the agent has not looked at', async () => {
    // The checkout button is on the page and the agent never fixated it, so it is not in
    // the context at all — and a history that mentions it changes nothing.
    const context = contextOf({
      fixatedElements: [element('el-jacket', 'Waterproof jacket — £129', 'link')],
      history: [{ step: 'browse', kind: 'click', targetElementId: 'el-checkout', ok: false }],
    });
    const fixated = new Set(context.fixatedElements.map((item) => item.id));

    for (const seed of seedBand(64)) {
      const decision = await decide(context, seed);
      expect(validateDecision(context, decision)).toEqual([]);
      if (decision.action.targetElementId !== null) {
        expect(fixated.has(decision.action.targetElementId)).toBe(true);
      }
    }
  });

  it('looks further down the page when nothing it has seen is worth acting on', async () => {
    const decision = await decide(contextOf({ fixatedElements: BARREN_SCREEN }), 5);

    expect(decision.action.kind).toBe('scroll');
    expect(decision.action.targetElementId).toBeNull();
  });

  it('scrolls past a screen of navigation rather than clicking a link at random', async () => {
    // Every element here is a control the agent looked at, and none of them answers the
    // goal: being clickable is not a reason to click.
    for (const seed of seedBand(16)) {
      const decision = await decide(contextOf({ fixatedElements: NAVIGATION_SCREEN }), seed);
      expect(decision.action.kind).toBe('scroll');
    }
  });

  it('decides differently for two personas that differ only in risk and familiarity', async () => {
    const cautious = traitsWith({ riskTolerance: 0.05, interfaceFamiliarity: 0.95 });
    const chancer = traitsWith({ riskTolerance: 0.95, interfaceFamiliarity: 0.05 });

    const theirs = await Promise.all(
      seedBand(32).map(async (seed) => [
        (await decide(contextOf({ traits: cautious }), seed)).action.targetElementId,
        (await decide(contextOf({ traits: chancer }), seed)).action.targetElementId,
      ]),
    );

    expect(theirs.some(([mine, yours]) => mine !== yours)).toBe(true);
  });

  it('reads the text when the persona is a careful reader', async () => {
    const screen = [
      element('el-spec', 'Fully taped seams, 10,000 mm waterproof rating', null, {
        dwellMs: 1800,
        fixationCount: 5,
      }),
      element('el-jacket', 'Waterproof jacket — £129', 'link'),
    ];
    const careful = traitsWith({ detailOrientation: 0.9, scanningVsReading: 0.1 });

    const decision = await decide(contextOf({ traits: careful, fixatedElements: screen }), 4);

    expect(decision.action.kind).toBe('read');
    expect(decision.action.targetElementId).toBe('el-spec');
  });

  it('states an intent in the agent’s own words, naming what it acted on', async () => {
    const context = contextOf();
    const byId = new Map(context.fixatedElements.map((item) => [item.id, item.text]));

    for (const seed of seedBand(16)) {
      const { intent, action } = await decide(context, seed);
      expect(intent.trim()).not.toBe('');
      if (action.targetElementId !== null) {
        expect(intent).toContain(byId.get(action.targetElementId));
      }
    }
  });

  it('costs nothing', async () => {
    const { usage } = await decide(contextOf(), 9);

    expect(usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    });
  });
});

describe('persona traits change what the agent does', () => {
  const impatient = traitsWith({ patience: 0.1, persistence: 0.1 });
  const persistent = traitsWith({ patience: 0.9, persistence: 0.9 });

  it('makes an impatient, unpersistent persona hesitate and give up sooner', async () => {
    const quitter = await walkWhileStuck(impatient, 17);
    const trier = await walkWhileStuck(persistent, 17);

    expect(quitter).toContain('hesitate');
    expect(trier).toContain('hesitate');
    expect(quitter.indexOf('hesitate')).toBeLessThan(trier.indexOf('hesitate'));

    expect(quitter.at(-1)).toBe('abandon');
    expect(trier.at(-1)).toBe('abandon');
    expect(quitter.length).toBeLessThan(trier.length);
  });

  it('gives up where it came from rather than looping on going back', async () => {
    const kinds = await walkWhileStuck(persistent, 17);

    expect(kinds).toContain('backtrack');
    expect(kinds.filter((kind) => kind === 'backtrack')).toHaveLength(1);
  });

  it('never gives up on a session that is going well', async () => {
    // Every click advances, so the budget of fruitless actions never runs down: a task of
    // twenty screens is not an abandonment.
    const provider = createOfflineDeterministicProvider({ seed: 8 });
    const history: PastAction[] = [];

    for (let screen = 0; screen < 20; screen += 1) {
      const { action } = await provider.decide({
        goal: GOAL,
        traits: traitsWith({}),
        step: { id: `step-${screen}`, index: screen },
        fixatedElements: MATCHING_SCREEN,
        history,
      });
      expect(action.kind).toBe('click');
      history.push({
        step: `step-${screen}`,
        kind: action.kind,
        targetElementId: action.targetElementId,
        ok: true,
      });
    }
  });

  it('never goes back from the first screen of a session', async () => {
    const history: PastAction[] = [
      { step: 'landing', kind: 'click', targetElementId: 'el-newsletter', ok: false },
      { step: 'landing', kind: 'hesitate', targetElementId: null, ok: true },
    ];
    const context = contextOf({ step: { id: 'landing', index: 0 }, history });

    for (const seed of seedBand(16)) {
      expect((await decide(context, seed)).action.kind).not.toBe('backtrack');
    }
  });
});
