import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, runSchema } from '@personavision/contract';
import {
  ALL,
  aoiLabel,
  isFiltered,
  readFilter,
  shownOfLine,
  withFilter,
  without,
} from '../../src/screens/sessions/filters';
import { noMatchWords } from '../../src/screens/sessions/noMatchWords';

/**
 * The three filters as the URL carries them, over the committed seed example run.
 *
 * The point of these is that the query string is the whole of the filter state and that a
 * value the run has no entry for never becomes a filter: it is reported back so the screen
 * can drop it from the URL, rather than narrowing the list to nothing.
 */

const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/runs');
const SEED = '2026-10-24-1402-northwind-demo';

const seedRun = () =>
  runSchema.parse(
    JSON.parse(readFileSync(join(runsRoot, SEED, runPaths('').run), 'utf8')) as unknown,
  );

const query = (search: string) => new URLSearchParams(search);

describe('reading the filters out of the URL', () => {
  it('reads a version, an outcome and an area the run holds', () => {
    const read = readFilter(seedRun(), query('variant=B&outcome=success&aoi=B-review-complete'));

    expect(read.filter).toEqual({
      variant: 'B',
      outcome: 'success',
      aoiId: 'B-review-complete',
    });
    expect(read.aoi?.step).toBe('review');
    expect(read.unknown).toEqual([]);
    expect(isFiltered(read.filter)).toBe(true);
  });

  it('treats an absent parameter and the empty string a cleared control leaves alike', () => {
    for (const search of ['', 'variant=&outcome=&aoi=']) {
      const read = readFilter(seedRun(), query(search));

      expect(read.filter, search).toEqual({ variant: null, outcome: null, aoiId: null });
      expect(read.unknown, search).toEqual([]);
      expect(isFiltered(read.filter), search).toBe(false);
    }
  });

  it('drops a value the run has no entry for, and says which', () => {
    const read = readFilter(seedRun(), query('variant=Z&outcome=sideways&aoi=no-such-area'));

    // Not applied: a filter that cannot match would read as "nobody did this".
    expect(read.filter).toEqual({ variant: null, outcome: null, aoiId: null });
    expect(read.aoi).toBeNull();
    expect(read.unknown).toEqual(['variant', 'outcome', 'aoi']);
  });

  it('drops an area of one version asked for beside a filter on the other', () => {
    // No session can satisfy the pair, and the two together would be read as a finding
    // about the version on screen over the other version's figures.
    const read = readFilter(seedRun(), query('variant=A&aoi=B-review-complete'));

    expect(read.filter).toEqual({ variant: 'A', outcome: null, aoiId: null });
    expect(read.aoi).toBeNull();
    expect(read.unknown).toEqual(['aoi']);
  });

  it('keeps an area asked for beside a filter on its own version', () => {
    const read = readFilter(seedRun(), query('variant=B&aoi=B-review-complete'));

    expect(read.filter.aoiId).toBe('B-review-complete');
    expect(read.unknown).toEqual([]);
  });

  it('keeps the good half of a half-bad URL', () => {
    const read = readFilter(seedRun(), query('variant=A&outcome=nonsense'));

    expect(read.filter).toEqual({ variant: 'A', outcome: null, aoiId: null });
    expect(read.unknown).toEqual(['outcome']);
  });
});

describe('writing the filters back to the URL', () => {
  it('sets one filter and leaves the others alone', () => {
    expect(withFilter(query('outcome=failed'), 'variant', 'B').toString()).toBe(
      'outcome=failed&variant=B',
    );
  });

  it('removes a filter when the “All …” option is picked, rather than writing a word for it', () => {
    expect(withFilter(query('variant=B&outcome=failed'), 'variant', ALL).toString()).toBe(
      'outcome=failed',
    );
  });

  it('removes the parameters a run has no entry for', () => {
    expect(without(query('variant=A&outcome=sideways'), ['outcome']).toString()).toBe('variant=A');
  });
});

describe('the counts line while the list is narrowed', () => {
  it('states how much of the test the reader is looking at', () => {
    expect(shownOfLine(0, 24)).toBe('0 of 24 sessions');
    expect(shownOfLine(9, 24)).toBe('9 of 24 sessions');
    expect(shownOfLine(0, 1)).toBe('0 of 1 session');
  });
});

describe('what an area of interest is called on screen', () => {
  it('prints this version’s own words for a region both versions have', () => {
    const run = seedRun();
    const area = (id: string) => run.aois.find((candidate) => candidate.id === id);

    // `Completing action — A: "Place order", B: "Confirm purchase"`, as the run writes it.
    expect(aoiLabel(area('B-review-complete')!)).toBe('Confirm purchase');
    expect(aoiLabel(area('A-review-complete')!)).toBe('Place order');
  });

  it('prints a label written for one version whole', () => {
    const run = seedRun();
    expect(aoiLabel(run.aois.find((candidate) => candidate.id === 'B-cart-promo')!)).toBe(
      'Promo banner',
    );
  });
});

describe('the words of the no-match screen', () => {
  const words = (search: string) => {
    const run = seedRun();
    const read = readFilter(run, query(search));
    return noMatchWords(run, read.filter, read.aoi);
  };

  it('names the version, the area and how many reached the step without looking at it', () => {
    const read = words('variant=B&outcome=success&aoi=B-review-complete');

    expect(read.before).toBe('On Redesign candidate, nobody both looked at ');
    expect(read.area).toBe('Confirm purchase');
    expect(read.after).toBe(' and finished the task.');
    expect(read.detail).toBe(
      'That is the finding, not an empty table: of the 9 people who reached the Review step, ' +
        'not one ever looked at it.',
    );
  });

  it('takes the version from the area when the URL names only the area', () => {
    const read = words('aoi=B-review-complete');

    expect(read.before).toBe('On Redesign candidate, nobody looked at ');
    expect(read.area).toBe('Confirm purchase');
    expect(read.after).toBe('.');
  });

  it('keeps the four outcomes’ own words, and never merges them', () => {
    expect(words('variant=A&outcome=abandoned').before).toBe(
      'On Current checkout, nobody gave up.',
    );
    expect(words('outcome=failed').before).toBe('Nobody ended without the task done.');
    expect(words('outcome=automation_failure').before).toBe(
      'Nobody ran into our own automation breaking.',
    );
  });

  it('says so when the area was looked at and the outcome is what matched nothing', () => {
    // Every one of the nine people who reached A's review step fixated "Place order".
    expect(words('variant=A&outcome=failed&aoi=A-review-complete').detail).toBe(
      'That is the finding, not an empty table: of the 9 people who reached the Review step, ' +
        'every one of them looked at it.',
    );
  });

  it('says nobody reached the step when nobody did', () => {
    const run = seedRun();
    const unreached = run.aoiMetrics.find((metric) => metric.sessionCount === 0);
    if (unreached === undefined) return;

    const read = readFilter(run, query(`aoi=${unreached.aoiId}`));
    expect(noMatchWords(run, read.filter, read.aoi).detail).toContain('nobody ever reached the');
  });
});
