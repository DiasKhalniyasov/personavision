import type { Run } from '@personavision/contract';

/** One version's figures, as the scoring step wrote them. */
type Score = Run['scores'][number];

/**
 * The counts line of the Sessions screen: how many people the test ran, how many of them
 * were scored, and how many are excluded because our own automation broke.
 *
 * All three are **read from the run**, never counted over the rows on screen. The manifest
 * is the number of people; `scores[].scoredSessionCount` and
 * `scores[].outcomeCounts.automationFailure` are what the scoring step wrote, per version,
 * and the line sums the versions rather than re-deriving anything from a session file. So
 * the counts are right before a single session has been read, and they cannot drift from
 * the figures the Verdict and Score breakdown screens lead with.
 */

export interface SessionCounts {
  /** One session is one person on screen: `run.sessionIds`, as the pipeline wrote it. */
  readonly people: number;
  /** The people every figure in the test is computed over. */
  readonly scored: number;
  /** The people left out of every figure, because the failure was ours. */
  readonly automationFailures: number;
}

/** Whether the scoring step has written this run's figures at all. */
export function isScored(run: Run): boolean {
  return run.scores.length > 0;
}

export function sessionCounts(run: Run): SessionCounts {
  return {
    people: run.sessionIds.length,
    scored: run.scores.reduce((total, score) => total + score.scoredSessionCount, 0),
    automationFailures: run.scores.reduce(
      (total, score) => total + score.outcomeCounts.automationFailure,
      0,
    ),
  };
}

const people = (count: number): string => `${count} ${count === 1 ? 'person' : 'people'}`;

/**
 * The line as the prototype's `microlabel` prints it.
 *
 * A run whose scoring step has not written `scores` yet — one still open, or one that
 * failed — holds no figure to state, and "0 scored · 0 excluded" would be a flat denial
 * that anybody was scored or excluded rather than a report that nobody has been scored
 * yet. The people are still listed; the line says only what the run knows.
 */
export function countsLine(counts: SessionCounts, scored: boolean = true): string {
  if (!scored) return `${people(counts.people)} · not scored yet`;
  return [
    people(counts.people),
    `${counts.scored} scored`,
    `${counts.automationFailures} excluded because our automation broke`,
  ].join(' · ');
}

/**
 * The outcome counts the scoring step stored, for one version or for the whole test.
 *
 * This is the grid's **aggregate slice** (`docs/adr/0001`): the figure beside *Completed*
 * is `scores[].outcomeCounts.success`, written once by the pipeline, and never a tally of
 * the session files a browser happens to have read. The two agree on a sound run, which is
 * exactly why the difference matters — a screen that counted would go on agreeing while
 * quietly reporting its own arithmetic, and a reader could never tell which they were
 * looking at.
 *
 * The slice **composes with the version filter**, because the counts are stored per
 * version: narrowed to the redesign, *Completed* is the redesign's own success count.
 * `null` for a run whose scoring step has written nothing, or for a version it has no entry
 * for — then the options carry no figure rather than a zero nobody measured.
 */
export interface OutcomeSlice {
  readonly success: number;
  readonly abandoned: number;
  readonly failed: number;
  readonly automation_failure: number;
  /** Everybody the slice covers, which is the four of them: the *All* option's own figure. */
  readonly all: number;
}

export function outcomeSlice(run: Run, variant: string | null = null): OutcomeSlice | null {
  const scores =
    variant === null ? run.scores : run.scores.filter((score) => score.variant === variant);
  if (scores.length === 0) return null;

  const total = (read: (counts: Score['outcomeCounts']) => number): number =>
    scores.reduce((sum, score) => sum + read(score.outcomeCounts), 0);

  const success = total((counts) => counts.success);
  const abandoned = total((counts) => counts.abandoned);
  const failed = total((counts) => counts.failed);
  const automationFailure = total((counts) => counts.automationFailure);

  return {
    success,
    abandoned,
    failed,
    automation_failure: automationFailure,
    // The four outcomes are exhaustive, so their sum is every person the slice covers —
    // and an automation failure is one of the four, which is what keeps it inside the
    // *All* figure and out of the three the grid states about the site.
    all: success + abandoned + failed + automationFailure,
  };
}

/**
 * How many of the people read so far fall under each value of one field — the figure beside
 * a segment or a step.
 *
 * Neither has a stored slice: the aggregate holds the funnel and the outcomes, and nothing
 * counts the audience by segment. So these two are tallied over **the sessions themselves**,
 * which the screen has read anyway to draw a tile for each of them, and a caller states the
 * figure only once every session is in (`SessionsFilters`): a count over half the run is a
 * figure that would change under the reader while they looked at it.
 */
export function tally(values: readonly (string | null)[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
