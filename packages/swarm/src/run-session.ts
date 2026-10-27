/**
 * One persona, one variant, one seed, one task attempt — written as a session.
 *
 * This is the decision loop of `docs/FLOW.md` section 4, and the only place the three parts
 * of the simulation meet. Per screen it:
 *
 * 1. **captures the page** through the browser step's `CaptureSource`, so one loop drives
 *    Chromium or replays a committed capture set with no network at all (#6, #52);
 * 2. **builds the areas of interest and samples the persona's fixations** through the
 *    attention engine (#7), handing it the whole session's fixations as history — so
 *    `index` runs continuously across the session and inhibition of return reads across
 *    screens rather than restarting on each one;
 * 3. **asks the decision layer for exactly one decision** (#33) from a context holding only
 *    what the agent has looked at; and
 * 4. **executes the one action it decided** through the driver, recording whether it worked.
 *
 * **One decision per screen, not one per fixation.** A session therefore costs a handful of
 * model calls rather than hundreds, which is the whole reason the loop is shaped this way
 * (step #8). A screen looked at twice — scroll, then click — is two screens of the session
 * and two decisions, because the agent saw two different things.
 *
 * **The agent knows only what it looked at.** `DecisionContext.fixatedElements` is built
 * from this screen's fixations and nothing else, so an element the gaze never landed on has
 * no entry and no provider can act on one. `validateDecision` holds the reply to the same
 * rule from the other side.
 *
 * **Nothing here decides how the session ended.** The outcome, its step, its reason and its
 * attribution are `decideOutcome`'s (#35) and are stored exactly as it returns them. This
 * module hands it facts — the screens, the fixations, the actions, and whether our own
 * browsing broke — and reads nothing back out of them.
 *
 * **The same persona, seed and page produce the same session.** Every draw is seeded from
 * the session's seed and the screen's position; the one value that is not derived is
 * `startedAt`, which is the wall clock and is therefore an input.
 *
 * What it does not carry: the run's own index, counters and totals (#49 appends those as
 * each session lands), and the trajectory sink (#139 opens one around the decider).
 */

import { SessionBudget, taskStep, toAutomationFailure } from '@personavision/browser';
import { runPaths, SCHEMA_VERSION, writeSession } from '@personavision/contract';
import { buildAois, noSegmenter, sampleFixations } from '@personavision/engine';
import { validateDecision } from '@personavision/provider';
import { decideOutcome } from './outcome.js';
import type {
  ActResult,
  Action,
  Capture,
  CaptureContext,
  CaptureElement,
  CaptureSource,
  PageHandle,
  TaskDefinition,
  Variant,
} from '@personavision/browser';
import type { Persona, Session } from '@personavision/contract';
import type {
  Aoi,
  Capture as EngineCapture,
  EngineConfigOverrides,
  SampledFixation,
  SampledSaccade,
  Segmenter,
} from '@personavision/engine';
import type {
  Decision,
  DecisionActionKind,
  DecisionContext,
  DecisionProvider,
  FixatedElement,
  PastAction,
} from '@personavision/provider';
import type { AutomationFailure, OutcomePolicy, SessionTrace } from './outcome.js';

/** The decision layer a session runs through. A record, so a later seam is a new field. */
export interface SessionProviders {
  readonly decision: DecisionProvider;
}

/** One finished screen of a session, for a caller that has to build the run around it. */
export interface SessionScreen {
  readonly index: number;
  readonly step: string;
  readonly capture: Capture;
  /** The areas this screen's fixations were sampled over, as `run.json` records them. */
  readonly aois: readonly Aoi[];
  readonly decision: Decision;
  /** What the driver did with the decision, and `null` when it was not a page operation. */
  readonly executed: ActResult | null;
}

export interface RunSessionInput {
  /** The run directory this session's file and screenshots are written under. */
  readonly runDir: string;
  /** The run this session belongs to, as `run.json`'s `runId` spells it. */
  readonly runId: string;
  /** `S-01 … S-NN`: this session's id, and the name of its file under `sessions/`. */
  readonly sessionId: string;
  readonly variant: Variant;
  readonly persona: Persona;
  readonly seed: number;
  readonly task: TaskDefinition;
  readonly source: CaptureSource;
  readonly providers: SessionProviders;
  /**
   * The segmentation the areas of interest are built with. Element-derived areas only by
   * default, because a session's `aoiId`s have to name areas `run.json` also declares: a run
   * that segments passes the same segmenter here that it builds its `aois` with.
   */
  readonly segmenter?: Segmenter;
  /** The caps this session runs under, and the counters its `integrity` is read from. */
  readonly budget?: SessionBudget;
  /** How many screens one session may capture. Defaults to eight per step of the task. */
  readonly maxScreens?: number;
  /** The run's `engine.weights`, over the engine's defaults. */
  readonly weights?: EngineConfigOverrides;
  /**
   * When the session started, ISO 8601. It is an input rather than a reading of the clock
   * because a reproducible session is reproducible in every field: the swarm stamps it, and
   * a test that re-runs a session passes the same one. Defaults to now.
   */
  readonly startedAt?: string;
  /** The give-up budgets `decideOutcome` reads patience and persistence against. */
  readonly outcomePolicy?: OutcomePolicy;
  /**
   * Called once per finished screen, in order. It is how a run collects what belongs to the
   * run rather than to one session — the areas of interest `run.json` declares, and what the
   * decisions cost — while this function still returns nothing but the session (#49).
   */
  readonly onScreen?: (screen: SessionScreen) => void;
}

/** How many screens a session may capture per step the task declares, as the walk caps it. */
const SCREENS_PER_STEP = 8;

/**
 * How far a scroll with no target moves the page: three quarters of the viewport, which is
 * the conventional page scroll and leaves a band of what was already read on screen. A
 * scroll is never aimed at an element — the decision interface forbids a target on one — so
 * this is the only distance there is to choose.
 */
const SCROLL_SHARE = 0.75;

/** The step named when the session captured no screen at all: it never reached one. */
const NO_SCREEN_STEP = 'start';

/** The kinds the browser driver performs. The other three are the agent's, not the page's. */
const PAGE_OPERATIONS = new Set<DecisionActionKind>(['click', 'scroll', 'backtrack']);

/**
 * The session's action vocabulary, as `packages/contract` closes it, per decision kind.
 *
 * Two of the six are spelt differently either side of the seam, and this table is where
 * that is written down. A `read` and a `hesitate` are both the agent staying on the screen
 * without operating anything, which the contract has one word for; the screen's
 * `decidedAction` keeps the agent's own word, so nothing a person reads is merged.
 */
const ACTION_TYPES = {
  click: 'click',
  scroll: 'scroll',
  read: 'hesitate',
  hesitate: 'hesitate',
  backtrack: 'back',
  abandon: 'abandon',
} as const satisfies Record<DecisionActionKind, Session['actions'][number]['type']>;

const quoted = (label: string | null): string => (label === null ? 'the screen' : `“${label}”`);

/** What the replay's screen card says the agent did, in the agent's own six words. */
const decidedActionText = (kind: DecisionActionKind, label: string | null): string => {
  switch (kind) {
    case 'click':
      return `clicked ${quoted(label)}`;
    case 'read':
      return `read ${quoted(label)}`;
    case 'scroll':
      return 'scrolled down the page';
    case 'backtrack':
      return 'went back';
    case 'hesitate':
      return 'hesitated';
    case 'abandon':
      return 'gave up and left';
  }
};

/**
 * The screen's own random stream, derived from the session's seed and the screen's position.
 *
 * The seed alone would hand every screen the same sequence of draws, so two readings of one
 * page would differ only by the history behind them. Mixed with the golden-ratio constant,
 * and kept inside the 32-bit unsigned word that is the whole of `createSeededRandom`'s state.
 */
const screenSeed = (seed: number, screenIndex: number): number =>
  Math.imul(seed + screenIndex + 1, 0x9e37_79b1) >>> 0;

/** The merge key `buildAois` groups elements by: an area's box is one member's box. */
const boxKey = (box: { x: number; y: number; width: number; height: number }): string =>
  [box.x, box.y, box.width, box.height].map((value) => Math.round(value)).join(':');

/**
 * The element behind an area of interest, which is what an action is aimed at.
 *
 * An area carries the box of whichever element spoke for it, so the box is the join; the
 * DOM's entry is preferred over the accessibility tree's because it is the one that carries
 * a selector. A segmented region explains no element and has none, which is why the areas a
 * run segments cannot be clicked.
 */
const elementBehind = (aoi: Aoi, capture: Capture): CaptureElement | undefined => {
  const key = boxKey(aoi.bbox);
  const members = capture.elements.filter((element) => boxKey(element.bbox) === key);
  return members.find((element) => element.source === 'dom') ?? members[0];
};

/**
 * A captured screen as the attention engine reads one.
 *
 * The two packages describe the same screen and spell two fields differently, and this is
 * the only place that is bridged. The browser reports an element with no accessible name
 * and no visible text as `null` — a measurement that was taken and found nothing — while the
 * engine's relevance reads words and takes the empty string for no words at all. The step
 * and the screenshot are the caller's, because the engine's screen is one the task
 * recognised and one that has an image, and this loop has already established both.
 */
const asEngineCapture = (capture: Capture, step: string, screenshot: string): EngineCapture => ({
  step,
  screenshot,
  viewport: capture.viewport,
  pageHeight: capture.pageHeight,
  foldY: capture.foldY,
  elements: capture.elements.map((element) => ({
    id: element.id,
    source: element.source,
    role: element.role,
    name: element.name ?? '',
    text: element.text ?? '',
    bbox: element.bbox,
    isPrimaryAction: element.isPrimaryAction,
    belowFold: element.belowFold,
    selector: element.selector,
  })),
});

/** One decision kind, as the one page operation it is, or `null` when it resolves to none. */
const pageAction = (kind: DecisionActionKind, aoi: Aoi | null, capture: Capture): Action | null => {
  if (kind === 'backtrack') return { type: 'back' };
  if (kind === 'scroll') {
    return { type: 'scroll', deltaY: Math.round(capture.viewport.height * SCROLL_SHARE) };
  }
  if (aoi === null) return null;
  const element = elementBehind(aoi, capture);
  return element === undefined ? null : { type: 'click', elementId: element.id };
};

/**
 * What the agent looked at on this screen, and nothing else.
 *
 * One entry per area a fixation of this screen landed in, in the areas' own reading order,
 * carrying what a person who looked at it would have taken in and what the agent's own eyes
 * did. No selector, no box, no below-the-fold flag and no unfixated area: the knowledge
 * boundary `DecisionContext` declares is enforced here, where the context is built.
 */
const fixatedElementsOf = (
  aois: readonly Aoi[],
  fixations: readonly SampledFixation[],
  capture: Capture,
): FixatedElement[] => {
  const looks = new Map<string, { count: number; dwellMs: number }>();
  for (const fixation of fixations) {
    if (fixation.aoiId === null) continue;
    const seen = looks.get(fixation.aoiId) ?? { count: 0, dwellMs: 0 };
    looks.set(fixation.aoiId, {
      count: seen.count + 1,
      dwellMs: seen.dwellMs + fixation.durationMs,
    });
  }

  const elements: FixatedElement[] = [];
  for (const aoi of aois) {
    const looked = looks.get(aoi.id);
    if (looked === undefined) continue;
    const visible = elementBehind(aoi, capture)?.text?.trim();
    const text = visible === undefined || visible === '' ? aoi.label : visible;
    elements.push({
      id: aoi.id,
      role: aoi.role,
      text,
      ...(aoi.label === text ? {} : { name: aoi.label }),
      fixationCount: looked.count,
      dwellMs: looked.dwellMs,
    });
  }
  return elements;
};

/**
 * Whether the action did what the agent expected, which is what both sides of this loop
 * mean by `ok` — `decideOutcome`'s `TraceAction` and the decision layer's `PastAction`
 * both spell it "a click that advanced, a scroll that revealed".
 *
 * It is **not** `ActResult.ok`, which is the driver saying nothing of *ours* broke. A click
 * on a product name that the page does nothing with is a perfectly executed action that got
 * the agent nowhere, and the two readings pull opposite ways: recorded as a success it
 * resets the give-up budgets, so a person clicking the same useless thing twenty times
 * never runs out of patience and every session ends at the screen cap instead of in
 * character. The driver's own `ok` is kept where it belongs — a `false` there ends the
 * session as our breakage.
 *
 * Getting somewhere is the page becoming something else, in the two ways the driver reports:
 * the step it is on, and where it is scrolled to. A page that changed in place without
 * changing either — an accordion opening — is read as having got the agent nowhere, which is
 * the conservative reading and the only one the driver's answer supports.
 */
const gotSomewhere = (acted: ActResult, step: string, scrollY: number): boolean =>
  acted.step !== step || acted.scrollY !== scrollY;

/**
 * The one driver refusal that is the agent's doing and not our breakage: a `back` from a
 * screen with nothing behind it.
 *
 * The driver is right to refuse it — `act` calls a back that leaves the page where it was or
 * off the product entirely a `navigation_error`, and on the session's first page that is
 * what going back does. But an agent choosing to leave the way it came is the agent walking
 * off the task, not our browsing breaking, and `docs/FLOW.md` section 8 keeps those apart:
 * an automation failure is excluded from every score, and excluding a session because the
 * person in it pressed Back would be the simulation blaming itself for the person.
 *
 * So it is recorded as an action that got the agent nowhere and the session carries on from
 * the screen it is still on. Every other refusal, and a `navigation_error` on any other
 * kind, stays ours.
 */
const wentBackFromTheStart = (kind: DecisionActionKind, acted: ActResult): boolean =>
  kind === 'backtrack' && acted.failure === 'navigation_error';

/** A failure of our own, in the shape `decideOutcome` reads it. */
const ourBreakage = (error: unknown, attempting: string, step: string): AutomationFailure => {
  const failure = toAutomationFailure(error, attempting);
  // Not ours to classify, so not ours to record as ours: the caller sees what happened.
  if (failure === null) throw error;
  return { kind: failure.reason, detail: failure.message, step };
};

export const runSession = async (input: RunSessionInput): Promise<Session> => {
  const { persona, seed, task, variant } = input;
  const provider = input.providers.decision;
  const budget = input.budget ?? new SessionBudget();
  const maxScreens = input.maxScreens ?? SCREENS_PER_STEP * Math.max(1, task.steps.length);
  const finalStepId = task.steps.at(-1)?.id ?? null;
  const goal = { text: task.prompt };
  const ctx: CaptureContext = {
    variant: variant.id,
    device: persona.device,
    task,
    runDir: input.runDir,
  };

  const screens: Session['screens'] = [];
  const fixations: SampledFixation[] = [];
  const saccades: SampledSaccade[] = [];
  const actions: Session['actions'] = [];
  const history: PastAction[] = [];

  let scrollY = 0;
  let clockMs = 0;
  let completed = false;
  let primaryActionAoiId: string | null = null;
  let failure: AutomationFailure | null = null;

  const decider = provider.beginSession({ personaId: persona.id, seed });
  const stepNow = (): string => screens.at(-1)?.step ?? NO_SCREEN_STEP;

  /** One action of the agent's, in the contract's closed vocabulary. */
  const record = (
    kind: DecisionActionKind,
    aoi: Aoi | null,
    ok: boolean,
    value: string | null = null,
  ): void => {
    actions.push({
      tMs: clockMs,
      type: ACTION_TYPES[kind],
      target: kind === 'scroll' ? 'window' : (aoi?.label ?? null),
      aoiId: kind === 'scroll' ? null : (aoi?.id ?? null),
      value,
      ok,
    });
  };

  const page = await open(input, budget);
  if (page.handle === null) failure = page.failure;

  try {
    for (
      let screenIndex = 0;
      page.handle !== null && failure === null && screenIndex < maxScreens;
      screenIndex += 1
    ) {
      const handle = page.handle;
      const capturing = `capturing screen ${screenIndex + 1}`;
      let capture: Capture;
      try {
        capture = await budget.attempt(() => input.source.capture(handle, ctx), capturing);
      } catch (error) {
        failure = ourBreakage(error, capturing, stepNow());
        break;
      }
      if (capture.step === null) {
        failure = {
          kind: 'selector_not_found',
          detail: `the screen the ${stepNow()} step led to is on no step of the ${task.id} task`,
          step: stepNow(),
        };
        break;
      }
      const step = capture.step;
      const screenshot = capture.screenshot ?? runPaths('').screenshot(variant.id, step);

      const aois = await buildAois({
        capture: asEngineCapture(capture, step, screenshot),
        variant: variant.id,
        segmenter: input.segmenter ?? noSegmenter,
      });
      const scan = sampleFixations({
        aois,
        goal,
        persona: persona.traits,
        history: fixations,
        seed: screenSeed(seed, screenIndex),
        weights: input.weights,
        screenIndex,
        scrollY,
      });
      fixations.push(...scan.fixations);
      saccades.push(...scan.saccades);
      const lastLook = scan.fixations.at(-1);
      if (lastLook !== undefined) clockMs = lastLook.tMs + lastLook.durationMs;

      const declared = taskStep(task, step);
      const context: DecisionContext = {
        goal,
        traits: persona.traits,
        step: {
          id: step,
          index: screenIndex,
          ...(declared === null ? {} : { label: declared.label }),
        },
        fixatedElements: fixatedElementsOf(aois, scan.fixations, capture),
        // A copy: the running list goes on growing, and a provider that kept the one it was
        // handed would find this screen's context holding actions taken after it.
        history: [...history],
        ...(provider.readsImages ? { screenshot: { path: screenshot } } : {}),
      };

      const decision = await decider.decide(context);
      const kind = decision.action.kind;
      const aoi = aois.find((area) => area.id === decision.action.targetElementId) ?? null;
      // The control that advances the step the session is on: what a reader of the outcome
      // wants to know whether the agent ever looked at.
      primaryActionAoiId = aois.find((area) => area.isPrimaryAction)?.id ?? primaryActionAoiId;
      completed = step === finalStepId;

      screens.push({
        index: screenIndex,
        step,
        screenshot,
        scrollY,
        intent: decision.intent,
        decidedAction: decidedActionText(kind, aoi?.label ?? null),
      });

      let executed: ActResult | null = null;
      const violations = validateDecision(context, decision);
      if (violations.length > 0) {
        // A decision the interface rejects leaves the session with nothing it is allowed to
        // act on, which is our decision layer breaking and never the product's fault. It is
        // recorded as a target that could not be resolved, because that is what it is.
        failure = {
          kind: 'selector_not_found',
          detail: `the decision on the ${step} step is not one this interface accepts (${violations.join('; ')})`,
          step,
        };
      } else if (kind === 'abandon') {
        record(kind, null, true);
        history.push({ step, kind, targetElementId: null, ok: true });
      } else if (completed) {
        // The task's last step: the agent is asked what it makes of the screen it arrived on
        // and the walk ends there. Executing that decision would drive the session off the
        // task it was given — the task declares no step after this one to walk to.
      } else if (!PAGE_OPERATIONS.has(kind)) {
        record(kind, aoi, true);
        history.push({ step, kind, targetElementId: decision.action.targetElementId, ok: true });
      } else {
        try {
          executed = await execute(input, budget, handle, ctx, kind, aoi, capture);
        } catch (error) {
          record(kind, aoi, false);
          failure = ourBreakage(error, `acting on the ${step} screen`, step);
        }
        if (failure !== null) {
          // Nothing more to record: the driver threw and the attempt is already on the trace.
        } else if (executed === null) {
          record(kind, aoi, false);
          history.push({ step, kind, targetElementId: decision.action.targetElementId, ok: false });
          failure = {
            kind: 'selector_not_found',
            detail: `nothing on the ${step} screen carries the area of interest the agent aimed at`,
            step,
          };
        } else {
          const worked = executed.ok && gotSomewhere(executed, step, scrollY);
          scrollY = executed.scrollY;
          record(kind, aoi, worked, kind === 'scroll' ? String(executed.scrollY) : null);
          history.push({
            step,
            kind,
            targetElementId: decision.action.targetElementId,
            ok: worked,
          });
          if (!executed.ok && !wentBackFromTheStart(kind, executed)) {
            failure = {
              kind: executed.failure ?? 'timeout',
              detail: `the ${kind} on the ${step} step did not work (${executed.failure ?? 'no reason given'})`,
              step,
            };
          }
        }
      }

      input.onScreen?.({ index: screenIndex, step, capture, aois, decision, executed });
      if (failure !== null || completed || kind === 'abandon') break;
    }
  } finally {
    await decider.close().catch(() => undefined);
    // A browser that will not close is a leaked process, not a session that did not happen:
    // the session has its answer, and throwing here would throw that answer away.
    if (page.handle !== null) await input.source.close(page.handle).catch(() => undefined);
  }

  const durationMs = Math.max(clockMs, actions.at(-1)?.tMs ?? 0);
  const trace: SessionTrace = {
    screens: screens.map((screen) => ({ index: screen.index, step: screen.step })),
    fixations,
    actions: actions.map((action) => ({
      tMs: action.tMs,
      type: action.type,
      aoiId: action.aoiId,
      ok: action.ok,
    })),
    durationMs,
    taskCompleted: completed,
    primaryActionAoiId,
    automationFailure: failure,
    // Deliberately `null`. `durationMs` is the session's own clock — the time the agent
    // spent looking — while the budget's cap is wall-clock time in this process. Comparing
    // the two would call a session that took forty seconds of simulated reading and fifty
    // milliseconds of real time a wall-clock failure of ours. The real cap is the budget's,
    // and it arrives here as a typed failure like any other.
    wallClockBudgetMs: null,
  };

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: input.sessionId,
    runId: input.runId,
    variant: variant.id,
    taskId: task.id,
    kind: 'simulated',
    persona: { id: persona.id, traits: persona.traits, device: persona.device },
    participant: null,
    seed,
    startedAt: input.startedAt ?? new Date().toISOString(),
    durationMs,
    screens,
    fixations,
    saccades,
    actions,
    outcome: decideOutcome(trace, persona, input.outcomePolicy),
    integrity: budget.sessionIntegrity(),
  };

  await writeSession(input.runDir, session);
  return session;
};

/** What the open produced: the handle, or our own breakage in place of one. */
type OpenedPage =
  | { readonly handle: PageHandle; readonly failure: null }
  | { readonly handle: null; readonly failure: AutomationFailure };

const open = async (input: RunSessionInput, budget: SessionBudget): Promise<OpenedPage> => {
  const attempting = `opening ${input.variant.url}`;
  // The open in flight, kept so that a session which arrives after the budget has given up
  // on it is still closed: a browser nobody holds is a process that never goes away.
  const started = { inFlight: null as Promise<PageHandle> | null };
  try {
    const handle = await budget.attempt(() => {
      started.inFlight = input.source.openSession(input.variant, input.persona.device);
      return started.inFlight;
    }, attempting);
    return { handle, failure: null };
  } catch (error) {
    // Not awaited: waiting for an abandoned open would hold the session past the cap that
    // abandoned it, which is the one thing a cap exists to prevent.
    void started.inFlight?.then((handle) => input.source.close(handle)).catch(() => undefined);
    // Nothing of the task was reached, so there is no step this broke on.
    return { handle: null, failure: ourBreakage(error, attempting, NO_SCREEN_STEP) };
  }
};

/**
 * One page operation, under the session's budget. `null` says the decision resolved to no
 * operation at all — an area with no element behind it — which is a target that was never
 * acted on rather than an action that failed on the page.
 */
const execute = async (
  input: RunSessionInput,
  budget: SessionBudget,
  handle: PageHandle,
  ctx: CaptureContext,
  kind: DecisionActionKind,
  aoi: Aoi | null,
  capture: Capture,
): Promise<ActResult | null> => {
  const action = pageAction(kind, aoi, capture);
  if (action === null) return null;
  // The capture travels with the action, so the id the agent chose resolves against the
  // screen it was chosen on rather than against the page as it is now.
  return budget.attempt(
    () => input.source.act(handle, action, ctx, { screen: capture }),
    `acting on the ${capture.step} screen`,
  );
};
