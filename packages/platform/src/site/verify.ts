import { checkDnsTxt, nodeTxtResolver } from './check-dns.js';
import type { CheckedSite, SiteCheck, SiteCheckDeps, SiteCheckResult } from './checks.js';
import type { SiteRecord, SiteStore, SiteVerificationMethod } from '../store/types.js';

/**
 * The one path to verified: run a check, store what it found, and move the site **exactly
 * when the check passed**.
 *
 * There is no other path, and that is structural rather than a convention. `SiteStore` has a
 * single writer of the verification block, `verify`, which refuses a result that did not
 * pass; the only thing that builds a passing result is a check; and the only caller of
 * `verify` is this module. A route, a screen or a submitted body has nothing to write the
 * state through (`docs/FLOW.md` section 13).
 *
 * A failed check is **stored and answered, not raised**: the user asked us to look and we
 * looked, so the site comes back with its `lastCheck` and the sentence the screen prints.
 */

/** The four methods `docs/FLOW.md` section 13 names, in the order the screen lists them. */
export const SITE_VERIFICATION_METHODS: readonly SiteVerificationMethod[] = [
  'dns-txt',
  'meta-tag',
  'well-known-file',
  'connected-repository',
];

/**
 * The methods this platform can run today.
 *
 * Only `dns-txt` is wired here (#236). The two HTTP checks and the connected repository are
 * the tickets that follow, and **each wires itself in** by adding its check to `CHECKS`
 * below — which is the only edit needed, because this list is derived from it.
 */
const CHECKS: Partial<Record<SiteVerificationMethod, SiteCheck>> = {
  'dns-txt': checkDnsTxt,
};

export const AVAILABLE_SITE_VERIFICATION_METHODS: readonly SiteVerificationMethod[] =
  SITE_VERIFICATION_METHODS.filter((method) => CHECKS[method] !== undefined);

/**
 * A method this platform cannot check — one of section 13's four that is not wired yet, or a
 * word that is not a method at all.
 *
 * It carries the methods that **are** available, so the route's 400 names them rather than
 * leaving the caller to guess which of the four the screen may offer.
 */
export class SiteCheckNotAvailableError extends Error {
  readonly available: readonly SiteVerificationMethod[];

  constructor(message: string, available: readonly SiteVerificationMethod[]) {
    super(message);
    this.name = 'SiteCheckNotAvailableError';
    this.available = available;
  }
}

/** The available methods as a sentence lists them: `dns-txt`, or `dns-txt and meta-tag`. */
const listed = (methods: readonly SiteVerificationMethod[]): string => {
  if (methods.length === 0) return 'none';
  if (methods.length === 1) return methods[0] ?? 'none';
  return `${methods.slice(0, -1).join(', ')} and ${methods[methods.length - 1] ?? ''}`;
};

/**
 * The check for a submitted method, or the refusal that names what can be run.
 *
 * Whatever was submitted: a method of the four that is not wired yet, a string that is no
 * method, a number, nothing at all. Each gets a sentence naming the methods available, since
 * that is the one thing the caller can act on.
 */
export const siteCheckFor = (method: unknown): SiteCheck => {
  const available = AVAILABLE_SITE_VERIFICATION_METHODS;
  if (typeof method !== 'string' || method === '') {
    throw new SiteCheckNotAvailableError(
      `Name the check to run. Available today: ${listed(available)}.`,
      available,
    );
  }
  // `Object.hasOwn` rather than reading the key: `CHECKS['constructor']` and
  // `CHECKS['toString']` are functions on every object's prototype, and a submitted method
  // of either would otherwise be handed back as though it were a check.
  const check = Object.hasOwn(CHECKS, method)
    ? CHECKS[method as SiteVerificationMethod]
    : undefined;
  if (check === undefined) {
    throw new SiteCheckNotAvailableError(
      `"${method}" is not a check this platform runs yet. Available today: ${listed(available)}.`,
      available,
    );
  }
  return check;
};

/** The real resolver and the real clock — what `personavision serve` runs the checks with. */
export const defaultSiteCheckDeps = (): SiteCheckDeps => ({
  resolveTxt: nodeTxtResolver(),
  now: () => new Date(),
});

export interface VerifiedSite {
  /** The site as it now stands: verified when the check passed, with `lastCheck` either way. */
  readonly site: SiteRecord;
  /** What this check found, so the caller need not read it back off the record. */
  readonly check: SiteCheckResult;
}

/**
 * Run the named check on this site, store what it found, and verify the site if it passed.
 *
 * Throws `SiteCheckNotAvailableError` for a method that cannot be run — which is the one
 * thing here that is an error, because nothing was checked. A check that **ran** and failed
 * is a `VerifiedSite` whose `check.passed` is `false` and whose site is still unverified.
 */
export const verifySite = async ({
  sites,
  workspaceId,
  site,
  method,
  deps,
}: {
  sites: SiteStore;
  workspaceId: string;
  /** The stored site, already read in this workspace — so a site of another is never here. */
  site: SiteRecord & CheckedSite;
  /** Whatever was submitted. Parsed here, so no caller can skip the check. */
  method: unknown;
  deps: SiteCheckDeps;
}): Promise<VerifiedSite> => {
  const check = siteCheckFor(method);
  const result = await check(site, deps);
  return {
    // `verify` for a passing result and `recordCheck` for every other: one of them writes the
    // state and refuses anything that did not pass, the other cannot write the state at all.
    site: result.passed
      ? await sites.verify(workspaceId, site.id, result)
      : await sites.recordCheck(workspaceId, site.id, result),
    check: result,
  };
};
