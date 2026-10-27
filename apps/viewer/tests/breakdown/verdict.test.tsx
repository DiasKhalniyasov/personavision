// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns } from '../app';
import { Verdict } from '../../src/screens/breakdown/Verdict';
import { paths } from '../../src/shell/paths';
import { seedRun, show, withScore, withVerdict } from '../verdict/fixture';

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

  it('shows how many of the comparable seed groups put the harder version higher', () => {
    show(<Verdict run={seedRun()} />);

    // The count is the run's; the denominator is how many groups both versions were run in.
    expect(row().textContent).toContain('3 of 3 seed groups put it higher');
  });

  it('says there is nothing to compare rather than reporting a zero that reads as one', () => {
    // A run of real sessions carries no seed, so no group agreed and none disagreed.
    const run = seedRun();
    const unseeded = withVerdict(
      withScore(withScore(run, 'A', { perSeedGroup: [] }), 'B', { perSeedGroup: [] }),
      { seedGroupsAgreeing: 0 },
    );
    show(<Verdict run={unseeded} />);

    expect(row().textContent).toContain('No seed groups to compare');
    expect(row().textContent).not.toContain('put it higher');
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

  it('names no harder version when nothing separated the two', () => {
    // The field still names one, by a tie-break: a coloured chip beside a sentence saying
    // neither is harder would contradict it where a reader looks first.
    show(<Verdict run={withVerdict(seedRun(), { gapPoints: 0, bandsDisjoint: false })} />);

    expect(document.querySelector('.delta')).toBeNull();
    expect(row().querySelector('.tag-b')).toBeNull();
  });

  it('says there is no second band when only one version was scored', () => {
    const run = withVerdict(withScore(seedRun(), 'B', null), {
      gapPoints: 0,
      // A run with one scored version stores this as false; there was never a second band.
      bandsDisjoint: false,
      sentence: 'Only variant A was scored, so there was no gap to measure.',
    });
    show(<Verdict run={run} />);

    expect(row().textContent).toContain('no second band to compare');
    expect(row().textContent).not.toContain('did not separate the two versions');
    expect(row().textContent).toContain('No seed groups to compare');
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
