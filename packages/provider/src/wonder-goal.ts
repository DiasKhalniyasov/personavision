import { createSeededRandom, goalSchema } from '@personavision/contract';
import type { Goal } from '@personavision/contract';
import { z } from 'zod';
import { totalUsage } from './decision.js';
import type { DecisionUsage } from './types.js';
import type {
  WonderAsk,
  WonderEffort,
  WonderModel,
  WonderProvider,
  WonderReply,
} from './wonder.js';

/**
 * The second of the four things Muse Wonder answers: **a URL and a feature description in,
 * the goal a run is given out** (`docs/FLOW.md` section 12; step #219; #259).
 *
 * Two sentences come back — **the task** the agents attempt, in the words a person would
 * use, and **the success criterion**, what has to be observable in the page for an attempt
 * to count — with the model recorded as the goal's last author. The screen that shows both
 * and lets the user edit either is #225's; when the user does, the author becomes the user,
 * which is that screen's job and the reason `lastWrittenBy` is on the shape rather than
 * implied by who called.
 *
 * Three things are load-bearing here:
 *
 * 1. **The success criterion has to be observable in the page**: a visible element, a URL,
 *    or a piece of text. Not a judgement and not a feeling. _"a video preview is visible"_
 *    is a criterion; _"the page feels trustworthy"_ is not — no session can evaluate it, and
 *    a completion rate computed against it means nothing. {@link readCriterion} is that
 *    rule, exported and tested on its own rather than buried in a prompt, because it is the
 *    one thing in this file a reader will argue with.
 * 2. **One send-back, then a refusal.** A criterion that is not observable is sent back
 *    once, saying what was asked for instead. A second unobservable criterion refuses the
 *    goal with a reason a screen can show unchanged. Nothing here invents a criterion on
 *    the model's behalf, and nothing returns a goal half-formed: a refused goal is a
 *    {@link GoalCriterionError} carrying what both calls cost, because two calls were paid
 *    for whether or not an answer came back.
 * 3. **Deterministic and seeded offline, like every other use.** The same URL, the same
 *    feature description and the same seed give the same goal, in every process and on
 *    every platform, with no key and no network.
 *
 * The observability rule deliberately sits in {@link writeGoal} and **not** in the ask's
 * `parse`. A `parse` that threw on a judgement would take the first call's usage and the
 * criterion's own words down with it — the seam reports a refusal and no reply — leaving
 * nothing to send back, nothing to bill and nothing to quote in the refusal. So `parse`
 * holds the reply to the contract's goal shape, and the rule the two calls enforce is here,
 * where both replies and both receipts are in hand.
 */

/**
 * The effort this shape is worth. The goal was answered at `minimal` on the live call
 * (`docs/meta-model-api.md`, observed 2026-11-03), as the audience was: two short sentences
 * from a URL and a description is not a reasoning problem, and Wonder's own default of `max`
 * spends most of a call's tokens thinking about one.
 */
export const GOAL_EFFORT: WonderEffort = 'minimal';

/** The name the model is told the reply shape is called. */
export const GOAL_REPLY_SCHEMA_NAME = 'wonder_goal';

/**
 * The three kinds of thing a success criterion may name, and the whole of what
 * {@link readCriterion} accepts (`docs/FLOW.md` section 12).
 *
 * The list is closed because it is the rule rather than a convenience: a fourth kind would
 * be a fourth thing a session is expected to be able to see, which is a change to what a
 * completion rate means and not a change to this file.
 */
export const CRITERION_KINDS = ['element', 'url', 'text'] as const;

export type CriterionKind = (typeof CRITERION_KINDS)[number];

/**
 * What one success criterion was read as: one of the three kinds, or the sentence saying why
 * it is not observable and what was asked for instead.
 *
 * The refusal carries its reason rather than a code, because the reason is what a screen
 * shows and what the send-back sends: one sentence, naming the criterion it refused, so
 * neither a screen nor a prompt has to compose an explanation of its own.
 */
export type CriterionReading =
  | { readonly observable: true; readonly kind: CriterionKind }
  | { readonly observable: false; readonly reason: string };

/** Everything one goal ask needs. */
export interface GoalAskInput {
  /** The site the agents are pointed at: `http` or `https`, with a host. */
  readonly url: string;
  /** The feature whose experience is being tested, in the user's own words. */
  readonly feature: string;
  /** The run's or the request's seed, exactly as a session's is. */
  readonly seed: number;
  /** How much thinking this shape is worth; {@link GOAL_EFFORT} where the caller names none. */
  readonly effort?: WonderEffort;
  /**
   * The criterion that was sent back and why — present on the **second** of the two calls
   * and absent on the first.
   *
   * It is on the input rather than hidden inside {@link writeGoal} so that the send-back is
   * an ask like any other: a reader can build it, read the words it sends and test it
   * without driving a provider through a refusal.
   */
  readonly sentBack?: {
    readonly criterion: string;
    readonly reason: string;
  };
}

/** An example of each kind, used in every refusal so a reader is told what to write instead. */
const EXAMPLES = {
  element: 'a video preview is visible',
  url: 'the address bar reads /checkout/success',
  text: 'the page shows the text ‘Order complete’',
} as const satisfies Record<CriterionKind, string>;

const WHAT_WAS_ASKED_FOR = `a success criterion names what has to be observable in the page — a visible element (“${EXAMPLES.element}”), a URL (“${EXAMPLES.url}”) or a piece of text (“${EXAMPLES.text}”)`;

/**
 * What is inside quotation marks is quoted, not written — the rule `@personavision/contract`
 * applies before it looks for a sentence boundary, applied here for the same reason.
 *
 * A criterion's job includes naming **a piece of text** on the page, and page copy is
 * somebody else's words: `The page shows the text “Clean energy for everyone”` quotes a word
 * this file would otherwise read as a judgement. So a quoted span is blanked before the
 * sentence is read, and a criterion can quote whatever the page says.
 */
const QUOTED_SPAN = /"[^"]*"|“[^”]*”/gu;

const unquoted = (criterion: string): string => criterion.replace(QUOTED_SPAN, ' ');

const hasQuotedSpan = (criterion: string): boolean => new RegExp(QUOTED_SPAN).test(criterion);

/** A word list as a word-boundary pattern, matching the plural of each word as well. */
const anyOf = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join('|')})s?\\b`, 'iu');

/**
 * How the page felt, what the person made of it, what somebody thought of it. **A criterion
 * carrying one of these is refused even when it also names an element**: `the Buy button
 * looks trustworthy` names something a session can see and then asks the session to have an
 * opinion about it, which is the half nobody can score.
 *
 * The list is of feelings, opinions and states of mind, and deliberately not of words that
 * merely read as subjective next to an observable fact — `clearly visible` and `loads
 * quickly` are not here, because the first is observable and the second is refused below for
 * naming no element, no URL and no text rather than for the adverb.
 */
const JUDGEMENT_WORDS = [
  'feel',
  'feels',
  'felt',
  'feeling',
  'seem',
  'seems',
  'seemed',
  'trust',
  'trusts',
  'trusted',
  'trustworthy',
  'credible',
  'credibility',
  'intuitive',
  'confusing',
  'confused',
  'confusion',
  'beautiful',
  'attractive',
  'delightful',
  'delighted',
  'satisfied',
  'satisfying',
  'satisfaction',
  'confident',
  'confidence',
  'impressed',
  'enjoy',
  'enjoys',
  'enjoyed',
  'like',
  'likes',
  'liked',
  'prefer',
  'prefers',
  'understand',
  'understands',
  'understood',
  'perceive',
  'perceives',
  'believe',
  'believes',
  'realise',
  'realises',
  'realize',
  'realizes',
  'comfortable',
  'frustrated',
  'frustrating',
  'frustration',
  'engaging',
  'engaged',
  'compelling',
  'professional',
  'pleasant',
  'happy',
  'unhappy',
  'annoyed',
  'reassured',
  'reassuring',
  'convinced',
  'motivated',
  'excited',
  'bored',
  'intimidating',
  'overwhelming',
  'overwhelmed',
  'friendly',
  'welcoming',
] as const;

/**
 * Page furniture a session can look at. Not `page` and not `screen`: every criterion is
 * about the page, so a list carrying either would accept `the page feels trustworthy` on the
 * strength of its first two words.
 */
const ELEMENT_WORDS = [
  'button',
  'link',
  'video',
  'preview',
  'player',
  'image',
  'photo',
  'thumbnail',
  'icon',
  'logo',
  'banner',
  'modal',
  'dialog',
  'popup',
  'overlay',
  'drawer',
  'toast',
  'tooltip',
  'badge',
  'chip',
  'menu',
  'dropdown',
  'navbar',
  'navigation',
  'sidebar',
  'form',
  'field',
  'input',
  'textbox',
  'textarea',
  'checkbox',
  'radio',
  'toggle',
  'switch',
  'slider',
  'spinner',
  'loader',
  'card',
  'tile',
  'list',
  'table',
  'row',
  'column',
  'heading',
  'title',
  'subtitle',
  'label',
  'notice',
  'alert',
  'avatar',
  'chart',
  'graph',
  'map',
  'calendar',
  'tab',
  'panel',
  'section',
  'footer',
  'header',
  'breadcrumb',
  'pagination',
  'cart',
  'basket',
  'receipt',
  'invoice',
  'summary',
  'total',
  'price',
  'timer',
  'counter',
  'step',
  'stepper',
  'canvas',
  'iframe',
  'option',
  'element',
  'control',
  'widget',
  'download',
  'upload',
] as const;

/** Words naming a piece of the page's own copy, as opposed to a control on it. */
const TEXT_WORDS = [
  'text',
  'word',
  'wording',
  'copy',
  'message',
  'caption',
  'sentence',
  'headline',
  'string',
  'phrase',
] as const;

/**
 * The claim that makes a noun into something a session can check: that it is **there**. An
 * element noun on its own is a thing and not a criterion — `the confirmation banner` names
 * something without saying what about it counts.
 */
const VISIBILITY_WORDS = [
  'visible',
  'visibly',
  'appear',
  'appears',
  'appeared',
  'shown',
  'show',
  'shows',
  'showing',
  'display',
  'displays',
  'displayed',
  'displaying',
  'render',
  'renders',
  'rendered',
  'present',
  'contain',
  'contains',
  'containing',
  'include',
  'includes',
  'seen',
  'exist',
  'exists',
  'listed',
  'highlighted',
  'enabled',
  'disabled',
  'checked',
  'selected',
  'read',
  'reads',
  'say',
  'says',
  'state',
  'states',
  'name',
  'names',
  'load',
  'loads',
  'loaded',
  'open',
  'opens',
  'opened',
  'change',
  'changes',
  'changed',
  'navigate',
  'navigates',
  'redirect',
  'redirects',
  'land',
  'lands',
  'reach',
  'reaches',
] as const;

/** Words naming an address rather than something drawn on the page. */
const URL_WORDS = ['url', 'uri', 'address bar', 'query string', 'querystring', 'slug'] as const;

const JUDGEMENT = anyOf(JUDGEMENT_WORDS);
const ELEMENT = anyOf(ELEMENT_WORDS);
const TEXT = anyOf(TEXT_WORDS);
const VISIBILITY = anyOf(VISIBILITY_WORDS);
const URL_WORD = anyOf(URL_WORDS);

/**
 * A full address, or a path at the start of a word: `/checkout/success`, never `and/or`.
 *
 * It is blanked before the judgement check for the same reason a quoted span is: an address
 * is a locator and not words anybody wrote, so a criterion about `https://trust.example.com`
 * or `/trust-centre` is about where the person ended up and not about how the page felt.
 */
const ADDRESS_SOURCE = 'https?:\\/\\/[^\\s"”]+|(?:^|[\\s"“\'(])\\/[A-Za-z0-9._~/-]+';

const ADDRESS = new RegExp(ADDRESS_SOURCE, 'u');

const ADDRESS_SPAN = new RegExp(ADDRESS_SOURCE, 'gu');

/**
 * Whether one success criterion names something **observable in the page** — and which of
 * the three kinds it is — or why it does not (`docs/FLOW.md` section 12).
 *
 * This is the rule the two calls of {@link writeGoal} enforce, exported because it is the
 * one thing in this file a reader will argue with: a prompt that asked for an observable
 * criterion and hoped is not a rule, and a rule buried in a prompt cannot be tested, read
 * or disagreed with. It is a function of the sentence alone — no model, no network, no
 * state — so the same criterion reads the same way for the screen that previews a goal, the
 * provider that asked for it and the test that pins it.
 *
 * What it accepts, in order:
 *
 * - **A URL** — a full address, a path, or a sentence about the address bar.
 * - **A visible element** — page furniture, together with the claim that it is there. It is
 *   read before the text kind, so a criterion naming a control by its label — `the “Create
 *   video” button is visible` — is the element it is about and not the words on it.
 * - **A piece of text** — a quoted span, which is page copy by definition, or a word naming
 *   the page's copy together with the claim that it is there.
 *
 * What it refuses, with a sentence a screen can show unchanged: a judgement or a feeling,
 * wherever it appears, and anything naming none of the three. It never repairs, never
 * guesses a kind and never answers "probably": a criterion no session can evaluate is worth
 * one send-back and then a refusal, which is {@link writeGoal}'s half of the rule.
 */
export const readCriterion = (criterion: string): CriterionReading => {
  const stated = criterion.trim();
  if (stated === '') {
    return {
      observable: false,
      reason: `A success criterion was asked for and none was written: ${WHAT_WAS_ASKED_FOR}.`,
    };
  }

  // Page copy is somebody else's words, so the judgement check reads the criterion with its
  // quoted spans blanked — a criterion quoting a page that says “We are a friendly bank” is
  // about what the page shows and not about how it felt.
  const written = unquoted(stated);
  const judgement = JUDGEMENT.exec(written.replace(ADDRESS_SPAN, ' '));
  if (judgement !== null) {
    return {
      observable: false,
      reason: `“${stated}” is a judgement and not something a session can see — “${judgement[0]}” asks for an opinion about the page, and ${WHAT_WAS_ASKED_FOR}.`,
    };
  }

  if (ADDRESS.test(written) || URL_WORD.test(written)) {
    return { observable: true, kind: 'url' };
  }
  if (ELEMENT.test(written) && VISIBILITY.test(written)) {
    return { observable: true, kind: 'element' };
  }
  if (hasQuotedSpan(stated) || (TEXT.test(written) && VISIBILITY.test(written))) {
    return { observable: true, kind: 'text' };
  }

  return {
    observable: false,
    reason: `“${stated}” is not something a session can see: ${WHAT_WAS_ASKED_FOR}.`,
  };
};

/**
 * A goal refused because Muse Wonder wrote an unobservable success criterion twice.
 *
 * It is an **automation failure** in this project's vocabulary (`docs/FLOW.md` section 8),
 * like a reply the validator refused: a goal that could not be written is our breakage,
 * never a person who gave up. It carries
 *
 * - `reason` — one sentence, which is also the error's message, saying what both criteria
 *   were and what was asked for instead. A screen shows it unchanged.
 * - `refused` — the two criteria in the order they were written, so a reader can see that
 *   the send-back was tried and what came back.
 * - `usage` — what the two calls cost together. A refused goal is still two calls on the
 *   invoice, and a cost reported is better than one lost with the answer.
 *
 * **No criterion is invented here.** The alternative to this error is a run scored against a
 * sentence no session can evaluate, which is a completion rate that means nothing.
 */
export class GoalCriterionError extends Error {
  readonly attribution = 'automation' as const;
  readonly use = 'goal' as const;
  /** The sentence a screen shows, which is also this error's message. */
  readonly reason: string;
  /** The first criterion and the second, in the order they were written. */
  readonly refused: readonly string[];
  /** The model that wrote the second one, or `null` where the offline generator did. */
  readonly model: WonderModel | null;
  /** What both calls cost together, in the five figures a run's usage block totals. */
  readonly usage: DecisionUsage;

  constructor(options: {
    readonly reason: string;
    readonly refused: readonly string[];
    readonly model: WonderModel | null;
    readonly usage: DecisionUsage;
  }) {
    super(options.reason);
    this.name = 'GoalCriterionError';
    this.reason = options.reason;
    this.refused = options.refused;
    this.model = options.model;
    this.usage = options.usage;
  }
}

const described = goalSchema.shape;

/**
 * The two sentences the model writes, and nothing else.
 *
 * `lastWrittenBy` is **not** asked for: who wrote a goal is a fact about the call and not
 * something the model is in a position to report, so it is stamped on after the parse the
 * way the audience's id and provenance are. A reply that volunteers it is read without it.
 */
const goalReplySchema = z.strictObject({
  task: described.task,
  successCriterion: described.successCriterion,
});

/** As the structured-reply mechanism takes it, with the `$schema` key the protocol rejects. */
const jsonSchemaOf = (schema: z.ZodType): Readonly<Record<string, unknown>> => {
  const schemaObject = z.toJSONSchema(schema) as Record<string, unknown>;
  delete schemaObject.$schema;
  return schemaObject;
};

const isLoose = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The contract's own goal, with the model recorded as its last author.
 *
 * Two shapes reach it: the two sentences a model answers, and a whole `Goal` — which is what
 * the offline generator produces and what a caller is handed back, so a goal may be run
 * through here twice. Either way the author is stamped rather than read: a reply cannot name
 * itself the user's words.
 */
const parseGoal = (reply: unknown): Goal => {
  const written = isLoose(reply)
    ? Object.fromEntries(Object.entries(reply).filter(([field]) => field !== 'lastWrittenBy'))
    : reply;
  return goalSchema.parse({ ...goalReplySchema.parse(written), lastWrittenBy: 'model' });
};

/** The site this goal is about: a web address a client can actually ask for. */
const siteOf = (url: string): URL => {
  let site: URL;
  try {
    site = new URL(url);
  } catch {
    throw new TypeError(
      `a goal is written about a site, and "${url}" is not a web address: the URL the agents are pointed at is handed in, and an address this use cannot read is a refusal rather than a goal about a guess`,
    );
  }
  if (site.protocol !== 'http:' && site.protocol !== 'https:') {
    throw new TypeError(
      `a goal is written about a site at http or https, and "${url}" is ${site.protocol}: a scheme that runs code or reads local disk is not a site a swarm can be pointed at`,
    );
  }
  return site;
};

const trimmed = (text: string): string => text.trim().replace(/[\s.,;:!?]+$/u, '');

/**
 * The feature description as one clause this file can put inside a sentence of its own: its
 * first sentence, with quotation marks taken out.
 *
 * The user's own words are stored exactly as typed and may be two sentences — `featureSchema`
 * says so on purpose — while a goal's two sentences are each held to one. So the offline
 * stand-in takes the first sentence and leaves the rest: a goal built from the whole
 * paragraph would be refused by the shape it has to satisfy.
 */
const clauseOf = (feature: string): string => {
  const stated = trimmed(feature).replace(/["“”]/gu, '');
  const first = trimmed(stated.split(/[.!?]\s+/u)[0]);
  // A description whose first sentence is empty — one that opens with its own full stop — is
  // read whole with its terminators taken out, which is the one way to keep a clause that
  // carries none of them without inventing words the user did not type.
  return first === '' ? trimmed(stated.replace(/[.!?]+/gu, ' ')) : first;
};

/**
 * The goal with no model: deterministic, seeded, and the project's default.
 *
 * Its criterion is **observable by construction** — one of the three kinds, chosen off the
 * stream — so the offline implementation never sends itself back, and the three kinds are
 * exercised by the default path rather than only by a fake reply. The seed it is handed is
 * derived from the ask's seed and its document by the offline implementation, so the same
 * URL, the same feature description and the same seed give the same goal everywhere.
 */
const offlineGoal = (input: GoalAskInput, seed: number): Goal => {
  const random = createSeededRandom(seed);
  const site = siteOf(input.url);
  const clause = clauseOf(input.feature);
  const kind = CRITERION_KINDS[Math.floor(random() * CRITERION_KINDS.length)];
  // The clause is quoted in all three, and not only in the one that is about text: the
  // user's own words are the one part of a criterion this file did not choose, and a feature
  // described as “making checkout feel easy” would otherwise read as the judgement that
  // {@link readCriterion} refuses. A quoted span is page copy, and is read as such.
  const criterion = {
    element: `A confirmation banner naming “${clause}” is visible on the page.`,
    url: `The address bar reads a URL under ${site.origin} naming “${clause}”.`,
    text: `The page shows the text “${clause}”.`,
  }[kind];
  return parseGoal({
    task: `A person who came to ${site.host} attempts ${clause}.`,
    successCriterion: criterion,
  });
};

const documentOf = (input: GoalAskInput): string => {
  const site = siteOf(input.url);
  const asked = [
    'Read a website and the feature somebody wants tested on it, and write the goal a swarm of simulated people will be given.',
    '',
    '## The site',
    '',
    site.href,
    '',
    '## The feature, in the words it was typed in',
    '',
    trimmed(input.feature),
    '',
    '## What to answer',
    '',
    '- `task`: what the people attempt, in one plain sentence and in the words a person would use.',
    `- \`successCriterion\`: what has to be **observable in the page** for one attempt to count as a success, in one plain sentence. ${WHAT_WAS_ASKED_FOR[0].toUpperCase()}${WHAT_WAS_ASKED_FOR.slice(1)}.`,
    '- A judgement is not a criterion. “The page feels trustworthy”, “the user understands the pricing” and “checkout is easy” cannot be evaluated by anybody watching the page, and a completion rate computed against one of them means nothing.',
    '- Both fields are required, and each is one sentence. A field left out, carrying two sentences or carrying a type other than the one asked for is refused with the path named rather than filled in for you.',
  ];
  if (input.sentBack === undefined) return asked.join('\n');
  return [
    ...asked,
    '',
    '## The criterion you wrote, sent back',
    '',
    input.sentBack.criterion,
    '',
    input.sentBack.reason,
    '',
    'Write both sentences again, with a success criterion naming one of those three. Do not restate the criterion above, and do not explain it: name the element, the URL or the text instead.',
  ].join('\n');
};

/**
 * One goal ask: the document, the shape, the validator and the offline generator.
 *
 * It is exported beside {@link writeGoal} so that the send-back is an ordinary ask — build
 * it with `sentBack` and read the words it sends — and so that a caller holding a provider
 * of its own needs nothing from this file but the ask.
 */
export const goalAsk = (input: GoalAskInput): WonderAsk<Goal> => {
  if (trimmed(input.feature) === '') {
    throw new TypeError(
      'a goal is written about a feature, and this ask carries none: an empty feature box is a form the user has not filled in, not a task to invent on their behalf',
    );
  }
  // Read here as well as in the document, so an unusable URL is refused when the ask is
  // built rather than when a provider gets round to it.
  siteOf(input.url);
  return {
    use: 'goal',
    document: documentOf(input),
    seed: input.seed,
    replySchema: { name: GOAL_REPLY_SCHEMA_NAME, schema: jsonSchemaOf(goalReplySchema) },
    effort: input.effort ?? GOAL_EFFORT,
    parse: parseGoal,
    offline: (seed) => offlineGoal(input, seed),
  };
};

/** What two calls spent together, as the five figures one reply reports. */
const bothCalls = (first: DecisionUsage, second: DecisionUsage): DecisionUsage => {
  // Through the run's own total, so a figure renamed on either side stops compiling rather
  // than quietly halving what a goal cost. `calls` is the one field a reply has no room for:
  // a `WonderReply` reports what it spent, and how many calls that took is this file's.
  const total = totalUsage([first, second]);
  return {
    inputTokens: total.inputTokens,
    cachedInputTokens: total.cachedInputTokens,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningTokens,
    estimatedCostUsd: total.estimatedCostUsd,
  };
};

/**
 * The goal, written through whichever implementation is behind the seam: **one send-back,
 * then a refusal** (`docs/FLOW.md` section 12).
 *
 * The first reply's criterion is read by {@link readCriterion}. Observable, and that is the
 * goal. Not observable, and the same ask goes out again carrying the criterion and the
 * sentence saying what was asked for instead — one more call, never two — and an observable
 * second criterion is the goal, reported with **both calls' usage** in the five figures,
 * because a send-back is something the run paid for and not something it got free. A second
 * unobservable criterion is a {@link GoalCriterionError}: no criterion is invented, no goal
 * comes back half-formed, and the reason is a sentence a screen shows unchanged.
 */
export const writeGoal = async (
  provider: WonderProvider,
  input: GoalAskInput,
): Promise<WonderReply<Goal>> => {
  const first = await provider.ask(goalAsk(input));
  const read = readCriterion(first.value.successCriterion);
  if (read.observable) return first;

  const second = await provider.ask(
    goalAsk({
      ...input,
      sentBack: { criterion: first.value.successCriterion, reason: read.reason },
    }),
  );
  const usage = bothCalls(first.usage, second.usage);
  const reread = readCriterion(second.value.successCriterion);
  if (reread.observable) return { ...second, usage };

  const refused = [first.value.successCriterion, second.value.successCriterion];
  throw new GoalCriterionError({
    reason: `The success criterion was sent back once and came back unobservable again — “${refused[0]}”, then “${refused[1]}” — so this goal is refused rather than run against a criterion no session can evaluate: ${WHAT_WAS_ASKED_FOR}.`,
    refused,
    model: second.model,
    usage,
  });
};
