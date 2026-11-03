import type { SiteCheck, SiteLastTest, SiteVerification } from '@/sites/store';

/**
 * How a site's card reads: the one place the Sites screen's sentences are composed.
 *
 * **No number in here is a cap.** Every figure the card states arrives on the platform's
 * answer (`caps` on a site); what these helpers decide is the *noun* beside it, because
 * "1 run an hour" and "4 runs an hour" are the same cap said correctly. A screen that chose
 * a number would be a screen that one day disagrees with the thing that enforces it.
 */

/** `24 Oct`, in the reader's own time zone and in the locale every figure in this app uses. */
const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });

/** `09:12`, on the twenty-four-hour clock the rest of the product prints. */
const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** An instant as a reader reads it, or `null` for one that is not an instant at all. */
const whenWords = (at: string): string | null => {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : `${day.format(parsed)} ${time.format(parsed)}`;
};

/**
 * The address on the card, which is the address the user typed with two things taken off it:
 * the scheme, because `https://` is eleven characters that are the same on every card, and
 * any user and password in it, because a card is read over somebody's shoulder and a
 * screenshot keeps what is on it. The whole stored URL is on the Add-a-site screen's own
 * field, which is where a site's address is edited.
 *
 * The path stays: a site is *the page the feature starts on*, and two sites on one host are
 * two different pages (the auto-decision of 2026-11-04 on #267). A lone trailing slash goes,
 * since `example.com/` and `example.com` are the same address written twice.
 *
 * A URL the browser cannot parse is printed exactly as it is stored rather than silently
 * patched: the platform only stores an absolute `http:` or `https:` URL, so this is the
 * answer to a record from some future that this build does not understand.
 */
export const siteName = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const written = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return written.endsWith('/') ? written.slice(0, -1) : written;
};

/** The four ways a site can be proved, in the words a reader of the card gets. */
const METHOD_WORDS: Readonly<Record<string, string>> = {
  'dns-txt': 'DNS',
  'meta-tag': 'a meta tag',
  'well-known-file': 'a file',
  'connected-repository': 'the GitHub repository',
};

/**
 * The card's microlabel: `Verified by DNS · 2 Nov`, or `Unverified`.
 *
 * Both halves can be missing from a verified site and neither is invented: a state with no
 * method reads `Verified`, and one with no instant leaves the date off. A method this build
 * does not know is named as the platform spells it rather than dropped, because "verified by
 * something" is less use to a reader than the platform's own word for it.
 */
export const verificationWords = (verification: SiteVerification): string => {
  if (verification.state !== 'verified') return 'Unverified';
  const { method, verifiedAt } = verification;
  const by = method === null ? '' : ` by ${METHOD_WORDS[method] ?? method}`;
  const at = verifiedAt === null ? null : new Date(verifiedAt);
  const on = at === null || Number.isNaN(at.getTime()) ? '' : ` · ${day.format(at)}`;
  return `Verified${by}${on}`;
};

/** `agents per run allowed`, said for one agent as well as for a hundred. */
export const agentsNoun = (agents: number): string =>
  agents === 1 ? 'agent per run allowed' : 'agents per run allowed';

/** `runs an hour`. */
export const runsNoun = (runs: number): string => (runs === 1 ? 'run an hour' : 'runs an hour');

/** `browsers at a time`. */
export const browsersNoun = (browsers: number): string =>
  browsers === 1 ? 'browser at a time' : 'browsers at a time';

/**
 * The quiet last line: the test this site last ran, or **nothing at all**.
 *
 * `null` where the platform has no last test to offer, and the card then draws no line —
 * not a sentence saying there has never been a test. The platform reads `lastTest` off the
 * site's launch ledger, which is trimmed to the last twenty-four hours on every write, so
 * an absent value means *nothing on record* and a site tested last week can have one. A
 * card that printed "no test yet" over a test the reader can still open in their own list
 * of tests would be a card that lies, and the absence of a line claims nothing.
 *
 * `name` is the run's own words — `run.json`'s `task.prompt`, which `GET /runs/index.json`
 * lists a test by — and it is `null` while that listing is still being read, for a test it
 * does not name, and for a listing that could not be read. The line is then the instant
 * alone, which is a shorter sentence rather than a different one: what the platform told us
 * about this site is *which run and when*, and that much is always sayable.
 */
export const lastTestWords = (
  lastTest: SiteLastTest | null,
  name: string | null,
): string | null => {
  if (lastTest === null) return null;
  const when = whenWords(lastTest.at);
  if (name === null) return when === null ? 'Tested once already' : `Last test: ${when}`;
  return when === null ? `Last test: ${name}` : `Last test: ${name} · ${when}`;
};

/**
 * What the last check found, for a check that did not find it: _"Last check: no TXT record
 * found on clipforge.example at 09:04."_
 *
 * A verified site can carry a failed check — the record was removed, a name server timed
 * out — and the card says both rather than choosing between them: a passing check is the one
 * thing that moves a site to verified and nothing moves it back (decision 89, settled as
 * _it stays verified, and the card also says what the last check found_). So the reader is
 * given the two facts and decides.
 *
 * The sentence is the platform's, written once there so that this card, the Add-a-site
 * screen and the CLI say the same words. What is added here is the punctuation and the
 * reader's own clock, which is what the platform deliberately leaves off — with the **day**
 * beside the time, because a check that failed at 09:04 last Tuesday reads as this morning
 * without it, and the card is the one place a reader meets it out of context.
 *
 * `null` for a site nobody has checked and for a check that passed: a check that found what
 * it looked for is already said by the microlabel above it.
 */
export const lastCheckWords = (lastCheck: SiteCheck | null): string | null => {
  if (lastCheck === null || lastCheck.passed) return null;
  const at = whenWords(lastCheck.checkedAt);
  return at === null
    ? `Last check: ${lastCheck.sentence}.`
    : `Last check: ${lastCheck.sentence} at ${at}.`;
};
