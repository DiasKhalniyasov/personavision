import { describe, expect, it } from 'vitest';
import { attributionWords, outcomeWords } from './index.js';
import type { Attribution, OutcomeStatus } from './index.js';

/**
 * The one rule this file exists to keep: somebody giving up, somebody ending without the
 * task done, and our own automation breaking are three different things, worded and
 * coloured differently, and never merged (`docs/FLOW.md` section 8).
 */
const STATUSES: readonly OutcomeStatus[] = ['success', 'abandoned', 'failed', 'automation_failure'];
const ATTRIBUTIONS: readonly Attribution[] = ['product', 'automation'];

describe('the outcome vocabulary', () => {
  it('words each outcome differently', () => {
    const labels = STATUSES.map((status) => outcomeWords(status).label);

    expect(labels).toEqual(['Success', 'Abandoned', 'Failed', 'Automation failure']);
    expect(new Set(labels).size, 'four outcomes, four words').toBe(4);
  });

  it('colours each outcome from a token of its own', () => {
    const tokens = STATUSES.map((status) => outcomeWords(status).token);

    expect(tokens).toEqual([
      '--outcome-success',
      '--outcome-abandoned',
      '--outcome-failed',
      '--attr-automation',
    ]);
    expect(new Set(tokens).size, 'four outcomes, four tokens').toBe(4);
    expect(new Set(STATUSES.map((status) => outcomeWords(status).backgroundToken)).size).toBe(4);
  });

  it('folds none of abandoned, failed and an automation failure into another', () => {
    const abandoned = outcomeWords('abandoned');
    const failed = outcomeWords('failed');
    const automation = outcomeWords('automation_failure');

    for (const [left, right] of [
      [abandoned, failed],
      [abandoned, automation],
      [failed, automation],
    ]) {
      expect(left.label).not.toBe(right.label);
      expect(left.token).not.toBe(right.token);
      expect(left.backgroundToken).not.toBe(right.backgroundToken);
    }
    expect(
      [abandoned, failed, automation].map((words) => words.label),
      'and none of them is a success',
    ).not.toContain(outcomeWords('success').label);
  });
});

describe('the attribution vocabulary', () => {
  it('tells our own failure from the product’s, in words and in colour', () => {
    const [product, automation] = ATTRIBUTIONS.map((attribution) => attributionWords(attribution));

    expect(product?.label).toBe('product');
    expect(automation?.label).toBe('automation');
    expect(product?.token).toBe('--attr-product');
    expect(automation?.token).toBe('--attr-automation');
    expect(product?.token).not.toBe(automation?.token);
  });
});
