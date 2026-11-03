import { randomBytes } from 'node:crypto';

/**
 * The verification token of a site: what the platform mints, and the one place its name is
 * written down.
 *
 * The token is a **public proof of control, not a secret**. It is answered by `/sites`, shown
 * on the Add-a-site screen with the exact line to copy, and published by the user themselves
 * as a DNS record, a meta tag or a file — so nothing here hashes it, redacts it or treats it
 * as a credential. What it buys is that the person who put it where we look is the person who
 * controls that address.
 *
 * One name serves all three published forms, which is why it lives here rather than in each
 * check: `docs/FLOW.md` section 13 fixes it, and the DNS, meta-tag and well-known-file checks
 * of the later tickets of #221 read it from this module.
 */

/** The name of the TXT record, the meta tag and the well-known file. Section 13 fixes it. */
export const SITE_VERIFICATION_NAME = 'personavision-site-verification';

/** Every token begins with it, so a reader can tell one at a glance in a DNS zone. */
export const SITE_TOKEN_PREFIX = 'pv_';

/**
 * Six bytes as twelve hex characters — the prototype's `pv_7f3c91a2d84e`.
 *
 * It is short because a person types it into a DNS form by hand, and it is long enough
 * because guessing it buys nothing: a token only verifies the site it is *published on*, and
 * publishing it there is the control it proves. The two workspaces that add the same URL get
 * two different tokens, so one workspace's published token never verifies another's site.
 */
const TOKEN_BYTES = 6;

export const mintSiteToken = (): string =>
  `${SITE_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;

/**
 * The `name=value` pair a user publishes as a TXT record —
 * `personavision-site-verification=pv_7f3c91a2d84e`, as `#screen-site` prints it.
 */
export const siteVerificationPair = (token: string): string => `${SITE_VERIFICATION_NAME}=${token}`;
