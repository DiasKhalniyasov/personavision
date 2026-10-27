// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns } from '../app';
import { Verdict } from '../../src/screens/breakdown/Verdict';
import { paths } from '../../src/shell/paths';
import { seedRun, show, withVerdict } from '../verdict/fixture';

/**
 * The verdict line: the gap in points, the harder version, how many seed groups put it
 * higher, and whether the ± 1σ bands came apart.
 *
 * The sentence is the pipeline's and is asserted verbatim. What the tests here are really
 * about is the one failure mode the owner's contract calls out: a run whose bands overlap
 * must not read like a clean win.
 */

const row = (): HTMLElement => document.querySelector('[data-section="verdict"]') as HTMLElement;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the verdict line', () => {
  it('shows the gap, the harder version and the pipeline’s own sentence', () => {
    const run = seedRun();
    show(<Verdict run={run} />);

    expect(document.querySelector('.delta')?.textContent).toBe('+45');
    expect(row().textContent).toContain('Redesign candidate');
    expect(row().textContent).toContain(run.verdict.sentence);
  });

  it('shows how many seed groups put the harder version higher', () => {
    show(<Verdict run={seedRun()} />);

    expect(row().textContent).toContain('3 seed groups put it higher');
  });

  it('says the bands do not overlap when the run says they do not', () => {
    show(<Verdict run={seedRun()} />);

    expect(row().dataset.disjoint).toBe('true');
    expect(row().textContent).toContain('The bands do not overlap');
  });

  it('says so when the bands overlap, rather than reading as a clean win', () => {
    show(<Verdict run={withVerdict(seedRun(), { bandsDisjoint: false })} />);

    expect(row().dataset.disjoint).toBe('false');
    expect(row().textContent).toContain('The bands overlap');
    expect(row().textContent).toContain('did not separate the two versions');
    expect(row().textContent).not.toContain('The bands do not overlap');
  });

  it('shows no gap at all when there is none to show', () => {
    show(<Verdict run={withVerdict(seedRun(), { gapPoints: 0, bandsDisjoint: false })} />);

    expect(document.querySelector('.delta')).toBeNull();
  });

  it('prints a fractional gap as the field holds it', () => {
    show(<Verdict run={withVerdict(seedRun(), { gapPoints: 42.5 })} />);

    expect(document.querySelector('.delta')?.textContent).toBe('+42.5');
  });

  it('opens the heatmap the verdict turns on', () => {
    const run = seedRun();
    show(<Verdict run={run} />);

    const link = screen.getByRole('link', { name: 'See where attention went' });
    const hero = run.verdict.heroEvidence;
    expect(link.getAttribute('href')).toBe(paths.attention(run.runId, hero.variant, hero.step));
  });
});
