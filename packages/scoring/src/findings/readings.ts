import type { Session } from '@personavision/contract';
import type { Aoi, AoiMetric, VariantScore } from '../score.js';

/**
 * What the rules read: one object per variant, holding every reading a rule needs, derived
 * once from the sessions and the aggregates.
 *
 * The rules themselves then contain no arithmetic over fixations — they compare readings
 * against `scoringConfig.thresholds` and pick the worst instance. That split is what makes
 * a rule reviewable as a sentence about the product rather than as a loop.
 *
 * **Only scored sessions are read.** Every reading below is over sessions whose own
 * `excludedFromScores` is false, so an automation failure can reach no rule's numerator and
 * no rule's denominator; the exclusion is read from the session and never re-derived (#35).
 * The sessions that *were* excluded are kept apart, in `ExcludedReading`, because one rule
 * is about them and says so in words.
 */

/** The outcomes a rule counts, by the step the session ended on. */
export interface StepOutcomes {
  readonly step: string;
  /** Sessions that reached the step at all, by id, in session-id order. */
  readonly reachedBy: readonly string[];
  /** Of them, those that gave up here rather than going on. */
  readonly abandonedBy: readonly string[];
  /** Of them, those that ended here with the task unfinished and the product at fault. */
  readonly failedBy: readonly string[];
}

/** One area of one variant, as every rule sees it. */
export interface AreaReading {
  readonly aoi: Aoi;
  /** Sessions that reached the area's step, by id. */
  readonly reachedBy: readonly string[];
  /** Of them, those that looked at the area at all. */
  readonly lookedBy: readonly string[];
  /** `lookedBy` over `reachedBy`, and 0 when nobody got there. */
  readonly lookedAtShare: number;
  /**
   * Nobody ever looked. Read from the `aoiMetrics` row's `timeToFirstFixationMs: null`
   * where there is one — that row is the number the Attention screen shows, and a finding
   * that disagreed with it would contradict the screen beside it.
   */
  readonly neverLookedAt: boolean;
  /**
   * Median seconds from arriving on the step to the first look, over the sessions that
   * looked; `null` when none did. Measured from the step's own arrival, as the friction
   * score's component is (decision 12): the session clock would put every control on a
   * late step past the cap and say nothing about the control.
   */
  readonly secondsToFirstLook: number | null;
  /** How long the first look held, in ms; `null` when nobody looked. */
  readonly firstLookMs: number | null;
  /** Time spent on the area per session, in ms, as the aggregate reports it. */
  readonly totalLookMs: number;
  /** Returns to the area per session, as the aggregate reports them. */
  readonly returns: number;
  /** Of all the time the step's areas held, the share this one holds. */
  readonly shareOfStepAttention: number;
  /** Sessions whose very first look on the step landed in this area. */
  readonly firstLookOfStepBy: readonly string[];
}

/** One variant, and everything the rules ask about it. */
export interface VariantReading {
  readonly variant: string;
  readonly score: VariantScore | undefined;
  /** The scored sessions of this variant, in session-id order. */
  readonly sessions: readonly Session[];
  /** The steps these sessions reached, in journey order. */
  readonly steps: readonly string[];
  readonly outcomes: readonly StepOutcomes[];
  readonly areas: readonly AreaReading[];
  /**
   * The last step that declares a control advancing the task. The control there is the one
   * that completes it, which is the only one a claim calls "the button that completes the
   * order"; `undefined` when the variant declares no such control anywhere.
   */
  readonly completingStep: string | undefined;
}

/** The sessions our own automation lost, which one rule states and no rule counts. */
export interface ExcludedReading {
  readonly sessions: readonly Session[];
  /** How many sessions the run had in all, excluded ones included: the note's population. */
  readonly totalSessionCount: number;
}

export interface RunReading {
  readonly variants: readonly VariantReading[];
  readonly excluded: ExcludedReading;
}

/** Non-empty by construction: every caller guards on the count first. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const byId = (sessions: readonly Session[]): string[] =>
  sessions.map((session) => session.sessionId).sort();

/**
 * The steps the sessions reached, in journey order: the earliest screen each appeared as,
 * with the step id breaking a remaining tie.
 *
 * The same ordering `score.ts` derives, restated here for the same reason `build.ts`
 * restates the engine's aggregate: this package's only dependency is the artifact contract,
 * and journey order is a fact about the run rather than about the order an array happens to
 * be in — two steps reading equally badly must not name a different worst step depending on
 * which session was listed first.
 */
const stepsInJourneyOrder = (sessions: readonly Session[]): string[] => {
  const firstSeenAt = new Map<string, number>();
  for (const session of sessions) {
    for (const screen of session.screens) {
      const earliest = firstSeenAt.get(screen.step);
      if (earliest === undefined || screen.index < earliest)
        firstSeenAt.set(screen.step, screen.index);
    }
  }
  return [...firstSeenAt.entries()]
    .sort(([stepA, atA], [stepB, atB]) => atA - atB || stepA.localeCompare(stepB))
    .map(([step]) => step);
};

const reached = (session: Session, step: string): boolean =>
  session.screens.some((screen) => screen.step === step);

/**
 * Seconds from arriving on a step to the first look at one of its areas, or `undefined`
 * when this session never looked at it.
 *
 * A session may reach the same step twice, and each screen is one visit, so the reading is
 * the first visit in which the area was looked at, measured from that visit's own first
 * recorded look — the earliest evidence the step was in front of the agent. The same
 * definition the friction score's 35% component uses.
 */
const secondsToFirstLook = (session: Session, aoi: Aoi): number | undefined => {
  if (session.variant !== aoi.variant) return undefined;
  const visits = session.screens
    .filter((screen) => screen.step === aoi.step)
    .map((screen) => screen.index)
    .sort((a, b) => a - b);

  for (const visit of visits) {
    const onVisit = session.fixations
      .filter((fixation) => fixation.screenIndex === visit)
      .sort((a, b) => a.index - b.index);
    const arrival = onVisit[0];
    if (arrival === undefined) continue;
    const first = onVisit.find((fixation) => fixation.aoiId === aoi.id);
    if (first === undefined) continue;
    return Math.max(0, first.tMs - arrival.tMs) / 1000;
  }
  return undefined;
};

/** The area the session's first look on a step landed in, by id; `null` when it landed outside one. */
const firstLookOfStep = (session: Session, step: string): string | null | undefined => {
  const visit = session.screens.find((screen) => screen.step === step);
  if (visit === undefined) return undefined;
  const first = session.fixations
    .filter((fixation) => fixation.screenIndex === visit.index)
    .sort((a, b) => a.index - b.index)[0];
  return first === undefined ? undefined : first.aoiId;
};

const areaReading = (
  aoi: Aoi,
  sessions: readonly Session[],
  rows: ReadonlyMap<string, AoiMetric>,
  stepAttentionMs: number,
): AreaReading => {
  const onStep = sessions.filter((session) => reached(session, aoi.step));
  const samples = onStep
    .map((session) => ({ session, seconds: secondsToFirstLook(session, aoi) }))
    .filter(
      (sample): sample is { session: Session; seconds: number } => sample.seconds !== undefined,
    );
  const row = rows.get(aoi.id);

  // Two independent answers to "did anybody look at this": the aggregate's row, which the
  // Attention screen shows, and the sessions themselves. Either one saying no is a no — a
  // row that reports a time nobody's fixations support is a disagreement, and the safe
  // reading of it is the one that makes no claim about an audience that was never there.
  const neverLookedAt =
    samples.length === 0 || row === undefined || row.timeToFirstFixationMs === null;

  return {
    aoi,
    reachedBy: byId(onStep),
    lookedBy: byId(samples.map((sample) => sample.session)),
    lookedAtShare: onStep.length === 0 ? 0 : samples.length / onStep.length,
    neverLookedAt,
    secondsToFirstLook: neverLookedAt ? null : median(samples.map((sample) => sample.seconds)),
    firstLookMs: row?.firstFixationDurationMs ?? null,
    totalLookMs: row?.totalDwellMs ?? 0,
    returns: row?.revisits ?? 0,
    shareOfStepAttention: stepAttentionMs === 0 ? 0 : (row?.totalDwellMs ?? 0) / stepAttentionMs,
    firstLookOfStepBy: byId(
      onStep.filter((session) => firstLookOfStep(session, aoi.step) === aoi.id),
    ),
  };
};

const variantReading = (
  variant: string,
  sessions: readonly Session[],
  aois: readonly Aoi[],
  rows: ReadonlyMap<string, AoiMetric>,
  scores: readonly VariantScore[],
): VariantReading => {
  const steps = stepsInJourneyOrder(sessions);
  const ofVariant = aois.filter((aoi) => aoi.variant === variant);

  const attentionByStep = new Map(
    steps.map((step) => [
      step,
      ofVariant
        .filter((aoi) => aoi.step === step)
        .reduce((total, aoi) => total + (rows.get(aoi.id)?.totalDwellMs ?? 0), 0),
    ]),
  );

  const areas = ofVariant
    .filter((aoi) => steps.includes(aoi.step))
    .map((aoi) => areaReading(aoi, sessions, rows, attentionByStep.get(aoi.step) ?? 0));

  const primarySteps = steps.filter((step) =>
    ofVariant.some((aoi) => aoi.step === step && aoi.isPrimaryAction),
  );

  return {
    variant,
    score: scores.find((score) => score.variant === variant),
    sessions,
    steps,
    outcomes: steps.map((step) => {
      const onStep = sessions.filter((session) => reached(session, step));
      const endedHere = onStep.filter((session) => session.outcome.step === step);
      return {
        step,
        reachedBy: byId(onStep),
        abandonedBy: byId(endedHere.filter((session) => session.outcome.status === 'abandoned')),
        failedBy: byId(
          endedHere.filter(
            (session) =>
              session.outcome.status === 'failed' && session.outcome.attribution === 'product',
          ),
        ),
      };
    }),
    areas,
    completingStep: primarySteps[primarySteps.length - 1],
  };
};

/**
 * Every reading the rules need, in variant-id order so the findings list does not depend on
 * the order the sessions arrived in.
 */
export const readRun = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
  aoiMetrics: readonly AoiMetric[],
  scores: readonly VariantScore[],
): RunReading => {
  const rows = new Map(aoiMetrics.map((row) => [row.aoiId, row]));
  const scored = sessions.filter((session) => !session.outcome.excludedFromScores);
  const variants = [...new Set(scored.map((session) => session.variant))].sort();

  return {
    variants: variants.map((variant) =>
      variantReading(
        variant,
        scored.filter((session) => session.variant === variant),
        aois,
        rows,
        scores,
      ),
    ),
    excluded: {
      sessions: sessions.filter((session) => session.outcome.excludedFromScores),
      totalSessionCount: sessions.length,
    },
  };
};

/**
 * The control that advances one step, chosen the way the friction score chooses it.
 *
 * A step may declare more than one, and an agent only has to find one of them, so the step
 * reads as its **best** control: found soonest, with a control nobody ever looked at
 * coming last and the area's id breaking a remaining tie. That is `score.ts`'s rule, and
 * it matters more here than there — a rule's *firing* depends on this area, so taking
 * whichever control happened to be listed first in `aois` would make "this banner competes
 * for attention" a fact about the order of an array.
 */
export const controlOf = (reading: VariantReading, step: string): AreaReading | undefined =>
  reading.areas
    .filter((area) => area.aoi.step === step && area.aoi.isPrimaryAction)
    .sort(
      (a, b) =>
        Number(a.neverLookedAt) - Number(b.neverLookedAt) ||
        (a.secondsToFirstLook ?? 0) - (b.secondsToFirstLook ?? 0) ||
        a.aoi.id.localeCompare(b.aoi.id),
    )[0];
