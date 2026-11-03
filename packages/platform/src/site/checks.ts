import type {
  SiteCheckFinding,
  SiteCheckResult,
  SiteCheckTarget,
  SiteVerificationMethod,
} from '../store/types.js';

/**
 * The check seam: one shape for all four methods of `docs/FLOW.md` section 13, and the one
 * place a check's sentence is composed.
 *
 * A check is **a function from a site to a result**, and a failed check is a result rather
 * than an exception — because the thing a screen has to print is not "the check threw", it is
 * _what we looked for, where we looked, and what we found instead_. The prototype's promise
 * on `#screen-site` — _"A failed check says what it looked for, where, and what it found
 * instead. Nothing here is 'something went wrong'"_ — is a promise about this object, so the
 * four outcomes of `SiteCheckOutcome` are the whole vocabulary and there is no fifth for
 * "unexpected".
 *
 * Everything a check reaches for is **passed in**: a resolver and a clock today, and the
 * fetcher the two HTTP checks of the tickets that follow #236 will need, added to
 * `SiteCheckDeps` by whichever of them lands first. Nothing here reads the environment, opens
 * a socket of its own or asks the time — so every test of a check is offline, and the one
 * place the real resolver is built is `defaultSiteCheckDeps` in `verify.ts`.
 *
 * The sentences live here rather than in each check, so that the four methods answer in one
 * voice: a check supplies the **noun** for what it looks for ("TXT record", "meta tag") and
 * the finding, and the wording is this module's.
 */

export type {
  SiteCheckFinding,
  SiteCheckOutcome,
  SiteCheckResult,
  SiteCheckTarget,
} from '../store/types.js';

/**
 * What a check reads of a site: the address it is proving and the token to look for.
 *
 * Narrower than `SiteRecord` — which satisfies it structurally — so that a test of a check
 * states the two things the check actually uses rather than building a whole stored record.
 */
export interface CheckedSite {
  /** The URL as the user typed it. Its host is what a DNS check looks up. */
  readonly url: string;
  /** This site's token, from which the line to look for is composed. */
  readonly token: string;
}

/** TXT records for a name, shaped as `node:dns/promises`' `resolveTxt` answers them. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

/** What the checks are given instead of reaching for the world themselves. */
export interface SiteCheckDeps {
  readonly resolveTxt: TxtResolver;
  /** The clock, so `checkedAt` is the caller's and a test can fix it. */
  readonly now: () => Date;
}

/** A check: a site in, a result out. It does not throw for a site that fails it. */
export type SiteCheck = (site: CheckedSite, deps: SiteCheckDeps) => Promise<SiteCheckResult>;

/**
 * What a method looks for, named as its sentences name it — _"no **TXT record** found on …"_,
 * _"the **TXT records** on … do not include …"_. English needs both numbers, so a check gives
 * both rather than this module guessing a plural.
 */
export interface SiteCheckSubject {
  readonly one: string;
  readonly many: string;
}

/**
 * `a`, `a and b`, `a, b or c` — the places a sentence names.
 *
 * Both joiners, because the outcomes need different ones: nothing was found on `a` **or**
 * `b`, while `a` **and** `b` are what published something else or did not answer.
 */
const places = (at: readonly string[], joiner: 'and' | 'or'): string => {
  if (at.length === 0) return 'this site';
  if (at.length === 1) return at[0] ?? 'this site';
  return `${at.slice(0, -1).join(', ')} ${joiner} ${at[at.length - 1] ?? ''}`;
};

/**
 * The finding as one sentence. The four outcomes each get their own, which is the screen
 * contract: a check that did not pass and a host that did not answer do not share a line.
 */
const sentenceFor = (
  subject: SiteCheckSubject,
  lookedFor: string,
  found: SiteCheckFinding,
): string => {
  switch (found.outcome) {
    case 'found':
      return `the ${subject.one} on ${places(found.at, 'and')} carries ${lookedFor}`;
    case 'other-values':
      return `the ${subject.many} on ${places(found.at, 'and')} do not include ${lookedFor}`;
    case 'nothing-published':
      return `no ${subject.one} found on ${places(found.at, 'or')}`;
    case 'no-answer':
      // A reason is always given for this outcome; the fallback is the compiler's, not a
      // state a check can reach. It still names the check rather than blaming the user.
      return `${places(found.at, 'and')} did not answer: ${
        found.because ?? `the ${subject.one} could not be read`
      }`;
  }
};

/** How many published values are quoted back. A zone file is not a sentence. */
const MAX_VALUES = 8;

/** How much of one value is quoted back. */
const MAX_VALUE_CHARS = 200;

const clipped = (value: string): string =>
  value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS)}…`;

/** The line was published where we looked. The one finding that verifies a site. */
export const foundTheLine = (at: readonly string[]): SiteCheckFinding => ({
  outcome: 'found',
  at,
  values: [],
  because: null,
});

/**
 * Something is published there and none of it is the line.
 *
 * The values are quoted back, because "what it found instead" is the whole point — but
 * capped, because a TXT record set can be kilobytes and this is stored on the site record.
 */
export const otherValues = (
  at: readonly string[],
  values: readonly string[],
): SiteCheckFinding => ({
  outcome: 'other-values',
  at,
  values: values.slice(0, MAX_VALUES).map(clipped),
  because: null,
});

/** The address answered, and publishes nothing of this kind at all. */
export const nothingPublished = (at: readonly string[]): SiteCheckFinding => ({
  outcome: 'nothing-published',
  at,
  values: [],
  because: null,
});

/** The address did not answer, and this is why — its own sentence, per the screen contract. */
export const noAnswer = (at: readonly string[], because: string): SiteCheckFinding => ({
  outcome: 'no-answer',
  at,
  values: [],
  because,
});

/**
 * A result, with `passed` and `sentence` derived rather than passed in — so a check cannot
 * hand back a finding of `other-values` that claims to have passed, and every method's
 * sentence is written in one place.
 */
export const siteCheckResult = ({
  method,
  subject,
  lookedFor,
  lookedIn,
  found,
  at,
}: {
  method: SiteVerificationMethod;
  subject: SiteCheckSubject;
  lookedFor: string;
  lookedIn: readonly SiteCheckTarget[];
  found: SiteCheckFinding;
  /** The moment the check ran, from the injected clock. */
  at: Date;
}): SiteCheckResult => ({
  method,
  passed: found.outcome === 'found',
  lookedFor,
  lookedIn,
  found,
  sentence: sentenceFor(subject, lookedFor, found),
  checkedAt: at.toISOString(),
});
