import { mintSiteToken } from './token.js';
import type { SiteRecord, SiteStore } from '../store/types.js';

/**
 * Adding a site to a workspace: the URL that is accepted, and the record that is opened.
 *
 * A site is a URL that belongs to a workspace (`docs/FLOW.md` section 13). This module is the
 * whole of what it takes to open one, and it takes **a URL and nothing else** — the token is
 * minted here and the verification block is the store's, so there is no argument through
 * which a submitted `token`, `id` or `verification` could reach a record. That is the
 * structural half of section 13's rule that only a passing check may verify a site; the
 * checks themselves are the later tickets of #221.
 */

/** A URL that cannot be saved, and where it is wrong. The shape `AudienceIssue` already has. */
export interface SiteIssue {
  /** `url` — the field of the Add-a-site form this concerns. */
  readonly path: string;
  readonly message: string;
}

/**
 * A URL this platform will not point a swarm at, reported **at the path it is wrong at** so
 * that the Add-a-site form renders the sentence against its own field rather than as a banner.
 */
export class SiteUrlNotAcceptedError extends Error {
  readonly issues: readonly SiteIssue[];

  constructor(issues: readonly SiteIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'SiteUrlNotAcceptedError';
    this.issues = issues;
  }
}

/** The one example in every message, so a user is shown the shape rather than told a rule. */
const EXAMPLE = 'https://app.example.com/create';

/** How much of what was submitted is quoted back. A 64 KB body is not a sentence. */
const QUOTE_LIMIT = 80;

const quoted = (value: string): string =>
  value.length <= QUOTE_LIMIT ? value : `${value.slice(0, QUOTE_LIMIT)}…`;

const refuse = (message: string): never => {
  throw new SiteUrlNotAcceptedError([{ path: 'url', message }]);
};

/**
 * The submitted URL, or the refusal that says what is wrong with it.
 *
 * Absolute `http:` or `https:`, and that is the whole rule. A URL carrying credentials, or a
 * non-default port on a host that is not `localhost`, is **accepted as given**: normalising
 * somebody's address is not this ticket's business, and the URL stored is the one they typed,
 * because that is the address they will prove they control.
 *
 * Nothing is assumed on their behalf either — `app.example.com` with no scheme is refused and
 * told so, rather than silently becoming `https://app.example.com`. A swarm of a hundred
 * browsers is pointed at the address a person wrote, not at one we guessed from it.
 */
export const parseSiteUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    return refuse(`a site needs a URL — the address the feature starts on, like ${EXAMPLE}`);
  }
  const url = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse(
      `"${quoted(url)}" is not a whole web address: a site is an absolute URL, like ${EXAMPLE}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse(
      `a site is an http:// or https:// URL, and "${quoted(parsed.protocol)}" is not one`,
    );
  }
  // `new URL('https://')` throws, but `new URL('https://?q')` does not and names no host.
  // A URL with no host names no site, whatever else it carries.
  if (parsed.hostname === '') {
    return refuse(`"${quoted(url)}" names no site: a site is an absolute URL, like ${EXAMPLE}`);
  }
  // The URL the user typed, not `parsed.href`: the round trip through `URL` adds a trailing
  // slash, lower-cases the host and re-escapes the path, none of which they asked for.
  return url;
};

/**
 * A new site in this workspace: unverified, with a token of its own.
 *
 * The token is minted per site rather than per workspace or per URL, so the same URL added by
 * two workspaces is two records with two tokens and neither verifies the other.
 */
export const addSite = async ({
  sites,
  workspaceId,
  url,
}: {
  sites: SiteStore;
  workspaceId: string;
  /** Whatever was submitted. Parsed here, so no caller can skip the check. */
  url: unknown;
}): Promise<SiteRecord> =>
  sites.create(workspaceId, { url: parseSiteUrl(url), token: mintSiteToken() });
