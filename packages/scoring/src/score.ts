import type { Run, Score, Session } from '@personavision/contract';
import { scoringConfig } from './config.js';

/**
 * The friction score: `docs/FLOW.md` section 5, taken literally.
 *
 * Four things that go wrong, each first expressed as a fraction between 0 and 1, then
 * weighted, summed and multiplied by 100. Higher is worse. The weights and the two
 * normalisation constants are `scoringConfig`'s; nothing here writes one down.
 *
 * Pure: no disk, no network, no browser, and no field name that is not imported from
 * `@personavision/contract`.
 *
 * **Scored sessions are those whose session says `excludedFromScores: false`.** The flag
 * is read, never re-derived (#35): a selector timeout is a weakness of our own simulation
 * and is never held against a variant. An excluded session appears in
 * `outcomeCounts.automationFailure` and changes no component and no score.
 *
 * **The reported number is the median across seed groups with ± one standard deviation.**
 * A score is computed per seed group from that group's sessions alone, and `perSeedGroup`
 * keeps every group score so the spread is auditable rather than asserted. The deviation
 * is the **sample** standard deviation (over `n - 1`), which is what the acceptance table
 * in section 5 reports: its clean reading of `22 ± 3` over seed groups scoring 19, 22 and
 * 25, and its defective `67 ± 4` over 63, 67 and 71, are both the sample deviation of
 * three groups exactly, and the population deviation of neither.
 *
 * `components` is therefore read over **every** scored session of the variant, while
 * `frictionScore` is the median of the groups: the card shows what drove the number beside
 * a number the groups agreed on, and weighting the reported components by hand will land
 * near the median rather than exactly on it. That is the relationship the score breakdown
 * screen in the prototype already shows — its clean card reads 22 beside components that
 * blend to 21.5 — and not a disagreement.
 */

/** The run artifact's shapes, under the names the step spec uses for them. */
export type Aoi = Run['aois'][number];
export type AoiMetric = Run['aoiMetrics'][number];
export type Task = Run['task'];

/** One row of `scores`: one variant × task. `Score` is the artifact contract's name for it. */
export type VariantScore = Score;

/** Non-empty by construction: every caller guards on the count first. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The sample standard deviation, and zero for a single group — one seed group has a score
 * but no spread, and `0` says "this is one group" rather than claiming a tight band.
 */
const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const sumOfSquares = values.reduce((total, value) => total + (value - mean) ** 2, 0);
  return Math.sqrt(sumOfSquares / (values.length - 1));
};

const scored = (session: Session): boolean => !session.outcome.excludedFromScores;

/**
 * The steps the sessions reached, in journey order.
 *
 * A step's place in the journey is the earliest screen it appeared as, which is a fact
 * about the run; collecting the steps in the order the sessions happen to be listed in
 * would make it a fact about the array, and two steps that read equally badly would then
 * name a different worst step depending on which session came first. A step id breaks a
 * remaining tie, so the order is total.
 */
const stepsReached = (sessions: readonly Session[]): string[] => {
  const firstSeenAt = new Map<string, number>();
  for (const session of sessions) {
    for (const screen of session.screens) {
      const earliest = firstSeenAt.get(screen.step);
      if (earliest === undefined || screen.index < earliest) {
        firstSeenAt.set(screen.step, screen.index);
      }
    }
  }
  return [...firstSeenAt.entries()]
    .sort(([stepA, atA], [stepB, atB]) => atA - atB || stepA.localeCompare(stepB))
    .map(([step]) => step);
};

/** What one area of interest reads, as the time-to-first-fixation component needs it. */
interface FirstFixationReading {
  /** Median seconds after arriving on the step; `null` when nobody ever looked. */
  readonly medianSeconds: number | null;
  readonly value: number;
}

const NEVER_FIXATED: FirstFixationReading = { medianSeconds: null, value: 1 };

/**
 * How long after arriving on a step a session first looked at one area, in seconds.
 *
 * The session's `tMs` runs on the session's own clock, from the start of the session, so
 * a control on the third step would read tens of seconds and every variant would sit at
 * the cap. Section 5 asks for the time *before someone first looks at the control*, which
 * is measured from the moment the step appeared, and the session shape carries no screen
 * onset: the first fixation recorded on the step's screen is the earliest evidence that
 * the step was in front of the agent, so that is the arrival. A primary action that took
 * the very first fixation therefore reads 0 — the honest answer to "how long before they
 * looked at it", and the reason `packages/engine`'s run-level row, which refuses to
 * manufacture that zero for a per-area metric, is not what this component reads.
 *
 * A session may reach the same step twice — it went back — and each screen is one visit,
 * so each visit has its own arrival. The reading is the **first visit in which the area was
 * looked at**, measured from that visit's own arrival; pooling the visits would count a
 * whole detour as time spent not seeing the control, and a session that came back to the
 * basket and found Checkout straight away would read as the slowest in the run.
 *
 * `undefined` when the session never reached the step or never looked at the area: it has
 * no time to first fixation, and a zero would be a different claim.
 */
const secondsToFirstFixation = (session: Session, aoi: Aoi): number | undefined => {
  if (session.variant !== aoi.variant) return undefined;
  const visits = session.screens
    .filter((screen) => screen.step === aoi.step)
    .map((screen) => screen.index)
    .sort((a, b) => a - b);

  for (const visit of visits) {
    const fixations = session.fixations
      .filter((fixation) => fixation.screenIndex === visit)
      .sort((a, b) => a.index - b.index);
    const arrival = fixations[0];
    if (arrival === undefined) continue;
    const first = fixations.find((fixation) => fixation.aoiId === aoi.id);
    if (first === undefined) continue;
    return Math.max(0, first.tMs - arrival.tMs) / 1000;
  }
  return undefined;
};

/**
 * One area's reading across the sessions that looked at it.
 *
 * The median is over the sessions that **fixated** the area, as `packages/engine`'s
 * aggregate takes its first-fixation medians: a session that never looked has no time to
 * contribute, not a zero. Whether anybody ever looked at all is the one thing read from
 * `aoiMetrics` rather than re-derived — that row is the number the heatmaps and the
 * findings are built on (`timeToFirstFixationMs: null` is the engine's "never fixated is
 * a null, not a zero"), and a score that disagreed with it would contradict the Attention
 * screen beside it. An area with no row at all has nothing measured, which is the same
 * answer: nobody saw it.
 */
const firstFixationReading = (
  sessions: readonly Session[],
  aoi: Aoi,
  aoiMetrics: readonly AoiMetric[],
): FirstFixationReading => {
  const row = aoiMetrics.find((metric) => metric.aoiId === aoi.id);
  if (row === undefined || row.timeToFirstFixationMs === null) return NEVER_FIXATED;

  const samples = sessions
    .map((session) => secondsToFirstFixation(session, aoi))
    .filter((seconds): seconds is number => seconds !== undefined);
  if (samples.length === 0) return NEVER_FIXATED;

  const seconds = median(samples);
  return {
    medianSeconds: seconds,
    value: Math.min(seconds / scoringConfig.normalisation.timeToFirstFixationSeconds, 1),
  };
};

/**
 * The step where the primary action reads worst, and its reading.
 *
 * A step may declare more than one primary action, and an agent only has to find one of
 * them, so a step reads as its **best** control; the component then takes the **worst**
 * step, as section 5 says. Ties go to the step that comes first in the journey, so the
 * answer does not depend on the order the areas or the sessions happen to be listed in.
 *
 * A variant that declares no primary action anywhere is a full 1.0: nobody could have
 * looked at a control that is not there. The step named is then the furthest the sessions
 * got, which is where the task would have been completed.
 */
const worstPrimaryAction = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
  aoiMetrics: readonly AoiMetric[],
): Score['components']['timeToFirstFixationPrimary'] => {
  const steps = stepsReached(sessions);
  if (steps.length === 0) {
    throw new Error(
      'a variant whose sessions reached no step cannot be scored: the time to the primary action has no step to be measured on',
    );
  }

  let worst: Score['components']['timeToFirstFixationPrimary'] | undefined;
  for (const step of steps) {
    const primaries = aois.filter((aoi) => aoi.step === step && aoi.isPrimaryAction);
    if (primaries.length === 0) continue;
    const readings = primaries.map((aoi) => firstFixationReading(sessions, aoi, aoiMetrics));
    const best = readings.reduce((soonest, reading) =>
      reading.value < soonest.value ? reading : soonest,
    );
    if (worst === undefined || best.value > worst.value) worst = { worstStep: step, ...best };
  }

  return worst ?? { worstStep: steps[steps.length - 1], ...NEVER_FIXATED };
};

/**
 * Returns in one session to areas that do not advance the task.
 *
 * A return is a fixation landing in an area the gaze had already visited and then left, so
 * a run of consecutive fixations inside one area is one visit — the definition
 * `packages/engine`'s aggregate uses, restated here because section 5 counts returns
 * **per session** across every dead-end area, and the run-level row holds a median per
 * area that cannot be split back into sessions or into seed groups.
 *
 * Fixation order is the session's continuous `index`, never a timestamp sort. An area the
 * `aois` list does not describe counts as neither a dead end nor the primary action, but
 * it does break the run of fixations, so coming back across it is still a return.
 */
const deadEndReturns = (session: Session, byId: ReadonlyMap<string, Aoi>): number => {
  const visited = new Set<string>();
  let previousAoiId: string | null = null;
  let returns = 0;

  for (const fixation of [...session.fixations].sort((a, b) => a.index - b.index)) {
    const aoiId = fixation.aoiId;
    if (aoiId === null) {
      previousAoiId = null;
      continue;
    }
    const aoi = byId.get(aoiId);
    const isDeadEnd = aoi !== undefined && !aoi.isPrimaryAction;
    if (isDeadEnd && visited.has(aoiId) && previousAoiId !== aoiId) returns += 1;
    visited.add(aoiId);
    previousAoiId = aoiId;
  }

  return returns;
};

/** The four components over one set of sessions: a whole variant, or one seed group of it. */
const componentsOf = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
  aoiMetrics: readonly AoiMetric[],
): Score['components'] => {
  const byId = new Map(aois.map((aoi) => [aoi.id, aoi]));
  const share = (matching: (session: Session) => boolean): number =>
    sessions.filter(matching).length / sessions.length;

  return {
    // "The task not done **and the product at fault**": a failure our own automation
    // caused is not the product's, and `outcomeCounts.failed` carries it instead.
    taskFailureRate: share(
      (session) => session.outcome.status === 'failed' && session.outcome.attribution === 'product',
    ),
    abandonment: share((session) => session.outcome.status === 'abandoned'),
    timeToFirstFixationPrimary: worstPrimaryAction(sessions, aois, aoiMetrics),
    deadEndRevisits: Math.min(
      median(sessions.map((session) => deadEndReturns(session, byId))) /
        scoringConfig.normalisation.deadEndRevisitsPerSession,
      1,
    ),
  };
};

/**
 * Weighted, summed and put on the contract's 0–100 scale.
 *
 * Each component is a fraction in 0..1 and the weights sum to exactly one, so the blend
 * cannot leave 0..1 by more than a float's last digit — but `frictionScore` is typed as
 * points out of 100 and would be refused at 100.000000000000014, so the answer is held
 * inside the range the contract declares. A set of weights that genuinely summed to more
 * than one is a different mistake, and the configuration test is where it fails.
 */
const frictionScoreOf = (components: Score['components']): number => {
  const { weights, pointsPerUnit } = scoringConfig;
  const blend =
    weights.taskFailureRate * components.taskFailureRate +
    weights.abandonment * components.abandonment +
    weights.timeToFirstFixationPrimary * components.timeToFirstFixationPrimary.value +
    weights.deadEndRevisits * components.deadEndRevisits;
  return Math.min(Math.max(blend * pointsPerUnit, 0), pointsPerUnit);
};

const outcomeCountsOf = (
  scoredSessions: readonly Session[],
  excluded: readonly Session[],
): Score['outcomeCounts'] => {
  for (const session of excluded) {
    if (session.outcome.status === 'automation_failure') continue;
    // The mirror of the contradiction refused below. The only outcome kept out of a score
    // is an automation failure, and `outcomeCounts` has one field for it: counting a
    // session that says it was abandoned there would report the product's own result as a
    // weakness of our simulation, and drop it from the share that gave up.
    throw new Error(
      `session ${session.sessionId} is excluded from the scores but reports outcome "${session.outcome.status}": only an automation failure is excluded, and outcomeCounts has nowhere else to put it`,
    );
  }

  const counts = { success: 0, abandoned: 0, failed: 0, automationFailure: excluded.length };
  for (const session of scoredSessions) {
    const { status } = session.outcome;
    if (status === 'automation_failure') {
      // The two fields disagree: a session is either excluded from the scores or it is one
      // of the three product outcomes. Scoring it either way would write a `scores` row
      // whose counts cannot add up to its own `scoredSessionCount`, so it is refused here
      // where the session can still be named.
      throw new Error(
        `session ${session.sessionId} reports outcome "automation_failure" but excludedFromScores: false — the exclusion is read from the session, never re-derived`,
      );
    }
    counts[status] += 1;
  }
  return counts;
};

/**
 * One `scores` row per variant that has at least one scored session, ordered by variant id
 * so the answer does not depend on the order the sessions arrived in.
 *
 * A variant whose every session was an automation failure gets no row: it has no friction
 * score and no completion rate, and the contract types `scoredSessionCount` as positive
 * for exactly that reason — a zero there would report a number nobody measured.
 */
export const score = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
  aoiMetrics: readonly AoiMetric[],
  task: Task,
): VariantScore[] => {
  const forTask = sessions.filter((session) => session.taskId === task.id);
  const variants = [...new Set(forTask.map((session) => session.variant))].sort();

  return variants.flatMap((variant): VariantScore[] => {
    const ofVariant = forTask.filter((session) => session.variant === variant);
    const scoredSessions = ofVariant.filter(scored);
    if (scoredSessions.length === 0) return [];

    const variantAois = aois.filter((aoi) => aoi.variant === variant);
    const components = componentsOf(scoredSessions, variantAois, aoiMetrics);
    const outcomeCounts = outcomeCountsOf(
      scoredSessions,
      ofVariant.filter((session) => !scored(session)),
    );

    // A simulated session carries a seed and a real one does not, and the spread is
    // reported per seed group: a session belonging to no group would sit inside the median
    // and outside `perSeedGroup`, so the number could not be audited against the groups
    // printed beside it. One or the other, never a mixture.
    const seedless = scoredSessions.find((session) => session.seed === null);
    if (seedless !== undefined && scoredSessions.some((session) => session.seed !== null)) {
      throw new Error(
        `session ${seedless.sessionId} on variant ${variant} carries no seed while others of the same variant do: a friction score is the median across seed groups, and a session in no group cannot be in it`,
      );
    }

    const seeds = [
      ...new Set(
        scoredSessions
          .map((session) => session.seed)
          .filter((seed): seed is number => seed !== null),
      ),
    ].sort((a, b) => a - b);

    const perSeedGroup = seeds.map((seed) => ({
      seed,
      frictionScore: frictionScoreOf(
        componentsOf(
          scoredSessions.filter((session) => session.seed === seed),
          variantAois,
          aoiMetrics,
        ),
      ),
    }));

    // A run of real sessions carries no seed, so there is no group to name and the whole
    // scored set is the one group: its score is the median and there is no spread.
    const groupScores =
      perSeedGroup.length === 0
        ? [frictionScoreOf(components)]
        : perSeedGroup.map((group) => group.frictionScore);

    return [
      {
        variant,
        taskId: task.id,
        frictionScore: {
          median: median(groupScores),
          sd: sampleStandardDeviation(groupScores),
        },
        completionRate: outcomeCounts.success / scoredSessions.length,
        components,
        outcomeCounts,
        scoredSessionCount: scoredSessions.length,
        perSeedGroup,
      },
    ];
  });
};
