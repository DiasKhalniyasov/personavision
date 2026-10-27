import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, runSchema } from '@personavision/contract';
import { countsLine, sessionCounts } from '../../src/screens/sessions/counts';

/**
 * The counts line, over the committed seed example run.
 *
 * The point of these is the *source*: every figure is one the run already holds, so the
 * line is right before a session file has been read and cannot drift from the figures the
 * Verdict and Score breakdown screens lead with.
 */

const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/runs');
const SEED = '2026-10-24-1402-northwind-demo';

const seedRun = () =>
  runSchema.parse(
    JSON.parse(readFileSync(join(runsRoot, SEED, runPaths('').run), 'utf8')) as unknown,
  );

describe('the counts a run holds', () => {
  it('are the manifest and the scoring step’s own totals, summed over the versions', () => {
    const run = seedRun();

    expect(sessionCounts(run)).toEqual({ people: 24, scored: 22, automationFailures: 2 });
    // And they are not a recount: the manifest and the stored per-version figures say so.
    expect(run.sessionIds).toHaveLength(24);
    expect(run.scores.map((score) => score.scoredSessionCount)).toEqual([11, 11]);
    expect(run.scores.map((score) => score.outcomeCounts.automationFailure)).toEqual([1, 1]);
  });

  it('read as the prototype’s counts line', () => {
    expect(countsLine(sessionCounts(seedRun()))).toBe(
      '24 people · 22 scored · 2 excluded because our automation broke',
    );
  });

  it('say “person” when a test ran one, so a count never reads as a plural of itself', () => {
    expect(countsLine({ people: 1, scored: 1, automationFailures: 0 })).toBe(
      '1 person · 1 scored · 0 excluded because our automation broke',
    );
  });

  it('are zero for a test that recorded nobody, rather than throwing', () => {
    const run = { ...seedRun(), sessionIds: [], scores: [] };

    expect(sessionCounts(run)).toEqual({ people: 0, scored: 0, automationFailures: 0 });
  });
});
