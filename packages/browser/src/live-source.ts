/**
 * The capture source that drives a real browser, and the walk that uses it.
 *
 * `createLiveSource()` is the `CaptureSource` over Chromium — the one a run launched
 * against a URL uses. `walkTask` is the loop above it: open the variant, capture the screen,
 * act on it, capture the next one, until the task's last step is reached or something of
 * ours breaks.
 *
 * **The walk decides nothing.** `TaskWalk.decide` is where the swarm's decision loop goes:
 * it is handed the screen that was just captured and the step's declaration, and it answers
 * with the action to take or with `null` to stop the walk there. Without one the walk
 * advances on the control the step declares, which is what drives a task from end to end in
 * a single call and is the whole of this module's own judgement.
 *
 * **A failure of ours ends the walk and is returned, not thrown.** The screens captured
 * before it are facts worth keeping — the swarm's trace is built from them — so the result
 * carries them, the typed failure, and the one outcome a failure of ours can produce:
 * `attribution: "automation"`, `excludedFromScores: true`. An error this module cannot place
 * is rethrown instead (`toAutomationFailure`), because a mystery recorded as our breakage is
 * a session excluded for the wrong reason.
 *
 * **It reports no product outcome.** Whether a session was a success, was abandoned or
 * failed is `packages/swarm`'s `decideOutcome` to decide from the trace and the persona, and
 * this module hands it facts: the screens, whether the task's last step was reached, and the
 * integrity counters. `completed: true` says the walk got there, not that the person did.
 *
 * **The retries and the caps are the session's.** One `SessionBudget` runs the whole walk —
 * opening, every capture and every action — so a broken variant costs a session its cap
 * rather than one cap per operation, and the counters the artifact records are the session's.
 * A caller that holds a budget passes it; `capture()`'s own budget is set to a single
 * attempt so that nothing retries twice (`createLiveSource`). A walk is capped in screens as
 * well as in time, because a decision layer that never advances the step would otherwise
 * spend the session's whole clock and have the budget report a session the product is not at
 * fault for as our own breakage.
 *
 * One failure of ours the walk does not watch for: a subframe whose document never arrives.
 * `watchFrameFailures` has to be attached before the navigation whose frames it judges, and
 * the navigation a session opens with happens inside `CaptureSource.openSession`, which has
 * no channel to hand a watch back. A consumer that needs the opening page's frames judged
 * attaches the watch itself.
 */

import { act } from './act.js';
import { SessionBudget } from './budget.js';
import { capture } from './capture.js';
import { AutomationFailure } from './errors.js';
import { toAutomationFailure, toAutomationFailureOutcome } from './failure-mapping.js';
import { closeSession, openSession } from './session.js';
import { taskStep } from './steps.js';
import type { SessionBudgetLimits, SessionIntegrity } from './budget.js';
import type { AutomationFailureOutcome } from './failure-mapping.js';
import type {
  ActResult,
  Action,
  Capture,
  CaptureContext,
  CaptureSource,
  Device,
  PageHandle,
  TaskDefinition,
  TaskStep,
  Variant,
} from './types.js';

/**
 * What to do on the screen that was just captured, and `null` to stop the walk on it.
 *
 * The step is the task's own declaration of the screen the capture is on, so a decision
 * layer has the control that advances it without re-reading the task.
 */
export type DecideAction = (
  screen: Capture,
  step: TaskStep | null,
) => Action | null | Promise<Action | null>;

/** One variant, under one device, against one task, writing into one run directory. */
export interface TaskWalk {
  readonly variant: Variant;
  readonly device: Device;
  readonly task: TaskDefinition;
  readonly runDir: string;
  /**
   * The caller's decision per screen. Defaults to advancing on the control the step
   * declares, which walks the task from its first step to its last.
   */
  readonly decide?: DecideAction;
  /**
   * The session's budget: the caps the walk runs under, and the counters its integrity is
   * read from. The swarm holds one per session and passes it; without one the walk runs
   * under a fresh budget with the default caps.
   */
  readonly budget?: SessionBudget;
  /**
   * How many screens one walk may capture. Defaults to eight per step the task declares.
   *
   * A decision layer is free to act on one screen several times — scroll, then click — so
   * nothing in the loop guarantees that a step ever advances. Without a cap a `decide` that
   * only ever scrolls would capture until the session's clock ran out, hold every capture it
   * took in memory, and end as an automation failure: a session the product is not at fault
   * for, excluded as our breakage. Reaching the cap instead ends the walk with the screens it
   * took and no failure at all, and a trace that went nowhere is exactly what
   * `decideOutcome` reads to call the session abandoned.
   */
  readonly maxScreens?: number;
}

/**
 * One screen of a walk: what was captured, and what the action taken on it did.
 *
 * A screen captured twice — a decision layer that scrolls and then clicks — is two entries
 * whose captures name one image file, because `screenshots/<variant>/<step>.png` is one image
 * per screen of one variant and the second capture overwrote the first. The later entry is
 * the one the file on disk matches, which is also the row `run.json` keeps
 * (`run-projection.ts`).
 */
export interface WalkScreen {
  readonly capture: Capture;
  /**
   * What the action did, or `null` on the screen the walk ended on — nothing was done to
   * it, or what was done never reported.
   */
  readonly action: ActResult | null;
}

/** What one walk of one task over one variant produced. */
export interface TaskWalkResult {
  readonly variant: string;
  /** The screens, in the order they were captured. */
  readonly screens: readonly WalkScreen[];
  /** The last step the walk recognised, and `null` when it never reached one. */
  readonly step: string | null;
  /** `true` when the walk reached the last step the task declares. */
  readonly completed: boolean;
  /** The two counters a session artifact records under `integrity`. */
  readonly integrity: SessionIntegrity;
  /** Our own browsing breaking, when that is what ended the walk. */
  readonly failure: AutomationFailure | null;
  /**
   * The session outcome that failure produces, and `null` when nothing of ours broke. Its
   * `step` is the step the walk **broke on** — the screen it was capturing, or the step the
   * action was taken on — rather than the last one it recognised, so that a page which
   * never rendered its own required element is named by the step it failed to be.
   */
  readonly outcome: AutomationFailureOutcome | null;
}

export type WalkTask = (source: CaptureSource, walk: TaskWalk) => Promise<TaskWalkResult>;

/**
 * The capture's own budget: one attempt, and no clock of its own.
 *
 * Retrying, capping and counting are the session's, and the session's budget is the walk's,
 * which races every capture against what the session has left. A wall clock here would be a
 * cap no caller configured — read out in `outcome.reason` as a number from nowhere — and one
 * `withoutOwnCap` could not strip either, because a cap reached on time alone carries no
 * cause.
 *
 * The clock is spelt as the longest a timer will actually wait rather than as `Infinity` or
 * as the largest safe integer: a budget floors its limits to whole finite numbers, and a
 * delay past a timer's own ceiling does not wait for ever — it fires at once, which would cap
 * every capture immediately.
 */
const LONGEST_TIMER_MS = 2_147_483_647;

const ONE_ATTEMPT: SessionBudgetLimits = {
  maxRetries: 0,
  wallClockMs: LONGEST_TIMER_MS,
};

/**
 * A capture's own cap failure, replaced by the failure that actually ended it.
 *
 * A budget that may not retry still reports reaching its retry cap, and that sentence would
 * be the second cap a person reads in `outcome.reason` once the session's budget has worded
 * its own. What broke travels as the cause, and that is what the session's budget should see.
 */
const withoutOwnCap = (error: unknown): unknown =>
  error instanceof AutomationFailure && error.cause instanceof AutomationFailure
    ? error.cause
    : error;

const captureOnce: CaptureSource['capture'] = async (page, ctx) => {
  try {
    return await capture(page, ctx, new SessionBudget(ONE_ATTEMPT));
  } catch (error) {
    throw withoutOwnCap(error);
  }
};

/**
 * Chromium over a URL: the module's own seams, behind the interface the engine, the swarm
 * and the tests are written against.
 */
export const createLiveSource = (): CaptureSource => ({
  openSession,
  capture: captureOnce,
  act,
  close: closeSession,
});

/** A capture of a screen the task declares: the only kind a walk can go on from. */
type OnAStep = Capture & { step: string };

const onAStep = (capture: Capture): capture is OnAStep => capture.step !== null;

/** How many screens a walk may capture per step the task declares. */
const SCREENS_PER_STEP = 8;

/** The walk's own judgement, and the whole of it: take the control the step declares. */
const advance: DecideAction = (_screen, step) =>
  step === null ? null : { type: 'click', selector: step.primaryAction.selector };

/** The step the walk expects next: the one the task declares after the last it recognised. */
const nextStep = (task: TaskDefinition, reached: string | null): TaskStep | null => {
  if (reached === null) return task.steps[0] ?? null;
  const at = task.steps.findIndex((step) => step.id === reached);
  return at === -1 ? null : (task.steps[at + 1] ?? null);
};

/** The last step the task declares: the one a walk that reaches it has completed on. */
const finalStep = (task: TaskDefinition): TaskStep | null =>
  task.steps[task.steps.length - 1] ?? null;

/**
 * A screen the task does not declare, which the walk cannot go on from: there is no primary
 * action on it to act on and no name to write its image under. The step it should have been
 * is named with the element that step requires, because a page that did not render its own
 * form is the shape this takes on a real product.
 */
const unrecognisedScreen = (
  task: TaskDefinition,
  expected: TaskStep | null,
  url: string,
): AutomationFailure =>
  new AutomationFailure(
    'selector_not_found',
    expected === null
      ? `${url} is on no step of the ${task.id} task, which declares no further step to look for`
      : `${url} is on no step of the ${task.id} task: the ${expected.id} step requires ${expected.match.requiredSelector}`,
  );

/** An action the page reported back on, and reported that it did not work. */
const actionFailure = (action: Action, step: string, result: ActResult): AutomationFailure =>
  new AutomationFailure(
    result.failure ?? 'timeout',
    `the ${action.type} on the ${step} step did not work (${result.failure ?? 'no reason given'})`,
  );

export const walkTask: WalkTask = async (source, walk) => {
  const budget = walk.budget ?? new SessionBudget();
  const decide = walk.decide ?? advance;
  const ctx: CaptureContext = {
    variant: walk.variant.id,
    device: walk.device,
    task: walk.task,
    runDir: walk.runDir,
  };
  const final = finalStep(walk.task);
  const declaredCap = walk.maxScreens;
  const maxScreens =
    declaredCap !== undefined && Number.isFinite(declaredCap)
      ? Math.max(0, Math.floor(declaredCap))
      : SCREENS_PER_STEP * Math.max(1, walk.task.steps.length);
  const screens: WalkScreen[] = [];
  let reached: string | null = null;

  const report = (failure: AutomationFailure | null, brokeOn: string | null): TaskWalkResult => ({
    variant: walk.variant.id,
    screens,
    step: reached,
    completed: failure === null && final !== null && reached === final.id,
    integrity: budget.sessionIntegrity(),
    failure,
    outcome: failure === null ? null : toAutomationFailureOutcome(failure, brokeOn),
  });

  /** Our own breakage, however it arrived: the walk ends and says so rather than throwing. */
  const broke = (error: unknown, attempting: string, brokeOn: string | null): TaskWalkResult => {
    const failure = toAutomationFailure(error, attempting);
    // Not ours to classify, so not ours to report as ours: the caller sees what happened.
    if (failure === null) throw error;
    return report(failure, brokeOn);
  };

  const opening = `opening ${walk.variant.url}`;
  // The open in flight, kept so that a session which arrives after the budget has given up on
  // it is still closed. The budget abandons an operation it cannot cancel, and a browser
  // nobody holds is a process that never goes away — one per session of a swarm. It is held
  // on an object rather than in a variable because what a closure assigns is not what the
  // compiler reads afterwards.
  const session = { inFlight: null as Promise<PageHandle> | null };
  let page: PageHandle;
  try {
    page = await budget.attempt(() => {
      session.inFlight = source.openSession(walk.variant, walk.device);
      return session.inFlight;
    }, opening);
  } catch (error) {
    // Not awaited: waiting for an abandoned open would hold the session past the cap that
    // abandoned it, which is the one thing a cap exists to prevent.
    void session.inFlight?.then((handle) => source.close(handle)).catch(() => undefined);
    // Nothing of the task was reached, so there is no step this broke on.
    return broke(error, opening, null);
  }

  try {
    for (;;) {
      if (screens.length >= maxScreens) {
        // The cap, which is not a failure of ours: see `TaskWalk.maxScreens`.
        return report(null, null);
      }

      const expected = nextStep(walk.task, reached);
      const capturing = `capturing the ${expected === null ? 'next' : expected.id} screen`;
      let screen: OnAStep;
      try {
        screen = await budget.attempt(async () => {
          const taken = await source.capture(page, ctx);
          if (!onAStep(taken)) {
            throw unrecognisedScreen(walk.task, expected, page.page.url());
          }
          return taken;
        }, capturing);
      } catch (error) {
        return broke(error, capturing, expected?.id ?? null);
      }
      reached = screen.step;

      const declared = taskStep(walk.task, screen.step);
      const action = reached === final?.id ? null : await decide(screen, declared);
      if (action === null) {
        // The task's last step, or a decision layer that stopped here: either way nothing
        // was done to this screen.
        screens.push({ capture: screen, action: null });
        return report(null, null);
      }

      const acting = `acting on the ${screen.step} screen`;
      let acted: ActResult;
      try {
        // The capture travels with the action, so an `elementId` an agent chose resolves
        // against the screen it was chosen on rather than against the page as it is now.
        acted = await budget.attempt(() => source.act(page, action, ctx, { screen }), acting);
      } catch (error) {
        return broke(error, acting, screen.step);
      }

      // A failure `act` reported is kept on the screen — it is what the page did, and the
      // trace records it — and it ends the walk without being retried. An action can have
      // navigated before it failed, and a second attempt at the same target would act on a
      // screen no capture covers and be classified by whatever that screen made of it.
      screens.push({ capture: screen, action: acted });
      if (!acted.ok) {
        return broke(actionFailure(action, screen.step, acted), acting, screen.step);
      }
    }
  } finally {
    // A browser that will not close is a leaked process, not a session that did not happen:
    // the walk has its answer, and throwing here would throw that answer away.
    await source.close(page).catch(() => undefined);
  }
};
