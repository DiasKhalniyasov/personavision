// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from './setup';
import { assertTokensLoaded, readScoreThreshold, scoreBand } from '../src/tokens';

describe('the score-band thresholds come from the design tokens', () => {
  it('reads the committed values out of docs/design/tokens.css', () => {
    loadDesignTokens();

    expect(readScoreThreshold('good')).toBe(25);
    expect(readScoreThreshold('bad')).toBe(60);
  });

  it('follows an override of the custom property instead of returning a literal', () => {
    loadDesignTokens();
    document.documentElement.style.setProperty('--score-threshold-good', '31');
    document.documentElement.style.setProperty('--score-threshold-bad', '72');

    expect(readScoreThreshold('good')).toBe(31);
    expect(readScoreThreshold('bad')).toBe(72);
  });

  it('throws when the token does not resolve, rather than inventing a default', () => {
    expect(() => readScoreThreshold('good')).toThrow('--score-threshold-good');
  });
});

describe('assertTokensLoaded', () => {
  it('passes once the tokens are in the document', () => {
    loadDesignTokens();

    expect(() => assertTokensLoaded()).not.toThrow();
  });

  it('names the file when the stylesheet never arrived', () => {
    expect(() => assertTokensLoaded()).toThrow('docs/design/tokens.css');
  });

  it('fails at boot when a threshold no longer resolves to a number', () => {
    loadDesignTokens();
    document.documentElement.style.setProperty('--score-threshold-bad', 'auto');

    // Checking both thresholds is what catches this at boot rather than at the first
    // score a screen tries to band.
    expect(() => assertTokensLoaded()).toThrow('--score-threshold-bad');
  });
});

describe('scoreBand', () => {
  beforeEach(loadDesignTokens);

  it('bands a friction score by the thresholds, boundaries included', () => {
    expect(scoreBand(0)).toBe('good');
    expect(scoreBand(25)).toBe('good');
    expect(scoreBand(26)).toBe('warn');
    expect(scoreBand(59)).toBe('warn');
    expect(scoreBand(60)).toBe('bad');
    expect(scoreBand(100)).toBe('bad');
  });

  it('moves with the tokens: a stricter good threshold rebands the same score', () => {
    expect(scoreBand(22)).toBe('good');

    document.documentElement.style.setProperty('--score-threshold-good', '20');

    expect(scoreBand(22)).toBe('warn');
  });

  it('rejects a score that is not a finite number instead of calling it clean', () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(() => scoreBand(score as number), String(score)).toThrow('finite number');
    }
  });
});
