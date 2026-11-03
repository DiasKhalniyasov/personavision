import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  TxtResolver,
} from './checks.js';
import { siteVerificationPair } from './token.js';

/**
 * The DNS TXT check: the first of `docs/FLOW.md` section 13's four methods, and the one the
 * screen recommends.
 *
 * The user adds `personavision-site-verification=<token>` as a TXT record; this resolves TXT
 * for the site's host and, failing that, for **each parent domain down to and including the
 * two-label suffix**. Both halves of what `#screen-site` says have to work: it promises _"Add
 * this record on clipforge.example. It covers every site on the domain"_ while the line it
 * prints to copy is written on `beta.clipforge.example`, so a record on either verifies the
 * site.
 *
 * ponytail: the two-label stop is wrong for a multi-label public suffix — on `shop.example.co.uk`
 * the walk also asks `co.uk`, which answers nothing anybody but the registry could have put
 * there, and a user on such a domain verifies on `example.co.uk` or on the exact host. A
 * public-suffix list is a dependency and a monthly update for that, and `docs/FLOW.md` has
 * not asked for one.
 *
 * Node's own resolver and no dependency added. The resolver is **injected** (`SiteCheckDeps`),
 * so every test of this file is offline; `nodeTxtResolver` below is the one that reaches DNS.
 */

/** As the sentences name it: "no TXT record found on …", "the TXT records on … do not include …". */
const TXT_RECORD: SiteCheckSubject = { one: 'TXT record', many: 'TXT records' };

/**
 * How long one lookup is given, and how many times it is tried.
 *
 * The screen contract says a check answers within its own timeout — the request is the only
 * thing in flight, with no polling and no job id — so the bound is per lookup and short:
 * a hostname of three labels is two lookups, and a user pressing "Check the record" waits
 * seconds rather than Node's default minute.
 */
const LOOKUP_TIMEOUT_MS = 2_500;
const LOOKUP_TRIES = 1;

/**
 * Why a rejected lookup did not answer, in the user's words — or `null` for a name that
 * resolved and simply publishes no TXT record, which is a finding and not a silence.
 */
const becauseOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown }).code;
  switch (code) {
    // The name exists and has no TXT records at all. Not "did not answer": DNS answered.
    case 'ENODATA':
      return null;
    case 'ENOTFOUND':
    case 'NXDOMAIN':
      return 'that domain does not exist';
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
      return 'the lookup timed out';
    case 'ESERVFAIL':
      return 'the name servers for that domain would not answer';
    case 'EREFUSED':
    case 'ECONNREFUSED':
      return 'the name servers for that domain refused the query';
    default:
      return typeof code === 'string'
        ? `the lookup failed with ${code}`
        : 'the lookup did not complete';
  }
};

/**
 * The site's host, as DNS asks for it.
 *
 * A stored site's URL is always one `parseSiteUrl` accepted, so it always parses and always
 * names a host; the fallback is for a record written by hand, and it looks up what is there
 * rather than throwing — a check reports, it does not fail.
 */
const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * The domains a record on which verifies this host: the host itself, then each parent down to
 * and including the two-label suffix.
 *
 * `beta.clipforge.example` → `beta.clipforge.example`, `clipforge.example`. An address with
 * one label (`localhost`) and an IP literal are themselves and nothing else — walking the
 * parents of `127.0.0.1` would ask DNS for `0.0.1`, which names no domain of anybody's.
 */
export const verificationDomains = (hostname: string): readonly string[] => {
  // A trailing dot is the same name to DNS, and brackets are the URL syntax for IPv6.
  const host = hostname
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (host === '') return [];
  if (isIP(host) !== 0) return [host];
  const labels = host.split('.');
  if (labels.length < 2) return [host];
  return labels.slice(0, labels.length - 1).map((_label, index) => labels.slice(index).join('.'));
};

/** One TXT record, whose 255-byte chunks are one value (RFC 1035) and are joined as one. */
const valueOf = (chunks: readonly string[]): string => chunks.join('');

export const checkDnsTxt: SiteCheck = async (
  site: CheckedSite,
  { resolveTxt, now }: SiteCheckDeps,
) => {
  const lookedFor = siteVerificationPair(site.token);
  const domains = verificationDomains(hostnameOf(site.url));
  const lookedIn: readonly SiteCheckTarget[] = domains.map((value) => ({
    kind: 'domain',
    value,
  }));
  const result = (found: SiteCheckFinding) =>
    siteCheckResult({
      method: 'dns-txt',
      subject: TXT_RECORD,
      lookedFor,
      lookedIn,
      found,
      at: now(),
    });

  /** Domains that published TXT records, none of them the line. */
  const published: { domain: string; values: string[] }[] = [];
  /** Domains that did not answer, with why. */
  const silent: { domain: string; because: string }[] = [];

  for (const domain of domains) {
    let records: string[][];
    try {
      records = await resolveTxt(domain);
    } catch (error) {
      const because = becauseOf(error);
      // A domain that did not answer does not end the walk: the record the user added on
      // the parent still verifies the site when the host itself has no TXT records of its own.
      if (because !== null) silent.push({ domain, because });
      continue;
    }
    const values = records.map(valueOf);
    // `includes` rather than equality: providers and zone editors wrap, pad and quote a TXT
    // value, and what the user published is the line whatever is around it. A token is
    // twelve hex characters minted per site, so no token is a prefix of another.
    if (values.some((value) => value.includes(lookedFor))) return result(foundTheLine([domain]));
    if (values.length > 0) published.push({ domain, values });
  }

  if (published.length > 0) {
    return result(
      otherValues(
        published.map(({ domain }) => domain),
        published.flatMap(({ values }) => values),
      ),
    );
  }
  // Every domain asked, and not one of them answered: the one outcome that is about the
  // host rather than about what it publishes, and it says which it was.
  if (silent.length > 0 && silent.length === domains.length) {
    return result(
      noAnswer(
        silent.map(({ domain }) => domain),
        silent[0]?.because ?? 'the lookup did not complete',
      ),
    );
  }
  return result(nothingPublished(domains));
};

/**
 * The resolver that reaches DNS — the only thing in this file that does, and not what a test
 * is given.
 *
 * Its own `Resolver` rather than the module-level `resolveTxt`, so the timeout is this
 * check's and not the process's.
 */
export const nodeTxtResolver = (): TxtResolver => {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: LOOKUP_TRIES });
  return (hostname) => resolver.resolveTxt(hostname);
};
