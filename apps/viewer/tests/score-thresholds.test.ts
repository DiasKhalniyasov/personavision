// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from './setup';
import { readScoreThreshold, scoreBand } from '../src/tokens';

describe('the score-band thresholds come from the design tokens', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.documentElement.removeAttribute('style');
  });

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

describe('scoreBand', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.documentElement.removeAttribute('style');
    loadDesignTokens();
  });

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
});
