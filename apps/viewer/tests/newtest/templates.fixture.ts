import { vi } from 'vitest';
import { serveRunData } from '../app';
import { servedSite } from '../sites/fixture';
import { CONNECTION_PATH, forgetGithubConnection } from '../../src/screens/settings/connection';
import { SITES_PATH } from '../../src/sites/store';
import { clearSiteCache } from '../../src/sites/useSites';
import type { SiteSeed } from '../sites/fixture';

/**
 * The workspace the two screens that offer the example tests read: its sites, its GitHub
 * connection and its runs, over one stubbed `fetch`.
 *
 * The platform is faked **at the network boundary and not at the module boundary**, as every
 * screen suite in this app fakes it: the screens read their own stores, so what is asserted
 * is what a screen does with an answer rather than what a mocked module was asked.
 *
 * The three layers are composed the way the server composes them, and in that order, rather
 * than each fixture being called in turn: `serveSites` and `serveConnection` each start from
 * `serveRunData`, so calling both would leave only the second one's route standing.
 *
 * `POST /sites` is **served, not counted**: a site added here joins the list the next `GET`
 * answers, because that is what the step a template lands on reads — the audience step
 * chooses among the workspace's sites, and a site the platform accepted but does not list is
 * a site that step would silently replace.
 */

export interface WorkspaceBehaviour {
  /** The sites the workspace already holds. */
  readonly sites?: readonly SiteSeed[];
  /** What `POST /sites` answers instead of adding the site. */
  readonly refusesCreate?: { readonly status: number; readonly body: unknown };
  /** Hold `GET /sites` until `release` is called: the list is still being read. */
  readonly holdList?: boolean;
  /** Hold `POST /sites` until `release` is called: a site is still being added. */
  readonly holdCreate?: boolean;
  /** `POST /sites` is not answered at all: the platform is not there. */
  readonly createUnreachable?: boolean;
  /** `GET /sites` cannot be read, so no site is known before one is posted. */
  readonly listUnreachable?: boolean;
  /** The workspace's run directories. `[]` is a workspace with no test. */
  readonly runIds?: string[];
}

export interface ServedWorkspace {
  /** The URLs posted to `POST /sites`, in order. */
  created: () => readonly string[];
  /** The sites the workspace holds now, as `GET /sites` would list them. */
  listed: () => readonly string[];
  /** Answer a held read or a held write. */
  release: () => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function serveWorkspace(behaviour: WorkspaceBehaviour = {}): Promise<ServedWorkspace> {
  // Anything read before this test is another test's answer.
  clearSiteCache();
  forgetGithubConnection();
  await serveRunData(behaviour.runIds === undefined ? {} : { runIds: behaviour.runIds });
  const runData = globalThis.fetch;

  /** The workspace's sites as they stand, which a `POST` adds to. */
  const live: SiteSeed[] = [...(behaviour.sites ?? [])];
  const created: string[] = [];

  let release = (): void => {};
  const held =
    behaviour.holdList === true || behaviour.holdCreate === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));

    if (pathname === CONNECTION_PATH) {
      // The normal state: the App exists and this workspace has connected no repository,
      // which is the path-2 card's lock and is not what these tests are about.
      return json(200, { registered: true, connection: null });
    }

    if (pathname === SITES_PATH) {
      if ((init?.method ?? 'GET') === 'POST') {
        const url = (JSON.parse(String(init?.body ?? '{}')) as { url?: string }).url ?? '';
        created.push(url);
        if (held !== null && behaviour.holdCreate === true) await held;
        if (behaviour.createUnreachable === true) throw new TypeError('Failed to fetch');
        const refusal = behaviour.refusesCreate;
        if (refusal !== undefined) return json(refusal.status, refusal.body);
        const seed: SiteSeed = { id: `site-${String(live.length + 1)}`, url };
        live.push(seed);
        return json(201, servedSite(seed));
      }
      if (held !== null && behaviour.holdList === true) await held;
      if (behaviour.listUnreachable === true) throw new TypeError('Failed to fetch');
      return json(200, { sites: live.map(servedSite) });
    }

    return runData(input as RequestInfo, init);
  });

  return {
    created: () => created,
    listed: () => live.map((seed) => seed.url),
    release: () => {
      release();
    },
  };
}
