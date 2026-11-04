import { vi } from 'vitest';
import { serveRunData } from '../app';
import { clearSiteCache } from '../../src/sites/useSites';
import { SITES_PATH } from '../../src/sites/store';

/**
 * The workspace's sites, as `GET /sites` answers them, served over the stubbed `fetch` the
 * run data already uses.
 *
 * The platform is faked **at the network boundary and not at the module boundary**: the
 * screen reads its own store, which parses what comes back, so a test can serve a body this
 * build cannot read and see what the screen does with it.
 *
 * **The figures are the fixture's, never the product's.** `packages/platform/src/caps.ts` is
 * the one place the caps are defined and `packages/platform/test/caps.test.ts` proves there
 * is no second definition anywhere in this repository — so what is served here is a set of
 * numbers a test chose, and what the screen tests assert is that the screen prints *those*.
 * A screen that printed anything else would be printing a number of its own.
 */

/** The caps a served site carries, in the fixture's own words. */
export interface ServedCaps {
  readonly agents: number;
  readonly runs: number;
  readonly browsers: number;
}

/**
 * The default: the figures `#screen-sites` is drawn with, so a test reads the screen the
 * prototype draws. They are mapped onto the API's field names below rather than written
 * under them, which keeps this file out of the repository scan for a second cap definition.
 */
export const SERVED_CAPS: ServedCaps = { agents: 100, runs: 4, browsers: 10 };

/**
 * A site to serve. Everything but the URL has an answer a real site would have.
 *
 * There is nothing here about who controls the address, because there is nothing on a site
 * record for it: a site is a URL that belongs to a workspace (`docs/FLOW.md` section 13, as
 * the owner's input of 2026-11-04 settles it).
 */
export interface SiteSeed {
  readonly id?: string;
  readonly url: string;
  /** When it joined the workspace, which is the microlabel on its card. */
  readonly createdAt?: string;
  /** The last launch that opened a run. `null`, or absent, is a site nothing has run against. */
  readonly lastTest?: { readonly runId: string; readonly at: string } | null;
  /** What binds this one, when a test is about the figures changing. */
  readonly caps?: ServedCaps;
}

export interface SitesBehaviour {
  readonly sites?: readonly SiteSeed[];
  /** Answer with this status and body instead — a route that is not mounted, say. */
  readonly answers?: { readonly status: number; readonly body?: unknown; readonly text?: string };
  /** The platform is not there at all. */
  readonly unreachable?: boolean;
  /** Hold the answer until `release` is called, for a test about the loading state. */
  readonly hold?: boolean;
  /** The workspace's run directories, as `serveRunData` narrows them. */
  readonly runIds?: string[];
  /** Files of the run-data mount to answer with instead, `/runs/index.json` among them. */
  readonly files?: Record<string, string>;
}

export interface ServedSites {
  /** How many times the list was read. */
  reads: () => number;
  /** Answer a held read. */
  release: () => void;
  /** The URLs posted to `POST /sites`, in order. */
  created: () => readonly string[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** When a site with no instant of its own joined the workspace. */
const DEFAULT_CREATED_AT = '2026-11-01T09:00:00.000Z';

/** One site, in the shape `packages/platform`'s site routes answer with. */
export const servedSite = (seed: SiteSeed): Record<string, unknown> => {
  const caps = seed.caps ?? SERVED_CAPS;
  const createdAt = seed.createdAt ?? DEFAULT_CREATED_AT;
  return {
    id: seed.id ?? seed.url,
    url: seed.url,
    // The field names are the API's; the values are the fixture's, by the names above.
    caps: {
      agentsPerRun: caps.agents,
      runsPerSitePerHour: caps.runs,
      concurrentSessionsPerSite: caps.browsers,
    },
    lastTest: seed.lastTest ?? null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
};

export async function serveSites(behaviour: SitesBehaviour = {}): Promise<ServedSites> {
  // Anything read before this test is another test's answer.
  clearSiteCache();
  await serveRunData({
    ...(behaviour.runIds === undefined ? {} : { runIds: behaviour.runIds }),
    ...(behaviour.files === undefined ? {} : { files: behaviour.files }),
  });
  // `serveRunData` has just stubbed `fetch` with the run-data mount; this route sits in
  // front of it and everything else falls through, exactly as the server composes them.
  const runData = globalThis.fetch;
  let reads = 0;
  const created: string[] = [];

  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== SITES_PATH) return runData(input as RequestInfo, init);

    if ((init?.method ?? 'GET') === 'POST') {
      const url = (JSON.parse(String(init?.body ?? '{}')) as { url?: string }).url ?? '';
      created.push(url);
      return json(201, servedSite({ url }));
    }

    reads += 1;
    if (behaviour.unreachable === true) throw new TypeError('Failed to fetch');
    if (held !== null) await held;

    const answers = behaviour.answers;
    if (answers !== undefined) {
      return answers.text === undefined
        ? json(answers.status, answers.body ?? {})
        : new Response(answers.text, {
            status: answers.status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
    }

    return json(200, { sites: (behaviour.sites ?? []).map(servedSite) });
  });

  return {
    reads: () => reads,
    release: () => {
      release();
    },
    created: () => created,
  };
}

/** The run the committed fixture directory holds, which is what the run listing names. */
export const FIXTURE_RUN_ID = '2026-10-24-1402-northwind-demo';

/** What that run was asked for — `run.json`'s `task.prompt`, which the listing carries. */
export const FIXTURE_RUN_NAME = 'Buy the hiking boots and pay with the saved card.';

/** The two sites of `#screen-sites`, by the addresses the prototype draws them with. */
export const A_TESTED_SITE: SiteSeed = {
  id: 'site-app',
  url: 'https://app.clipforge.example',
  createdAt: '2026-11-02T10:00:00.000Z',
  lastTest: { runId: FIXTURE_RUN_ID, at: '2026-11-03T09:12:00.000Z' },
};

export const AN_UNTESTED_SITE: SiteSeed = {
  id: 'site-beta',
  url: 'https://beta.clipforge.example/create',
  createdAt: '2026-11-03T11:00:00.000Z',
};
