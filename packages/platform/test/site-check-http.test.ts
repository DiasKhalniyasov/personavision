import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { checkWellKnownFile, siteVerificationFileUrl } from '../src/site/check-file.js';
import { checkMetaTag, siteVerificationMetaTag } from '../src/site/check-meta.js';
import { BODY_LIMIT_BYTES } from '../src/site/fetch-once.js';
import type { CheckedSite, SiteCheck, SiteCheckResult, TxtResolver } from '../src/site/checks.js';
import type { SiteVerification } from '../src/store/types.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * The two HTTP verification checks (#237) — the meta tag and the well-known file — and the one
 * fetch policy they share.
 *
 * Every test here runs against a **local fixture server**, which is the only honest way to
 * assert a policy made of a redirect mode, a byte cap and a timeout: a stubbed `fetch` would
 * assert what this file believes about those options rather than what `fetch` does with them.
 * Nothing reaches the network — the fixture listens on `127.0.0.1` on a port the kernel picks,
 * and the sites under test are that address.
 *
 * Each assertion is about **the result's words** and not only its boolean, because the words
 * are the deliverable: `#screen-site` promises _"A failed check says what it looked for,
 * where, and what it found instead. Nothing here is 'something went wrong'"_, and that is a
 * promise about this object rather than about a screen's copy.
 */

/** The prototype's token, so the lines asserted here are the lines `#screen-site` prints. */
const TOKEN = 'pv_7f3c91a2d84e';

/** `#screen-site`'s "Last check: … at 09:04." is this instant. */
const CHECKED_AT = '2026-11-03T09:04:00.000Z';

/** The tag and the path, spelled out once here rather than imported, so a drift is a failure. */
const TAG = `<meta name="personavision-site-verification" content="${TOKEN}">`;
const FILE_PATH = '/.well-known/personavision-site-verification.txt';

/**
 * The bound every test that expects an answer runs with.
 *
 * Generous, and deliberately not the few hundred milliseconds a fixture on loopback needs:
 * these suites run beside a hundred others, and a bound tight enough to be tidy is a bound
 * that fires under load and turns an assertion about a sentence into a flake.
 */
const PATIENT_TIMEOUT_MS = 10_000;

/** The bound the one test that waits for the timeout runs with, so it waits this long and no longer. */
const IMPATIENT_TIMEOUT_MS = 250;

/** What a fixture answers one request with. */
interface Answer {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Headers, then silence — so the timeout fires while the body is being read. */
  readonly stall?: boolean;
  /** Written in chunks past the cap, without a `content-length`, so the stream is the bound. */
  readonly stream?: number;
}

interface Fixture {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Every path asked for, in order — so "exactly one request" is an assertion. */
  readonly asked: string[];
  /** What each path answers. A path not named answers 404. */
  readonly answers: Map<string, Answer>;
  readonly close: () => Promise<void>;
}

const startFixture = async (): Promise<Fixture> => {
  const asked: string[] = [];
  const answers = new Map<string, Answer>();
  const serve = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    asked.push(path);
    const answer = answers.get(path);
    if (answer === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(answer.status ?? 200, {
      'content-type': 'text/html; charset=utf-8',
      ...answer.headers,
    });
    if (answer.stall === true) {
      // Headers sent and nothing more, ever. The connection is closed by `closeAllConnections`.
      response.flushHeaders();
      return;
    }
    if (answer.stream !== undefined) {
      // A chunk at a time and no `content-length`, so only the reader's cap can stop it.
      const chunk = 'x'.repeat(16 * 1_024);
      for (let written = 0; written < answer.stream; written += chunk.length) {
        response.write(chunk);
      }
      response.end();
      return;
    }
    response.end(answer.body ?? '');
  };
  const server: Server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    asked,
    answers,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe('the two HTTP verification checks', () => {
  let fixture: Fixture;
  /** A second fixture on another port: an off-origin redirect needs somewhere to point. */
  let elsewhere: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
    elsewhere = await startFixture();
  });

  afterAll(async () => {
    await fixture.close();
    await elsewhere.close();
  });

  beforeEach(() => {
    fixture.asked.length = 0;
    fixture.answers.clear();
    elsewhere.asked.length = 0;
    elsewhere.answers.clear();
  });

  /**
   * An address nothing listens on: a fixture started for its port and then closed.
   *
   * Not a hard-coded low port — the fetch specification keeps a list of ports it refuses to
   * request at all (1 and 9 among them), and that refusal is not the connection being
   * refused by a server.
   */
  const closedOrigin = async (): Promise<string> => {
    const spent = await startFixture();
    await spent.close();
    return spent.origin;
  };

  /** The site under test: the fixture's address, with the prototype's token. */
  const siteAt = (path: string): CheckedSite => ({
    id: 'the-clipforge-site',
    workspaceId: 'the-clipforge-workspace',
    url: `${fixture.origin}${path}`,
    token: TOKEN,
  });

  const run = async (
    check: SiteCheck,
    site: CheckedSite,
    timeoutMs = PATIENT_TIMEOUT_MS,
  ): Promise<SiteCheckResult> =>
    check(site, {
      // The real `fetch`, pointed at the fixture: the policy is what is under test, so
      // nothing here stands in for it.
      resolveTxt: async () => {
        throw new Error('no HTTP check resolves DNS');
      },
      now: () => new Date(CHECKED_AT),
      fetchTimeoutMs: timeoutMs,
    });

  describe('the meta tag', () => {
    const PAGE = '/create';
    const page = () => `${fixture.origin}${PAGE}`;

    it('composes the line the screen prints to copy', () => {
      expect(siteVerificationMetaTag(TOKEN)).toBe(TAG);
    });

    it('passes when the tag is in the head, and says which page carries which line', async () => {
      fixture.answers.set(PAGE, {
        body: `<!doctype html><html lang="en"><head>${TAG}<title>Clipforge</title></head><body>hi</body></html>`,
      });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(true);
      expect(result.method).toBe('meta-tag');
      expect(result.lookedFor).toBe(TAG);
      expect(result.lookedIn).toEqual([{ kind: 'url', value: page() }]);
      expect(result.found).toEqual({ outcome: 'found', at: [page()], values: [], because: null });
      expect(result.sentence).toBe(`the meta tag on ${page()} carries ${TAG}`);
      expect(result.checkedAt).toBe(CHECKED_AT);
      expect(fixture.asked).toEqual([PAGE]);
    });

    it('reads the tag however it is spelled, quoted and ordered', async () => {
      fixture.answers.set(PAGE, {
        body: `<head><META CONTENT='${TOKEN}' NAME='personavision-site-verification' /></head>`,
      });

      expect((await run(checkMetaTag, siteAt(PAGE))).passed).toBe(true);
    });

    it('does not verify when no tag of that name is on the page, and says so', async () => {
      fixture.answers.set(PAGE, {
        body: '<head><meta name="description" content="Clipforge"></head>',
      });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('nothing-published');
      expect(result.sentence).toBe(`no meta tag found on ${page()}`);
      expect(fixture.asked).toEqual([PAGE]);
    });

    it('does not verify a tag carrying another token, and quotes what it found instead', async () => {
      fixture.answers.set(PAGE, {
        body: '<head><meta name="personavision-site-verification" content="pv_000000000000"></head>',
      });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.found).toEqual({
        outcome: 'other-values',
        at: [page()],
        values: ['pv_000000000000'],
        because: null,
      });
      expect(result.sentence).toBe(`the meta tags on ${page()} do not include ${TAG}`);
    });

    it('does not verify when the page cannot be reached, and does not claim the tag is absent', async () => {
      // Nothing listens there, so the connection is refused and what is on the page is
      // unknown rather than known to be missing.
      const origin = await closedOrigin();

      const result = await run(checkMetaTag, { ...siteAt(PAGE), url: `${origin}/create` });

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toBe(`${origin}/create did not answer: the connection was refused`);
      expect(result.sentence).not.toContain('something went wrong');
    });
  });

  describe('the well-known file', () => {
    const file = () => `${fixture.origin}${FILE_PATH}`;

    it('composes the URL the screen prints, on the origin and not under the path', () => {
      expect(siteVerificationFileUrl('https://beta.clipforge.example/create')).toBe(
        `https://beta.clipforge.example${FILE_PATH}`,
      );
    });

    it('passes when the file holds the token, and says which file carries it', async () => {
      fixture.answers.set(FILE_PATH, {
        headers: { 'content-type': 'text/plain' },
        body: `${TOKEN}\n`,
      });

      const result = await run(checkWellKnownFile, siteAt('/create'));

      expect(result.passed).toBe(true);
      expect(result.method).toBe('well-known-file');
      expect(result.lookedFor).toBe(TOKEN);
      expect(result.lookedIn).toEqual([{ kind: 'url', value: file() }]);
      expect(result.sentence).toBe(`the file on ${file()} carries ${TOKEN}`);
      expect(result.checkedAt).toBe(CHECKED_AT);
      expect(fixture.asked).toEqual([FILE_PATH]);
    });

    it('does not verify when the file is not served, and names the status', async () => {
      const result = await run(checkWellKnownFile, siteAt('/create'));

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toBe(`${file()} did not answer: it answered 404`);
    });

    it('does not verify when the file holds another token, and quotes it back', async () => {
      fixture.answers.set(FILE_PATH, { body: 'pv_000000000000' });

      const result = await run(checkWellKnownFile, siteAt('/create'));

      expect(result.passed).toBe(false);
      expect(result.found).toEqual({
        outcome: 'other-values',
        at: [file()],
        values: ['pv_000000000000'],
        because: null,
      });
      expect(result.sentence).toBe(`the files on ${file()} do not include ${TOKEN}`);
    });

    it('says the file is empty rather than that no file was found', async () => {
      fixture.answers.set(FILE_PATH, { body: '   \n' });

      const result = await run(checkWellKnownFile, siteAt('/create'));

      expect(result.passed).toBe(false);
      expect(result.sentence).toBe(`the file on ${file()} is empty`);
    });

    it('does not verify when the host cannot be reached, and does not claim the file is absent', async () => {
      const origin = await closedOrigin();

      const result = await run(checkWellKnownFile, {
        ...siteAt('/create'),
        url: `${origin}/create`,
      });

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toBe(
        `${origin}${FILE_PATH} did not answer: the connection was refused`,
      );
    });
  });

  describe('the one fetch policy both checks share', () => {
    const PAGE = '/create';

    it('follows a redirect onto the site’s own origin once, and verifies', async () => {
      fixture.answers.set(PAGE, { status: 301, headers: { location: '/create/' } });
      fixture.answers.set('/create/', { body: `<head>${TAG}</head>` });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(true);
      // Read from the address that answered, which is the one worth naming back.
      expect(result.found.at).toEqual([`${fixture.origin}/create/`]);
      expect(fixture.asked).toEqual([PAGE, '/create/']);
    });

    it('does not verify through another origin, and names where it was being sent', async () => {
      const away = `${elsewhere.origin}/create`;
      fixture.answers.set(PAGE, { status: 302, headers: { location: away } });
      elsewhere.answers.set('/create', { body: `<head>${TAG}</head>` });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toBe(
        `${fixture.origin}${PAGE} did not answer: it redirected to ${away}, which is not this site’s own address`,
      );
      // The token is on the other origin and was never read: that is the boundary.
      expect(elsewhere.asked).toEqual([]);
      expect(fixture.asked).toEqual([PAGE]);
    });

    it('follows one redirect and not a chain', async () => {
      fixture.answers.set(PAGE, { status: 301, headers: { location: '/one' } });
      fixture.answers.set('/one', { status: 301, headers: { location: '/two' } });
      fixture.answers.set('/two', { body: `<head>${TAG}</head>` });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.sentence).toContain('a check follows one redirect only');
      expect(fixture.asked).toEqual([PAGE, '/one']);
    });

    it('names a 500 and a 404 differently, and neither is “something went wrong”', async () => {
      fixture.answers.set(PAGE, { status: 500, body: 'oops' });
      const broken = await run(checkMetaTag, siteAt(PAGE));
      fixture.answers.delete(PAGE);
      const missing = await run(checkMetaTag, siteAt(PAGE));

      expect(broken.sentence).toBe(`${fixture.origin}${PAGE} did not answer: it answered 500`);
      expect(missing.sentence).toBe(`${fixture.origin}${PAGE} did not answer: it answered 404`);
      expect(broken.sentence).not.toBe(missing.sentence);
      for (const sentence of [broken.sentence, missing.sentence]) {
        expect(sentence).not.toContain('something went wrong');
      }
    });

    it('drops a body larger than the cap rather than reading it, and says so', async () => {
      fixture.answers.set(PAGE, { stream: BODY_LIMIT_BYTES + 64 * 1_024 });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.sentence).toBe(
        `${fixture.origin}${PAGE} did not answer: its body is larger than 512 KiB`,
      );
    });

    it('refuses a declared oversize body on its content-length alone', async () => {
      fixture.answers.set(PAGE, {
        headers: { 'content-length': String(BODY_LIMIT_BYTES * 4) },
        body: `<head>${TAG}</head>`,
      });

      const result = await run(checkMetaTag, siteAt(PAGE));

      expect(result.passed).toBe(false);
      expect(result.sentence).toContain('its body is larger than 512 KiB');
    });

    it('gives up at its own timeout, and says how long it waited', async () => {
      fixture.answers.set(PAGE, { stall: true });

      const result = await run(checkMetaTag, siteAt(PAGE), IMPATIENT_TIMEOUT_MS);

      expect(result.passed).toBe(false);
      expect(result.found.outcome).toBe('no-answer');
      expect(result.sentence).toContain('timed out');
      expect(result.sentence).toContain(`${IMPATIENT_TIMEOUT_MS}ms`);
      expect(fixture.asked).toEqual([PAGE]);
    });

    it('makes exactly one request per check, whatever it finds', async () => {
      fixture.answers.set(PAGE, { body: `<head>${TAG}</head>` });
      fixture.answers.set(FILE_PATH, { body: TOKEN });

      await run(checkMetaTag, siteAt(PAGE));
      await run(checkWellKnownFile, siteAt(PAGE));

      expect(fixture.asked).toEqual([PAGE, FILE_PATH]);
    });

    it('sends no cookie and no authorization of ours', async () => {
      // Asserted on the wire rather than on the options object: what matters is what a user's
      // server actually receives from us (`#221`: nothing here reads a credential).
      const headers: Record<string, string | string[] | undefined>[] = [];
      const watcher = createServer((request, response) => {
        headers.push(request.headers);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<head>${TAG}</head>`);
      });
      await new Promise<void>((resolve) => watcher.listen(0, '127.0.0.1', resolve));
      const { port } = watcher.address() as AddressInfo;
      try {
        const result = await run(checkMetaTag, {
          ...siteAt(PAGE),
          url: `http://127.0.0.1:${port}/create`,
        });
        expect(result.passed).toBe(true);
      } finally {
        watcher.closeAllConnections();
        await new Promise<void>((resolve) => watcher.close(() => resolve()));
      }
      expect(headers).toHaveLength(1);
      expect(headers[0]?.cookie).toBeUndefined();
      expect(headers[0]?.authorization).toBeUndefined();
    });
  });
});

/**
 * The same two methods over HTTP, through `POST /sites/:siteId/verify` — because the thing the
 * product has is the route, not the function. The fixture is the site, and the DNS resolver is
 * injected as the DNS suite injects it, so neither method reaches the network.
 */
describe('POST /sites/:siteId/verify, by meta tag and by well-known file', () => {
  const UNVERIFIED: SiteVerification = { state: 'unverified', method: null, verifiedAt: null };

  let served: TestServer;
  let cookie: string;
  let fixture: Fixture;
  /** The TXT records the injected resolver answers from, so the DNS method still works here. */
  let zone: Record<string, string[][]>;

  const resolveTxt: TxtResolver = async (hostname) => {
    const records = zone[hostname];
    if (records === undefined)
      throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    return records;
  };

  interface SiteBody {
    id: string;
    url: string;
    token: string;
    verification: SiteVerification;
    lastCheck: SiteCheckResult | null;
    check?: SiteCheckResult;
  }

  /** A site at the fixture, added through the route as the Add-a-site screen adds one. */
  const addSite = async (path: string): Promise<SiteBody> => {
    const response = await served.request('/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ url: `${fixture.origin}${path}` }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as SiteBody;
  };

  const verify = async (siteId: string, method: string): Promise<SiteBody> => {
    const response = await served.request(`/sites/${siteId}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as SiteBody;
  };

  const read = async (siteId: string): Promise<SiteBody> => {
    const response = await served.request(`/sites/${siteId}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return (await response.json()) as SiteBody;
  };

  beforeEach(async () => {
    fixture = await startFixture();
    zone = {};
    served = await startTestServer({
      siteChecks: {
        resolveTxt,
        now: () => new Date(CHECKED_AT),
        fetchTimeoutMs: PATIENT_TIMEOUT_MS,
      },
    });
    const signedIn = await served.signIn({
      email: DEMO_ACCOUNT_EMAIL,
      password: served.platform.seeded?.password ?? '',
    });
    expect(signedIn.status).toBe(200);
    cookie = cookieOf(signedIn);
  });

  afterEach(async () => {
    await served.close();
    await fixture.close();
  });

  it('verifies a site whose page carries the meta tag, and reads the method back', async () => {
    const site = await addSite('/create');
    fixture.answers.set('/create', {
      body: `<head>${siteVerificationMetaTag(site.token)}</head>`,
    });

    const verified = await verify(site.id, 'meta-tag');

    expect(verified.check?.passed).toBe(true);
    expect(verified.verification).toEqual({
      state: 'verified',
      method: 'meta-tag',
      verifiedAt: CHECKED_AT,
    });
    expect((await read(site.id)).verification.method).toBe('meta-tag');
    expect(fixture.asked).toEqual(['/create']);
  });

  it('verifies a site serving the well-known file, and reads the method back', async () => {
    const site = await addSite('/create');
    fixture.answers.set(FILE_PATH, { body: `${site.token}\n` });

    const verified = await verify(site.id, 'well-known-file');

    expect(verified.check?.passed).toBe(true);
    expect(verified.verification).toEqual({
      state: 'verified',
      method: 'well-known-file',
      verifiedAt: CHECKED_AT,
    });
    expect((await read(site.id)).verification.method).toBe('well-known-file');
    expect(fixture.asked).toEqual([FILE_PATH]);
  });

  it('leaves a failing site unverified, with a lastCheck naming what was fetched', async () => {
    const site = await addSite('/create');
    fixture.answers.set('/create', { body: '<head><title>Clipforge</title></head>' });

    const answered = await verify(site.id, 'meta-tag');

    expect(answered.verification).toEqual(UNVERIFIED);
    const stored = (await read(site.id)).lastCheck;
    expect(stored?.method).toBe('meta-tag');
    expect(stored?.passed).toBe(false);
    expect(stored?.lookedIn).toEqual([{ kind: 'url', value: `${fixture.origin}/create` }]);
    expect(stored?.sentence).toBe(`no meta tag found on ${fixture.origin}/create`);
  });

  it('does not verify a site that redirects the check to another origin', async () => {
    const away = await startFixture();
    try {
      const site = await addSite('/create');
      away.answers.set('/create', { body: `<head>${siteVerificationMetaTag(site.token)}</head>` });
      fixture.answers.set('/create', {
        status: 302,
        headers: { location: `${away.origin}/create` },
      });

      const answered = await verify(site.id, 'meta-tag');

      expect(answered.verification).toEqual(UNVERIFIED);
      expect(answered.check?.sentence).toContain(`it redirected to ${away.origin}/create`);
      expect(away.asked).toEqual([]);
    } finally {
      await away.close();
    }
  });

  it('still verifies by DNS TXT record, unchanged', async () => {
    const site = await addSite('/create');
    zone['127.0.0.1'] = [[`personavision-site-verification=${site.token}`]];

    const verified = await verify(site.id, 'dns-txt');

    expect(verified.verification.method).toBe('dns-txt');
    expect(fixture.asked).toEqual([]);
  });
});
