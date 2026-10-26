import { SCHEMA_VERSION, type Session } from '@personavision/contract';
import type { Aoi, AoiMetric } from '../../src/index.js';

/**
 * How a fixture session is written down, and how it becomes one.
 *
 * A session the scorer reads is a few hundred lines of fixations, and what a test cares
 * about is two readings: how long after arriving on a step the agent first looked at the
 * control that advances it, and how many times it went back to something that does not.
 * So a fixture states those two numbers per step and this builder constructs a session
 * that **provably** reads that way — `test/fixtures.test.ts` holds it to that by scoring
 * the sets and checking the readings that come back.
 *
 * Nothing here is random and nothing here reads a file: the same spec always builds the
 * same session, byte for byte.
 */

/** One fixation every `STRIDE_MS`, each `DURATION_MS` long, so a step's clock is readable. */
const DURATION_MS = 250;
const STRIDE_MS = 300;
/** The pause between the last fixation of one step and the first of the next. */
const BETWEEN_STEPS_MS = 400;

export interface StepSpec {
  readonly step: string;
  /**
   * Seconds after arriving on the step before the primary action is first fixated, or
   * `null` when it never was — which is the case the whole formula turns on. A step with
   * no primary action declared at all also takes `null`.
   */
  readonly primaryAfterSeconds: number | null;
  /** Returns on this step to an area that does not advance the task. */
  readonly deadEndReturns: number;
}

export interface SessionSpec {
  readonly sessionId: string;
  readonly variant: string;
  /** `null` for a session with no seed, as a real recorded session has. */
  readonly seed: number | null;
  readonly personaId: string;
  readonly steps: readonly StepSpec[];
  readonly status: Session['outcome']['status'];
  /**
   * Defaults to `automation` for an automation failure and `product` for everything else.
   * A failure attributed to our own automation is not the product's failure rate.
   */
  readonly attribution?: Session['outcome']['attribution'];
  /** Defaults to true for an automation failure and false otherwise. Read, never derived. */
  readonly excludedFromScores?: boolean;
}

/** The four generated people of the fixture audience: two on a phone, two on a desktop. */
export const FIXTURE_PERSONAS: Record<string, NonNullable<Session['persona']>> = {
  'P-1': {
    id: 'P-1',
    traits: {
      persistence: 0.7,
      scanningVsReading: 0.8,
      detailOrientation: 0.4,
      interfaceFamiliarity: 0.6,
      patience: 0.5,
      riskTolerance: 0.5,
    },
    device: {
      name: 'iPhone 15',
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      touch: true,
    },
  },
  'P-2': {
    id: 'P-2',
    traits: {
      persistence: 0.4,
      scanningVsReading: 0.3,
      detailOrientation: 0.8,
      interfaceFamiliarity: 0.3,
      patience: 0.7,
      riskTolerance: 0.3,
    },
    device: {
      name: 'Pixel 8',
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      touch: true,
    },
  },
  'P-3': {
    id: 'P-3',
    traits: {
      persistence: 0.8,
      scanningVsReading: 0.6,
      detailOrientation: 0.5,
      interfaceFamiliarity: 0.9,
      patience: 0.4,
      riskTolerance: 0.7,
    },
    device: {
      name: 'Desktop 1440',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      touch: false,
    },
  },
  'P-4': {
    id: 'P-4',
    traits: {
      persistence: 0.3,
      scanningVsReading: 0.5,
      detailOrientation: 0.6,
      interfaceFamiliarity: 0.5,
      patience: 0.8,
      riskTolerance: 0.4,
    },
    device: {
      name: 'Desktop 1280',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
    },
  },
};

const REASONS: Record<Session['outcome']['status'], string> = {
  success: 'the order was placed',
  abandoned: 'gave up at the order total',
  failed: 'the order could not be placed',
  automation_failure: 'the continue selector timed out',
};

/** The centre of an area, never negative: a fixation lands at a point on the page. */
const centre = (aoi: Aoi): { x: number; y: number } => ({
  x: Math.max(0, Math.round(aoi.bbox.x + aoi.bbox.width / 2)),
  y: Math.max(0, Math.round(aoi.bbox.y + aoi.bbox.height / 2)),
});

/**
 * The order the fixations of one step land in.
 *
 * Two dead-end areas and, when it was fixated at all, the primary action. The step opens
 * on the first dead-end area — which is how "a promo banner takes the first fixation" is
 * written in the data: it is the first area the variant's step lists. The returns are then
 * made by alternating between the two dead ends, so each one lands in an area the gaze had
 * already visited and then left: exactly one return each, and never two fixations running
 * in the same area, which would be one visit rather than a return.
 */
const fixationOrder = (
  spec: StepSpec,
  primary: Aoi | undefined,
  deadEnds: readonly Aoi[],
): Aoi[] => {
  const [first, second] = deadEnds;
  const opening =
    primary === undefined || spec.primaryAfterSeconds === null
      ? [first, second]
      : spec.primaryAfterSeconds === 0
        ? [primary, first, second]
        : [first, second, primary];
  const returns = Array.from({ length: spec.deadEndReturns }, (_, index) =>
    index % 2 === 0 ? first : second,
  );
  return [...opening, ...returns];
};

/**
 * A session that reads the way its spec says, valid against the artifact contract's
 * session schema.
 *
 * The areas come from the same `aois` list the scorer is given, so a fixture cannot name
 * an area the run does not have: the primary action of a step is the one marked as such,
 * and the dead ends are the rest, in the order the list declares them.
 */
export const buildSession = (spec: SessionSpec, aois: readonly Aoi[]): Session => {
  const screens: Session['screens'] = [];
  const fixations: Session['fixations'] = [];
  const actions: Session['actions'] = [];
  let clockMs = 0;

  spec.steps.forEach((step, screenIndex) => {
    const onStep = aois.filter((aoi) => aoi.variant === spec.variant && aoi.step === step.step);
    const primary = onStep.find((aoi) => aoi.isPrimaryAction);
    const deadEnds = onStep.filter((aoi) => !aoi.isPrimaryAction);
    if (deadEnds.length < 2) {
      throw new Error(
        `step ${spec.variant}/${step.step} declares ${deadEnds.length} areas that do not advance the task: a fixture step needs two, to alternate between when it makes a return`,
      );
    }

    screens.push({
      index: screenIndex,
      step: step.step,
      screenshot: `screens/${spec.variant}-${step.step}.png`,
      scrollY: 0,
      intent: `work out how to get past ${step.step}`,
      decidedAction: primary === undefined ? 'read the page' : `use ${primary.label}`,
    });

    const stepStartMs = clockMs;
    let cursorMs = stepStartMs;
    for (const [position, aoi] of fixationOrder(step, primary, deadEnds).entries()) {
      const isTimedPrimary =
        aoi === primary && step.primaryAfterSeconds !== null && step.primaryAfterSeconds > 0;
      const tMs = isTimedPrimary ? stepStartMs + step.primaryAfterSeconds * 1000 : cursorMs;
      if (tMs < cursorMs) {
        throw new Error(
          `${spec.sessionId} looks at the primary action of ${step.step} after ${step.primaryAfterSeconds}s, which is before the ${position} fixations that opened the step: a fixture needs more than ${(position * STRIDE_MS) / 1000}s there`,
        );
      }
      const { x, y } = centre(aoi);
      fixations.push({
        index: fixations.length,
        screenIndex,
        tMs,
        durationMs: DURATION_MS,
        x,
        y,
        pageX: x,
        pageY: y,
        aoiId: aoi.id,
      });
      if (aoi === primary) {
        actions.push({
          tMs: tMs + DURATION_MS,
          type: 'click',
          target: `#${aoi.id}`,
          aoiId: aoi.id,
          value: null,
          ok: true,
        });
      }
      cursorMs = tMs + STRIDE_MS;
    }
    clockMs = cursorMs + BETWEEN_STEPS_MS;
  });

  const saccades = fixations.slice(1).map((fixation, position) => {
    const from = fixations[position];
    return {
      fromFixation: from.index,
      toFixation: fixation.index,
      amplitudePx: Math.round(Math.hypot(fixation.pageX - from.pageX, fixation.pageY - from.pageY)),
      durationMs: 40,
    };
  });

  const lastStep = spec.steps[spec.steps.length - 1];
  if (lastStep === undefined) throw new Error(`${spec.sessionId} has no steps`);
  if (spec.status === 'abandoned') {
    actions.push({
      tMs: clockMs,
      type: 'abandon',
      target: null,
      aoiId: null,
      value: null,
      ok: true,
    });
  }
  if (spec.status === 'failed' || spec.status === 'automation_failure') {
    actions.push({
      tMs: clockMs,
      type: 'click',
      target: '#continue',
      aoiId: null,
      value: null,
      ok: false,
    });
  }

  const isAutomationFailure = spec.status === 'automation_failure';
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: spec.sessionId,
    runId: 'fixture-run',
    variant: spec.variant,
    taskId: 'buy-a-tent',
    kind: 'simulated',
    persona: FIXTURE_PERSONAS[spec.personaId] ?? null,
    participant: null,
    seed: spec.seed,
    startedAt: '2026-10-24T14:02:00.000Z',
    durationMs: clockMs,
    screens,
    fixations,
    saccades,
    actions,
    outcome: {
      status: spec.status,
      step: lastStep.step,
      reason: REASONS[spec.status],
      attribution: spec.attribution ?? (isAutomationFailure ? 'automation' : 'product'),
      excludedFromScores: spec.excludedFromScores ?? isAutomationFailure,
    },
    integrity: { selectorFailures: isAutomationFailure ? 1 : 0, retries: 0 },
  };
};

/** Non-empty by construction: every caller below guards on the count first. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** What one session did in one area; absent when it never fixated the area. */
interface SessionAoiStats {
  timeToFirstFixationMs: number;
  firstFixationDurationMs: number;
  totalDwellMs: number;
  fixationCount: number;
  revisits: number;
}

const statsByAoi = (session: Session): Map<string, SessionAoiStats> => {
  const stats = new Map<string, SessionAoiStats>();
  let previousAoiId: string | null = null;
  for (const fixation of [...session.fixations].sort((a, b) => a.index - b.index)) {
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
 * The `aoiMetrics` rows these sessions would produce.
 *
 * `aggregate` in `packages/engine` is the one place in the project where per-area numbers
 * are computed, and this restates its two rules rather than importing it, because this
 * package depends on `@personavision/contract` and nothing else: **never fixated is a
 * `null`, not a zero**, and **a session excluded from the scores changes no aggregate**.
 * First-fixation values are medians over the sessions that looked; accumulated values are
 * medians over every session behind the row, a session that never looked counting as the
 * zero it really is.
 *
 * Deriving the rows from the sessions rather than writing them out is what keeps the two
 * halves of the fixture from disagreeing — a never-fixated control cannot accidentally get
 * a row that says somebody saw it.
 */
export const buildAoiMetrics = (
  sessions: readonly Session[],
  aois: readonly Aoi[],
): AoiMetric[] => {
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

    const perSessionMedian = (of: (stats: SessionAoiStats) => number): number =>
      sessionCount === 0
        ? 0
        : median(perSession.map((stats) => (stats === undefined ? 0 : of(stats))));
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
