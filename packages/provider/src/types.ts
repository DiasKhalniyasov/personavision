/**
 * The decision layer's one interface, and the shapes either side of it.
 *
 * Every provider — the offline deterministic policy here, the Meta Model API provider
 * (#43), anything added later — implements `DecisionProvider` and nothing else. The four
 * rules this file exists to hold are:
 *
 * 1. **The context carries only what the agent could know.** Its goal, its traits, the
 *    step it is on, the elements it has fixated on *this screen* with their text and
 *    roles, its own action history, and the screenshot when the provider can read images.
 *    There is no full DOM dump, no selector, no geometry and no path to an element the
 *    agent never looked at — so no provider can act on one.
 * 2. **A decision is the agent's intent in its own words plus exactly one action.** Click,
 *    scroll, read, hesitate, backtrack or abandon, with that action's target. Not two
 *    actions, not none.
 * 3. **Every decision reports what the call cost**, including the cached-input and
 *    reasoning figures the owner's model mode bills (`muse-spark-1.3`, #43) — zero
 *    throughout for a provider that costs nothing. The swarm adds them up per run (#32).
 * 4. **What belongs to one agent session lives on that session's handle**, not in the
 *    context. `beginSession({ personaId, seed })` hands back the decider for one session,
 *    and a conversation, a cache key or a trajectory file is kept there — so none of the
 *    three has to become a field of `DecisionContext` and widen what every provider may
 *    act on (#138).
 *
 * The types the agent's world is made of — the element, the traits — are declared here
 * structurally, field-for-field as `packages/browser` and `packages/contract` spell them,
 * exactly as `packages/engine` declares its own: a capture element or a contract persona
 * therefore satisfies them with no adapter, and nothing in this package imports either.
 */

import type { RunUsage } from '@personavision/contract';

/** Which decision layer ran, as `run.json`'s `engine.mode` records it. */
export type ProviderMode = 'offline' | 'model';

/**
 * The agent's current goal, as the swarm hands it over. Only the text: the task prompt is
 * all the agent has been told to do.
 */
export interface Goal {
  readonly text: string;
}

/**
 * The persona's behaviour traits, each on `[0, 1]`, as `packages/contract`'s
 * `personaSchema` spells them.
 */
export interface PersonaTraits {
  readonly persistence: number;
  readonly scanningVsReading: number;
  readonly detailOrientation: number;
  readonly interfaceFamiliarity: number;
  readonly patience: number;
  readonly riskTolerance: number;
}

/**
 * One element the agent has **looked at** on this screen — the only elements a decision
 * may target.
 *
 * It carries what a person who looked at it would have taken in (its words, what kind of
 * control it is) and what the agent's own eyes did (how often it landed, how long it
 * stayed). It deliberately carries no selector, no bounding box, no `isPrimaryAction` and
 * no below-the-fold flag: a selector would let a provider act on the page rather than on
 * what it saw, and the rest is the task's or the page's knowledge, not the agent's.
 */
export interface FixatedElement {
  /** Stable across sessions on the same variant and step, as the capture assigns it. */
  readonly id: string;
  /** The ARIA or DOM role, `null` when the element has none. */
  readonly role: string | null;
  /** The visible text, which is not always the accessible name. */
  readonly text: string;
  /** The accessible name, when the capture has one that differs from the text. */
  readonly name?: string;
  /** How many fixations landed on it on this screen. At least one, or it is not here. */
  readonly fixationCount: number;
  /** Total dwell on it on this screen, in milliseconds. */
  readonly dwellMs: number;
}

/** The step of the task the agent is on, as `run.json`'s `steps[]` spells it. */
export interface DecisionStep {
  readonly id: string;
  /** Which screen of this session it is, counted from 0. */
  readonly index: number;
  /** The step's human label, when the run carries one. */
  readonly label?: string;
}

/** The six things an agent can decide to do. Exactly one of them per screen. */
export const DECISION_ACTION_KINDS = [
  'click',
  'scroll',
  'read',
  'hesitate',
  'backtrack',
  'abandon',
] as const;

export type DecisionActionKind = (typeof DECISION_ACTION_KINDS)[number];

/**
 * One action, with its target.
 *
 * `targetElementId` names a `FixatedElement` of the same context, or is `null` when the
 * action is not aimed at an element — a scroll down the page, a pause, a step back, giving
 * up. `validateDecision` holds every provider to that.
 */
export interface DecisionAction {
  readonly kind: DecisionActionKind;
  readonly targetElementId: string | null;
}

/** One action the agent already took, in the order it took them. */
export interface PastAction {
  /** The step it happened on, so the policy can tell this screen from the ones before. */
  readonly step: string;
  readonly kind: DecisionActionKind;
  readonly targetElementId: string | null;
  /** Whether it did what the agent expected: a click that advanced, a scroll that revealed. */
  readonly ok: boolean;
}

/**
 * The screenshot of the current screen, for a provider that reads images.
 *
 * Run-directory-relative, exactly as `runPaths('').screenshot(variant, step)` spells it:
 * the provider that wants the pixels reads the file, and the offline policy never looks.
 */
export interface DecisionScreenshot {
  readonly path: string;
}

/**
 * Everything a provider is given, and so everything the agent knows.
 *
 * Adding a field here widens what every provider may act on, which is why the knowledge
 * boundary is written down above rather than left to each implementation.
 */
export interface DecisionContext {
  readonly goal: Goal;
  readonly traits: PersonaTraits;
  readonly step: DecisionStep;
  /** The elements it has fixated on this screen. A decision may target no other element. */
  readonly fixatedElements: readonly FixatedElement[];
  /** Its own actions so far this session, oldest first. */
  readonly history: readonly PastAction[];
  /** Present only when the provider reads images; the offline policy ignores it. */
  readonly screenshot?: DecisionScreenshot;
}

/**
 * What one `decide` call cost: the five figures `run.json` totals, per call.
 *
 * It is the contract's own `RunUsage` without the `calls` count, so that a decision's usage
 * cannot drift from what the artifact records — `packages/contract` is the only place a
 * field of the artifact is named (#32), and these five are its names.
 *
 * Five figures, because the owner's model mode bills in five: `muse-spark-1.3` with cached
 * input reports `usage.input_tokens_details.cached_tokens`, and it spends reasoning tokens
 * — 172 of 182 output tokens on a one-word reply, as the owner measured — so a run that
 * counted only input and output would overstate a cached run and understate a reasoning
 * one. All five are zero for a provider that costs nothing.
 */
export type DecisionUsage = Omit<RunUsage, 'calls'>;

/**
 * A relevance hint per element, keyed by `FixatedElement.id`, each on `[0, 1]`.
 *
 * Optional, and offline always absent: in model mode the agent may say which elements it
 * found relevant, and the engine's `relevance` pulls its own lexical value toward the hint
 * by `config.relevance.hintWeight` (#62). The shape is the `RelevanceHints` that module
 * already accepts.
 */
export type RelevanceHints = Readonly<Record<string, number>>;

/**
 * Which model produced a decision, and in which mode.
 *
 * Absent offline, where there is no model to name. Present on every decision a model
 * provider returns, because a run's cost can only be checked against an invoice if each
 * call says what it was priced at: the same usage costs twelve times as much in one of the
 * owner's two modes as in the other (#43), and the run artifact records the mode it ran in
 * (#142). It is a sibling of `usage` rather than a field of it, because `usage` is the
 * contract's own five figures and gains no sixth.
 *
 * The mode's vocabulary belongs to the provider that implements it — `contributor` and
 * `standard` for the Meta Model API — so this interface takes the words rather than
 * declaring them.
 */
export interface DecisionModel {
  /** The provider's own name for the tier, as its records and the run artifact spell it. */
  readonly mode: string;
  /** The model actually called, never one that was substituted for it. */
  readonly modelId: string;
}

/** What a provider decided: the agent's words, one action, and the call's cost. */
export interface Decision {
  /** The agent's intent, in its own words — what the replay shows it was thinking. */
  readonly intent: string;
  readonly action: DecisionAction;
  readonly relevanceHints?: RelevanceHints;
  readonly usage: DecisionUsage;
  /** Which model and mode produced it. Absent when no model did. */
  readonly model?: DecisionModel;
}

/**
 * Who one agent session is: the persona it runs as, and the seed it decides from — the
 * `persona.id` and `seed` that `sessions/S-NN.json` records, by those names.
 *
 * These two are the whole of a session's identity because they are the whole of what a
 * provider needs in order to keep one session apart from every other: a cached call's
 * `prompt_cache_key` is derived from them, a conversation belongs to exactly one pair, and
 * a trajectory file is named from them (#43, #139).
 *
 * The run's **model mode** is deliberately not here. It is configured on the provider and
 * every session it begins inherits it, so two modes are two model ids that the provider's
 * cache namespaces for us — a mode argument here would put the same fact in two places and
 * let a session disagree with the run it belongs to.
 */
export interface DecisionSessionIdentity {
  /** The persona this session runs as. */
  readonly personaId: string;
  /** The seed this session decides from. */
  readonly seed: number;
}

/**
 * One agent session's decider: the handle every decision of that session goes through.
 *
 * `decide` returns exactly what the stateless `decide` returns — the agent's intent, one
 * action and its target, optional relevance hints, usage. What the handle adds is
 * somewhere for a provider to keep what belongs to *this* session and to no other: its
 * append-only conversation, its cache key, its trajectory file. That is why the handle
 * exists rather than three more fields on `DecisionContext`: the per-screen context still
 * carries only what the agent could know, and gains nothing.
 *
 * **Two handles never share state.** A swarm runs as many at once as it has sessions, and
 * what one of them decides, closes or writes is invisible to the rest.
 *
 * **A handle is closable**, because a session ends: that is the moment a trajectory sink is
 * flushed and shut (#139), so that a half-written line is never left behind. `close` waits
 * for a turn still in flight — that turn is the session's last, and the sink is shut once it
 * has settled rather than under the line it is meant to contain — and it releases exactly
 * once however often it is called. Afterwards the handle refuses to decide, with
 * `DecisionSessionClosedError`, before the provider's own body runs and therefore before
 * anything could be written.
 */
export interface DecisionSession extends DecisionSessionIdentity {
  decide(context: DecisionContext): Promise<Decision>;
  /** Ends the session and releases what it held. Idempotent: closing twice is not an error. */
  close(): Promise<void>;
}

/**
 * The decision layer. Two methods, and three facts about the implementation that a run
 * records and the swarm reads before it builds a context.
 */
export interface DecisionProvider {
  /** The provider's name, as `run.json`'s `engine.provider` records it. */
  readonly name: string;
  /** Which mode this provider is, as `run.json`'s `engine.mode` records it. */
  readonly mode: ProviderMode;
  /** Whether it reads `context.screenshot`; the swarm omits the screenshot when it does not. */
  readonly readsImages: boolean;
  /**
   * The model this provider calls, as its decisions and the run artifact spell it. Absent
   * on a provider that calls none — the offline policy — and on one that will not say.
   *
   * It is here so that a caller which asked for one tier can see that it was handed
   * another: `selectDecisionProvider` refuses a provider naming a model it did not ask for,
   * rather than record a model id no decision in the run was ever costed at (#143).
   */
  readonly modelId?: string;
  /**
   * One decision, belonging to no session. The swarm does not use this: a session's screens
   * go through the handle `beginSession` returns, which is the only thing that can hold a
   * conversation, a cache key or a trajectory. It stays because a single decision — a test,
   * a one-screen probe — is a reasonable thing to ask for and needs no session to answer.
   */
  decide(context: DecisionContext): Promise<Decision>;
  /**
   * Begins one agent session and returns its decider. Every decision of that session goes
   * through the returned handle, and the handle is closed when the session ends.
   *
   * A provider with nothing to remember returns a handle that forwards straight through,
   * which is what the offline deterministic policy does.
   */
  beginSession(identity: DecisionSessionIdentity): DecisionSession;
}
