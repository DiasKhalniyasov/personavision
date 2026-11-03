/**
 * Sites: a URL that belongs to a workspace, its verification token, and its verification
 * state (`docs/FLOW.md` section 13).
 *
 * The module's entry point: all four of section 13's checks — the DNS TXT record, the meta
 * tag, the well-known file and a connected repository — and the one fetch policy the two
 * HTTP checks share, reached from here rather than one file at a time from outside.
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
  SiteFetch,
  TxtResolver,
} from './checks.js';

export { checkDnsTxt, nodeTxtResolver, verificationDomains } from './check-dns.js';

export { checkMetaTag, siteVerificationMetaTag } from './check-meta.js';

export {
  checkWellKnownFile,
  SITE_VERIFICATION_FILE_PATH,
  siteVerificationFileUrl,
} from './check-file.js';

export { BODY_LIMIT_BYTES, FETCH_TIMEOUT_MS, fetchOnce, nodeFetch } from './fetch-once.js';
export type { FetchedBody } from './fetch-once.js';

export { checkConnectedRepository } from './check-repository.js';

export { noSiteConnections, storedSiteConnections } from './connections.js';
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
