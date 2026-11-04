import { addedWords, whenWords } from '@/screens/sites/words';
import type { SiteRecord } from '@/sites/store';

/**
 * How `#screen-site` reads: the two sentences this screen composes about the site it is
 * showing, and nothing else.
 *
 * **A site is a URL and nothing more.** Nothing here asks a reader to prove anything about
 * the address, because there is nothing to prove (`docs/FLOW.md` section 13, and the owner's
 * input of **2026-11-04**) — what this screen says about a site is what it *is*: the URL, the
 * day it was added, the test it last ran, and the figures it is bound by.
 *
 * **No figure and no instant is composed here.** The caps are `caps` on the platform's
 * answer and the clock is the Sites screen's own (`screens/sites/words`), so the site's
 * page, a card and the audience step of `/new` describe the same site in the same words —
 * down to how one `lastTest.at` is spelled.
 */

/**
 * Why there is no way to edit the URL in front of it, in the prototype's own words.
 *
 * No route updates a site's URL — #269 settled that, and the owner's input of 2026-11-04
 * does not change it — so the field is read-only and this is what a reader does instead.
 */
const ANOTHER_SITE = 'To test a different URL, add another site.';

/**
 * The line under the read-only URL: when this site was added, the test it last ran, and
 * what to do about an address that is wrong.
 *
 * **Nothing is claimed about a site with no last test.** The platform reads `lastTest` off a
 * launch ledger trimmed to the last day, so an absent value is _nothing on record_ rather
 * than a site never tested — a site tested last week has none — and a line reading "no tests
 * yet" over a test still in the reader's own list would be a line that lies. The clause is
 * simply absent, which claims nothing, as a card on the Sites screen leaves it out.
 */
export const siteFootnote = (site: SiteRecord): string => {
  const added = addedWords(site.createdAt);
  const tested = site.lastTest === null ? null : whenWords(site.lastTest.at);
  const head = added === null ? 'Added to this workspace' : added;
  return tested === null
    ? `${head}. ${ANOTHER_SITE}`
    : `${head} · last test ${tested}. ${ANOTHER_SITE}`;
};
