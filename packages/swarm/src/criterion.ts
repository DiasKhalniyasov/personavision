/**
 * Whether a session **observed** the success criterion its run was given — read off what the
 * session already captured, with no browser and no second look at the page.
 *
 * This is the other half of the goal (`docs/FLOW.md` section 12). `writeGoal` makes a model
 * state a criterion that is observable in the page — a visible element, a URL, a piece of
 * text — and `readCriterion` (`@personavision/provider`, #259) is the rule that says which of
 * the three one sentence is. This module answers the question that follows: **was it there?**
 *
 * It exists because a completion rate computed against nothing means nothing. Before it, a
 * one-URL run derived a single `page` step and `completed = step === finalStepId` matched the
 * moment the page loaded: every session of every one-URL run was a success with no action
 * taken, and the figure the product leads with was 100% by construction (#400).
 *
 * **What a screen offers.** Exactly what a capture holds: the extracted elements' accessible
 * names and visible text, and the address the screen was at. Nothing opens a browser, probes
 * a selector or evaluates script, so the same rule holds for a live run, for a replayed
 * capture set and for the offline engine — and a session already written to disk can be
 * re-read against a criterion without being walked again.
 *
 * **How a criterion becomes something to look for.** Its *terms*:
 *
 * - a **quoted span** is page copy by definition and is taken whole — `the “Create video”
 *   button is visible` looks for `create video` and not for two words that happen to be near
 *   each other;
 * - a **path or address**, for a criterion `readCriterion` called a URL — `the address bar
 *   reads /checkout/success` looks for `/checkout/success` in the address;
 * - otherwise the criterion's **content words**: its own words with the scaffolding removed —
 *   the articles and auxiliaries, the visibility vocabulary that makes a noun into a claim
 *   (`is visible`, `is shown`), the words naming the page itself and the words naming the
 *   three kinds (`text`, `url`, `address bar`). What is left is what the sentence is about.
 *
 * **Every term has to be there.** A criterion is observed when all of its terms are on one
 * screen, each matched where one word is the other's beginning — so `price` answers for
 * `prices` and for `priced`, and `confirm` for `confirmation`. Not *any* term: a site whose
 * navigation says *Pricing* would otherwise satisfy "the pricing page is shown, with at least
 * one plan's price visible" on its home page, which is the defect this module exists to
 * remove.
 *
 * **It errs towards not observed.** A criterion naming a control by a category word the page
 * never utters — `the checkout link is visible`, on a page that says *Checkout* but never
 * *link* — is read as not observed. That is deliberate: a session wrongly called a success
 * puts a number on a screen that a reader will believe, and a session wrongly called a
 * failure puts a reason beside it that names the words it looked for and did not find. The
 * second is a criterion worth rewording; the first is a product that lies.
 */

import { readCriterion } from '@personavision/provider';
import type { CriterionKind } from '@personavision/provider';

/**
 * One captured screen, as a criterion is read against it.
 *
 * A `Capture`'s elements satisfy the element shape field-for-field, so the session loop
 * passes its own capture with no adapter.
 */
export interface ObservableScreen {
  /** The step the screen is on, as the task recognised it. */
  readonly step: string;
  /** The address the screen was at: the variant's URL, or where the last action landed. */
  readonly url: string;
  /** What the capture extracted: each element's accessible name and its visible text. */
  readonly elements: readonly {
    readonly name?: string | null;
    readonly text?: string | null;
  }[];
}

/**
 * The criterion a run was given, read **once** before the walk: what has to be on a screen,
 * or why no screen can be searched for it.
 */
export interface CriterionToObserve {
  /** The criterion, in the words the run's goal states it. */
  readonly criterion: string;
  /** What `readCriterion` classified it as, or `null` when nothing can look for it. */
  readonly kind: CriterionKind | null;
  /** What has to be on a screen. Empty exactly when `unobservable` says why none can be. */
  readonly terms: readonly string[];
  /**
   * Why no screen can be searched for it, in `readCriterion`'s own words, or in this
   * module's where a criterion it accepted names nothing to look for; `null` when one can.
   */
  readonly unobservable: string | null;
}

/** What one screen showed of a criterion. */
export interface CriterionSighting {
  /** Whether every term was on it. */
  readonly observed: boolean;
  /** The step of the screen it was looked for on. */
  readonly step: string;
  /** The terms the screen had, in the criterion's own words. */
  readonly found: readonly string[];
  /** The terms it did not have — what an outcome's reason says was looked for in vain. */
  readonly missing: readonly string[];
}

/** The shortest word one word may be the beginning of rather than have to equal. */
const STEM_LENGTH = 4;

/**
 * The shortest word a criterion can be about.
 *
 * Shorter than this is punctuation's leftovers and the grammar between the words that
 * matter: the `s` of `one plan’s price`, the `a` of an article, the `to` of an infinitive.
 * A term nobody meant is a term the page will not have, and a criterion is observed only
 * when every term is — so a stray letter would fail every screen there is.
 */
const SHORTEST_TERM = 3;

/**
 * What every criterion is made of besides the thing it is about: the articles, the
 * auxiliaries, the quantifiers, the words naming the page itself, the visibility vocabulary
 * that turns a noun into a claim, and the words naming the three kinds.
 *
 * The visibility and kind words are the same lists `readCriterion` reads a criterion's kind
 * from — `is visible`, `shows`, `the text`, `the address bar`. They are what makes a sentence
 * a criterion rather than a noun, which is exactly why none of them is ever on the page: a
 * page shows a receipt, it does not show the word "visible".
 *
 * The **element** words are deliberately not here. `receipt`, `cart`, `price` and `heading`
 * are things a page says, and dropping them would leave `the confirmation receipt is visible`
 * looking only for `confirmation` — satisfied by any page that mentions the one it is on.
 */
const SCAFFOLDING = new Set(
  [
    // Articles, pronouns, prepositions, conjunctions and quantifiers.
    'the',
    'a',
    'an',
    'and',
    'or',
    'nor',
    'but',
    'of',
    'in',
    'on',
    'at',
    'to',
    'for',
    'with',
    'from',
    'by',
    'into',
    'onto',
    'over',
    'under',
    'above',
    'below',
    'after',
    'before',
    'that',
    'this',
    'these',
    'those',
    'it',
    'its',
    'their',
    'there',
    'here',
    'any',
    'all',
    'both',
    'each',
    'every',
    'least',
    'most',
    'more',
    'less',
    'one',
    'two',
    'than',
    'then',
    'when',
    'while',
    'where',
    'which',
    'who',
    'whose',
    'what',
    'not',
    'no',
    'also',
    'still',
    'already',
    'own',
    'same',
    'other',
    'anywhere',
    'somewhere',
    // Auxiliaries and the copula.
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'has',
    'have',
    'had',
    'does',
    'do',
    'did',
    'can',
    'could',
    'will',
    'would',
    'should',
    'must',
    'may',
    'might',
    'get',
    'gets',
    // What every criterion is about, so never what one is about.
    'page',
    'screen',
    'site',
    'user',
    'person',
    'people',
    'agent',
    'session',
    'browser',
    'view',
    'viewport',
    'window',
    'top',
    'bottom',
    'end',
    // `readCriterion`'s visibility vocabulary: the claim, never the thing.
    'visible',
    'visibly',
    'appear',
    'appeared',
    'shown',
    'show',
    'showing',
    'display',
    'displayed',
    'displaying',
    'render',
    'rendered',
    'present',
    'contain',
    'containing',
    'include',
    'seen',
    'exist',
    'listed',
    'highlighted',
    'enabled',
    'disabled',
    'checked',
    'selected',
    'read',
    'say',
    'state',
    'name',
    'load',
    'loaded',
    'open',
    'opened',
    'change',
    'changed',
    'navigate',
    'redirect',
    'land',
    'reach',
    'reaches',
    // `readCriterion`'s words for the three kinds, which name a category and not a thing.
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
    'url',
    'uri',
    'address',
    'bar',
    'query',
    'querystring',
    'slug',
  ].map((word) => singular(word)),
);

/** A quoted span: page copy, taken whole. Both the typographic and the straight pair. */
const QUOTED_SPAN = /"([^"]+)"|“([^”]+)”|‘([^’]+)’/gu;

/**
 * The punctuation a sentence puts after a term rather than the page putting it in one: the
 * full stop of `the address bar reads /checkout/success.`, and the one inside a quoted span
 * a model closed with the sentence. Dropped from a term, never from the screen, so a term
 * only ever becomes easier to find.
 */
const TRAILING_STOP = /[.,;:!?]+$/u;

/** A full address, or a path at the start of a word — the pattern `readCriterion` reads. */
const ADDRESS_SPAN = /https?:\/\/[^\s"”]+|(?:^|[\s"“'(])(\/[A-Za-z0-9._~/?&=%-]+)/gu;

/**
 * The criterion a run was given, classified and turned into terms — or the sentence saying
 * why no screen can be searched for it.
 *
 * `undefined` in, `null` out: a run with no goal has no criterion, and the old rule — the
 * final declared step — decides its sessions.
 */
export const criterionToObserve = (criterion: string | undefined): CriterionToObserve | null => {
  if (criterion === undefined || criterion.trim() === '') {
    return null;
  }
  const stated = criterion.trim();
  const reading = readCriterion(stated);
  if (!reading.observable) {
    return { criterion: stated, kind: null, terms: [], unobservable: reading.reason };
  }
  const terms = termsOf(stated, reading.kind);
  if (terms.length === 0) {
    return {
      criterion: stated,
      kind: null,
      terms: [],
      unobservable: `“${stated}” names nothing a captured screen could be searched for: a criterion a session can check names the element, the address or the words it expects to find.`,
    };
  }
  return { criterion: stated, kind: reading.kind, terms, unobservable: null };
};

/**
 * What one screen showed of the criterion: every term, or which ones were missing.
 *
 * A criterion nothing can look for is never observed, on any screen — it is not promoted to
 * a success by falling back to a weaker test, which is the whole point of #400.
 */
export const observeCriterion = (
  read: CriterionToObserve,
  screen: ObservableScreen,
): CriterionSighting => {
  const haystack = haystackOf(screen);
  const found: string[] = [];
  const missing: string[] = [];
  for (const term of read.terms) {
    (holds(term, haystack) ? found : missing).push(term);
  }
  return {
    observed: read.unobservable === null && read.terms.length > 0 && missing.length === 0,
    step: screen.step,
    found,
    missing,
  };
};

/** What a screen can be searched: its address as written, its words, and its copy as one run. */
interface Haystack {
  readonly url: string;
  readonly copy: string;
  readonly words: ReadonlySet<string>;
}

const haystackOf = (screen: ObservableScreen): Haystack => {
  const spoken: string[] = [];
  for (const element of screen.elements) {
    if (element.name != null && element.name !== '') spoken.push(element.name);
    if (element.text != null && element.text !== '') spoken.push(element.text);
  }
  const copy = fold(spoken.join(' · '));
  const url = fold(screen.url);
  return { url, copy, words: new Set([...wordsIn(copy), ...wordsIn(url)]) };
};

/**
 * Whether one term is on a screen.
 *
 * A term naming an address is looked for in the address, because that is the only place an
 * address is; a term of several words is looked for in the screen's copy as one run, and in
 * the address, because a quoted span is a phrase and not a bag of words; a single word is
 * looked for among the screen's words, where one word may be the other's beginning.
 */
const holds = (term: string, haystack: Haystack): boolean => {
  const sought = fold(term);
  if (sought.startsWith('/') || sought.startsWith('http')) {
    return haystack.url.includes(sought);
  }
  if (/[^a-z0-9]/u.test(sought)) {
    return haystack.copy.includes(sought) || haystack.url.includes(sought);
  }
  const stem = singular(sought);
  for (const word of haystack.words) {
    if (sameWord(stem, word)) return true;
  }
  return false;
};

/**
 * Two words are the same word when one is the other's beginning: `price` answers for
 * `prices` and for `priced`, and `confirm` for `confirmation`. A word shorter than
 * {@link STEM_LENGTH} has to match outright, so `tab` is not `table` and `id` is not
 * `identity`.
 */
const sameWord = (left: string, right: string): boolean => {
  const shared = Math.min(left.length, right.length);
  if (shared < STEM_LENGTH) return left === right;
  return left.slice(0, shared) === right.slice(0, shared);
};

/** What the criterion is about, as terms: a quoted span, an address, or its content words. */
const termsOf = (criterion: string, kind: CriterionKind): readonly string[] => {
  const quoted = [...criterion.matchAll(QUOTED_SPAN)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim().replace(TRAILING_STOP, ''))
    .filter((span) => span !== '');
  if (kind === 'url') {
    const addresses = [...criterion.matchAll(ADDRESS_SPAN)]
      .map((match) => (match[1] ?? match[0]).trim().replace(TRAILING_STOP, ''))
      .filter((address) => address !== '');
    if (addresses.length > 0) return [...new Set(addresses)];
  }
  if (quoted.length > 0) return [...new Set(quoted)];
  return contentWordsOf(criterion);
};

/** The criterion's own words, with the scaffolding removed and each one said once. */
const contentWordsOf = (criterion: string): readonly string[] => {
  const kept: string[] = [];
  const said = new Set<string>();
  for (const word of wordsIn(fold(criterion))) {
    const stem = singular(word);
    if (word.length < SHORTEST_TERM || SCAFFOLDING.has(stem) || said.has(stem)) continue;
    said.add(stem);
    kept.push(word);
  }
  return kept;
};

/** Accents folded and case dropped, so a page's `Café` answers for a criterion's `cafe`. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

/** The words of folded text: letters and digits, in the order they are written. */
function wordsIn(folded: string): readonly string[] {
  return folded.split(/[^a-z0-9]+/u).filter((word) => word !== '');
}

/** A plural's singular, where stripping one `s` leaves a word: `prices` → `price`. */
function singular(word: string): string {
  return word.length >= STEM_LENGTH && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}
