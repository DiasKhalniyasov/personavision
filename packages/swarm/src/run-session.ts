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
 * **Every model call of the session is written down as it happens.** The decision layer is
 * handed an append-only `trajectories/S-NN.jsonl` under the run directory for the length of
 * the session, so a run is auditable and replayable from its own files (#139).
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
 * module hands it facts — the screens, the fixations, the actions, what the run's success
 * criterion was and whether this session saw it, and whether our own browsing broke — and
 * reads nothing back out of them.
 *
 * **The walk ends where the task says it ends, and a goal says so differently.** A task
 * carrying a `successCriterion` is done when that criterion is **observed** on a screen this
 * session captured (`criterion.ts`, #400); a task carrying none is done at its last declared
 * step. The difference matters because a one-URL run derives a single step that the page
 * matches the moment it loads: under the step rule every such session was finished before it
 * had done anything.
 *
 * **The session names its own recording, and where it is in it.** A session opens asking to
 * be recorded as `videos/S-NN.webm`, and the recording is what knows both clocks: this loop
 * marks where each screen it keeps was captured and where each action it records happened,
 * so the offsets the session JSON carries are **measured against the recording** rather than
 * inferred from `startedAt` and a duration — which is what lets a recommendation citing
 * `S-62 · 0:48` open on the frame it means. A source that opens no browser has nothing to
 * record and the session carries no video at all; a recording that failed is carried as
 * absent with its reason, and the session is otherwise complete and scored like any other.
 *
 * **The same persona, seed and page produce the same session.** Every draw is seeded from
 * the session's seed and the screen's position; the two values that are not derived are
 * `startedAt`, which is the wall clock and is therefore an input, and the recording — its
 * bytes and its wall-clock offsets, which are what a real browser took.
 *
 * What it does not carry: the run's own index, counters and totals (#49 appends those as
 * each session lands), and the trajectory sink (#139 opens one around the decider).
 */

import {
  discardRecording,
  SessionBudget,
  taskStep,
  toAutomationFailure,
  viewScreenshotPath,
} from '@personavision/browser';
import { runPaths, SCHEMA_VERSION, writeSession } from '@personavision/contract';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildAois,
  fixationDurationMedianMsFor,
  noSegmenter,
  sampleFixations,
  saccadeDurationMsFor,
} from '@personavision/engine';
import { openTrajectoryFile, validateDecision } from '@personavision/provider';
import { criterionToObserve, observeCriterion } from './criterion.js';
import { decideOutcome } from './outcome.js';
import type {
  ActResult,
  Action,
  Capture,
  CaptureContext,
  CaptureElement,
  CaptureSource,
  PageHandle,
  SessionRecording,
  TaskDefinition,
  Variant,
} from '@personavision/browser';
import type { Persona, Session, SessionVideo } from '@personavision/contract';
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
  Goal,
  PastAction,
  ScreenElement,
} from '@personavision/provider';
import type { CriterionSighting } from './criterion.js';
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
  /** `null` when the decision layer answered with nothing this screen could act on. */
  readonly decision: Decision | null;
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

/**
 * What the screen card says when the decision layer gave the session nothing it could use —
 * a reply that never arrived, or one the interface rejected. The screen is still recorded,
 * because its fixations are, and a screen left out would leave them pointing past the end.
 */
const NO_USABLE_DECISION = 'no decision this screen could act on';

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
 * Source precedence, then the element id — the order `buildAois` merges a group in.
 *
 * It is spelt again here rather than imported because it is the other half of the same
 * join: the builder picks which member speaks for an area, and this picks which member an
 * action is aimed at, and the two have to agree. Without the ordering the answer would come
 * from wherever the capture happened to list its elements, which the builder goes out of
 * its way to keep out of its own output, and a session would stop being a fact about the
 * page.
 */
const SOURCE_PRECEDENCE: readonly CaptureElement['source'][] = ['dom', 'a11y'];

const bySourceThenId = (left: CaptureElement, right: CaptureElement): number =>
  SOURCE_PRECEDENCE.indexOf(left.source) - SOURCE_PRECEDENCE.indexOf(right.source) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * The element behind an area of interest, which is what an action is aimed at.
 *
 * An area carries the box of whichever element spoke for it, so the box is the join; the
 * DOM's entry wins because it is the one that carries a selector. A segmented region
 * explains no element and has none — the agent can look at a card grid nobody could name,
 * and there is nothing underneath it to operate.
 */
const elementBehind = (aoi: Aoi, capture: Capture): CaptureElement | undefined => {
  const key = boxKey(aoi.bbox);
  return capture.elements.filter((element) => boxKey(element.bbox) === key).sort(bySourceThenId)[0];
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
    // The page's own name for this region, where it declared one: it is what the engine
    // mints an area's id from, so dropping it here would hand the engine a capture that
    // looks uninstrumented and split one control's dwell across the two viewports.
    region: element.region ?? null,
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
/** Every area on the screen as the agent can name it: what a screenshot-reading agent may act on. */
const screenElementsOf = (aois: readonly Aoi[], capture: Capture): ScreenElement[] =>
  aois.map((aoi) => {
    const visible = elementBehind(aoi, capture)?.text?.trim();
    const text = visible === undefined || visible === '' ? aoi.label : visible;
    return { id: aoi.id, role: aoi.role, text, ...(aoi.label === text ? {} : { name: aoi.label }) };
  });

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
 * off the product entirely a `navigation_error`, and with nothing behind it that is what
 * going back does. But an agent choosing to leave the way it came is the agent walking off
 * the task, not our browsing breaking, and `docs/FLOW.md` section 8 keeps those apart: an
 * automation failure is excluded from every score, and excluding a session because the
 * person in it pressed Back would be the simulation blaming itself for the person.
 *
 * `depth` is how far into the walk the session has got: one per step it advanced, less one
 * per back that landed, so zero means there is nowhere behind it to go. A back refused at
 * any other depth is a navigation that genuinely failed and stays ours — otherwise a reset
 * connection would be written up as a product outcome and counted towards the scores.
 *
 * Refused at depth zero, it is recorded as an action that got the agent nowhere and the
 * session carries on from the screen it is still on.
 */
const wentBackFromTheStart = (kind: DecisionActionKind, acted: ActResult, depth: number): boolean =>
  kind === 'backtrack' && acted.failure === 'navigation_error' && depth === 0;

/**
 * The areas of a screen the agent could actually see: those whose box overlaps the band the
 * viewport shows at this scroll offset.
 *
 * Overlap rather than containment — an area straddling the bottom edge is partly on screen
 * and can be looked at — and the band is in page space, as every box in a capture is.
 *
 * A screen where that leaves nothing falls back to the whole screen: a screen with no
 * fixations at all would claim the agent never looked, which is a stranger thing to record
 * than a page whose boxes disagree with its own scroll offset.
 */
const onScreen = (
  aois: readonly Aoi[],
  scrollY: number,
  viewportHeight: number,
): readonly Aoi[] => {
  const visible = aois.filter(
    (area) => area.bbox.y + area.bbox.height > scrollY && area.bbox.y < scrollY + viewportHeight,
  );
  return visible.length > 0 ? visible : aois;
};

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
  /**
   * Whether the walk ends when the task's last step is reached, whatever the criterion says.
   *
   * **A declared multi-step task says where its end is** (`docs/FLOW.md` section 12): its
   * last step is the end of the errand, and walking past it would drive the session off the
   * task it was given — onto a page the task recognises as no step, which this loop can only
   * record as our own breakage. A task declaring **one** step says nothing of the kind: a
   * one-URL run derives that single step from the URL it was handed, and the page matches it
   * on load, so stopping there is stopping before anything has happened — which is the whole
   * of #400.
   *
   * Reaching the end is not the same as having done the task. On a run with a goal the
   * criterion still decides that; this only decides where the walk stops.
   */
  const walkEndsAtFinalStep = task.steps.length > 1;
  /**
   * What the run said counts as having done the task, read once before the walk — `null` on
   * a run with no goal, where the final declared step is the end of the task (#400).
   *
   * A criterion is checked against what this session captures and nothing else, so reading
   * it opens no browser and makes no call: the same rule holds live, on a replayed capture
   * set and on the offline engine.
   */
  const criterion = criterionToObserve(task.successCriterion);
  /**
   * What the agent is trying to do on the screen it is on: the step's own goal where the
   * task declares one, and the whole prompt where it does not.
   *
   * Both the attention engine and the decision layer read it lexically, so handing the
   * whole errand to every screen makes a conventional next-step control — "Checkout",
   * which shares no word with "Buy the hiking boots and pay with the saved card" — rank
   * below the page's copy, and no session gets past the first step (#78). The step goal
   * names no element and no selector: it narrows what the person wants here, not what the
   * page offers.
   */
  const goalOn = (stepId: string): Goal => ({
    text: taskStep(task, stepId)?.goal ?? task.prompt,
  });
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

  /**
   * The session's recording — `of` — bound once the browser has opened one, and what it came
   * to — `video`, the file and its offsets or the stated absence of one.
   *
   * `of` is `undefined` on a source that opens no browser: a run directory replayed from disk
   * has nothing to record, which is what leaves a fixture-mode session carrying no video at
   * all rather than an absence it would have to explain. Both are held on an object rather
   * than in variables because the marks below are made from a closure, and what a closure
   * assigns is not what the compiler reads afterwards.
   */
  const recorded: { of?: SessionRecording; video?: SessionVideo } = {};

  let scrollY = 0;
  let clockMs = 0;
  let completed = false;
  /** Whether the walk reached the task's last declared step: the step rule, as a fact. */
  let reachedFinalStep = false;
  /**
   * Where the session is, and what the last screen showed of the criterion.
   *
   * A capture records the page's elements and not its address, so the address is carried
   * along the walk: the variant's URL to begin with, and whatever the driver reports the
   * page became after each action. It is what a criterion `readCriterion` called a URL is
   * read against.
   */
  let url = variant.url;
  let lastSighting: CriterionSighting | null = null;
  let primaryActionAoiId: string | null = null;
  let failure: AutomationFailure | null = null;
  /**
   * Whether our own action budget is what ended the walk: set on the last screen it allows,
   * and never on a failure, the end of the walk or the agent's own `abandon`, each of which
   * leaves the loop before it. `decideOutcome` reads it off the trace below (#413).
   */
  let stoppedOnBudget = false;
  /** How far into the walk the session has got: what a back has behind it to return to. */
  let depth = 0;
  /** Targets the driver reported it could not resolve, which it answers with rather than throws. */
  let reportedSelectorFailures = 0;

  // The session's trajectory: opened here because the file is named from the session id,
  // which belongs to the run and not to the provider, and closed in the `finally` below once
  // the handle has let go of its last turn. Nothing is created until a record arrives, so a
  // session on the offline provider — which makes no model call — leaves no file at all (#139).
  const trajectory = openTrajectoryFile({ runDir: input.runDir, sessionId: input.sessionId });
  const decider = provider.beginSession(
    { personaId: persona.id, seed },
    { trajectory: trajectory.sink },
  );
  const stepNow = (): string => screens.at(-1)?.step ?? NO_SCREEN_STEP;

  /**
   * One action of the agent's, in the contract's closed vocabulary.
   *
   * `atMs` is where it is in the recording, measured by the caller **before** the page was
   * operated: a click waits out the navigation it causes, so the moment the driver comes back
   * is the frame after the next screen has loaded and not the frame the click happened on. An
   * action the agent took without operating anything — a read, a hesitation, giving up —
   * happens where the decision did, which is now.
   */
  const record = (
    kind: DecisionActionKind,
    aoi: Aoi | null,
    ok: boolean,
    value: string | null = null,
    atMs?: number,
  ): void => {
    actions.push({
      tMs: clockMs,
      type: ACTION_TYPES[kind],
      target: kind === 'scroll' ? 'window' : (aoi?.label ?? null),
      aoiId: kind === 'scroll' ? null : (aoi?.id ?? null),
      value,
      ok,
    });
    // Marked here because this is the one place an action is recorded: an offset list has to
    // be exactly as long as the array it indexes, and the contract rejects a session whose
    // two disagree.
    recorded.of?.action(atMs);
  };

  const page = await open(input, budget);
  if (page.handle === null) failure = page.failure;
  recorded.of = page.handle?.video;

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
      // Where this screen is in the recording, measured now and marked when the screen is
      // kept: what follows is a model call that can take seconds, and a screen's offset is
      // where it was captured and not where the answer about it arrived.
      const capturedAtMs = recorded.of?.at();
      const step = capture.step;
      const screenshot = capture.screenshot ?? runPaths('').screenshot(variant.id, step);

      const goal = goalOn(step);
      const aois = await buildAois({
        capture: asEngineCapture(capture, step, screenshot),
        variant: variant.id,
        segmenter: input.segmenter ?? noSegmenter,
      });
      // A model that sees the screenshot reports its own looks (owner decision, 2026-10-28):
      // nothing is sampled for it, and its looks become this screen's fixations below.
      const modelGaze = provider.readsImages === true;
      const scan = modelGaze
        ? { fixations: [], saccades: [] }
        : sampleFixations({
            // Only what is on the agent's screen. The sampler draws over the areas it is handed
            // and takes no viewport, so this is where the page's own extent becomes a limit on
            // where a look can land: handed every area of the page it puts fixations on content
            // three screens down, and a control below the fold is then "looked at" without
            // anybody having scrolled to it — which makes the defect the demo leads with
            // undiscoverable (#78; `docs/FLOW.md` section 8: a control below the fold is a
            // finding waiting to happen).
            //
            // The run's own `aois` stay the whole screen's, so an area nobody could see is still
            // declared and still carries its honest zero in `aoiMetrics` rather than going
            // missing from the artifact.
            aois: onScreen(aois, scrollY, capture.viewport.height),
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
        task: { text: task.prompt },
        traits: persona.traits,
        ...(persona.profile === undefined ? {} : { profile: persona.profile }),
        step: {
          id: step,
          index: screenIndex,
          ...(declared === null ? {} : { label: declared.label }),
        },
        fixatedElements: fixatedElementsOf(aois, scan.fixations, capture),
        // A copy: the running list goes on growing, and a provider that kept the one it was
        // handed would find this screen's context holding actions taken after it.
        history: [...history],
        ...(provider.readsImages
          ? {
              // The visible screen as captured where there is one; the full page cut to the
              // viewport where there is not (a recorded capture has only the full page).
              screenshot: existsSync(resolve(input.runDir, viewScreenshotPath(screenshot)))
                ? { path: resolve(input.runDir, viewScreenshotPath(screenshot)) }
                : {
                    path: resolve(input.runDir, screenshot),
                    view: {
                      top: scrollY,
                      width: capture.viewport.width,
                      height: capture.viewport.height,
                    },
                  },
              // Only what the screenshot shows: an element left or right of the viewport is
              // one nobody could click, and the model picks it as readily as the real one.
              screenElements: screenElementsOf(
                onScreen(aois, scrollY, capture.viewport.height).filter(
                  (area) =>
                    area.bbox.x < capture.viewport.width && area.bbox.x + area.bbox.width > 0,
                ),
                capture,
              ),
            }
          : {}),
      };

      // The control that advances the step the session is on: what a reader of the outcome
      // wants to know whether the agent ever looked at.
      primaryActionAoiId = aois.find((area) => area.isPrimaryAction)?.id ?? primaryActionAoiId;
      // What the task said counts as having done it, asked of the screen the session is on.
      // A run with a goal is completed by its criterion being **observed** and never by
      // arriving somewhere: a one-URL run derives one step, which the page matches the
      // moment it loads, so the step rule made every such session a success (#400). A run
      // with no goal keeps that rule, because a declared task says where its end is.
      if (criterion !== null) {
        lastSighting = observeCriterion(criterion, { step, url, elements: capture.elements });
      }
      reachedFinalStep = reachedFinalStep || step === finalStepId;
      completed =
        criterion === null ? step === finalStepId : completed || lastSighting?.observed === true;
      // Where the walk stops, which on a run with a goal is not the same question as whether
      // the task was done: a declared multi-step task still ends at its last step even when
      // its criterion was never observed, because the task declares nowhere to go next.
      const endOfWalk = completed || (walkEndsAtFinalStep && step === finalStepId);

      /** One look at an area, after the screen's last one: where the eye went and for how long. */
      const lookAt = (area: Aoi, durationMs: number): SampledFixation => {
        const previous = fixations.at(-1);
        // Clamped to the page: a box a sticky header or an animation puts partly above it
        // has a centre the contract refuses as a place anybody looked.
        const pageX = Math.max(0, area.bbox.x + area.bbox.width / 2);
        const pageY = Math.max(0, area.bbox.y + area.bbox.height / 2);
        const amplitudePx =
          previous === undefined ? 0 : Math.hypot(pageX - previous.pageX, pageY - previous.pageY);
        const gapMs = previous === undefined ? 0 : saccadeDurationMsFor(amplitudePx);
        const look: SampledFixation = {
          index: fixations.length,
          screenIndex,
          tMs: clockMs + gapMs,
          durationMs,
          x: pageX,
          // An area the page has scrolled partly past sits above the viewport: its look, at the top edge.
          y: Math.max(0, pageY - scrollY),
          pageX,
          pageY,
          aoiId: area.id,
        };
        if (previous !== undefined && previous.screenIndex === screenIndex) {
          saccades.push({
            fromFixation: previous.index,
            toFixation: look.index,
            amplitudePx,
            durationMs: gapMs,
          });
        }
        fixations.push(look);
        clockMs = look.tMs + look.durationMs;
        return look;
      };

      let decision: Decision | null = null;
      try {
        decision = await decider.decide(context);
      } catch (error) {
        // The decision layer is the one call in this loop the browser's failure mapping
        // knows nothing about, and it is the one most likely to fail in model mode: a 429
        // or a reset socket on the fourth screen would otherwise throw away every screen,
        // fixation and action the session had collected and write no file at all.
        failure = {
          kind: 'timeout',
          detail: `the decision on the ${step} step never arrived (${(error as Error).message})`,
          step,
        };
      }
      const violations = decision === null ? [] : validateDecision(context, decision);
      // Only a decision the interface accepts may be read: a reply parsed into the wrong
      // shape can carry a kind outside the six words, and the screen's own copy is composed
      // from that kind.
      const usable = decision !== null && violations.length === 0 ? decision : null;
      const kind = usable === null ? null : usable.action.kind;
      const aoi =
        usable === null
          ? null
          : (aois.find((area) => area.id === usable.action.targetElementId) ?? null);

      const seenHere: SampledFixation[] = [...scan.fixations];
      if (modelGaze && usable !== null) {
        for (const seen of usable.looks ?? []) {
          const area = aois.find((candidate) => candidate.id === seen.targetElementId);
          if (area === undefined) continue; // a look at nothing on this screen is not a look
          seenHere.push(lookAt(area, seen.durationMs));
        }
      }

      if (aoi !== null && !seenHere.some((f) => f.aoiId === aoi.id)) {
        seenHere.push(lookAt(aoi, fixationDurationMedianMsFor(persona.traits)));
      }

      // This screen happened whatever the decision layer did with it, and its fixations are
      // already on the session: a screen left out here would leave them pointing past the end.
      screens.push({
        index: screenIndex,
        step,
        screenshot,
        scrollY,
        // The agent's own words, when it managed any. Never ours: an invented intent would
        // be the simulation putting words in the mouth of the person it is reporting on.
        intent: typeof decision?.intent === 'string' ? decision.intent : '',
        decidedAction:
          kind === null ? NO_USABLE_DECISION : decidedActionText(kind, aoi?.label ?? null),
      });
      // A screen captured twice — scroll, then click — is two screens of the session and two
      // offsets, because the agent saw two different things at two moments of the recording.
      recorded.of?.screen(capturedAtMs);

      let executed: ActResult | null = null;
      if (violations.length > 0) {
        // A decision the interface rejects leaves the session with nothing it is allowed to
        // act on, which is our decision layer breaking and never the product's fault. It is
        // recorded as a target that could not be resolved, because that is what it is.
        failure = {
          kind: 'selector_not_found',
          detail: `the decision on the ${step} step is not one this interface accepts (${violations.join('; ')})`,
          step,
        };
      } else if (kind === null) {
        // The decision never arrived; `failure` already says so.
      } else if (kind === 'abandon') {
        record(kind, null, true);
        history.push({ step, kind, targetElementId: null, ok: true });
      } else if (endOfWalk) {
        // The end of the walk: the agent is asked what it makes of the screen it arrived on
        // and the walk ends there. Executing that decision would drive the session off the
        // task it was given — the task declares no step after this one to walk to.
      } else if (!PAGE_OPERATIONS.has(kind)) {
        record(kind, aoi, true);
        history.push({ step, kind, targetElementId: aoi?.id ?? null, ok: true });
      } else {
        const attempted = { step, kind, targetElementId: aoi?.id ?? null };
        const depthBefore = depth;
        // Before the page is operated: what follows waits for the navigation the action
        // causes, and the budget may retry it, so the recording's own clock has moved on by
        // seconds — or past a cap — by the time the driver answers.
        const actedAtMs = recorded.of?.at();
        try {
          executed = await execute(input, budget, handle, ctx, kind, aoi, capture);
        } catch (error) {
          record(kind, aoi, false, null, actedAtMs);
          history.push({ ...attempted, ok: false });
          failure = ourBreakage(error, `acting on the ${step} screen`, step);
        }
        if (executed === null && failure === null) {
          // The agent looked at an area with no control under it — a region a segmenter
          // explained and the DOM did not — and tried to click it. Nothing happened, which
          // is the page's answer and not our breakage: ending the session here would throw
          // away every session in which a persona looked hardest at the part of a page the
          // DOM cannot explain, which is exactly what a segmented run exists to observe.
          record(kind, aoi, false, null, actedAtMs);
          history.push({ ...attempted, ok: false });
        } else if (executed !== null) {
          const worked = executed.ok && gotSomewhere(executed, step, scrollY);
          // Depth counts navigations and not progress: a scroll gets the agent somewhere
          // and puts nothing behind it to go back to.
          if (executed.ok && executed.step !== step) {
            depth = Math.max(0, depth + (kind === 'backtrack' ? -1 : 1));
          }
          scrollY = executed.scrollY;
          // Where the page ended up, which the next screen's criterion is read against.
          url = executed.url;
          record(kind, aoi, worked, kind === 'scroll' ? String(executed.scrollY) : null, actedAtMs);
          history.push({ ...attempted, ok: worked });
          // The driver reports a target it could not resolve rather than throwing one, so
          // the budget's own counter never sees it: the session artifact's `selectorFailures`
          // is the two added together, or the replay's integrity card would read "every
          // action resolved" on the session a selector failure ended.
          if (executed.failure === 'selector_not_found') reportedSelectorFailures += 1;
          if (!executed.ok && !wentBackFromTheStart(kind, executed, depthBefore)) {
            failure = {
              kind: executed.failure ?? 'timeout',
              detail: `the ${kind} on the ${step} step did not work (${executed.failure ?? 'no reason given'})`,
              step,
            };
          }
        }
      }

      input.onScreen?.({ index: screenIndex, step, capture, aois, decision, executed });
      if (failure !== null || endOfWalk || kind === 'abandon') break;
      // Nothing of the session's own has ended it, so the only thing that can is the cap on
      // the next turn of this loop. On the last screen it allows, this is a walk *we*
      // stopped, and the write-up has to say so rather than read a give-up off its last
      // screens (#413).
      stoppedOnBudget = screenIndex + 1 >= maxScreens;
    }
  } finally {
    await decider.close().catch(() => undefined);
    // After the handle, never before it: `close` waits for a turn still in flight, so the
    // trajectory is shut once its last line has been written rather than under it. It is
    // write-through, so this flushes what is already on its way and nothing more — a line
    // that could not be written came back to the provider as a typed failure at the time.
    await trajectory.close();
    // The recording is finished before the browser goes, because finishing is what closes
    // the context, saves the file at the contract's path and measures it. It reports its own
    // failures as an absent recording rather than throwing, and the `catch` is for the
    // impossible one: the session has its answer, and a recording may not cost it.
    recorded.video = await recorded.of?.finish().catch((error: unknown) => ({
      state: 'absent' as const,
      reason: `the recording could not be finished, so this session has none: ${error instanceof Error ? error.message : String(error)}`,
    }));
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
    // The **step rule**, always, which is what `decideOutcome` documents this field as and
    // the only thing it reads it for: a run with no goal is decided by it, and a run with one
    // is decided by `criterion` below. Writing the criterion's answer here as well would
    // leave a reader of a trace unable to say which rule produced the boolean.
    taskCompleted: reachedFinalStep,
    // The criterion as this session read it, where the run had one: what it looked for,
    // whether it saw it, and what the screen it ended on was missing. `decideOutcome` turns
    // that into the status and the words a reader gets; nothing here decides either.
    ...(criterion === null
      ? {}
      : {
          criterion: {
            criterion: criterion.criterion,
            observed: completed,
            unobservable: criterion.unobservable,
            missing: lastSighting?.missing ?? criterion.terms,
          },
        }),
    // Present only where the budget is what ended the walk, and it is the figure the walk
    // ran under: a session stopped at its last allowed screen is not the person giving up,
    // and `decideOutcome` names the budget instead of calling it an abandonment (#413).
    ...(stoppedOnBudget ? { stoppedOnBudget: maxScreens } : {}),
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
    integrity: {
      ...budget.sessionIntegrity(),
      selectorFailures: budget.sessionIntegrity().selectorFailures + reportedSelectorFailures,
    },
    // Absent when nothing was recording: a session nobody could record names no video at
    // all, which is the contract's difference between a session that recorded none and one
    // that lost one. A recording that failed is here, with its reason in words.
    ...(recorded.video === undefined ? {} : { video: recorded.video }),
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
      started.inFlight = input.source.openSession(input.variant, input.persona.device, {
        // The session's own recording, named by the session it belongs to: one source drives
        // every session of a run and one file cannot be two sessions. A source that opens no
        // browser has nothing to record and ignores it.
        // `runId` is said rather than taken from the directory: a remote task's run
        // directory is a scratch directory of its own, and a recording filed under that
        // name is an object nothing could read back (`@personavision/browser`).
        video: { runDir: input.runDir, runId: input.runId, sessionId: input.sessionId },
      });
      return started.inFlight;
    }, attempting);
    return { handle, failure: null };
  } catch (error) {
    // Not awaited: waiting for an abandoned open would hold the session past the cap that
    // abandoned it, which is the one thing a cap exists to prevent.
    void started.inFlight
      ?.then(async (handle) => {
        // The recording of a session nobody is waiting for is finished and then removed.
        // Finished, because closing the browser on an unfinished recording leaves the file
        // under the name Playwright chose (`session.ts`) — an orphan in `videos/` that no
        // session names; removed, because this session is written up as having no video, and
        // a file at its own path would say otherwise.
        const abandoned = await handle.video?.finish().catch(() => undefined);
        if (abandoned?.state === 'recorded') {
          // Wherever `finish()` put it: the run directory, or the object store one variable
          // selects, which is where the bytes are when a bucket is configured.
          await discardRecording({
            runDir: input.runDir,
            runId: input.runId,
            sessionId: input.sessionId,
          });
        }
        await input.source.close(handle);
      })
      .catch(() => undefined);
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
