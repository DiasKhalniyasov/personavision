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

/** Non-empty by construction: every caller below guards on the session count first. */
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
 *
 * `timeToFirstFixationMs` is the fixation's `tMs`, which the contract puts on the
 * session's clock — it counts from the start of the session, not from the moment the
 * area's step appeared. Re-basing it per step needs a screen onset the session shape does
 * not carry yet, and guessing one from the first fixation on the screen would manufacture
 * the zero this module exists to refuse. See the note on #57.
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
 * variant, and reached the area's step — the denominator `docs/FLOW.md` section 7, beat 5
 * states in words ("0 of 9 agents who reached this step looked at it"). Two populations
 * then share that row, because the honest answer differs by metric:
 *
 * - *First-fixation* values are medians over the sessions that **fixated** the area. A
 *   session that never looked has no time to first fixation, and a zero would be a lie;
 *   when nobody looked the value is `null`.
 * - *Accumulated* values — dwell, fixation count, revisits — are medians over **every**
 *   session behind the row, a session that never looked counting as the zero it really is.
 *   `docs/FLOW.md` section 5 defines dead-end revisits as the median returns *per session*,
 *   and the friction score reads this row rather than recomputing it.
 *
 * The counts round down, so a median of half a revisit never reports a return nobody made.
 *
 * An area no session reached at all reports `sessionCount: 0` with `lookedAtShare: 0`: the
 * contract types the share as a number, so "no data" is told by the count, and a screen
 * saying "0 of N looked" has to read `sessionCount` before it says anything.
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
    const perSession = behindTheRow.map(({ stats }) => stats.get(aoi.id));
    const looked = perSession.filter((stats): stats is SessionAoiStats => stats !== undefined);
    const sessionCount = behindTheRow.length;

    /** Over every session behind the row; a session that never looked contributes a zero. */
    const perSessionMedian = (of: (stats: SessionAoiStats) => number): number =>
      sessionCount === 0
        ? 0
        : median(perSession.map((stats) => (stats === undefined ? 0 : of(stats))));

    /** Over the sessions that fixated the area; `null` rather than an invented number. */
    const amongLookers = (of: (stats: SessionAoiStats) => number): number | null =>
      looked.length === 0 ? null : median(looked.map(of));

    return {
      aoiId: aoi.id,
      timeToFirstFixationMs: amongLookers((stats) => stats.timeToFirstFixationMs),
      firstFixationDurationMs: amongLookers((stats) => stats.firstFixationDurationMs),
      totalDwellMs: perSessionMedian((stats) => stats.totalDwellMs),
      fixationCount: Math.floor(perSessionMedian((stats) => stats.fixationCount)),
      revisits: Math.floor(perSessionMedian((stats) => stats.revisits)),
      lookedAtShare: sessionCount === 0 ? 0 : looked.length / sessionCount,
      sessionCount,
    };
  });
};
