import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  areaSource,
  assertNeverFixatedConsistent,
  elapsedSeconds,
  firstFixationDuration,
  isNeverFixated,
  lookedAtShare,
  medianCaveat,
  neverFixatedLabel,
  neverFixatedProblem,
  neverFixatedSentence,
  noFiguresRecorded,
  notPresentInVariant,
  unknownAreaProblem,
} from './attentionWording';
import type { Aoi, AoiMetric } from './useAttentionAreas';

/**
 * The words the areas-of-interest figures are read in.
 *
 * The one that matters is `never`. `docs/FLOW.md` section 3 makes an area nobody fixated a
 * **result** rather than a gap, so these tests are mostly about what is never printed: no
 * `0 ms` for a first fixation that never happened, no blank cell, and no figure at all for
 * a row whose two halves of "never" disagree.
 */

const metric = (over: Partial<AoiMetric> = {}): AoiMetric => ({
  aoiId: 'B-review-complete',
  timeToFirstFixationMs: 2300,
  firstFixationDurationMs: 480,
  totalDwellMs: 1600,
  fixationCount: 2,
  revisits: 0,
  lookedAtShare: 1,
  sessionCount: 9,
  ...over,
});

const area = (over: Partial<Aoi> = {}): Aoi => ({
  id: 'B-review-complete',
  variant: 'B',
  step: 'review',
  label: 'Completing action',
  source: 'dom',
  role: 'button',
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  isPrimaryAction: false,
  belowFold: false,
  ...over,
});

/** A never-fixated area as the pipeline writes one: both halves of it at once. */
const neverFixated = metric({
  timeToFirstFixationMs: null,
  firstFixationDurationMs: null,
  totalDwellMs: 0,
  fixationCount: 0,
  revisits: 0,
  lookedAtShare: 0,
});

describe('the figures, as the table prints them', () => {
  it('prints the share of the audience who looked at it, whole', () => {
    expect(lookedAtShare(0)).toBe('0%');
    expect(lookedAtShare(1)).toBe('100%');
    expect(lookedAtShare(0.91)).toBe('91%');
  });

  it('never rounds a share nobody had up off zero, or one everybody had down off 100', () => {
    expect(lookedAtShare(0)).toBe('0%');
    expect(lookedAtShare(0.004)).toBe('<1%');
    expect(lookedAtShare(0.999)).toBe('>99%');
  });

  it('prints a first-fixation duration in milliseconds', () => {
    expect(firstFixationDuration(480)).toBe('480 ms');
    expect(firstFixationDuration(0)).toBe('0 ms');
  });

  it('prints an em dash, not a zero, for a first fixation that never happened', () => {
    expect(firstFixationDuration(null)).toBe('—');
    expect(firstFixationDuration(null)).not.toContain('0');
    expect(firstFixationDuration(null).trim()).not.toBe('');
  });

  it('prints a time and a dwell in seconds, as the prototype compares them', () => {
    expect(elapsedSeconds(2300)).toBe('2.3 s');
    expect(elapsedSeconds(0)).toBe('0.0 s');
    expect(elapsedSeconds(22229)).toBe('22.2 s');
  });
});

describe('the word for an area nobody ever looked at', () => {
  it('is “never”, and nothing that could be read as a fast first look', () => {
    expect(neverFixatedLabel()).toBe('never');
  });

  it('is what a null time to first fixation means', () => {
    expect(isNeverFixated(neverFixated)).toBe(true);
    expect(isNeverFixated(metric({ timeToFirstFixationMs: 0 }))).toBe(false);
  });

  it('says the finding in words, with the audience the share is out of', () => {
    expect(neverFixatedSentence({ aoiLabel: 'complete', variantName: 'B', reachedCount: 9 })).toBe(
      'No fixation ever landed in “complete” on variant B. 0 of 9 people in your audience who ' +
        'reached this step looked at it. Nothing is missing from the data: the area was simply ' +
        'never seen.',
    );
  });
});

describe('the two halves of “never” have to agree', () => {
  it('holds for a row the pipeline wrote either way', () => {
    expect(neverFixatedProblem(neverFixated)).toBeNull();
    expect(neverFixatedProblem(metric())).toBeNull();
    expect(() => {
      assertNeverFixatedConsistent(neverFixated);
    }).not.toThrow();
  });

  it('names the area when no fixation is recorded but somebody is said to have looked', () => {
    const problem = neverFixatedProblem(
      metric({ timeToFirstFixationMs: null, lookedAtShare: 0.5 }),
    );

    expect(problem).toContain('B-review-complete');
    expect(problem).toContain('no fixation was ever recorded');
    expect(problem).toContain('50%');
  });

  it('names the area when a fixation is recorded but nobody is said to have looked', () => {
    const problem = neverFixatedProblem(metric({ lookedAtShare: 0 }));

    expect(problem).toContain('B-review-complete');
    expect(problem).toContain('nobody is reported as having looked at it');
  });

  it('throws for a caller that has no row to state it in', () => {
    expect(() => {
      assertNeverFixatedConsistent(metric({ lookedAtShare: 0 }));
    }).toThrow(/B-review-complete/);
  });
});

describe('the rest of a row’s words', () => {
  it('names the three boundary sources the pipeline records', () => {
    expect(areaSource(area({ source: 'dom' }))).toBe('DOM');
    expect(areaSource(area({ source: 'a11y' }))).toBe('Accessibility tree');
    expect(areaSource(area({ source: 'sam' }))).toBe('SAM 3.1 segment');
  });

  it('marks the step’s primary action beside its source', () => {
    expect(areaSource(area({ source: 'dom', isPrimaryAction: true }))).toBe('DOM · primary action');
    expect(areaSource(area({ isPrimaryAction: false }))).not.toContain('primary action');
  });

  it('says an area this version does not have is a comparison, not a gap', () => {
    expect(notPresentInVariant('B')).toBe('Not present in variant B — nothing to compare');
  });

  it('names the area in a row whose figures are missing or attached to nothing', () => {
    expect(noFiguresRecorded('B-review-complete')).toContain('B-review-complete');
    expect(unknownAreaProblem('a-box-that-is-not-here')).toContain('a-box-that-is-not-here');
  });

  it('states that the figures are medians and what “looked at it” means', () => {
    expect(medianCaveat()).toContain('Medians across the people whose session was scored');
    expect(medianCaveat()).toContain('looked inside the area at least once');
  });
});

/**
 * These words are written once. The table prints them, the isolate caption says them in a
 * sentence and a finding quotes them, so two of them disagreeing is the one way this screen
 * could tell a reader that an area was never seen and that it was seen half the time.
 */
describe('this module is the only place these words are written', () => {
  const srcDir = fileURLToPath(new URL('../..', import.meta.url));

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (!['.ts', '.tsx'].includes(extname(entry.name))) return [];
      // A test asserts the words, which is what makes it a test of them.
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return [path];
    });

  it.each([
    'SAM 3.1 segment',
    'Accessibility tree',
    'Not present in variant',
    'No fixation ever landed',
    'Medians across the people whose session was scored',
  ])('writes “%s” in no other file of the application', (phrase) => {
    const holders = sourceFiles(srcDir).filter((path) =>
      readFileSync(path, 'utf8').includes(phrase),
    );

    expect(holders.map((path) => path.slice(srcDir.length))).toEqual([
      'screens/attention/attentionWording.ts',
    ]);
  });
});
