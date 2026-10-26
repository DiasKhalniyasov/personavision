/**
 * How a session ended, and who is at fault — decided once, here.
 *
 * `decideOutcome` is the **only** place in the repository that turns a finished session's
 * trace into a `status`, a `step`, a `reason` and an `attribution`. The session writer
 * (#44) stores what it returns unmodified; the friction score (#26) reads
 * `excludedFromScores` off the stored session; the screens read the outcome. Nothing
 * downstream re-derives any of it, and the browser driver's typed failures (#50) are fed
 * in here rather than turned into outcomes of their own.
 *
 * Three rules this module exists to hold (`docs/FLOW.md` sections 5 and 8):
 *
 * 1. **The four statuses stay four.** A session is *abandoned* when the person gave up,
 *    *failed* when it ended with the task not done, and an *automation failure* when our
 *    own browsing broke. Those three are never merged, and none of them is *success*.
 * 2. **Giving up is in character, not a stopwatch.** Persona patience and persistence set
 *    the dwell and the fruitless-action budgets, so the same trace ends *abandoned* for a
 *    low-patience persona and *success* for a persistent one.
 * 3. **Our breakage is never a verdict on the product.** A typed driver failure or a
 *    per-session wall-clock cap is `attribution: "automation"` and
 *    `excludedFromScores: true` — it counts towards no score, no heatmap and no aggregate.
 *    Every other ending is the product's, and is counted.
 *
 * It is a pure function over a trace plus a persona: no browser, no provider, no disk, no
 * clock of its own, so it is testable on synthetic traces.
 */

import type { Session } from '@personavision/contract';

/** The outcome block of a session, exactly as `packages/contract` declares it. */
export type SessionOutcome = Session['outcome'];
export type OutcomeStatus = SessionOutcome['status'];
export type Attribution = SessionOutcome['attribution'];

/**
 * Our own breakage, as the browser driver types it (#50), plus the wall-clock cap this
 * module applies itself. Every kind here is the simulation's fault, never the product's.
 */
export const AUTOMATION_FAILURE_KINDS = [
  'selector_not_found',
  'timeout',
  'navigation_error',
  'frame_error',
  'wall_clock_timeout',
] as const;

export type AutomationFailureKind = (typeof AUTOMATION_FAILURE_KINDS)[number];

export interface AutomationFailure {
  readonly kind: AutomationFailureKind;
  /** What was being attempted when it broke, in words a designer can read. */
  readonly detail: string;
  /** The step it broke on. */
  readonly step: string;
}

/** One screen of the walk: its position, and the step of the task it is. */
export interface TraceScreen {
  readonly index: number;
  readonly step: string;
}

/** One fixation of the walk, as the session stores it. */
export interface TraceFixation {
  readonly screenIndex: number;
  readonly tMs: number;
  readonly durationMs: number;
  readonly aoiId: string | null;
}

export type TraceActionType = Session['actions'][number]['type'];

/** One action the agent took, and whether it did what the agent expected. */
export interface TraceAction {
  readonly tMs: number;
  readonly type: TraceActionType;
  readonly aoiId: string | null;
  readonly ok: boolean;
}

/**
 * What the walk observed. Every field is a fact the browser, the engine or the decision
 * layer recorded — never a verdict, which is what this module is for. A `Session` from
 * `packages/contract` satisfies these shapes field-for-field, so the session writer passes
 * its own trace with no adapter.
 */
export interface SessionTrace {
  readonly screens: readonly TraceScreen[];
  readonly fixations: readonly TraceFixation[];
  /** Oldest first, as the session stores them. */
  readonly actions: readonly TraceAction[];
  readonly durationMs: number;
  /** The task's own success condition, as the browser observed it: a fact, not a verdict. */
  readonly taskCompleted: boolean;
  /** The area of interest holding the control that advances the task, when the task names one. */
  readonly primaryActionAoiId?: string | null;
  /** Set when the driver's own browsing broke; `null` or absent when it did not. */
  readonly automationFailure?: AutomationFailure | null;
  /** The per-session wall-clock cap the swarm ran under, when it set one. */
  readonly wallClockBudgetMs?: number | null;
}

/**
 * Who walked it. Only the two traits that govern giving up are read, so a generated
 * persona from `packages/contract` satisfies this with no adapter.
 */
export interface DecidingPersona {
  readonly traits: {
    readonly patience: number;
    readonly persistence: number;
  };
}

/**
 * What patience and persistence buy, as the two budgets an agent gives up against. Both
 * are interpolated across the trait's `[0, 1]`, so a persona in the middle gets a middling
 * budget rather than falling into a bucket.
 */
export interface OutcomePolicy {
  /** Dwell tolerated since it last got anywhere: at patience 0, and at patience 1. */
  readonly dwellAtNoPatienceMs: number;
  readonly dwellAtFullPatienceMs: number;
  /** Fruitless actions tolerated since it last got anywhere: at persistence 0, and at 1. */
  readonly attemptsAtNoPersistence: number;
  readonly attemptsAtFullPersistence: number;
}

/**
 * The committed budgets: roughly 8 to 40 seconds of dwell and 2 to 10 fruitless actions
 * across the trait range. They are configurable because the demo's spread is tuned
 * against the acceptance table in `docs/FLOW.md` section 5, never per call site.
 */
export const OUTCOME_POLICY: OutcomePolicy = {
  dwellAtNoPatienceMs: 8_000,
  dwellAtFullPatienceMs: 40_000,
  attemptsAtNoPersistence: 2,
  attemptsAtFullPersistence: 10,
};

/** The step named when the walk captured no screen at all — it never reached one. */
const NO_SCREEN_STEP = 'start';

/** An action that did what the agent expected, and so is progress rather than effort. */
const PROGRESS_ACTIONS: readonly TraceActionType[] = ['click', 'type'];

/**
 * Decide how a session ended and who is at fault.
 *
 * The order of the questions is the contract, not an implementation detail:
 *
 * 1. **Did our own browsing break?** A typed driver failure, a passed wall-clock cap, or a
 *    walk that captured no screen at all. Our breakage ends the session, and a session our
 *    simulation broke says nothing about the product, so it is asked first.
 * 2. **Did the persona give up?** Either it said so — an `abandon` action — or its patience
 *    or its persistence ran out over the trace. Asked before success, because a
 *    low-patience persona abandons part-way through a trace that a persistent persona
 *    walks to the end.
 * 3. **Was the task done?** `success` if the browser saw the task's success condition.
 * 4. **Otherwise it ended with the task not done** — `failed`, the product's.
 */
export function decideOutcome(
  trace: SessionTrace,
  persona: DecidingPersona,
  policy: OutcomePolicy = OUTCOME_POLICY,
): SessionOutcome {
  const failure = automationFailureOf(trace);
  if (failure) {
    return automationOutcome(failure);
  }

  const giveUp = findGiveUp(trace, persona, policy);
  if (giveUp) {
    return productOutcome('abandoned', giveUp.step, giveUpReason(trace, giveUp));
  }

  const endStep = trace.screens.at(-1)?.step ?? NO_SCREEN_STEP;
  if (trace.taskCompleted) {
    return productOutcome(
      'success',
      endStep,
      `Completed the task on the "${endStep}" step.${primaryActionClause(trace)}`,
    );
  }
  return productOutcome(
    'failed',
    endStep,
    `The session ended on the "${endStep}" step with the task not done.${primaryActionClause(trace)}`,
  );
}

/**
 * Our own breakage, from whichever of the three ways it shows up in a trace. The
 * wall-clock cap is checked here rather than trusted to the caller so that a swarm which
 * only records the cap and the duration still gets the same verdict as one that maps the
 * cap to a typed failure itself.
 */
function automationFailureOf(trace: SessionTrace): AutomationFailure | null {
  if (trace.automationFailure) {
    return trace.automationFailure;
  }
  const lastStep = trace.screens.at(-1)?.step ?? NO_SCREEN_STEP;
  const cap = trace.wallClockBudgetMs;
  if (cap != null && trace.durationMs > cap) {
    return {
      kind: 'wall_clock_timeout',
      detail: `the session passed its ${seconds(cap)} s wall-clock cap at ${seconds(trace.durationMs)} s`,
      step: lastStep,
    };
  }
  if (trace.screens.length === 0) {
    return {
      kind: 'navigation_error',
      detail: 'no screen was captured, so the session never reached the task',
      step: NO_SCREEN_STEP,
    };
  }
  return null;
}

/** Why the agent stopped trying, and where. */
interface GiveUp {
  /** `stated` when the agent decided to abandon; otherwise the budget that ran out. */
  readonly cause: 'stated' | 'patience' | 'persistence';
  readonly step: string;
  /** Fruitless actions since it last got anywhere. */
  readonly attempts: number;
  /** Dwell since it last got anywhere, in milliseconds. */
  readonly dwellMs: number;
  /** When it stopped trying, so the reason can count the revisits behind it. */
  readonly tMs: number;
  /** The last moment it got anywhere, which the dwell and the revisits are counted from. */
  readonly sinceMs: number;
}

/**
 * The first moment the agent stopped trying: it said so, or one of its two budgets ran
 * out. Both budgets count from the last action that got it somewhere, so an agent that
 * keeps making progress never spends them however long the session runs.
 */
function findGiveUp(
  trace: SessionTrace,
  persona: DecidingPersona,
  policy: OutcomePolicy,
): GiveUp | null {
  const dwellBudgetMs = lerp(
    policy.dwellAtNoPatienceMs,
    policy.dwellAtFullPatienceMs,
    persona.traits.patience,
  );
  const attemptsBudget = Math.round(
    lerp(
      policy.attemptsAtNoPersistence,
      policy.attemptsAtFullPersistence,
      persona.traits.persistence,
    ),
  );

  let sinceMs = 0;
  let attempts = 0;

  for (const action of trace.actions) {
    const at = (cause: GiveUp['cause']): GiveUp => ({
      cause,
      step: stepAt(trace, action.tMs),
      attempts,
      dwellMs: action.tMs - sinceMs,
      tMs: action.tMs,
      sinceMs,
    });

    if (action.type === 'abandon') {
      return at('stated');
    }
    if (action.ok && PROGRESS_ACTIONS.includes(action.type)) {
      sinceMs = action.tMs;
      attempts = 0;
      continue;
    }
    attempts += 1;
    if (attempts > attemptsBudget) {
      return at('persistence');
    }
    if (action.tMs - sinceMs > dwellBudgetMs) {
      return at('patience');
    }
  }
  return null;
}

function giveUpReason(trace: SessionTrace, giveUp: GiveUp): string {
  const revisits = revisitsBetween(trace, giveUp.sinceMs, giveUp.tMs);
  const effort = `${giveUp.attempts} actions, ${seconds(giveUp.dwellMs)} s of dwell and ${revisits} revisits to areas of interest it had already seen, since it last got anywhere`;
  if (giveUp.cause === 'stated') {
    return `Gave up on the "${giveUp.step}" step: ${effort}.`;
  }
  const spent = giveUp.cause === 'patience' ? 'Patience' : 'Persistence';
  return `${spent} spent on the "${giveUp.step}" step: ${effort}.`;
}

/**
 * What the primary action — the control that advances the task — did for this session:
 * whether it was ever fixated, how long it took, and whether a click on it landed. It is
 * the clause a designer reads the outcome by, so it is composed from the trace rather than
 * from the status.
 */
function primaryActionClause(trace: SessionTrace): string {
  const aoiId = trace.primaryActionAoiId;
  if (aoiId == null) {
    return '';
  }
  const onPrimary = trace.fixations.filter((fixation) => fixation.aoiId === aoiId);
  if (onPrimary.length === 0) {
    return ` The primary action in "${aoiId}" was never fixated.`;
  }
  const first = onPrimary.reduce((earliest, fixation) =>
    fixation.tMs < earliest.tMs ? fixation : earliest,
  );
  const clicked = trace.actions.some(
    (action) => action.type === 'click' && action.aoiId === aoiId && action.ok,
  );
  const looked = `fixated ${onPrimary.length} times, first ${seconds(first.tMs)} s in`;
  return clicked
    ? ` The primary action in "${aoiId}" was ${looked}, and clicked.`
    : ` The primary action in "${aoiId}" was ${looked}, but never clicked.`;
}

/**
 * Returns, in a window, to an area of interest the agent had already fixated before the
 * window opened: the revisits an outcome's reason counts.
 */
function revisitsBetween(trace: SessionTrace, fromMs: number, toMs: number): number {
  const seen = new Set<string>();
  let revisits = 0;
  for (const fixation of trace.fixations) {
    if (fixation.aoiId == null) {
      continue;
    }
    if (fixation.tMs < fromMs) {
      seen.add(fixation.aoiId);
      continue;
    }
    if (fixation.tMs > toMs) {
      break;
    }
    if (seen.has(fixation.aoiId)) {
      revisits += 1;
    }
    seen.add(fixation.aoiId);
  }
  return revisits;
}

/**
 * The step the agent was on at a moment of the session. Actions carry a time and not a
 * screen, so the step is the one the last fixation before that moment landed on.
 */
function stepAt(trace: SessionTrace, tMs: number): string {
  let step = trace.screens[0]?.step ?? NO_SCREEN_STEP;
  for (const fixation of trace.fixations) {
    if (fixation.tMs > tMs) {
      break;
    }
    step = trace.screens[fixation.screenIndex]?.step ?? step;
  }
  return step;
}

/** The one place `attribution` and `excludedFromScores` are set together. */
function automationOutcome(failure: AutomationFailure): SessionOutcome {
  return {
    status: 'automation_failure',
    step: failure.step,
    reason: `Our own browsing broke on the "${failure.step}" step: ${failure.detail}.`,
    attribution: 'automation',
    excludedFromScores: true,
  };
}

function productOutcome(
  status: Exclude<OutcomeStatus, 'automation_failure'>,
  step: string,
  reason: string,
): SessionOutcome {
  return { status, step, reason, attribution: 'product', excludedFromScores: false };
}

function lerp(atZero: number, atOne: number, t: number): number {
  return atZero + (atOne - atZero) * clampUnit(t);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** One decimal, because a reason reads "12.4 s of dwell" and not "12437 ms". */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
