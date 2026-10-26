import type { Run, Session } from '@personavision/contract';

/**
 * Per-area-of-interest aggregates across a run's sessions.
 *
 * This is the one place in the project where per-area numbers are computed: no screen and
 * no scorer recomputes them. Two rules carry the project's credibility here.
 *
 * **Never fixated is a `null`, not a zero.** An area the sampler never selected reports
 * `timeToFirstFixationMs: null`, `firstFixationDurationMs: null` and `lookedAtShare: 0`.
 * No near-zero value is invented to fill the gap: "nobody looked at it" is a result that
 * has to survive all the way to the screen (`docs/FLOW.md` section 7, beat 5).
 *
 * **Automation failures change no aggregate.** A session with `outcome.excludedFromScores`
 * is out of every metric and out of the denominator of `lookedAtShare`. The flag is read
 * from the session, never re-derived: our own browsing breaking is a weakness of the
 * simulation and must never shape a heatmap.
 */

/** An area of interest, as `run.json` records it. */
export type Aoi = Run['aois'][number];

/** One row of `run.json`'s `aoiMetrics`: an area's numbers across the run's sessions. */
export type AoiMetric = Run['aoiMetrics'][number];

/** Non-empty by construction: only areas with at least one fixating session reach it. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** What one session did in one area. Absent from the map when it never fixated the area. */
interface SessionAoiStats {
  timeToFirstFixationMs: number;
  firstFixationDurationMs: number;
  totalDwellMs: number;
  fixationCount: number;
  revisits: number;
}

/**
 * Fixation order is the session's continuous `index`, never a timestamp sort, and a
 * revisit is a return after the gaze left the area: a run of consecutive fixations inside
 * one area is one visit.
 */
const statsByAoi = (session: Session): Map<string, SessionAoiStats> => {
  const stats = new Map<string, SessionAoiStats>();
  const inOrder = [...session.fixations].sort((a, b) => a.index - b.index);
  let previousAoiId: string | null = null;

  for (const fixation of inOrder) {
    const aoiId = fixation.aoiId;
    if (aoiId === null) {
      previousAoiId = null;
      continue;
    }
    const seen = stats.get(aoiId);
    if (seen === undefined) {
      stats.set(aoiId, {
        timeToFirstFixationMs: fixation.tMs,
        firstFixationDurationMs: fixation.durationMs,
        totalDwellMs: fixation.durationMs,
        fixationCount: 1,
        revisits: 0,
      });
    } else {
      seen.totalDwellMs += fixation.durationMs;
      seen.fixationCount += 1;
      if (previousAoiId !== aoiId) seen.revisits += 1;
    }
    previousAoiId = aoiId;
  }

  return stats;
};

/**
 * One metric row per area of interest passed in, in that order, including the areas no
 * session reached.
 *
 * A session is behind an area's row when it was not excluded from scores, ran the area's
 * variant, and reached the area's step — the denominator beat 5 states in words ("0 of 9
 * agents who reached this step looked at it"). Every reported value is a median over the
 * sessions that fixated the area, so that the ones that never looked lower no number
 * except `lookedAtShare`, which is exactly what they are counted in. The counts are
 * rounded to whole fixations and whole revisits, as the contract types them.
 */
export const aggregate = (sessions: readonly Session[], aois: readonly Aoi[]): AoiMetric[] => {
  const contributing = sessions
    .filter((session) => !session.outcome.excludedFromScores)
    .map((session) => ({ session, stats: statsByAoi(session) }));

  return aois.map((aoi) => {
    const behindTheRow = contributing.filter(
      ({ session }) =>
        session.variant === aoi.variant &&
        session.screens.some((screen) => screen.step === aoi.step),
    );
    const looked = behindTheRow
      .map(({ stats }) => stats.get(aoi.id))
      .filter((stats): stats is SessionAoiStats => stats !== undefined);
    const sessionCount = behindTheRow.length;

    if (looked.length === 0) {
      return {
        aoiId: aoi.id,
        timeToFirstFixationMs: null,
        firstFixationDurationMs: null,
        totalDwellMs: 0,
        fixationCount: 0,
        revisits: 0,
        lookedAtShare: 0,
        sessionCount,
      };
    }

    return {
      aoiId: aoi.id,
      timeToFirstFixationMs: median(looked.map((stats) => stats.timeToFirstFixationMs)),
      firstFixationDurationMs: median(looked.map((stats) => stats.firstFixationDurationMs)),
      totalDwellMs: median(looked.map((stats) => stats.totalDwellMs)),
      fixationCount: Math.round(median(looked.map((stats) => stats.fixationCount))),
      revisits: Math.round(median(looked.map((stats) => stats.revisits))),
      lookedAtShare: looked.length / sessionCount,
      sessionCount,
    };
  });
};
