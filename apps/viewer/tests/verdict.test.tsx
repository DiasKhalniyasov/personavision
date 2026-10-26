// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, serveRunData } from './app';
import { paths } from '../src/shell/paths';

/**
 * The Verdict's composition. The sections themselves are #14's, #15's, #16's and #108's;
 * what this ticket owns is that they are all there, in the prototype's order, each in its
 * own file — so that filling one does not touch another.
 */

const SEED = '2026-10-24-1402-northwind-demo';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the Verdict screen', () => {
  it('composes its nine sections in the order #screen-verdict draws them', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).not.toBeNull();
    });

    const sections = [...container.querySelectorAll('[data-section], [data-shell]')]
      .map((element) => element.getAttribute('data-section') ?? element.getAttribute('data-shell'))
      .filter((slot) => slot !== null && !['chrome', 'tabbar'].includes(slot));

    expect(sections).toEqual([
      'workspace-name',
      'test-picker',
      'simulated-badge',
      'account-menu',
      'audience-line',
      'excluded-banner',
      'headline',
      'completion-figures',
      'reasons',
      'hero-evidence',
      'headline-findings',
      'detail-doors',
      'simulated-disclaimer',
    ]);
  });

  it('leads with one answer and no second chart: the quietness is the contract', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(container.querySelector('[data-section="hero-evidence"]')).not.toBeNull();
    });

    // One piece of evidence, in the one tinted band.
    expect(container.querySelectorAll('[data-section="hero-evidence"]')).toHaveLength(1);
    expect(container.querySelectorAll('.strip-tint')).toHaveLength(1);
    // Nothing a deeper screen owns: no table, no session row, no friction score.
    expect(container.querySelectorAll('table')).toHaveLength(0);
  });
});
