/**
 * Sites: a URL that belongs to a workspace, its verification token, and its verification
 * state (`docs/FLOW.md` section 13).
 *
 * The module's entry point, so that the checks the later tickets of #221 add — DNS TXT, the
 * meta tag, the well-known file and a connected repository — join it here rather than being
 * reached one file at a time from outside.
 */

export { addSite, parseSiteUrl, SiteUrlNotAcceptedError } from './site.js';
export type { SiteIssue } from './site.js';

export {
  mintSiteToken,
  SITE_TOKEN_PREFIX,
  SITE_VERIFICATION_NAME,
  siteVerificationPair,
} from './token.js';
