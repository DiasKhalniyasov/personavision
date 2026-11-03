import type { FunnelSlice, Run, Session } from '@personavision/contract';
import { distributionOf, scoredSessions, stepWalk, type FunnelSliceSpec } from './sessions.js';

/**
 * The timing of one slice: the whole session end to end, the time per step, and the slowest
 * sessions with the step the time went on — all of it as a distribution rather than a mean,
 * so a slow tail is not hidden by an average (`docs/FLOW.md` section 14.5).
 *
 * The quantiles, the bins and the rounding are `sessions.ts`'s and are not redefined here:
 * the median the timing table prints and the median the heatmaps panel prints are one
 * function called twice. The per-step spans are its step walk, so this figure cannot
 * disagree with the funnel about which step a second belonged to.
 *
 * Three readings this file settles, because the table on `#screen-funnel` prints them and
 * nothing else in the aggregate answers them:
 *
 * 1. **A step's time in one session is the sum of its spans in that session.** A step walked
 *    twice — the `back` revisit the prototype's funnel shows — contributes the whole time
 *    that person spent on that step, one sample, not two. A session is the unit of the
 *    distribution, so "the sessions that reached the step" is also the sample count.
 * 2. **A screen nobody looked at contributes nothing.** `stepWalk` reports it as reached with
 *    no time measured (`durationMs: null`), and nothing measured is left out of the sample
 *    rather than entered as zero, which would pull the median down to a second nobody spent.
 *    Where that leaves a step with no sample at all, the step is **left out of `perStep`** —
 *    the contract stores no distribution of nothing, by the same rule that leaves out a slice
 *    no session falls in — rather than carrying four zeroes.
 * 3. **The step the time went on is the step with the largest of those sums**, reported as the
 *    span itself and not as a share of the session, which is what the prototype's *where the
 *    time went* column says (*4:10 of it on the waiting screen*). Two steps tied on the same
 *    span resolve to the one `run.steps` declares first, so the file is the same on every
 *    machine.
 */

/**
 * What the timing is given. **#290 settles the rest of this shape in this file**; the barrel
 * re-exports it by name, so adding to it costs that file no edit.
 */
export interface TimingInput {
  /** The run, read for `steps` and their declared order. */
  readonly run: Run;
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #290 implements: the whole `timing` block of a stored slice. */
export type TimingBuilder = (input: TimingInput) => FunnelSlice['timing'];

/** How many rows the prototype's *slowest sessions* table holds at most. */
const SLOWEST_COUNT = 5;

/**
 * How long one session spent on each step it was measured on: the spans of its step walk,
 * summed per step, with the unmeasured ones left out. A step absent from the map is one this
 * session either never reached or was never timed on — the two the distribution treats alike.
 */
const measuredPerStep = (session: Session): Map<string, number> => {
  const perStep = new Map<string, number>();
  for (const span of stepWalk(session)) {
    if (span.durationMs === null) continue;
    perStep.set(span.step, (perStep.get(span.step) ?? 0) + span.durationMs);
  }
  return perStep;
};

/**
 * The step one session's time went on: the largest of the sums above, in the order `run.steps`
 * declares its steps, so a tie goes to the earlier step rather than to whichever the engine
 * happened to write down first. `null` for a session nothing was measured on at all, which has
 * no step to name.
 */
const dominantStepOf = (
  run: Run,
  measured: ReadonlyMap<string, number>,
): { step: string; ms: number } | null => {
  let dominant: { step: string; ms: number } | null = null;
  for (const step of run.steps) {
    const ms = measured.get(step.id);
    if (ms === undefined) continue;
    if (dominant === null || ms > dominant.ms) dominant = { step: step.id, ms };
  }
  return dominant;
};

/**
 * The time of one slice, as the contract stores it.
 *
 * Automation failures are dropped here as well as by the slice enumeration: this is the
 * figure that would otherwise name one in its slowest row, and *the slowest session of the
 * run* turning out to be our own harness timing out is exactly the figure `docs/FLOW.md`
 * section 11 keeps out. A slice with nothing left after that is not a slice the enumeration
 * produces, so it throws rather than returning a spread of zeroes.
 */
export const timingOfSlice: TimingBuilder = ({ run, slice }) => {
  const sessions = scoredSessions(slice.sessions).sessions;
  const total = distributionOf(sessions.map((session) => session.durationMs));
  if (total === null) {
    throw new Error(
      `the timing of slice "${slice.key}" is of no scored session: a slice has a denominator, and an automation failure is in no figure`,
    );
  }

  const measured = new Map(
    sessions.map((session) => [session.sessionId, measuredPerStep(session)] as const),
  );

  // One row per step of `run.steps`, in that declared order, and only where somebody was
  // timed on it: a step reached by nobody, and a step every one of whose screens went
  // unlooked at, both have no distribution rather than an empty one.
  const perStep = run.steps.flatMap((step) => {
    const sample = sessions.flatMap((session) => {
      const ms = measured.get(session.sessionId)?.get(step.id);
      return ms === undefined ? [] : [ms];
    });
    const distribution = distributionOf(sample);
    return distribution === null ? [] : [{ step: step.id, distribution }];
  });

  // Slowest first, and ties by session id, so re-aggregating the same sessions writes the
  // same five rows on every machine.
  const slowest = [...sessions]
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    )
    .flatMap((session) => {
      const dominant = dominantStepOf(run, measured.get(session.sessionId) ?? new Map());
      if (dominant === null) return [];
      return [
        {
          sessionId: session.sessionId,
          totalMs: Math.round(session.durationMs),
          dominantStep: dominant.step,
          dominantStepMs: Math.round(dominant.ms),
        },
      ];
    })
    .slice(0, SLOWEST_COUNT);

  return { total, perStep, slowest };
};
