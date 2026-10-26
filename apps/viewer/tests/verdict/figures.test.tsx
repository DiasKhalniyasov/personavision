// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns } from '../app';
import { CompletionFigures } from '../../src/screens/verdict/CompletionFigures';
import { completionBand, inTen, percent } from '../../src/screens/verdict/completionBand';
import { seedRun, show, withScore, withVerdict } from './fixture';

/**
 * The two completion figures: the share of the audience that finished the task, per
 * version, with the number of people behind it and the one to ship marked.
 *
 * Everything here is read from the run as the pipeline wrote it, so most of these tests
 * move a stored field and assert the screen followed it rather than recomputing something
 * of its own.
 */

/** The figures on screen, in the order they are drawn. */
const figures = (): HTMLElement[] => screen.getAllByRole('figure');

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the two completion figures', () => {
  it('renders each as N in 10, with the percentage and the population', () => {
    const run = seedRun();
    show(<CompletionFigures run={run} />);

    const [current, redesign] = figures();
    expect((current as HTMLElement).textContent).toBe(
      '8 in 10Current checkout82% · 9 of 11 people completed the task · the one to ship',
    );
    expect((redesign as HTMLElement).textContent).toBe(
      '2 in 10Redesign candidate18% · 2 of 11 people completed the task',
    );
  });

  it('reads the share from the stored rate, never from the sessions behind it', () => {
    // The counts stay at 9 of 11 and the stored rate says a half: the screen reports the
    // rate the scoring step wrote, and the population it wrote beside it.
    const run = withScore(seedRun(), 'A', { completionRate: 0.5 });
    show(<CompletionFigures run={run} />);

    const text = (figures()[0] as HTMLElement).textContent ?? '';
    expect(text).toContain('5 in 10');
    expect(text).toContain('50%');
    expect(text).toContain('9 of 11 people completed the task');
  });

  it('never shows a figure without its population', () => {
    show(<CompletionFigures run={seedRun()} />);

    for (const figure of figures()) {
      expect(figure.textContent, figure.textContent ?? '').toMatch(
        /\d+ of \d+ people completed the task/,
      );
    }
  });

  it('announces each figure with its version and its population', () => {
    const run = seedRun();
    show(<CompletionFigures run={run} />);

    // Each figure is one announced group: the number, the version it belongs to and the
    // people behind it are read together, so the answer is available without sight of it.
    expect(figures()).toHaveLength(run.variants.length);
    for (const [index, figure] of figures().entries()) {
      const variant = run.variants[index] as (typeof run.variants)[number];
      expect(figure.textContent, variant.name).toContain(variant.name);
      expect(figure.textContent, variant.name).toContain('people completed the task');
    }
  });
});

describe('the one to ship', () => {
  it('marks the version verdict.preferredVariant names', () => {
    show(<CompletionFigures run={seedRun()} />);

    expect((figures()[0] as HTMLElement).textContent).toContain('the one to ship');
    expect((figures()[1] as HTMLElement).textContent).not.toContain('the one to ship');
  });

  it('follows the field when the artifact prefers the other version', () => {
    // Nothing else changes: B still has the lower rate, and the marking still moves.
    show(<CompletionFigures run={withVerdict(seedRun(), { preferredVariant: 'B' })} />);

    expect((figures()[0] as HTMLElement).textContent).not.toContain('the one to ship');
    expect((figures()[1] as HTMLElement).textContent).toContain('the one to ship');
    expect(screen.getAllByText('the one to ship')).toHaveLength(1);
  });
});

describe('the band comes from the design tokens', () => {
  it('bands a rate by the committed thresholds, both boundaries included', () => {
    expect(completionBand(1)).toBe('good');
    expect(completionBand(0.6)).toBe('good');
    expect(completionBand(0.59)).toBe('warn');
    expect(completionBand(0.31)).toBe('warn');
    expect(completionBand(0.3)).toBe('bad');
    expect(completionBand(0)).toBe('bad');
  });

  it('rebands the rendered figure when a threshold moves', () => {
    const run = seedRun();
    const { rerender } = show(<CompletionFigures run={run} />);
    const value = () => figures()[0]?.querySelector('.figure-value')?.className ?? '';

    // The band is a colour, and the class the colour hangs on is the only place it can be
    // read in a test: 82% is inside the good band as the tokens are committed.
    expect(value()).toContain('completion-good');

    document.documentElement.style.setProperty('--completion-threshold-good', '0.9');
    rerender(<CompletionFigures run={{ ...run }} />);

    expect(value()).toContain('completion-warn');
  });

  it('refuses a rate that is not a share of the audience, rather than banding it good', () => {
    for (const rate of [Number.NaN, 1.4, -0.1, null, undefined]) {
      expect(() => completionBand(rate as number), String(rate)).toThrow('between 0 and 1');
      expect(() => inTen(rate as number), String(rate)).toThrow('between 0 and 1');
      expect(() => percent(rate as number), String(rate)).toThrow('between 0 and 1');
    }
  });
});

describe('the figure out of ten', () => {
  it('rounds the share to tenths, as the product says it', () => {
    expect(inTen(0.818182)).toBe(8);
    expect(inTen(0.181818)).toBe(2);
    expect(percent(0.818182)).toBe(82);
    expect(percent(0.181818)).toBe(18);
  });

  it('keeps 10 for everybody and 0 for nobody, and rounds to neither', () => {
    expect(inTen(1)).toBe(10);
    expect(inTen(0)).toBe(0);
    // 96% is not everybody, and 3% is not nobody: the population beside the figure would
    // say so, and the figure must not disagree with it.
    expect(inTen(0.958)).toBe(9);
    expect(inTen(0.028)).toBe(1);
  });

  it('does not claim the whole audience got through when three of them did not', () => {
    const run = withScore(seedRun(), 'A', {
      completionRate: 0.958333,
      outcomeCounts: { success: 69, abandoned: 2, failed: 1, automationFailure: 0 },
      scoredSessionCount: 72,
    });
    show(<CompletionFigures run={run} />);

    const text = (figures()[0] as HTMLElement).textContent ?? '';
    expect(text).toContain('9 in 10');
    expect(text).not.toContain('10 in 10');
    expect(text).toContain('96% · 69 of 72 people completed the task');
  });
});

describe('a test with one version', () => {
  it('says the figure it has is a reading and not a comparison', () => {
    const run = seedRun();
    const alone = { ...run, variants: run.variants.slice(0, 1) };
    const { container } = show(<CompletionFigures run={alone} />);

    expect(figures()).toHaveLength(1);
    expect((figures()[0] as HTMLElement).textContent).toContain('8 in 10');
    expect(container.textContent).toContain('This test ran one version');
    expect(container.textContent).toContain('not a comparison');
  });

  it('says nothing of the kind when the test has its two versions', () => {
    const { container } = show(<CompletionFigures run={seedRun()} />);

    expect(container.textContent).not.toContain('This test ran one version');
  });
});

describe('a figure nobody measured', () => {
  it('says why there is no figure when no session on a version was scored', () => {
    const run = withScore(seedRun(), 'B', { scoredSessionCount: 0 });
    show(<CompletionFigures run={run} />);

    const text = (figures()[1] as HTMLElement).textContent ?? '';
    expect(text).toContain('Redesign candidate');
    expect(text).toContain('no session on this version was scored');
    // No rate over nothing: no figure, no percentage.
    expect(text).not.toMatch(/in 10/);
    expect(text).not.toMatch(/\d+%/);
  });

  it('names the version a run has no score for, rather than showing one figure as a comparison', () => {
    const run = withScore(seedRun(), 'B', null);
    show(<CompletionFigures run={run} />);

    expect(figures()).toHaveLength(2);
    const text = (figures()[1] as HTMLElement).textContent ?? '';
    expect(text).toContain('Redesign candidate');
    expect(text).toContain('recorded no score for this version');
    // The figure the run does have is still a figure.
    expect((figures()[0] as HTMLElement).textContent).toContain('8 in 10');
  });
});
