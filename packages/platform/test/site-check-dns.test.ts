import { describe, expect, it } from 'vitest';
import { checkDnsTxt, verificationDomains } from '../src/site/check-dns.js';
import { siteVerificationPair } from '../src/site/token.js';
import type { CheckedSite, SiteCheckResult, TxtResolver } from '../src/site/checks.js';

/**
 * The DNS TXT check (#236), in every state it can end in.
 *
 * Each assertion is about **the result's words** and not only its boolean, because the words
 * are the deliverable: `#screen-site` promises _"A failed check says what it looked for,
 * where, and what it found instead. Nothing here is 'something went wrong'"_, and that is a
 * promise about this object rather than about a screen's copy.
 *
 * Every test passes its own resolver and its own clock. Nothing here reaches DNS, which is
 * the repository's rule that a fresh clone tests with no network (`CONTEXT.md`).
 */

/** The prototype's token, so the lines asserted here are the lines `#screen-site` prints. */
const TOKEN = 'pv_7f3c91a2d84e';
const PAIR = `personavision-site-verification=${TOKEN}`;

/** The prototype's site: the record is written on the host, the screen names the domain. */
const SITE: CheckedSite = { url: 'https://beta.clipforge.example/create', token: TOKEN };
const HOST = 'beta.clipforge.example';
const DOMAIN = 'clipforge.example';

/** `#screen-site`'s "Last check: … at 09:04." is this instant. */
const CHECKED_AT = '2026-11-03T09:04:00.000Z';

/** What one name answers: its TXT records, or the code the resolver rejects with. */
type Answer = string[][] | { rejects: string };

/** A rejection shaped as `node:dns` rejects — the code is what the check reads. */
const dnsError = (code: string): Error => Object.assign(new Error(`queryTxt ${code}`), { code });

/**
 * A zone, and the names the check actually asked for.
 *
 * A name the zone does not mention rejects `ENODATA`, which is what a resolver answers for a
 * host that exists and publishes no TXT record — the ordinary case for a site whose owner has
 * not added the record yet.
 */
const resolverOf = (zone: Record<string, Answer>): { resolveTxt: TxtResolver; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    resolveTxt: async (hostname) => {
      asked.push(hostname);
      const answer = zone[hostname] ?? { rejects: 'ENODATA' };
      if (Array.isArray(answer)) return answer;
      throw dnsError(answer.rejects);
    },
  };
};

const check = async (
  zone: Record<string, Answer>,
  site: CheckedSite = SITE,
): Promise<{ result: SiteCheckResult; asked: string[] }> => {
  const { resolveTxt, asked } = resolverOf(zone);
  const result = await checkDnsTxt(site, { resolveTxt, now: () => new Date(CHECKED_AT) });
  return { result, asked };
};

describe('the DNS TXT check', () => {
  describe('the token published on the site’s own host', () => {
    it('passes, and says which record on which domain carries which line', async () => {
      const { result } = await check({ [HOST]: [[PAIR]] });

      expect(result.passed).toBe(true);
      expect(result.method).toBe('dns-txt');
      expect(result.found).toEqual({ outcome: 'found', at: [HOST], values: [], because: null });
      expect(result.sentence).toBe(`the TXT record on ${HOST} carries ${PAIR}`);
      expect(result.checkedAt).toBe(CHECKED_AT);
    });

    it('stops at the host rather than asking the domain as well', async () => {
      const { asked } = await check({ [HOST]: [[PAIR]] });

      expect(asked).toEqual([HOST]);
    });

    it('looked for the line the screen prints, spelled the way the screen prints it', async () => {
      const { result } = await check({ [HOST]: [[PAIR]] });

      expect(result.lookedFor).toBe(siteVerificationPair(TOKEN));
      // The line in `#screen-site`'s `code.tokenline`, composed from the result's own field,
      // so the line a user is shown and the line the platform searches for are one string.
      expect(`${HOST}.  TXT  "${result.lookedFor}"`).toBe(
        `beta.clipforge.example.  TXT  "personavision-site-verification=pv_7f3c91a2d84e"`,
      );
    });

    it('names both domains as the places it was prepared to look', async () => {
      const { result } = await check({ [HOST]: [[PAIR]] });

      expect(result.lookedIn).toEqual([
        { kind: 'domain', value: HOST },
        { kind: 'domain', value: DOMAIN },
      ]);
    });

    it('reads a record the name server split into chunks as one value', async () => {
      // A TXT value over 255 bytes arrives in pieces (RFC 1035) and is one string.
      const { result } = await check({
        [HOST]: [['personavision-site-verification=', TOKEN]],
      });

      expect(result.passed).toBe(true);
    });

    it('passes on a record that carries the line among other text', async () => {
      const { result } = await check({ [HOST]: [[`"${PAIR}" ; added 3 Nov`]] });

      expect(result.passed).toBe(true);
    });
  });

  describe('the token published only on the parent domain', () => {
    it('passes, because the screen promises a record on the domain covers the host', async () => {
      const { result, asked } = await check({ [DOMAIN]: [[PAIR]] });

      expect(result.passed).toBe(true);
      expect(result.found.at).toEqual([DOMAIN]);
      expect(result.sentence).toBe(`the TXT record on ${DOMAIN} carries ${PAIR}`);
      expect(asked).toEqual([HOST, DOMAIN]);
    });

    it('passes even when the host itself did not answer at all', async () => {
      // A domain that did not answer does not end the walk: the record on the parent is
      // still the proof of control the user published.
      const { result } = await check({
        [HOST]: { rejects: 'ETIMEOUT' },
        [DOMAIN]: [[PAIR]],
      });

      expect(result.passed).toBe(true);
      expect(result.found.at).toEqual([DOMAIN]);
    });
  });

  describe('no TXT record at all', () => {
    it('says so, naming both domains it looked on', async () => {
      const { result } = await check({});

      expect(result.passed).toBe(false);
      expect(result.found).toEqual({
        outcome: 'nothing-published',
        at: [HOST, DOMAIN],
        values: [],
        because: null,
      });
      expect(result.sentence).toBe(`no TXT record found on ${HOST} or ${DOMAIN}`);
    });

    it('is the sentence `#screen-site` prints, for a site on the domain itself', async () => {
      const { result } = await check({}, { url: `https://${DOMAIN}/create`, token: TOKEN });

      // "Last check: no TXT record found on clipforge.example at 09:04." — the screen adds
      // the prefix, the time in the reader's zone and the full stop.
      expect(result.sentence).toBe('no TXT record found on clipforge.example');
      expect(result.checkedAt).toBe(CHECKED_AT);
    });

    it('says the same for a name server that answers with an empty record set', async () => {
      const { result } = await check({ [HOST]: [], [DOMAIN]: [] });

      expect(result.found.outcome).toBe('nothing-published');
      expect(result.sentence).toBe(`no TXT record found on ${HOST} or ${DOMAIN}`);
    });

    it('says so when the host does not exist but the domain publishes nothing', async () => {
      const { result } = await check({ [HOST]: { rejects: 'ENOTFOUND' } });

      expect(result.found.outcome).toBe('nothing-published');
      expect(result.found.at).toEqual([HOST, DOMAIN]);
    });
  });

  describe('a TXT record with a different or malformed token', () => {
    it('quotes back what is published there instead', async () => {
      const theirs = 'personavision-site-verification=pv_000000000000';
      const { result } = await check({ [HOST]: [[theirs]], [DOMAIN]: [['v=spf1 -all']] });

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('other-values');
      expect(result.found.at).toEqual([HOST, DOMAIN]);
      expect(result.found.values).toEqual([theirs, 'v=spf1 -all']);
      expect(result.sentence).toBe(
        `the TXT records on ${HOST} and ${DOMAIN} do not include ${PAIR}`,
      );
    });

    it('does not pass a line that is nearly the one the screen gave', async () => {
      for (const malformed of [
        'personavision-site-verification',
        `personavision-site-verification ${TOKEN}`,
        'personavision-site-verification =pv_7f3c91a2d84e',
        'personavision-site-verification=pv_7f3c91a2d84',
        'personavision-site-verification=7f3c91a2d84e',
        'PERSONAVISION-SITE-VERIFICATION=PV_7F3C91A2D84E',
        'personavision_site_verification=pv_7f3c91a2d84e',
      ]) {
        const { result } = await check({ [HOST]: [[malformed]] });

        expect(result.passed).toBe(false);
        // And the user is shown what is there, so they can see what differs.
        expect(result.found.values).toContain(malformed);
      }
    });

    it('does not verify this site with another workspace’s published token', async () => {
      // Two workspaces that add the same URL get two tokens, so one workspace's published
      // record is not the other's proof even on the very domain it is published on.
      const { result } = await check(
        { [HOST]: [[PAIR]] },
        { url: SITE.url, token: 'pv_aaaa0000bbbb' },
      );

      expect(result.passed).toBe(false);
      expect(result.lookedFor).toBe('personavision-site-verification=pv_aaaa0000bbbb');
    });
  });

  describe('a resolver that rejects', () => {
    it('says the domain does not exist, for NXDOMAIN', async () => {
      const { result } = await check(
        { [DOMAIN]: { rejects: 'ENOTFOUND' } },
        {
          url: `https://${DOMAIN}/create`,
          token: TOKEN,
        },
      );

      expect(result.passed).toBe(false);
      expect(result.found).toEqual({
        outcome: 'no-answer',
        at: [DOMAIN],
        values: [],
        because: 'that domain does not exist',
      });
      expect(result.sentence).toBe(`${DOMAIN} did not answer: that domain does not exist`);
    });

    it('says the lookup timed out, for a timeout', async () => {
      const { result } = await check({
        [HOST]: { rejects: 'ETIMEOUT' },
        [DOMAIN]: { rejects: 'ETIMEOUT' },
      });

      expect(result.found.outcome).toBe('no-answer');
      expect(result.found.because).toBe('the lookup timed out');
      expect(result.sentence).toBe(`${HOST} and ${DOMAIN} did not answer: the lookup timed out`);
    });

    it('names what the name servers did, for the codes that say it', async () => {
      const said: Record<string, string> = {
        ESERVFAIL: 'the name servers for that domain would not answer',
        EREFUSED: 'the name servers for that domain refused the query',
        ETIMEDOUT: 'the lookup timed out',
      };
      for (const [code, because] of Object.entries(said)) {
        const { result } = await check({
          [HOST]: { rejects: code },
          [DOMAIN]: { rejects: code },
        });

        expect(result.found.because).toBe(because);
      }
    });

    it('names an unfamiliar code rather than reaching for “something went wrong”', async () => {
      const { result } = await check({
        [HOST]: { rejects: 'EBADRESP' },
        [DOMAIN]: { rejects: 'EBADRESP' },
      });

      expect(result.found.because).toBe('the lookup failed with EBADRESP');
      expect(result.sentence).toContain('did not answer');
    });
  });

  describe('a walk where only some of the names could be read', () => {
    it('does not call a record missing from a domain it could not read', async () => {
      // The host exists and publishes no TXT record; the domain — the one the screen tells
      // the user to add the record on — timed out. "No TXT record found on beta… or
      // clipforge…" would send a user to re-add a record they have already added.
      const { result } = await check({ [DOMAIN]: { rejects: 'ETIMEOUT' } });

      expect(result.found).toEqual({
        outcome: 'no-answer',
        at: [DOMAIN],
        values: [],
        because: 'the lookup timed out',
      });
      expect(result.sentence).toBe(`${DOMAIN} did not answer: the lookup timed out`);
    });

    it('names only the domains the reason is true of', async () => {
      const { result } = await check({
        [HOST]: { rejects: 'ENOTFOUND' },
        [DOMAIN]: { rejects: 'ETIMEOUT' },
      });

      // One of them does not exist and the other timed out. Naming both after one reason
      // would tell the user that `clipforge.example` does not exist, which it does.
      expect(result.found.at).toEqual([DOMAIN]);
      expect(result.found.because).toBe('the lookup timed out');
    });

    it('is still “no record found” when every name was read', async () => {
      // A name that does not exist is an answer and not a silence: nothing is published on
      // a name that is not there, so the walk did establish that the record is missing.
      const { result } = await check({ [HOST]: { rejects: 'ENOTFOUND' } });

      expect(result.found.outcome).toBe('nothing-published');
      expect(result.found.at).toEqual([HOST, DOMAIN]);
    });
  });

  it('never says “something went wrong”, in any state it can end in', async () => {
    const zones: Record<string, Answer>[] = [
      { [HOST]: [[PAIR]] },
      { [DOMAIN]: [[PAIR]] },
      {},
      { [HOST]: [['v=spf1 -all']] },
      { [HOST]: { rejects: 'ENOTFOUND' }, [DOMAIN]: { rejects: 'ENOTFOUND' } },
      { [HOST]: { rejects: 'ETIMEOUT' }, [DOMAIN]: { rejects: 'ETIMEOUT' } },
      { [HOST]: { rejects: 'ENOTANERROR' }, [DOMAIN]: { rejects: 'ENOTANERROR' } },
    ];
    for (const zone of zones) {
      const { result } = await check(zone);

      expect(result.sentence.toLowerCase()).not.toContain('something went wrong');
      expect(result.sentence).not.toBe('');
      expect(result.passed).toBe(result.found.outcome === 'found');
    }
  });

  it('is a result and never a throw, whatever the resolver does', async () => {
    const result = await checkDnsTxt(SITE, {
      resolveTxt: () => Promise.reject(new Error('the resolver exploded')),
      now: () => new Date(CHECKED_AT),
    });

    expect(result.passed).toBe(false);
    expect(result.found.outcome).toBe('no-answer');
  });

  it('is a result for a rejection that is not an error object at all', async () => {
    // The resolver is an injected seam, so what it rejects with is a caller's choice. A
    // `TypeError` reading `.code` off `undefined` would escape this check, past the route's
    // one catch, and answer the user a 500 instead of a sentence.
    for (const thrown of [undefined, null, 'ETIMEOUT', 7]) {
      const result = await checkDnsTxt(SITE, {
        resolveTxt: async () => {
          throw thrown;
        },
        now: () => new Date(CHECKED_AT),
      });

      expect(result.found.outcome).toBe('no-answer');
      expect(result.found.because).toBe('the lookup did not complete');
    }
  });
});

describe('the domains a TXT record verifies a host on', () => {
  it('walks the host down to and including the two-label suffix', () => {
    expect(verificationDomains('beta.clipforge.example')).toEqual([
      'beta.clipforge.example',
      'clipforge.example',
    ]);
    expect(verificationDomains('a.b.c.clipforge.example')).toEqual([
      'a.b.c.clipforge.example',
      'b.c.clipforge.example',
      'c.clipforge.example',
      'clipforge.example',
    ]);
  });

  it('is the domain itself for a site on the domain', () => {
    expect(verificationDomains('clipforge.example')).toEqual(['clipforge.example']);
  });

  it('asks nothing above the two-label suffix on a multi-label public suffix', () => {
    // ponytail: `co.uk` is in the walk and answers nothing anybody but the registry could
    // have published. A user there verifies on `example.co.uk` or on the exact host, and a
    // public-suffix list is a dependency and a monthly update for that one case.
    expect(verificationDomains('shop.example.co.uk')).toEqual([
      'shop.example.co.uk',
      'example.co.uk',
      'co.uk',
    ]);
  });

  it('is itself and nothing else for one label, an IPv4 literal and an IPv6 literal', () => {
    // Walking the parents of `127.0.0.1` would ask DNS for `0.0.1`, which is nobody's domain.
    expect(verificationDomains('localhost')).toEqual(['localhost']);
    expect(verificationDomains('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(verificationDomains('[::1]')).toEqual(['::1']);
  });

  it('reads a trailing dot and capitals as the same name', () => {
    expect(verificationDomains('Beta.ClipForge.Example.')).toEqual([
      'beta.clipforge.example',
      'clipforge.example',
    ]);
  });

  it('asks at most five names, keeping the host and the two-label suffix', () => {
    const deep = `${'a.'.repeat(60)}clipforge.example`;
    const walked = verificationDomains(deep);

    // The walk is sequential and each lookup has its own timeout, so the label count is the
    // number of seconds one request can be held open. Both ends survive the cap: the host
    // being proved, and the domain the screen tells the user to add the record on.
    expect(walked).toHaveLength(5);
    expect(walked[0]).toBe(deep);
    expect(walked.at(-1)).toBe('clipforge.example');
  });

  it('looks a dev server up as its one host', async () => {
    const { result, asked } = await check(
      {},
      { url: 'http://localhost:5173/create', token: TOKEN },
    );

    expect(asked).toEqual(['localhost']);
    expect(result.lookedIn).toEqual([{ kind: 'domain', value: 'localhost' }]);
  });
});
