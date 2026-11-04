import type { SiteCaps, SiteLastTest } from '@/sites/store';

/**
 * How a site reads, wherever it is read: the one place these sentences are composed.
 *
 * The Sites screen's cards, the site's own page and the audience step of `/new` all describe
 * the same record, so they describe it in the same words.
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

/**
 * The card's microlabel: `Added 2 Nov` — when this site joined the workspace.
 *
 * `null` for an instant that is not one, and the card then draws no microlabel: the day a
 * site was added is a fact about it, and a reader is better served by the line being absent
 * than by the word "Added" over nothing.
 */
export const addedWords = (createdAt: string): string | null => {
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? null : `Added ${day.format(at)}`;
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
 * The three figures that bind this site, as one line: the platform's numbers, our nouns.
 *
 * Here rather than on either screen, because the site's own page and the audience step of
 * `/new` state the same three caps about the same site, and _"1 run an hour"_ and _"4 runs
 * an hour"_ are the same cap said correctly in both places.
 */
export const capWords = (caps: SiteCaps): string =>
  [
    `${String(caps.agentsPerRun)} ${agentsNoun(caps.agentsPerRun)}`,
    `${String(caps.runsPerSitePerHour)} ${runsNoun(caps.runsPerSitePerHour)}`,
    `${String(caps.concurrentSessionsPerSite)} ${browsersNoun(caps.concurrentSessionsPerSite)}`,
  ].join(' · ');
