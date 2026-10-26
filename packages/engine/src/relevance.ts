import type { EngineConfig, GoalVerbRoleWeights } from './config.js';
import { defaultEngineConfig } from './config.js';
import { CONVENTIONAL_CONTROL_ROLES } from './persona.js';
import type { Goal } from './types.js';

/**
 * Top-down goal relevance per area of interest — the half of the engine that makes an
 * agent looking for the price look at price-like elements (#7, user stories 3 and 4).
 *
 * **It never calls a model, and it never fetches anything.** The whole demo is a cold
 * clone of this repository with no API key, so relevance offline is lexical and
 * role-based: the goal's content words against the area's accessible name and text, plus
 * the weight the goal's verb puts on the area's class of element. In model mode the
 * agent's per-screen decision may supply a relevance hint for an area — #33 publishes it
 * as the optional `relevanceHints` on a `DecisionProvider`'s result — and a hint pulls the
 * offline value toward itself by `config.relevance.hintWeight`. Omit the hints and the
 * offline value comes back unchanged.
 *
 * **The range is `[config.relevance.floor, 1]`**, the same for every area on a screen, so
 * that `sampleFixations` can weigh relevance against salience with `beta`. An area the
 * goal says nothing about scores the floor exactly — never a negative value, which would
 * dominate the sampler's softmax rather than simply losing to the areas that matched.
 *
 * **What is data and what is code.** Every number is in the configuration object under
 * `relevance`, including which classes of element each goal verb favours
 * (`goalVerbRoleWeights`), so the calibration step (#11) can fit the ranking without a
 * code change. The *vocabulary* — which words are intent verbs, which roles are controls,
 * what reads like a value — is structure rather than a tunable number, so it lives here
 * and in `persona.ts`, as `CONVENTIONAL_CONTROL_ROLES` does.
 */

/**
 * What relevance reads of an area of interest: an id, a role, and whatever words the area
 * carries.
 *
 * Declared as the least this module needs so that both sides of the engine satisfy it
 * structurally, with no adapter and no import: a `CaptureElement` from the browser step
 * spells its accessible name `name` and carries the visible `text`, while an `Aoi` as
 * `packages/contract` publishes it spells the name `label` and carries no text at all.
 */
export interface RelevanceArea {
  readonly id: string;
  /** The ARIA or DOM role, `null` when the element has none. */
  readonly role: string | null;
  /** The accessible name, as a `CaptureElement` spells it. */
  readonly name?: string;
  /** The accessible name, as the contract's `Aoi` spells it. */
  readonly label?: string;
  /** The visible text, which is not always the accessible name. */
  readonly text?: string;
}

/**
 * A relevance hint per area of interest, keyed by `RelevanceArea.id`, each in `[0, 1]` —
 * the shape this ticket accepts and #33's `relevanceHints` satisfies. A value outside the
 * range, or one that is not a finite number, is brought into the range rather than trusted:
 * a hint is a model's output, and the sampler's softmax is no place to find that out.
 */
export type RelevanceHints = Readonly<Record<string, number>>;

export interface RelevanceInput {
  readonly areas: readonly RelevanceArea[];
  readonly goal: Goal;
  /** Absent in offline mode, which is the default and the demo. */
  readonly hints?: RelevanceHints;
  /** Defaults to `defaultEngineConfig`; a run passes `resolveEngineConfig(...).config`. */
  readonly config?: EngineConfig;
}

/**
 * Light normalisation, no stemming library: case and punctuation go, and a plural becomes
 * its singular by the three rules that cover English nouns on a shopping page. A token of
 * three characters or fewer is left alone, so `vs` does not become `v`.
 */
const singular = (token: string): string => {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
};

/**
 * Letters and digits of any script are word characters, and everything else separates
 * words: a goal written in Cyrillic or in a CJK script still produces tokens that can
 * match an element's name, rather than producing none and leaving the whole screen at the
 * floor as though the goal had asked for nothing.
 */
const tokenise = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '')
    .map(singular);

/**
 * The classes of element a goal verb can favour. They are classes rather than roles so
 * that the configuration's table stays short enough to fit by hand and by calibration.
 */
type RoleClass = keyof GoalVerbRoleWeights;

/** The intent the goal's words express, or `null` when its words express none. */
type GoalIntent = keyof EngineConfig['relevance']['goalVerbRoleWeights'] | null;

/**
 * The intent vocabulary: which words put a goal in which class. Singular and lower case,
 * because the goal is normalised the same way before it is looked up here.
 *
 * `null` — a goal with no word in any of these lists — is the honest answer for "this goal
 * asks for nothing I recognise", and it switches the role term off entirely so that such a
 * goal leaves every area at the floor instead of quietly ranking the screen by role alone.
 */
const GOAL_INTENT_WORDS_RAW: Readonly<Record<Exclude<GoalIntent, null>, readonly string[]>> = {
  /** Advance the task: these favour the controls that do it. */
  complete: [
    'place',
    'buy',
    'purchase',
    'checkout',
    'submit',
    'pay',
    'confirm',
    'continue',
    'proceed',
    'complete',
    'finish',
    'add',
    'register',
    'subscribe',
    'book',
    'apply',
    'send',
    'click',
    'press',
    'sign',
  ],
  /** Read a value off the screen: these favour text that reads like one. */
  find: [
    'find',
    'locate',
    'search',
    'how',
    'much',
    'many',
    'price',
    'cost',
    'cheap',
    'cheaper',
    'cheapest',
    'expensive',
    'total',
    'amount',
    'quantity',
    'size',
    'weight',
    'rating',
    'discover',
    'identify',
  ],
  /** Weigh two values against each other: these favour values too. */
  compare: [
    'compare',
    'comparison',
    'versus',
    'vs',
    'difference',
    'differ',
    'between',
    'choose',
    'decide',
    'pick',
    'select',
    'best',
    'better',
  ],
  /** Recognised, but neither a value nor a control in particular. */
  other: [
    'read',
    'check',
    'review',
    'verify',
    'understand',
    'learn',
    'browse',
    'explore',
    'scan',
    'inspect',
    'see',
    'view',
    'watch',
    'visit',
  ],
};

/**
 * Words that carry no intent and name nothing on a screen, so they are dropped before the
 * lexical match. They are dropped *after* the intent lookup above, because "how much" is
 * two stop words that together say the goal is after a value.
 */
const STOP_WORDS_RAW: readonly string[] = [
  'a',
  'about',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'here',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'much',
  'my',
  'of',
  'on',
  'onto',
  'or',
  'our',
  'out',
  'over',
  'should',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'up',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
];

/**
 * Both vocabularies pass through `singular` once, here, rather than being written in their
 * normalised form by hand: a goal's tokens are normalised before they are looked up, so a
 * raw `versus` or `this` in a list above would otherwise be a word no goal could match.
 */
const normalised = (words: readonly string[]): ReadonlySet<string> => new Set(words.map(singular));

const GOAL_INTENT_WORDS: Readonly<Record<Exclude<GoalIntent, null>, ReadonlySet<string>>> = {
  complete: normalised(GOAL_INTENT_WORDS_RAW.complete),
  find: normalised(GOAL_INTENT_WORDS_RAW.find),
  compare: normalised(GOAL_INTENT_WORDS_RAW.compare),
  other: normalised(GOAL_INTENT_WORDS_RAW.other),
};

const STOP_WORDS: ReadonlySet<string> = normalised(STOP_WORDS_RAW);

/**
 * How many words a string may hold and still read as a value rather than as prose. The
 * ceiling holds whatever the digits look like, currency symbol or not: "Free shipping on
 * all orders over $50 this week" is a banner, and classing it as a value would hand it the
 * top weight of a price-seeking goal's role table and set it against the actual price.
 */
const VALUE_MAX_WORDS = 6;

/**
 * Whether a string reads like a value — a price, a total, a quantity, a rating — rather
 * than prose: a short string with a digit in it, in any script's digits. A paragraph that
 * happens to mention a number does not qualify, and nor does a string with no digit at all.
 */
const readsLikeAValue = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed === '' || !/\p{N}/u.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= VALUE_MAX_WORDS;
};

/**
 * A control is a control first: a button labelled "$5 off" advances the task, and a goal
 * that asks to complete something should favour it for that and not for its digits.
 */
const roleClassOf = (area: RelevanceArea): RoleClass => {
  const role = area.role;
  if (role !== null && CONVENTIONAL_CONTROL_ROLES.has(role)) return 'control';
  const name = area.name ?? area.label ?? '';
  if (readsLikeAValue(name) || readsLikeAValue(area.text ?? '')) return 'value';
  return 'prose';
};

/**
 * The class with the most of the goal's words in it. A tie goes to the most committing
 * intent — "how do I place the order" is a completion goal that happens to start with a
 * question — and no word in any list means no recognised intent at all.
 */
const goalIntentOf = (goalWords: readonly string[]): GoalIntent => {
  const words = new Set(goalWords);
  const counted = (['complete', 'compare', 'find', 'other'] as const).map((intent) => ({
    intent,
    hits: [...words].filter((word) => GOAL_INTENT_WORDS[intent].has(word)).length,
  }));
  const best = counted.reduce((winner, candidate) =>
    candidate.hits > winner.hits ? candidate : winner,
  );
  return best.hits === 0 ? null : best.intent;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** The share of the goal's content words that appear in this text. */
const matchShare = (goalWords: readonly string[], text: string): number => {
  if (goalWords.length === 0 || text === '') return 0;
  const found = new Set(tokenise(text));
  return goalWords.filter((word) => found.has(word)).length / goalWords.length;
};

/**
 * Relevance per area of interest for one goal on one screen, keyed by area id and in the
 * areas' own order.
 *
 * Pure: the same inputs always produce the same output, nothing passed in is mutated, and
 * no file is read and no socket opened — a hint is the only way anything a model said
 * reaches this function, and it arrives as a number.
 */
export const relevanceByArea = (input: RelevanceInput): Map<string, number> => {
  const config = (input.config ?? defaultEngineConfig).relevance;
  const { floor, hintWeight, nameMatchWeight, textMatchWeight, roleWeight } = config;

  const goalWords = tokenise(input.goal.text);
  const intent = goalIntentOf(goalWords);
  const contentWords = goalWords.filter((word) => !STOP_WORDS.has(word));
  const roleWeights = intent === null ? null : config.goalVerbRoleWeights[intent];

  /**
   * The denominator that bounds the result: the most any area *on this screen* could
   * score, so that the terms stay comparable across the screen whatever the weights are
   * fitted to, and so that a full match still reaches 1 rather than a fraction of it.
   *
   * The text term counts only when the screen's areas carry text at all: the contract's
   * `Aoi` has an accessible name and no text, so including a term no area can earn would
   * cap an Aoi-driven screen near 0.75 and mis-scale the `beta` fitted against captures.
   * Weights that sum to nothing leave every area at the floor rather than dividing by zero.
   */
  const hasText = input.areas.some((area) => (area.text ?? '') !== '');
  const maxTerms = nameMatchWeight + (hasText ? textMatchWeight : 0) + roleWeight;

  const relevance = new Map<string, number>();
  for (const area of input.areas) {
    const name = area.name ?? area.label ?? '';
    const terms =
      nameMatchWeight * matchShare(contentWords, name) +
      textMatchWeight * matchShare(contentWords, area.text ?? '') +
      roleWeight * (roleWeights === null ? 0 : roleWeights[roleClassOf(area)]);

    const offline = maxTerms > 0 ? floor + (1 - floor) * clamp(terms / maxTerms, 0, 1) : floor;

    const hint = input.hints?.[area.id];
    const value =
      hint === undefined || !Number.isFinite(hint)
        ? offline
        : offline + (clamp(hint, 0, 1) - offline) * hintWeight;

    /**
     * Ids are unique per screen by construction — `buildAois` merges the DOM, the
     * accessibility tree and the segmenter into one area per control, and every aggregate
     * joins on that id. A repeat would silently return fewer values than there are areas,
     * so it is a caller's defect worth hearing about rather than a shorter map.
     */
    if (relevance.has(area.id)) {
      throw new Error(`two areas of interest share the id "${area.id}" on one screen`);
    }
    relevance.set(area.id, clamp(value, floor, 1));
  }

  return relevance;
};
