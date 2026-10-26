import { describe, expect, it } from 'vitest';
import { FREE_USAGE, sumUsage, validateDecision } from '../src/decision.js';
import type { Decision, DecisionUsage } from '../src/types.js';
import { contextOf } from './fixtures.js';

const usage = (overrides: Partial<DecisionUsage> = {}): DecisionUsage => ({
  inputTokens: 1200,
  cachedInputTokens: 1024,
  outputTokens: 182,
  reasoningOutputTokens: 172,
  estimatedPriceUsd: 0.0009,
  ...overrides,
});

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  intent: 'That jacket is the one I want.',
  action: { kind: 'click', targetElementId: 'el-jacket' },
  usage: usage(),
  ...overrides,
});

describe('usage', () => {
  it('is five zeroes when the call cost nothing, and cannot be changed', () => {
    expect(FREE_USAGE).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      estimatedPriceUsd: 0,
    });
    expect(Object.isFrozen(FREE_USAGE)).toBe(true);
  });

  it('adds up a run field by field, cached and reasoning included', () => {
    expect(sumUsage([usage(), usage({ cachedInputTokens: 0, estimatedPriceUsd: 0.0011 })])).toEqual(
      {
        inputTokens: 2400,
        cachedInputTokens: 1024,
        outputTokens: 364,
        reasoningOutputTokens: 344,
        estimatedPriceUsd: 0.0009 + 0.0011,
      },
    );
  });

  it('totals nothing to five zeroes', () => {
    expect(sumUsage([])).toEqual(FREE_USAGE);
  });
});

describe('validating a decision against its context', () => {
  const context = contextOf();

  it('passes a well-formed decision', () => {
    expect(validateDecision(context, decision())).toEqual([]);
  });

  it('catches a target the agent never looked at', () => {
    const violations = validateDecision(
      context,
      decision({ action: { kind: 'click', targetElementId: 'el-checkout' } }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('el-checkout');
  });

  it('catches an action that is not one of the six', () => {
    const violations = validateDecision(
      context,
      // A provider reading a model's reply can produce this; the run finds out here.
      decision({ action: { kind: 'type' as 'click', targetElementId: 'el-jacket' } }),
    );

    expect(violations.join(' ')).toContain('the action set is');
  });

  it('catches a click with nothing to click', () => {
    const violations = validateDecision(
      context,
      decision({ action: { kind: 'click', targetElementId: null } }),
    );

    expect(violations.join(' ')).toContain('needs the element it is aimed at');
  });

  it('catches an empty intent', () => {
    expect(validateDecision(context, decision({ intent: '  ' })).join(' ')).toContain(
      'intent is empty',
    );
  });

  it('catches impossible usage', () => {
    expect(
      validateDecision(context, decision({ usage: usage({ cachedInputTokens: 2000 }) })).join(' '),
    ).toContain('cached input tokens are part of the input tokens');
    expect(
      validateDecision(context, decision({ usage: usage({ reasoningOutputTokens: 400 }) })).join(
        ' ',
      ),
    ).toContain('reasoning tokens are part of the output tokens');
    expect(
      validateDecision(context, decision({ usage: usage({ inputTokens: -1 }) })).join(' '),
    ).toContain('usage.inputTokens');
  });

  it('catches a relevance hint for an element that was never looked at, or off the scale', () => {
    expect(
      validateDecision(context, decision({ relevanceHints: { 'el-checkout': 0.5 } })).join(' '),
    ).toContain('el-checkout');
    expect(
      validateDecision(context, decision({ relevanceHints: { 'el-jacket': 1.4 } })).join(' '),
    ).toContain('on [0, 1]');
  });
});
