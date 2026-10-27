// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoringConfig } from '@personavision/scoring';
import { loadDesignTokens } from '../setup';
import { forgetRuns } from '../app';
import { ScoreCards } from '../../src/screens/breakdown/ScoreCards';
import { seedRun, show, withScore } from '../verdict/fixture';

/**
 * The two score cards: the friction score, its spread, its band, the scale it sits on and
 * the four weighted components.
 *
 * Every figure on the card is stored, so most of what is asserted here is that moving a
 * stored field moves the card — and that the two the product refuses to show are refused:
 * a score without its spread, and a time-to-fixation reading of `0 s` for a control nobody
 * ever looked at.
 */

const cards = (): HTMLElement[] => screen.getAllByRole('figure');

/** One card, by the version it is about. */
const cardFor = (name: string): HTMLElement =>
  cards().find((card) => card.querySelector('h2')?.textContent === name) as HTMLElement;

const rowsOf = (card: HTMLElement) => [...card.querySelectorAll('.components li')];
const textOf = (element: Element | null): string => element?.textContent ?? '';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the friction score, with its spread', () => {
  it('renders each version’s score, spread and band', () => {
    show(<ScoreCards run={seedRun()} />);

    const a = cardFor('Current checkout');
    expect(textOf(a.querySelector('.score-value'))).toBe('22');
    expect(textOf(a.querySelector('.score-spread'))).toBe('± 3');
    expect(textOf(a.querySelector('.score-band'))).toBe('Friction score · clean');

    const b = cardFor('Redesign candidate');
    expect(textOf(b.querySelector('.score-value'))).toBe('67');
    expect(textOf(b.querySelector('.score-spread'))).toBe('± 4');
    expect(textOf(b.querySelector('.score-band'))).toBe('Friction score · defective');
  });

  it('renders the figures the run stores, never figures of its own', () => {
    const run = seedRun();
    show(<ScoreCards run={run} />);

    // Walked rather than spot-checked: the claim is that *nothing* on the card is computed
    // from the sessions, so every card is held to the score the pipeline wrote for it.
    for (const score of run.scores) {
      const variant = run.variants.find((candidate) => candidate.id === score.variant);
      const card = cardFor(variant?.name as string);
      expect(textOf(card.querySelector('.score-value'))).toBe(String(score.frictionScore.median));
      expect(textOf(card.querySelector('.score-spread'))).toBe(`± ${score.frictionScore.sd}`);
      expect(textOf(card.querySelector('.footnote'))).toBe(
        `${score.outcomeCounts.success} completed · ${score.outcomeCounts.abandoned} gave up · ` +
          `${score.outcomeCounts.failed} failed · ${score.outcomeCounts.automationFailure} excluded (our automation)`,
      );
    }
  });

  it('follows a stored score that disagrees with the sessions behind it', () => {
    const run = withScore(seedRun(), 'A', { frictionScore: { median: 41.5, sd: 2.5 } });
    show(<ScoreCards run={run} />);

    const a = cardFor('Current checkout');
    expect(textOf(a.querySelector('.score-value'))).toBe('41.5');
    expect(textOf(a.querySelector('.score-spread'))).toBe('± 2.5');
  });

  it('draws the spread band and the marker on the 0–100 scale', () => {
    show(<ScoreCards run={seedRun()} />);

    const a = cardFor('Current checkout');
    const band = a.querySelector('.spreadband') as HTMLElement;
    const marker = a.querySelector('.marker') as HTMLElement;
    // 22 ± 3 is 19 to 25 on a scale of 100.
    expect(band.style.left).toBe('19%');
    expect(band.style.width).toBe('6%');
    expect(marker.style.left).toBe('22%');
  });

  it('holds the spread band on the scale rather than drawing it off the end', () => {
    // Seed groups scoring 0, 0 and 20: a median of 0 with a deviation of 12 would draw
    // half the band off the left of a scale that starts at 0.
    const run = withScore(seedRun(), 'A', { frictionScore: { median: 0, sd: 12 } });
    show(<ScoreCards run={run} />);

    const band = cardFor('Current checkout').querySelector('.spreadband') as HTMLElement;
    expect(band.style.left).toBe('0%');
    expect(band.style.width).toBe('12%');
  });

  it('shows no number at all for a score the run recorded no spread for', () => {
    const run = withScore(seedRun(), 'A', { frictionScore: { median: 22, sd: Number.NaN } });
    show(<ScoreCards run={run} />);

    const a = cardFor('Current checkout');
    expect(a.querySelector('.score-value')).toBeNull();
    expect(a.querySelector('.scale')).toBeNull();
    expect(textOf(a.querySelector('.score-missing'))).toContain('did not record a spread');
    // The components are still there: what is withheld is the number, not the card.
    expect(rowsOf(a)).toHaveLength(4);
  });

  it('announces each card with its score and its spread', () => {
    show(<ScoreCards run={seedRun()} />);

    expect(
      screen.getByRole('figure', {
        name: 'Current checkout: friction score 22 plus or minus 3 points, clean',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('figure', {
        name: 'Redesign candidate: friction score 67 plus or minus 4 points, defective',
      }),
    ).toBeTruthy();
  });
});

describe('the band comes from the tokens', () => {
  it('moves the band when --score-threshold-good moves', () => {
    // 22 is clean while the good threshold is the committed 25, and is not once it is 21.
    document.documentElement.style.setProperty('--score-threshold-good', '21');
    show(<ScoreCards run={seedRun()} />);

    const a = cardFor('Current checkout');
    expect(textOf(a.querySelector('.score-band'))).toBe('Friction score · some friction');
    expect((a.querySelector('.score-value') as HTMLElement).className).toContain('band-warn');
  });

  it('labels the scale with the thresholds the tokens declare', () => {
    document.documentElement.style.setProperty('--score-threshold-bad', '55');
    show(<ScoreCards run={seedRun()} />);

    const legend = [...cardFor('Current checkout').querySelectorAll('.scale-legend span')].map(
      (span) => textOf(span),
    );
    expect(legend).toEqual(['0 · no friction', '25', '55', '100 · unusable']);
  });
});

describe('the four weighted components', () => {
  it('names each one with the weight the scoring package holds', () => {
    show(<ScoreCards run={seedRun()} />);

    const { weights } = scoringConfig;
    const rows = rowsOf(cardFor('Current checkout')).map((row) =>
      textOf(row.querySelector('.what')),
    );
    expect(rows).toEqual([
      `Task failure rate weight ${Math.round(weights.taskFailureRate * 100)}%`,
      `Gave up weight ${Math.round(weights.abandonment * 100)}%`,
      'Time before anyone looked at the main button ' +
        `weight ${Math.round(weights.timeToFirstFixationPrimary * 100)}% · worst step: Review`,
      `Dead-end revisits per person weight ${Math.round(weights.deadEndRevisits * 100)}%`,
    ]);
  });

  it('reads each component against the counts the run stores', () => {
    show(<ScoreCards run={seedRun()} />);

    const readings = rowsOf(cardFor('Current checkout')).map((row) =>
      textOf(row.querySelector('.val')),
    );
    // 0 of 11 failed, 2 of 11 gave up, 2.3 s to the button, and 0.3 × the cap of five.
    expect(readings).toEqual(['0 / 11', '2 / 11', '2.3 s', '1.5']);
  });

  it('reads “never” for a control no session ever looked at', () => {
    show(<ScoreCards run={seedRun()} />);

    const readings = rowsOf(cardFor('Redesign candidate')).map((row) =>
      textOf(row.querySelector('.val')),
    );
    expect(readings[2]).toBe('never');
    expect(readings[2]).not.toBe('0 s');
    expect(readings[2]).not.toBe('');
  });

  it('reads a capped revisit component as the cap or more', () => {
    const run = withScore(seedRun(), 'A', {
      components: {
        ...(seedRun().scores[0] as NonNullable<ReturnType<typeof seedRun>['scores'][number]>)
          .components,
        deadEndRevisits: 1,
      },
    });
    show(<ScoreCards run={run} />);

    const readings = rowsOf(cardFor('Current checkout')).map((row) =>
      textOf(row.querySelector('.val')),
    );
    expect(readings[3]).toBe(`${scoringConfig.normalisation.deadEndRevisitsPerSession} or more`);
  });

  it('draws each bar at the stored component’s own width', () => {
    const run = seedRun();
    show(<ScoreCards run={run} />);

    const score = run.scores[0] as NonNullable<(typeof run.scores)[number]>;
    const widths = rowsOf(cardFor('Current checkout')).map(
      (row) => (row.querySelector('.bar > span') as HTMLElement).style.width,
    );
    expect(widths[0]).toBe(`${score.components.taskFailureRate * 100}%`);
    expect(widths[1]).toBe(`${score.components.abandonment * 100}%`);
  });
});

describe('a run with less to compare', () => {
  it('renders what it has and names the version that is missing', () => {
    const run = withScore(seedRun(), 'B', null);
    show(<ScoreCards run={run} />);

    expect(cards()).toHaveLength(2);
    const b = cardFor('Redesign candidate');
    expect(textOf(b)).toContain('records no friction score for Redesign candidate');
    expect(b.querySelector('.score-value')).toBeNull();
    // The version that does have one still reads as a figure, not as a comparison.
    expect(textOf(cardFor('Current checkout').querySelector('.score-value'))).toBe('22');
  });
});

describe('the cards without a pointer or a stylesheet', () => {
  it('is clean under axe', async () => {
    const { container } = show(<ScoreCards run={seedRun()} />);

    const results = await axe.run(container, { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('stacks the two cards below the prototype’s breakpoint', () => {
    // A media query is not reachable through a rendered component: jsdom applies no
    // stylesheet of its own, so the rule is read off the file the screen imports.
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, '../../src/screens/breakdown/ScoreCards.css'), 'utf8');

    const narrow = css.slice(css.indexOf('@media (max-width: 1000px)'));
    expect(narrow).toContain('grid-template-columns: 1fr;');
  });
});
