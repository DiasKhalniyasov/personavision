/**
 * Sites: a URL that belongs to a workspace, its verification token, and its verification
 * state (`docs/FLOW.md` section 13).
 *
 * The module's entry point, so that the checks the later tickets of #221 add — the meta tag,
 * the well-known file and a connected repository, beside the DNS TXT check that is here —
 * join it here rather than being reached one file at a time from outside.
 */

export { addSite, parseSiteUrl, SiteUrlNotAcceptedError } from './site.js';
export type { SiteIssue } from './site.js';

export {
  mintSiteToken,
  SITE_TOKEN_PREFIX,
  SITE_VERIFICATION_NAME,
  siteVerificationPair,
} from './token.js';

export {
  foundTheLine,
  noAnswer,
  nothingPublished,
  otherValues,
  places,
  siteCheckResult,
} from './checks.js';
export type {
  CheckedSite,
  SiteCheck,
  SiteCheckDeps,
  SiteCheckFinding,
  SiteCheckOutcome,
  SiteCheckResult,
  SiteCheckSubject,
  SiteCheckTarget,
  TxtResolver,
} from './checks.js';

export { checkDnsTxt, nodeTxtResolver, verificationDomains } from './check-dns.js';

export { checkConnectedRepository } from './check-repository.js';

export { noSiteConnections } from './connections.js';
export type { SiteConnections, SiteRepositoryConnection } from './connections.js';

export {
  AVAILABLE_SITE_VERIFICATION_METHODS,
  defaultSiteCheckDeps,
  SITE_VERIFICATION_METHODS,
  SiteCheckNotAvailableError,
  siteCheckFor,
  verifySite,
} from './verify.js';
export type { VerifiedSite } from './verify.js';
