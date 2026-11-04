import { agentsNoun, browsersNoun, runsNoun } from '@/screens/sites/words';
import type { SiteCaps, SiteCheck, SiteRecord } from '@/sites/store';

/**
 * How `#screen-site` reads: the four ways to prove a site, the exact line to copy for each,
 * and what the platform's last check is said to have found.
 *
 * **The token is public and is printed whole.** It is not a credential — it is the thing the
 * user publishes on the address they control, and a line to copy with a truncated token in
 * it is a line that does not work (`packages/platform/src/site/token.ts`).
 *
 * **No number in here is a cap**, and there is no branch on `verification.state` that
 * reaches one. Every figure the state line states arrives as `caps` on the platform's
 * answer and is identical for a verified and an unverified site — decision 71, as the owner
 * settled it on **2026-11-03**: _no gate on testing_, because the caps protect the site
 * being driven rather than the person who asked. What verification is worth is one line of
 * words, not a bigger number.
 *
 * The nouns beside those figures are the Sites screen's, read from its own words rather
 * than written twice: the two screens state the same three caps about the same site, and
 * "1 run an hour" and "4 runs an hour" are the same cap said correctly in both places.
 */

/** The name of the TXT record, the meta tag and the well-known file. Section 13 fixes it. */
const VERIFICATION_NAME = 'personavision-site-verification';

/** What a site serves the token at, as `packages/platform/src/site/check-file.ts` fetches it. */
const VERIFICATION_FILE_PATH = `/.well-known/${VERIFICATION_NAME}.txt`;

/** `3 Nov 09:04`, in the reader's own time zone and on the clock the rest of the app prints. */
const when = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** An instant as a reader reads it, or `null` for one that is not an instant at all. */
const instant = (at: string): string | null => {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : when.format(parsed);
};

/** The host of the site, or the whole URL for a record this build cannot parse. */
export const siteHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** The origin of the site, which is where `.well-known` lives, whatever path was added. */
const siteOrigin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** The four methods of `docs/FLOW.md` section 13, by the names the platform runs them under. */
export type MethodId = 'dns-txt' | 'meta-tag' | 'well-known-file' | 'connected-repository';

export interface VerifyMethod {
  readonly id: MethodId;
  /** The heading `#screen-site` gives this block. */
  readonly heading: string;
  /** The tag beside that heading, or `null` for a method the prototype draws without one. */
  readonly tag: { readonly words: string; readonly kind: 'success' | 'info' } | null;
  /** What the user does, in the prototype's own words. */
  readonly explain: (site: SiteRecord) => string;
  /**
   * The exact line to copy, with this site's own token in it — or `null` for the GitHub
   * method, where what the user publishes is an app installation rather than a string.
   */
  readonly line: ((site: SiteRecord) => string) | null;
  /** What its check button says. */
  readonly check: string;
}

/**
 * `beta.clipforge.example.  TXT  "personavision-site-verification=pv_7f3c91a2d84e"` — a zone
 * file line, spaced as the prototype spaces it so it can be pasted into a DNS form or a zone.
 */
const dnsLine = (site: SiteRecord): string =>
  `${siteHost(site.url)}.  TXT  "${VERIFICATION_NAME}=${site.token}"`;

export const METHODS: readonly VerifyMethod[] = [
  {
    id: 'dns-txt',
    heading: 'DNS TXT record',
    tag: { words: 'Recommended', kind: 'success' },
    // Not "on clipforge.example": which part of a hostname is the domain somebody owns is
    // a question no browser can answer (`example.co.uk` is two labels of public suffix), and
    // the platform does not need it answered — it resolves the host and then each parent
    // above it (`verificationDomains`), so a record on either place verifies the site. The
    // sentence names the host, which is the line above it, and says the parent works too.
    explain: (site) =>
      `Add this record on ${siteHost(site.url)}, or on any domain above it — we look at both. It covers every site on the domain, and it survives a deploy.`,
    line: dnsLine,
    check: 'Check the record',
  },
  {
    id: 'meta-tag',
    heading: 'Meta tag',
    explain: () => 'Put this in the <head> of the page above. We fetch the page once and read it.',
    tag: null,
    line: (site) => `<meta name="${VERIFICATION_NAME}" content="${site.token}">`,
    check: 'Check the page',
  },
  {
    id: 'well-known-file',
    heading: 'File',
    tag: null,
    explain: () => 'Serve this file with the token as its only contents.',
    line: (site) => `${siteOrigin(site.url)}${VERIFICATION_FILE_PATH}`,
    check: 'Check the file',
  },
  {
    id: 'connected-repository',
    heading: 'Connect the GitHub repository',
    tag: { words: 'Also unlocks Improve my site', kind: 'info' },
    explain: () =>
      'Install the PersonaVision app on the repository that deploys this site. One repository, read and write to pull requests, and it never merges anything.',
    line: null,
    check: 'Check the connection',
  },
];

/**
 * What the last check of this method found: _"Last check: no TXT record found on
 * clipforge.example at 3 Nov 09:04."_
 *
 * The sentence is the platform's, written once in `packages/platform` so that this screen,
 * the Sites screen and the CLI say the same words — and it carries no full stop and no clock,
 * because the punctuation and the reader's time zone belong to whoever is printing it. A
 * check that **passed** is printed too: a reader who has just pressed the button is owed the
 * answer whichever way it went, and nothing on this screen says "something went wrong".
 */
export const checkWords = (check: SiteCheck): string => {
  const at = instant(check.checkedAt);
  return at === null ? `Last check: ${check.sentence}.` : `Last check: ${check.sentence} at ${at}.`;
};

/** The three figures that bind this site, as one line: the platform's numbers, our nouns. */
export const capWords = (caps: SiteCaps): string =>
  [
    `${String(caps.agentsPerRun)} ${agentsNoun(caps.agentsPerRun)}`,
    `${String(caps.runsPerSitePerHour)} ${runsNoun(caps.runsPerSitePerHour)}`,
    `${String(caps.concurrentSessionsPerSite)} ${browsersNoun(caps.concurrentSessionsPerSite)}`,
  ].join(' · ');
