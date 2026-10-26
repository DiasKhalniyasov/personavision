import { createSeededRandom } from '@personavision/contract';
import { FREE_USAGE } from './decision.js';
import type {
  Decision,
  DecisionAction,
  DecisionContext,
  DecisionProvider,
  FixatedElement,
  Goal,
  PersonaTraits,
} from './types.js';

/**
 * The offline deterministic policy — the project's default decision layer, and the only
 * one that runs with no API key and no network.
 *
 * It is a scripted behaviour model, not a stub. Every screen it is handed, it scores the
 * elements the agent looked at by how well their words answer the goal and by what kind of
 * control they are, and then escalates the way a person does: look further down when
 * nothing here is it, pause when the screen is not yielding, go back when something it
 * tried failed, and give up when its patience and persistence are spent. The committed
 * demo run is produced by this policy, so it has to read as credible to a designer.
 *
 * **Deterministic per call, not per provider.** The random stream for a decision is
 * derived from the seed *and* a digest of the context, so the same context and seed give
 * the same decision wherever it is asked and in whatever order — a surprising session can
 * be re-run screen by screen, and a provider that has already decided twenty screens
 * decides the twenty-first exactly as a fresh one would.
 *
 * **It never widens the agent's knowledge.** It reads only `DecisionContext`, it ignores
 * `screenshot` (it cannot see), and it only ever targets an element of
 * `context.fixatedElements`.
 */

/**
 * Every number the policy turns on, in one place and named, so that the behaviour can be
 * argued with — and so that the calibration step (#11) has one table to fit rather than a
 * hunt through the branches. They are the policy's own constants, not a public knob: a
 * caller tunes behaviour by giving a persona different traits, which is what traits are.
 */
const POLICY = {
  /** How much a candidate's score comes from its words answering the goal. */
  goalWeight: 1,
  /** How much comes from being the kind of element a person acts on at all. */
  roleWeight: 0.35,
  /** How much comes from the agent's own eyes having stayed on it. */
  attentionWeight: 0.15,
  /**
   * The spread of the weighted choice among candidates. Low enough that a clear goal match
   * wins most seeds, high enough that a near-tie is genuinely undecided — which is what
   * makes a swarm of seeds a spread rather than one session repeated.
   */
  selectionTemperature: 0.22,
  /** Below this, the best thing on the screen is not worth acting on: look further down. */
  scrollThreshold: 0.35,
  /** How much of a reader the persona has to be before it reads text instead of acting. */
  readThreshold: 0.3,
  /** Reading something entirely beside the point is not credible either. */
  readScoreFloor: 0.15,
  /** Attempts on one screen before the agent pauses: 1 at no patience, 5 at full. */
  patienceBase: 1,
  patiencePerPatience: 4,
  /** Actions in a session before the agent gives up: 2 at nothing, 16 at full traits. */
  abandonBase: 2,
  abandonPerPersistence: 10,
  abandonPerPatience: 4,
  /** Failures and pauses before the agent gives up early: 2 at no persistence, 8 at full. */
  frustrationBase: 2,
  frustrationPerPersistence: 6,
} as const;

/** Roles a person acts on, roles a person reads, and what everything else is worth. */
const ROLE_PRIORS: Readonly<Record<string, number>> = {
  button: 1,
  link: 1,
  menuitem: 1,
  tab: 1,
  option: 1,
  checkbox: 1,
  radio: 1,
  textbox: 1,
  searchbox: 1,
  combobox: 1,
  heading: 0.5,
  img: 0.4,
  image: 0.4,
};

const OTHER_ROLE_PRIOR = 0.25;

/** The roles the policy treats as something to read rather than something to operate. */
const READABLE_ROLES = new Set([null, 'paragraph', 'text', 'generic', 'heading', 'listitem']);

/**
 * Words that carry no intent. Short enough to read, long enough that a goal sentence's
 * content words are what is left — the same job `packages/engine`'s relevance does, kept
 * here because this package depends on `packages/contract` only.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'do',
  'for',
  'from',
  'i',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'out',
  'that',
  'the',
  'then',
  'this',
  'to',
  'up',
  'want',
  'was',
  'what',
  'with',
  'you',
  'your',
]);

/** Case and punctuation go; a plural becomes its singular by the rules that cover English. */
const tokenise = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token !== '' && !STOPWORDS.has(token))
    .map((token) => {
      if (token.length <= 3) return token;
      if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
      if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
      if (token.endsWith('ss')) return token;
      if (token.endsWith('s')) return token.slice(0, -1);
      return token;
    });

/**
 * How much of the goal's content this element's words answer, on `[0, 1]`. Lexical, with
 * no model and no network: the goal's tokens against the element's text and accessible
 * name, plus a point for the goal's own verb appearing on a control.
 */
const goalMatch = (goal: Goal, element: FixatedElement): number => {
  const goalTokens = tokenise(goal.text);
  if (goalTokens.length === 0) return 0;
  const elementTokens = new Set(tokenise(`${element.text} ${element.name ?? ''}`));
  if (elementTokens.size === 0) return 0;
  const matched = goalTokens.filter((token) => elementTokens.has(token)).length;
  return matched / goalTokens.length;
};

const rolePrior = (role: string | null): number =>
  role === null ? OTHER_ROLE_PRIOR : (ROLE_PRIORS[role] ?? OTHER_ROLE_PRIOR);

interface Candidate {
  readonly element: FixatedElement;
  readonly score: number;
}

/** Highest score first, and by id within a tie so the order never depends on input order. */
const scoreCandidates = (context: DecisionContext): readonly Candidate[] =>
  context.fixatedElements
    .map((element) => ({
      element,
      score:
        POLICY.goalWeight * goalMatch(context.goal, element) +
        POLICY.roleWeight * rolePrior(element.role) +
        (POLICY.attentionWeight * Math.min(element.fixationCount, 3)) / 3,
    }))
    .sort(
      (left, right) => right.score - left.score || left.element.id.localeCompare(right.element.id),
    );

/** FNV-1a over the context, so that the stream depends on the whole situation. */
const digestOf = (context: DecisionContext): string =>
  [
    context.step.id,
    context.step.index,
    context.goal.text,
    context.fixatedElements
      .map(
        (element) =>
          `${element.id}:${element.role ?? ''}:${element.text}:${element.fixationCount}:${element.dwellMs}`,
      )
      .join(','),
    context.history
      .map(
        (action) =>
          `${action.step}:${action.kind}:${action.targetElementId ?? ''}:${action.ok ? 1 : 0}`,
      )
      .join(','),
  ].join('|');

const hash32 = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** One candidate, sampled by softmax over the scores, so the better one wins more seeds. */
const chooseCandidate = (candidates: readonly Candidate[], random: () => number): Candidate => {
  const best = candidates[0]?.score ?? 0;
  const weights = candidates.map((candidate) =>
    Math.exp((candidate.score - best) / POLICY.selectionTemperature),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= weights[index] as number;
    if (cursor <= 0) return candidates[index] as Candidate;
  }
  return candidates[candidates.length - 1] as Candidate;
};

const budgets = (traits: PersonaTraits) => ({
  /** Attempts on one screen before pausing. */
  patience: Math.round(POLICY.patienceBase + POLICY.patiencePerPatience * traits.patience),
  /** Actions in the session before giving up. */
  abandon: Math.round(
    POLICY.abandonBase +
      POLICY.abandonPerPersistence * traits.persistence +
      POLICY.abandonPerPatience * traits.patience,
  ),
  /** Failures and pauses before giving up early. */
  frustration: POLICY.frustrationBase + POLICY.frustrationPerPersistence * traits.persistence,
});

/** What the agent has already done on this screen. */
const screenHistory = (context: DecisionContext) => {
  const here = context.history.filter((action) => action.step === context.step.id);
  return {
    attempts: here.length,
    failures: here.filter((action) => !action.ok).length,
    hesitations: here.filter((action) => action.kind === 'hesitate').length,
    backtracked: here.some((action) => action.kind === 'backtrack'),
    scrolled: here.some((action) => action.kind === 'scroll'),
    readIds: new Set(
      here.filter((action) => action.kind === 'read').map((action) => action.targetElementId),
    ),
  };
};

const pick = <T>(options: readonly T[], random: () => number): T =>
  options[Math.min(options.length - 1, Math.floor(random() * options.length))] as T;

/** The goal in the agent's mouth: "find the price" rather than "Find the price of …". */
const goalFragment = (goal: Goal): string => {
  const text = goal.text.trim().replace(/[.!?]+$/, '');
  return text === '' ? 'get this done' : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
};

const intentFor = (
  action: DecisionAction,
  context: DecisionContext,
  target: FixatedElement | undefined,
  random: () => number,
): string => {
  const words =
    target === undefined ? 'it' : `“${target.text.trim() || target.name?.trim() || target.id}”`;
  const goal = goalFragment(context.goal);
  switch (action.kind) {
    case 'click':
      return pick(
        [
          `${words} looks like the way to ${goal}.`,
          `I'll try ${words} — that should be it.`,
          `${words} is the closest thing here to what I want.`,
        ],
        random,
      );
    case 'read':
      return pick(
        [
          `Let me read ${words} properly before I commit to anything.`,
          `${words} might say whether this is the right one.`,
        ],
        random,
      );
    case 'scroll':
      return pick(
        [
          `Nothing up here is it — there must be more further down.`,
          `I can't see what I need yet, so I'll keep going down the page.`,
        ],
        random,
      );
    case 'hesitate':
      return pick(
        [
          `I'm not sure which of these is right.`,
          `This isn't as obvious as I expected — let me think.`,
        ],
        random,
      );
    case 'backtrack':
      return pick(
        [
          `That didn't get me anywhere. I'll go back and try another way.`,
          `Wrong turn — back to the previous page.`,
        ],
        random,
      );
    case 'abandon':
      return pick(
        [
          `I've spent long enough trying to ${goal}. I'd give up at this point.`,
          `This isn't working and I'm done looking.`,
        ],
        random,
      );
  }
};

/**
 * The escalation, in the order it is checked. Each rule reads the agent's own history and
 * its traits, and the first one that fires is the decision:
 *
 * 1. **abandon** — its budget of actions is spent, or failures and pauses have passed what
 *    its persistence tolerates.
 * 2. **backtrack** — it has already paused on this screen, something it tried failed, and
 *    there is a screen behind it. Once per screen: a loop of going back is not behaviour.
 * 3. **hesitate** — attempts on this screen have passed what its patience allows. Once per
 *    screen, so that a pause is followed by an attempt rather than by another pause.
 * 4. **scroll** — nothing it has looked at is worth acting on, and it has not looked
 *    further down this screen yet.
 * 5. **read** — there is text it has not read, and it is enough of a reader to read it.
 * 6. **click** — the best candidate, sampled with seeded noise so that a near-tie is
 *    decided differently from seed to seed.
 */
const decideAction = (
  context: DecisionContext,
  candidates: readonly Candidate[],
  random: () => number,
): { action: DecisionAction; target?: FixatedElement } => {
  const here = screenHistory(context);
  const limits = budgets(context.traits);
  const frustration = here.failures + here.hesitations;

  if (context.history.length >= limits.abandon || frustration >= limits.frustration) {
    return { action: { kind: 'abandon', targetElementId: null } };
  }
  if (here.hesitations >= 1 && here.failures >= 1 && context.step.index > 0 && !here.backtracked) {
    return { action: { kind: 'backtrack', targetElementId: null } };
  }
  if (here.attempts >= limits.patience && here.hesitations === 0) {
    return { action: { kind: 'hesitate', targetElementId: null } };
  }

  const best = candidates[0];
  if (best === undefined || best.score < POLICY.scrollThreshold) {
    if (!here.scrolled) return { action: { kind: 'scroll', targetElementId: null } };
    if (best === undefined) return { action: { kind: 'hesitate', targetElementId: null } };
  }

  const readiness = context.traits.detailOrientation * (1 - context.traits.scanningVsReading);
  if (readiness >= POLICY.readThreshold) {
    const unread = candidates.find(
      (candidate) =>
        READABLE_ROLES.has(candidate.element.role) &&
        candidate.score >= POLICY.readScoreFloor &&
        !here.readIds.has(candidate.element.id),
    );
    if (unread !== undefined) {
      return {
        action: { kind: 'read', targetElementId: unread.element.id },
        target: unread.element,
      };
    }
  }

  const chosen = chooseCandidate(candidates, random);
  return {
    action: { kind: 'click', targetElementId: chosen.element.id },
    target: chosen.element,
  };
};

export interface OfflineProviderOptions {
  /** The session's seed, as `run.json` records it per session. */
  readonly seed: number;
}

export const OFFLINE_PROVIDER_NAME = 'offline-deterministic';

/**
 * The offline deterministic provider. Costs nothing, reads no images, and decides the same
 * way every time for a given context and seed.
 */
export const createOfflineDeterministicProvider = (
  options: OfflineProviderOptions,
): DecisionProvider => ({
  name: OFFLINE_PROVIDER_NAME,
  mode: 'offline',
  readsImages: false,
  decide: (context: DecisionContext): Promise<Decision> => {
    const random = createSeededRandom(
      (hash32(digestOf(context)) ^ Math.imul(options.seed >>> 0, 0x9e3779b1)) >>> 0,
    );
    const { action, target } = decideAction(context, scoreCandidates(context), random);
    return Promise.resolve({
      intent: intentFor(action, context, target, random),
      action,
      // No relevance hints offline: the engine's relevance is the same lexical reading of
      // the same words, so a hint from here would only pull it towards itself.
      usage: FREE_USAGE,
    });
  },
});
