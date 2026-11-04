import { vi } from 'vitest';
import { serveRunData } from '../app';
import { clearSiteCache } from '../../src/sites/useSites';
import { SITES_PATH } from '../../src/sites/store';
import { servedSite } from '../sites/fixture';
import type { SiteSeed } from '../sites/fixture';

/**
 * One site, as `GET /sites/:siteId` answers it, created by `POST /sites` and removed by
 * `DELETE /sites/:siteId` — served over the stubbed `fetch` the run data already uses.
 *
 * The platform is faked **at the network boundary and not at the module boundary**: the
 * screen reads its own store, which parses what comes back, so a test can serve the shape
 * the real route answers with and see what the screen does with it.
 *
 * The site itself is built by the Sites screen's own fixture (`../sites/fixture`), so the
 * two screens are tested against one served record rather than two that drift. **The
 * figures on it are the fixture's, never the product's**: `packages/platform/src/caps.ts`
 * is the one place the caps are defined, so what these tests assert is that the screen
 * prints the numbers it was *served*.
 */

/** How `DELETE /sites/:siteId` answers. The default is the soft-deleted record, as it does. */
export interface RemovalAnswer {
  /** Answer with this status and body instead, for a platform that refuses the removal. */
  readonly answers?: { readonly status: number; readonly body?: unknown };
  /** The platform is not there at all. */
  readonly unreachable?: boolean;
  /** Hold the answer until `releaseRemoval` is called, for a removal in flight. */
  readonly hold?: boolean;
}

export interface SiteBehaviour {
  /** What `GET /sites/:siteId` answers with. `null`, or absent, is a site that is not there. */
  readonly site?: SiteSeed | null;
  /** Hold that read until `release` is called, for a test about the loading state. */
  readonly hold?: boolean;
  /** The platform cannot be reached for the read. */
  readonly unreachable?: boolean;
  /** What `POST /sites` answers: the site it created, or a refusal against the `url` field. */
  readonly create?: { readonly refuse?: string; readonly id?: string };
  /** What `DELETE /sites/:siteId` answers. Absent is the removal going through. */
  readonly removal?: RemovalAnswer;
}

export interface ServedSite {
  /** How many times the site was read. */
  reads: () => number;
  /** Answer a held read. */
  release: () => void;
  /** Answer a held removal. */
  releaseRemoval: () => void;
  /** The URLs posted to `POST /sites`, in order. */
  created: () => readonly string[];
  /** The site ids sent to `DELETE /sites/:siteId`, in order. */
  removed: () => readonly string[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** The id `/sites/new` gives the site it creates, which is where the screen then goes. */
export const CREATED_SITE_ID = 'site-created';

export async function serveSite(behaviour: SiteBehaviour = {}): Promise<ServedSite> {
  // Anything read before this test is another test's answer.
  clearSiteCache();
  await serveRunData();
  // `serveRunData` has just stubbed `fetch` with the run-data mount; these routes sit in
  // front of it and everything else falls through, exactly as the server composes them.
  const runData = globalThis.fetch;
  let reads = 0;
  const created: string[] = [];
  const removed: string[] = [];

  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  let releaseRemoval = (): void => {};
  const heldRemoval = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const site = behaviour.site ?? null;

    if (pathname === SITES_PATH && method === 'POST') {
      const url = (JSON.parse(String(init?.body ?? '{}')) as { url?: string }).url ?? '';
      created.push(url);
      const refuse = behaviour.create?.refuse;
      if (refuse !== undefined) return json(400, { issues: [{ path: 'url', message: refuse }] });
      return json(201, servedSite({ id: behaviour.create?.id ?? CREATED_SITE_ID, url }));
    }

    const one = /^\/sites\/([^/]+)$/.exec(pathname);
    if (one !== null && method === 'DELETE') {
      removed.push(decodeURIComponent(one[1] as string));
      const answer = behaviour.removal ?? {};
      if (answer.unreachable === true) throw new TypeError('Failed to fetch');
      if (answer.hold === true) await heldRemoval;
      if (answer.answers !== undefined) {
        return json(answer.answers.status, answer.answers.body ?? {});
      }
      if (site === null) return json(404, { error: 'There is no such site.' });
      // The removal is soft, so the route answers the record with `deletedAt` set.
      return json(200, { ...servedSite(site), deletedAt: '2026-11-04T12:00:00.000Z' });
    }

    if (one !== null && method === 'GET') {
      reads += 1;
      if (behaviour.unreachable === true) throw new TypeError('Failed to fetch');
      if (held !== null) await held;
      if (site === null) return json(404, { error: 'There is no such site.' });
      return json(200, servedSite(site));
    }

    return runData(input as RequestInfo, init);
  });

  return {
    reads: () => reads,
    release: () => {
      release();
    },
    releaseRemoval: () => {
      releaseRemoval();
    },
    created: () => created,
    removed: () => removed,
  };
}

/** The site `#screen-site` is drawn with, by the address the prototype gives it. */
export const THE_SITE: SiteSeed = {
  id: 'site-beta',
  url: 'https://beta.clipforge.example/create',
  createdAt: '2026-11-03T11:00:00.000Z',
};
