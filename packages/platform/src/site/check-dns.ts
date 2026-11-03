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
 * How many names one check may ask for.
 *
 * The walk is sequential and each lookup has its own timeout, so the number of labels in a
 * hostname is the number of seconds a request can be held open — and nothing stops a user
 * adding a site at a sixty-label host. Five keeps every real hostname whole.
 */
const MAX_DOMAINS = 5;

/**
 * A lookup that did not answer: why, in the user's words, and whether that leaves what is
 * published on the name **unknown**.
 *
 * The difference decides the outcome. A name that does not exist publishes nothing, so a
 * walk that only met those is a walk that found no record; a name that timed out may well
 * carry the record the user added, so a walk that met one has not established anything.
 */
interface Silence {
  readonly because: string;
  readonly unreadable: boolean;
}

/**
 * Why a rejected lookup did not answer — or `null` for a name that resolved and simply
 * publishes no TXT record, which is a finding and not a silence.
 */
const becauseOf = (error: unknown): Silence | null => {
  // Whatever the resolver rejected with, including `undefined` and a string: reading `.code`
  // off it unguarded is the one way this check could throw rather than answer, and the
  // resolver is an injected seam that a caller — or a later check — supplies.
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    // The name exists and has no TXT records at all. Not "did not answer": DNS answered.
    case 'ENODATA':
      return null;
    // Also an answer, and a definite one — there is no such name, so nothing is published on
    // it. Still worth a sentence of its own, because a site whose own host does not resolve
    // is the news rather than the missing record.
    case 'ENOTFOUND':
    case 'NXDOMAIN':
      return { because: 'that domain does not exist', unreadable: false };
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
      return { because: 'the lookup timed out', unreadable: true };
    case 'ESERVFAIL':
      return { because: 'the name servers for that domain would not answer', unreadable: true };
    case 'EREFUSED':
    case 'ECONNREFUSED':
      return { because: 'the name servers for that domain refused the query', unreadable: true };
    default:
      return {
        because:
          typeof code === 'string'
            ? `the lookup failed with ${code}`
            : 'the lookup did not complete',
        unreadable: true,
      };
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
  const walk = labels
    .slice(0, labels.length - 1)
    .map((_label, index) => labels.slice(index).join('.'));
  if (walk.length <= MAX_DOMAINS) return walk;
  // Past the cap, both ends are kept — the host the user is proving and the two-label suffix
  // the screen tells them to add the record on — and the parents between them are dropped.
  return [...walk.slice(0, MAX_DOMAINS - 1), ...walk.slice(-1)];
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
  /** Domains that did not answer, with why and whether that leaves them unread. */
  const silent: { domain: string; because: string; unreadable: boolean }[] = [];

  for (const domain of domains) {
    let records: string[][];
    try {
      records = await resolveTxt(domain);
    } catch (error) {
      const silence = becauseOf(error);
      // A domain that did not answer does not end the walk: the record the user added on
      // the parent still verifies the site when the host itself has no TXT records of its own.
      if (silence !== null) silent.push({ domain, ...silence });
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
  // Nothing is published on anything we could read, and at least one name we could not read
  // at all. The line may well be on that one, so this is **not** "no TXT record found": that
  // sentence would send a user to re-add a record they have already added.
  const unreadable = silent.filter((entry) => entry.unreadable);
  if (unreadable.length > 0) {
    // One reason, and only the names it is true of. Lending one domain's reason to another —
    // telling a user that a domain which timed out does not exist — is exactly the invented
    // explanation the screen contract rules out.
    const because = unreadable[0]?.because ?? 'the lookup did not complete';
    return result(
      noAnswer(
        unreadable.filter((entry) => entry.because === because).map(({ domain }) => domain),
        because,
      ),
    );
  }
  // Every name was read, and not one of them exists: that is the sentence, rather than one
  // about a record missing from domains that are not there to carry it.
  if (silent.length > 0 && silent.length === domains.length) {
    return result(
      noAnswer(
        silent.map(({ domain }) => domain),
        silent[0]?.because ?? 'the lookup did not complete',
      ),
    );
  }
  // Every name answered — or does not exist, which is an answer — and none carries a record.
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
