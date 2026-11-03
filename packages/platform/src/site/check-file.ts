import {
  foundTheLine,
  noAnswer,
  nothingPublished,
  otherValues,
  siteCheckResult,
} from './checks.js';
import type {
  CheckedSite,
  SiteCheck,
  SiteCheckDeps,
  SiteCheckFinding,
  SiteCheckSubject,
  SiteCheckTarget,
} from './checks.js';
import { fetchOnce } from './fetch-once.js';
import { SITE_VERIFICATION_NAME } from './token.js';

/**
 * The well-known-file check: the third of `docs/FLOW.md` section 13's four methods, for the
 * user who can put a file on their server but cannot add a tag to a rendered page.
 *
 * The user serves `/.well-known/personavision-site-verification.txt` with the token as its
 * only contents; this fetches **that URL, once**, under the shared policy of `fetch-once.ts`,
 * and compares the body, trimmed, with this site's token.
 *
 * The path is on the site's **origin** and not under its path — `#screen-site` prints
 * `https://beta.clipforge.example/.well-known/personavision-site-verification.txt` for a site
 * added as `https://beta.clipforge.example/create`, because that is where `.well-known` lives
 * (RFC 8615) and where a server is configured to serve it from.
 */

/** As the sentences name it: "no file found on …", "the files on … do not include …". */
const FILE: SiteCheckSubject = { one: 'file', many: 'files' };

/** The path, composed from the one name `token.ts` fixes rather than spelled a second time. */
export const SITE_VERIFICATION_FILE_PATH = `/.well-known/${SITE_VERIFICATION_NAME}.txt`;

/**
 * The URL the user is told to serve, which is also the URL this check fetches.
 *
 * One string for both, so what `#screen-site` prints and what the platform asks for cannot
 * drift apart. A stored site's URL is always one `parseSiteUrl` accepted, so it always
 * resolves; the fallback is for a record written by hand, and it asks for what is there
 * rather than throwing — a check reports, it does not fail.
 */
export const siteVerificationFileUrl = (url: string): string => {
  try {
    return new URL(SITE_VERIFICATION_FILE_PATH, url).href;
  } catch {
    return `${url.replace(/\/+$/, '')}${SITE_VERIFICATION_FILE_PATH}`;
  }
};

export const checkWellKnownFile: SiteCheck = async (site: CheckedSite, deps: SiteCheckDeps) => {
  // The token itself, not a `name=value` pair: the file's whole contents are the token, which
  // is what the screen says and what this compares.
  const lookedFor = site.token;
  const file = siteVerificationFileUrl(site.url);
  const lookedIn: readonly SiteCheckTarget[] = [{ kind: 'url', value: file }];
  const result = (found: SiteCheckFinding, sentence?: string) =>
    siteCheckResult({
      method: 'well-known-file',
      subject: FILE,
      lookedFor,
      lookedIn,
      found,
      at: deps.now(),
      ...(sentence === undefined ? {} : { sentence }),
    });

  const fetched = await fetchOnce({
    url: file,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.fetchTimeoutMs === undefined ? {} : { timeoutMs: deps.fetchTimeoutMs }),
  });
  // The file could not be read, so what it holds is **unknown**. A 404 lands here too, with
  // its own clause — _"it answered 404"_ — because a path that is not served and a server
  // that refused the connection are different things to go and fix.
  if (!fetched.ok) return result(noAnswer([file], fetched.because));

  const contents = fetched.body.trim();
  if (contents === lookedFor) return result(foundTheLine([fetched.from]));
  if (contents === '') {
    // Served, and empty. "No file found" would be false — the file is there — so this is the
    // one sentence of this check that is not the shared wording: the user has the path right
    // and the contents to add.
    return result(nothingPublished([fetched.from]), `the file on ${fetched.from} is empty`);
  }
  // Something else is in it: an old token, a whole HTML page from a catch-all route that
  // answers 200 for every path, the token with a comment around it. Quoted back, clipped by
  // `checks.ts`, because what is in it instead is the half a user cannot see from here.
  return result(otherValues([fetched.from], [contents]));
};
