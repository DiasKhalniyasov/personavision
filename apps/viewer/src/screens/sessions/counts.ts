import type { Run } from '@personavision/contract';

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

/** The line as the prototype's `microlabel` prints it. */
export function countsLine(counts: SessionCounts): string {
  return [
    people(counts.people),
    `${counts.scored} scored`,
    `${counts.automationFailures} excluded because our automation broke`,
  ].join(' · ');
}
