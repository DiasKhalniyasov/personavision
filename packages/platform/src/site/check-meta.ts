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
 * The meta-tag check: the second of `docs/FLOW.md` section 13's four methods, for the user
 * who can deploy a line of HTML sooner than they can edit a DNS zone.
 *
 * The user puts `<meta name="personavision-site-verification" content="<token>">` in the
 * `<head>` of the page they added; this fetches **that URL, once**, under the shared policy
 * of `fetch-once.ts`, and looks for a tag of that name carrying this site's token.
 *
 * The URL fetched is the site's own URL as the user typed it — `#screen-site` says _"Put this
 * in the `<head>` of the page above. We fetch the page once and read it."_, and "the page
 * above" is the URL in the form on that screen, not its origin.
 *
 * ponytail: the tag is found by a **tolerant scan over the fetched bytes** rather than by an
 * HTML parser, so no dependency is added for it. The known ceiling is that a token inside an
 * HTML comment, a `<script>` string or a `<textarea>` counts — which is a page the user
 * themselves wrote the token into, so it proves what the check is there to prove, but it is
 * not what the tag means. If that ever matters, the upgrade is a parser behind this same
 * function and no caller changes.
 */

/** As the sentences name it: "no meta tag found on …", "the meta tags on … do not include …". */
const META_TAG: SiteCheckSubject = { one: 'meta tag', many: 'meta tags' };

/**
 * The line the user is told to install, which is also the line this check looks for.
 *
 * One string for both, so what `#screen-site` prints to copy and what the platform searches
 * for cannot drift apart: the screen's `<code class="tokenline">` is this, and so is the
 * result's `lookedFor`.
 */
export const siteVerificationMetaTag = (token: string): string =>
  `<meta name="${SITE_VERIFICATION_NAME}" content="${token}">`;

/** Every `<meta …>` element in the bytes, however it is spelled and wrapped. */
const META_ELEMENT = /<meta\b[^>]*>/gi;

/** One attribute of one element: double-quoted, single-quoted or bare. */
const ATTRIBUTE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * The `content` of every meta element whose `name` is the verification name, in the order the
 * page states them — a page may carry more than one, and a user who changed the token without
 * removing the old tag has two.
 *
 * Attribute order is not assumed (`content` before `name` is as valid), the attribute names
 * are matched case-insensitively as HTML has them, and a tag of the right name with no
 * `content` at all is an empty string rather than a tag we did not see: the user did install
 * something, and _"the meta tags … do not include …"_ is the honest answer about it.
 */
const verificationContents = (html: string): readonly string[] => {
  const contents: string[] = [];
  for (const element of html.match(META_ELEMENT) ?? []) {
    const attributes = new Map<string, string>();
    for (const [, key, quoted, singled, bare] of element.matchAll(ATTRIBUTE)) {
      // First spelling wins, as a browser's parser does with a repeated attribute.
      const name = (key ?? '').toLowerCase();
      if (!attributes.has(name)) attributes.set(name, quoted ?? singled ?? bare ?? '');
    }
    if (attributes.get('name')?.trim().toLowerCase() === SITE_VERIFICATION_NAME) {
      contents.push(attributes.get('content') ?? '');
    }
  }
  return contents;
};

export const checkMetaTag: SiteCheck = async (site: CheckedSite, deps: SiteCheckDeps) => {
  const lookedFor = siteVerificationMetaTag(site.token);
  const page = site.url;
  const lookedIn: readonly SiteCheckTarget[] = [{ kind: 'url', value: page }];
  const result = (found: SiteCheckFinding, sentence?: string) =>
    siteCheckResult({
      method: 'meta-tag',
      subject: META_TAG,
      lookedFor,
      lookedIn,
      found,
      at: deps.now(),
      ...(sentence === undefined ? {} : { sentence }),
    });

  const fetched = await fetchOnce({
    url: page,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.fetchTimeoutMs === undefined ? {} : { timeoutMs: deps.fetchTimeoutMs }),
  });
  // The page could not be read, so whether the tag is on it is **unknown** — not "no meta tag
  // found", which would send a user to re-install a tag they have already installed. The
  // policy's clause is the reason, and every way a request can end has its own.
  if (!fetched.ok) return result(noAnswer([page], fetched.because));

  const contents = verificationContents(fetched.body);
  // Trimmed, because an attribute wrapped across lines in a template carries the newline with
  // it, and the token the user pasted is the token whatever whitespace is around it.
  if (contents.some((content) => content.trim() === site.token)) {
    // `fetched.from` rather than `page`: on a same-origin redirect the tag was read from the
    // address that answered, and that is the address worth naming back.
    return result(foundTheLine([fetched.from]));
  }
  if (contents.length > 0) return result(otherValues([fetched.from], contents));
  // The page answered and carries no tag of this name at all. For a page served by a single
  // page application this is also what an un-rendered shell looks like, which is why the
  // sentence names the page rather than declaring the tag missing from the site.
  return result(nothingPublished([fetched.from]));
};
