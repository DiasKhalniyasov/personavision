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
 * Six rules this module exists to hold (`docs/FLOW.md` sections 5, 8 and 12):
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
 * 4. **A session succeeds only when its criterion was observed** (#400). Where the run was
 *    given a goal, `trace.criterion` says what the session made of that goal's success
 *    criterion, and it — not the step the walk ended on — decides completion. A criterion
 *    nothing could evaluate is never promoted to a success by falling back to a weaker
 *    test. Where the run was given none, the old rule stands: a declared multi-step task
 *    says where its end is, and reaching it is the task done.
 * 5. **An agent that never acted cannot succeed.** Success additionally requires one of
 *    {@link PROGRESS_ACTIONS} in the trace. A criterion that was already true when the
 *    agent arrived, on a page nobody operated, is `failed` and says so in words: the
 *    product was never tested, and a completion rate counting it means nothing.
 * 6. **A walk our own action budget stopped says so** (#413). The agent did not stop
 *    trying — we stopped it — so the session is never *abandoned*, which would read as a
 *    verdict on the product for something we did. It is `failed`, the product's, with the
 *    budget and the step it was on in its reason, and the four statuses stay four.
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

/**
 * The run's success criterion, and what this session made of it — present exactly when the
 * run was given a goal (`docs/FLOW.md` section 12, #400).
 *
 * It is facts and not a verdict, like every other field of a trace: `criterion.ts` reads the
 * sentence and checks it against what the session captured, and this module decides what the
 * answer means. A trace carrying none is a run with no goal, decided by the step it reached.
 */
export interface TraceCriterion {
  /** The criterion, in the words the run's goal states it. */
  readonly criterion: string;
  /** Whether it was observed on a captured screen of this session. */
  readonly observed: boolean;
  /**
   * Why no screen could be searched for it — a judgement, a feeling, a sentence naming none
   * of the three observable kinds — in the reader's own words; `null` when one could.
   */
  readonly unobservable: string | null;
  /** What the session looked for and did not find, in the criterion's own words. */
  readonly missing: readonly string[];
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
  /**
   * The task's own success condition, as the browser observed it: a fact, not a verdict.
   *
   * It is **the step rule** — the walk reached the task's last declared step — and it decides
   * a session only where the run was given no goal. Where one was, `criterion` below is the
   * success condition and this is ignored.
   */
  readonly taskCompleted: boolean;
  /**
   * The run's success criterion and what this session observed of it, where the run had one;
   * absent or `null` on a run with no goal.
   */
  readonly criterion?: TraceCriterion | null;
  /**
   * The action budget that ended the walk, in screens, when the budget is what ended it;
   * absent or `null` on every other ending — a failure of ours, the end of the walk, or the
   * agent's own `abandon`.
   *
   * It is a fact the walk recorded like any other, and the one fact a reader of a trace
   * cannot recover from the rest of it: a session cut off at its last allowed screen looks
   * exactly like one that stopped there of its own accord (#413).
   */
  readonly stoppedOnBudget?: number | null;
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
  /**
   * Fruitless actions tolerated since it last got anywhere, as a base plus a term per
   * trait. These three mirror the offline policy's own abandon budget
   * (`packages/provider/src/offline.ts`, #33) deliberately: that policy emits the
   * `abandon` action, and a budget here that ran out *sooner* would record a give-up on
   * screens the agent's own policy had decided to keep going on. They are duplicated
   * rather than imported because a provider is one way a trace is produced and this
   * module decides over every trace, model-mode traces included, where no policy emits an
   * `abandon` action at all.
   */
  readonly attemptsBase: number;
  readonly attemptsPerPersistence: number;
  readonly attemptsPerPatience: number;
}

/**
 * The committed budgets: 8 to 40 seconds of dwell across the patience range, and 2 to 16
 * fruitless actions across the two traits. They are configurable because the demo's
 * spread is tuned against the acceptance table in `docs/FLOW.md` section 5, never per
 * call site.
 */
export const OUTCOME_POLICY: OutcomePolicy = {
  dwellAtNoPatienceMs: 8_000,
  dwellAtFullPatienceMs: 40_000,
  attemptsBase: 2,
  attemptsPerPersistence: 10,
  attemptsPerPatience: 4,
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
 *    walks to the end. (Question 3 below is the one thing asked before it, and only
 *    because it says this session measured nothing at all.)
 * 3. **Could the criterion be observed at all?** A criterion the reader cannot evaluate
 *    leaves the session nothing to have done, so it is `failed` saying so. It is asked
 *    before the persona and not after: a walk that spent its patience against a criterion
 *    nobody could evaluate would otherwise be recorded as the person giving up on the
 *    product, which is a verdict the run cannot support. Abandonment keeps its precedence
 *    over the **success** test, which is what it is precedence over.
 * 4. **Did our own action budget stop the walk?** A session cut off at its last allowed
 *    screen is asked about before the persona and never after: the agent had more to try
 *    and we took the screens away, so reading a give-up off such a trace would record the
 *    person leaving a product our own cap stopped them using (#413). It is `failed`, and
 *    its reason names the budget.
 * 5. **Was the criterion observed?** Where the run had one, that is the success condition.
 *    Where it had none, the step rule stands: the task's last declared step.
 * 6. **Did the agent act?** Success needs one action that operated the page. An arrival on
 *    a screen that already satisfied the criterion is `failed`: nothing was tested.
 * 7. **Otherwise it ended with the task not done** — `failed`, the product's.
 */
export function decideOutcome(
  trace: SessionTrace,
  persona: DecidingPersona,
  policy: OutcomePolicy = OUTCOME_POLICY,
): SessionOutcome {
  const endStep = trace.screens.at(-1)?.step ?? NO_SCREEN_STEP;
  const criterion = trace.criterion ?? null;
  // The criterion decides completion where the run has one; the step rule where it does
  // not. Read once, because the abandonment scan asks the same question: effort after the
  // task was done is not effort towards it.
  const completed = criterion === null ? trace.taskCompleted : criterion.observed;

  const failure = automationFailureOf(trace);
  if (failure) {
    return automationOutcome(failure, endStep);
  }

  // Asked before the persona, and after our own browsing only: a criterion nothing can
  // evaluate means this session measured nothing, so neither a success nor a give-up can be
  // read off it. A walk that ran its patience out against an unevaluable criterion would
  // otherwise be recorded as the person giving up on the product — a verdict the run cannot
  // support, counted against the product's own score.
  if (criterion !== null && criterion.unobservable !== null) {
    return productOutcome(
      'failed',
      endStep,
      notDone(trace, endStep, `the criterion could not be observed. ${criterion.unobservable}`),
    );
  }

  /**
   * A session that ended with the task not done, in the one sentence both such endings
   * share: `how` is what the session did — it ended on that step, or our own budget stopped
   * it there — and the rest is the same words either way.
   */
  const notCompletedReason = (how: string): string =>
    criterion === null
      ? `The session ${how} on the "${endStep}" step with the task not done.${primaryActionClause(trace)}`
      : notDone(
          trace,
          endStep,
          `the criterion ${quoted(criterion.criterion)} was never observed — ${missingClause(endStep, criterion.missing)}.`,
          how,
        );

  // Asked before the give-up scan, which is the whole of the rule: on a walk we stopped, the
  // scan's dwell and fruitless actions are what our own cap left behind, so a give-up read
  // off them anywhere in the trace — the scan returns the first one, early or late — would
  // record the person leaving a site they were still being walked around. It is the
  // precedence the owner's own run asks for: S-01 was called `abandoned` at 8.8 s on a trace
  // eight actions long because that is all the actions we allowed it. Still `failed` and
  // still the product's — the session ended with the task not done — with the budget in its
  // words rather than a verdict we caused.
  if (trace.stoppedOnBudget != null && !completed) {
    return productOutcome(
      'failed',
      endStep,
      notCompletedReason(`was stopped after its ${plural(trace.stoppedOnBudget, 'action')}`),
    );
  }

  const giveUp = findGiveUp(trace, completed, persona, policy);
  if (giveUp) {
    return productOutcome('abandoned', giveUp.step, giveUpReason(trace, giveUp));
  }
  if (!completed) {
    return productOutcome('failed', endStep, notCompletedReason('ended'));
  }
  if (!acted(trace)) {
    return productOutcome(
      'failed',
      endStep,
      notDone(
        trace,
        endStep,
        criterion === null
          ? 'the step was reached without the agent acting on anything.'
          : `the criterion ${quoted(criterion.criterion)} was already true when the agent arrived, and nothing was acted on.`,
      ),
    );
  }
  return productOutcome(
    'success',
    endStep,
    criterion === null
      ? `Completed the task on the "${endStep}" step.${primaryActionClause(trace)}`
      : `Completed the task on the "${endStep}" step: the criterion ${quoted(criterion.criterion)} was observed.${primaryActionClause(trace)}`,
  );
}

/**
 * Whether the agent operated the page at all: one click or one keystroke anywhere in the
 * trace, whether or not it worked.
 *
 * A scroll, a hesitation and a step back are not among {@link PROGRESS_ACTIONS}, and a
 * session made only of them has looked at a product rather than used it.
 */
function acted(trace: SessionTrace): boolean {
  return trace.actions.some((action) => PROGRESS_ACTIONS.includes(action.type));
}

/**
 * The one shape of a failed session's reason: how the session ended, where, and what was
 * not done. `how` is "ended" unless our own action budget is what stopped it (#413).
 */
function notDone(trace: SessionTrace, step: string, because: string, how = 'ended'): string {
  return `The session ${how} on the "${step}" step with the task not done: ${because}${primaryActionClause(trace)}`;
}

/** The criterion's own words, quoted so a reader can see where the sentence ends. */
function quoted(criterion: string): string {
  return `“${criterion}”`;
}

/** What the screen was missing, in the criterion's own words. */
function missingClause(step: string, missing: readonly string[]): string {
  if (missing.length === 0) {
    return `the "${step}" step did not show it`;
  }
  // "no X and no Y", never "X or Y": every term is required, and a reader told the step
  // named neither would otherwise understand that either one would have done.
  return `the "${step}" step named ${missing.map((term) => `no “${term}”`).join(' and ')}`;
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
 *
 * `completed` is whether the walk's success condition was met — the criterion where the run
 * had one, the final declared step where it did not. It is passed in rather than read off
 * the trace so that one answer governs both this scan and the verdict.
 */
function findGiveUp(
  trace: SessionTrace,
  completed: boolean,
  persona: DecidingPersona,
  policy: OutcomePolicy,
): GiveUp | null {
  const dwellBudgetMs = lerp(
    policy.dwellAtNoPatienceMs,
    policy.dwellAtFullPatienceMs,
    persona.traits.patience,
  );
  const attemptsBudget = Math.round(
    policy.attemptsBase +
      policy.attemptsPerPersistence * clampUnit(persona.traits.persistence) +
      policy.attemptsPerPatience * clampUnit(persona.traits.patience),
  );

  // Effort after the task was done is not effort towards it: an agent reading the
  // confirmation page has given up on nothing, so the scan stops where the task was
  // completed rather than running to the end of the trace.
  const until = completed ? completedAtMs(trace) : Number.POSITIVE_INFINITY;

  let sinceMs = 0;
  let attempts = 0;

  for (const action of trace.actions) {
    if (action.tMs > until) {
      break;
    }
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

  // A session ends when the agent stops acting, so the dwell it ends on is where giving up
  // most often happens — and there is no action after it to measure it at.
  const trailingDwellMs = trace.durationMs - sinceMs;
  if (!completed && trailingDwellMs > dwellBudgetMs) {
    return {
      cause: 'patience',
      step: trace.screens.at(-1)?.step ?? NO_SCREEN_STEP,
      attempts,
      dwellMs: trailingDwellMs,
      tMs: trace.durationMs,
      sinceMs,
    };
  }
  return null;
}

/** When the task was done: the last action that got the agent anywhere. */
function completedAtMs(trace: SessionTrace): number {
  let completedAt = Number.POSITIVE_INFINITY;
  for (const action of trace.actions) {
    if (action.ok && PROGRESS_ACTIONS.includes(action.type)) {
      completedAt = action.tMs;
    }
  }
  return completedAt;
}

function giveUpReason(trace: SessionTrace, giveUp: GiveUp): string {
  const revisits = revisitsBetween(trace, giveUp.sinceMs, giveUp.tMs);
  const effort = `${plural(giveUp.attempts, 'action')}, ${seconds(giveUp.dwellMs)} s of dwell and ${revisitClause(revisits)}, since it last got anywhere`;
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
  const looked = `fixated ${plural(onPrimary.length, 'time')}, first ${seconds(first.tMs)} s in`;
  return clicked
    ? ` The primary action in "${aoiId}" was ${looked}, and clicked.`
    : ` The primary action in "${aoiId}" was ${looked}, but never clicked.`;
}

/**
 * Returns, in a window, to an area of interest the gaze had already visited **and left**,
 * so a run of consecutive fixations inside one area is one visit and not a revisit. It is
 * the definition `packages/scoring`'s dead-end returns uses, because `revisit` is one word
 * in this product (`docs/FLOW.md` section 8) and an outcome's reason counts it the same
 * way the friction score does.
 */
function revisitsBetween(trace: SessionTrace, fromMs: number, toMs: number): number {
  const seen = new Set<string>();
  let previousAoiId: string | null = null;
  let revisits = 0;
  for (const fixation of trace.fixations) {
    if (fixation.tMs > toMs) {
      break;
    }
    const aoiId = fixation.aoiId;
    // A fixation outside every area breaks the run, so coming back across it is a return.
    if (aoiId == null) {
      previousAoiId = null;
      continue;
    }
    if (fixation.tMs >= fromMs && seen.has(aoiId) && previousAoiId !== aoiId) {
      revisits += 1;
    }
    seen.add(aoiId);
    previousAoiId = aoiId;
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
function automationOutcome(failure: AutomationFailure, endStep: string): SessionOutcome {
  // A driver that broke before it knew where it was reports no step, and the contract's
  // `outcome.step` is a non-empty name: this module promises an outcome that parses, so
  // the last screen's step stands in rather than being passed through blank.
  const step = failure.step.trim() === '' ? endStep : failure.step;
  return {
    status: 'automation_failure',
    step,
    reason: `Our own browsing broke on the "${step}" step: ${failure.detail}.`,
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

/** The revisit clause of a reason, in the singular when there was one of them. */
function revisitClause(revisits: number): string {
  return revisits === 1
    ? '1 revisit to an area of interest it had already seen'
    : `${revisits} revisits to areas of interest it had already seen`;
}

/** "1 action", "3 actions": the reason is copy a designer reads, not a counter. */
function plural(howMany: number, noun: string): string {
  return `${howMany} ${noun}${howMany === 1 ? '' : 's'}`;
}

/** One decimal, because a reason reads "12.4 s of dwell" and not "12437 ms". */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
