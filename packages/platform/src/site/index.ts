/**
 * Sites: a URL that belongs to a workspace, and nothing more (`docs/FLOW.md` section 13).
 *
 * The module's entry point. A site record is its id, its URL, its workspace, its soft delete
 * and its launch ledger — there is no token here, no check and no state to prove: the owner's
 * input of 2026-11-04 took site ownership out of the product, so the only proof of control
 * this platform asks for is the GitHub App installation, and that belongs to the connection
 * below rather than to a site.
 */

export { addSite, parseSiteUrl, SiteUrlNotAcceptedError } from './site.js';
export type { SiteIssue } from './site.js';

export { noSiteConnections, storedSiteConnections } from './connections.js';
export type { SiteConnections, SiteRepositoryConnection } from './connections.js';
