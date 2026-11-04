// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup';
import {
  createSite,
  listSites,
  readSite,
  removeSite,
  SITES_PATH,
  sitePath,
} from '../../src/sites/store';
import type { StoreResult } from '../../src/sites/store';
import { clearSiteCache } from '../../src/sites/useSites';
import { SERVED_CAPS, servedSite } from './fixture';

/**
 * The one module in the app that speaks #221's site routes: list, read, create, remove.
 *
 * The screens are tested against the network; this is tested against the network too, but
 * one call at a time, because the shape of what it answers is what every site screen reads.
 *
 * **There are four calls and no fifth.** A site is a URL that belongs to a workspace
 * (`docs/FLOW.md` section 13, as the owner's input of 2026-11-04 settles it), so there is no
 * call here that could say anything about who controls the address.
 *
 * What it must never do is throw. Every way a request can go wrong — a platform that is not
 * there, a refusal with a message per field, a site of another workspace, an answer this
 * build cannot read — comes back as a result a screen can render with the form still
 * standing and whatever was typed still in it.
 */

/** What was asked for, and how. */
interface Asked {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

let asked: Asked[];

/**
 * What a failed call states, as a screen would read it: the one sentence, or the first
 * field message for a refusal. A call that succeeded is the test's own mistake.
 */
const problemOf = (result: StoreResult<unknown>): string => {
  if (result.ok) throw new Error('that call answered a site');
  return result.kind === 'refused' ? (result.issues[0]?.message ?? '') : result.problem;
};

/** Which kind of failure it was. */
const kindOf = (result: StoreResult<unknown>): string => {
  if (result.ok) throw new Error('that call answered a site');
  return result.kind;
};

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** Answer every request with this, and record what was asked. */
const serving = (reply: (path: string) => Response | Promise<Response>): void => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? null : String(init.body),
    });
    return reply(new URL(url).pathname);
  });
};

const A_SITE = servedSite({ id: 'site-beta', url: 'https://beta.clipforge.example/create' });

beforeEach(() => {
  asked = [];
  clearSiteCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the routes it speaks', () => {
  it('lists the workspace’s sites from GET /sites', async () => {
    serving(() => answer(200, { sites: [A_SITE] }));

    const result = await listSites();

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.map((site) => site.url)).toEqual([
      'https://beta.clipforge.example/create',
    ]);
    expect(asked[0]?.method).toBe('GET');
    expect(new URL(asked[0]?.url ?? '').pathname).toBe(SITES_PATH);
  });

  it('reads one site from GET /sites/:siteId, by the id a URL carries', async () => {
    serving(() => answer(200, A_SITE));

    const result = await readSite('site beta/1');

    expect(result.ok).toBe(true);
    expect(new URL(asked[0]?.url ?? '').pathname).toBe('/sites/site%20beta%2F1');
    expect(sitePath('site beta/1')).toBe('/sites/site%20beta%2F1');
  });

  it('creates one with POST /sites, sending the URL and nothing else', async () => {
    serving(() => answer(201, A_SITE));

    const result = await createSite('https://beta.clipforge.example/create');

    expect(result.ok).toBe(true);
    expect(asked[0]?.method).toBe('POST');
    // One field, because one field is read: a site record has nothing else on it for a
    // submission to reach.
    expect(JSON.parse(asked[0]?.body ?? '{}')).toEqual({
      url: 'https://beta.clipforge.example/create',
    });
  });

  it('removes one with DELETE /sites/:siteId, and sends no body', async () => {
    serving(() => answer(200, { ...A_SITE, deletedAt: '2026-11-04T12:00:00.000Z' }));

    const result = await removeSite('site beta/1');

    expect(result.ok).toBe(true);
    expect(asked[0]?.method).toBe('DELETE');
    expect(new URL(asked[0]?.url ?? '').pathname).toBe('/sites/site%20beta%2F1');
    expect(asked[0]?.body).toBeNull();
    // The removal is soft, so the route answers the record: the instant is on it.
    expect(result.ok && result.value.deletedAt).toBe('2026-11-04T12:00:00.000Z');
  });

  it('reads a 404 from the removal as there being no such site', async () => {
    serving(() => answer(404, { error: 'There is no such site.' }));

    const result = await removeSite('a-site-of-another-workspace');

    expect(kindOf(result)).toBe('not-found');
    expect(problemOf(result)).toBe('There is no such site.');
  });

  it('names what could not be removed when the platform answers nothing it can say', async () => {
    serving(() => answer(503, {}));

    const result = await removeSite('site-beta');

    // The sentence is about what the reader asked for, not about their sites.
    expect(problemOf(result)).toBe('That site could not be removed. It answered 503.');
  });

  it('asks for JSON on both reads, because each shares its path with a screen', async () => {
    serving((path) => answer(200, path === SITES_PATH ? { sites: [] } : A_SITE));

    await listSites();
    await readSite('site-beta');

    for (const request of asked) expect(request.headers['accept']).toBe('application/json');
  });
});

describe('what it answers with', () => {
  it('carries the caps the platform states, which is where a screen’s figures come from', async () => {
    serving(() => answer(200, { sites: [A_SITE] }));

    const result = await listSites();

    // Named through the fixture's own figures rather than written again here: the caps are
    // defined in `packages/platform/src/caps.ts` and nowhere else, and
    // `packages/platform/test/caps.test.ts` scans this repository to keep it that way.
    expect(result.ok && result.value[0]?.caps).toEqual({
      agentsPerRun: SERVED_CAPS.agents,
      runsPerSitePerHour: SERVED_CAPS.runs,
      concurrentSessionsPerSite: SERVED_CAPS.browsers,
    });
  });

  it('reads a site a platform that predates the field answers, with no last test', async () => {
    const older: Record<string, unknown> = { ...A_SITE };
    delete older['lastTest'];
    serving(() => answer(200, { sites: [older] }));

    const result = await listSites();

    // A key the answer leaves out is a site with nothing to say about its last test, not a
    // site this build cannot read.
    expect(result.ok && result.value[0]?.lastTest).toBeNull();
  });
});

describe('what it does with a refusal', () => {
  it('reads a 400 as one message per offending field', async () => {
    serving(() =>
      answer(400, {
        error: 'That site could not be saved.',
        issues: [{ path: 'url', message: 'That is not a URL.' }],
      }),
    );

    const result = await createSite('clipforge.example');

    expect(result).toEqual({
      ok: false,
      kind: 'refused',
      issues: [{ path: 'url', message: 'That is not a URL.' }],
    });
  });

  it('reads a 404 as there being no such site, in the platform’s words', async () => {
    serving(() => answer(404, { error: 'There is no such site.' }));

    const result = await readSite('a-site-of-another-workspace');

    expect(result).toEqual({
      ok: false,
      kind: 'not-found',
      problem: 'There is no such site.',
    });
  });

  it('names the status when the platform answers one it has no sentence for', async () => {
    serving(() => answer(503, {}));

    const result = await listSites();

    expect(result).toEqual({
      ok: false,
      kind: 'unreachable',
      problem: 'Your sites could not be read. It answered 503.',
    });
  });

  it('says the platform could not be reached, with the reason, rather than throwing', async () => {
    vi.stubGlobal('fetch', () => {
      throw new TypeError('Failed to fetch');
    });

    const result = await listSites();

    expect(kindOf(result)).toBe('unreachable');
    expect(problemOf(result)).toContain('Your sites could not be read.');
    expect(problemOf(result)).toContain('Failed to fetch');
  });

  it('says what it could not read when the answer is not a site, at the field it is wrong at', async () => {
    serving(() => answer(200, { sites: [{ ...A_SITE, caps: { agentsPerRun: 'a hundred' } }] }));

    const result = await listSites();

    expect(kindOf(result)).toBe('unreachable');
    expect(problemOf(result)).toContain('sites.0.caps.agentsPerRun');
  });

  it('says so when the answer is not JSON at all', async () => {
    serving(() => new Response('<!doctype html><title>Sites</title>', { status: 200 }));

    const result = await listSites();

    expect(kindOf(result)).toBe('unreachable');
    expect(problemOf(result)).toContain('not JSON');
  });
});
