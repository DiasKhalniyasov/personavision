import { vi } from 'vitest';
import { serveRunData } from '../app';
import { clearSiteCache } from '../../src/sites/useSites';
import { SITES_PATH } from '../../src/sites/store';
import { servedSite } from '../sites/fixture';
import type { SiteSeed } from '../sites/fixture';

/**
 * One site, as `GET /sites/:siteId` answers it, and the check `POST /sites/:siteId/verify`
 * runs — served over the stubbed `fetch` the run data already uses.
 *
 * The platform is faked **at the network boundary and not at the module boundary**: the
 * screen reads its own store, which parses what comes back, so a test can serve the shape
 * the real route answers with (the whole site, with the check's result beside it) and see
 * what the screen does with it.
 *
 * The site itself is built by the Sites screen's own fixture (`../sites/fixture`), so the
 * two screens are tested against one served record rather than two that drift. **The
 * figures on it are the fixture's, never the product's**: `packages/platform/src/caps.ts`
 * is the one place the caps are defined, so what these tests assert is that the screen
 * prints the numbers it was *served*.
 */

/** What a check answers: whether it found what it looked for, and in what words. */
export interface CheckAnswer {
  readonly passed: boolean;
  /** The platform's own sentence — no full stop and no clock, as the route answers it. */
  readonly sentence: string;
  readonly checkedAt?: string;
  /** Answer with this status and body instead, for a platform that refuses the check. */
  readonly answers?: { readonly status: number; readonly body?: unknown };
  /** The platform is not there at all. */
  readonly unreachable?: boolean;
  /** Hold the answer until `releaseCheck` is called, for a test about a check in flight. */
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
  /** What each method's check answers. A method absent from here is never checked by a test. */
  readonly checks?: Readonly<Record<string, CheckAnswer>>;
}

export interface ServedSite {
  /** How many times the site was read. */
  reads: () => number;
  /** Answer a held read. */
  release: () => void;
  /** Answer a held check. */
  releaseCheck: () => void;
  /** The URLs posted to `POST /sites`, in order. */
  created: () => readonly string[];
  /** The methods posted to `POST /sites/:siteId/verify`, in order. */
  checked: () => readonly string[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const DEFAULT_CHECKED_AT = '2026-11-03T09:04:00.000Z';

/** The site and the check, in the shape the verify route answers with. */
const checkedSite = (seed: SiteSeed, method: string, answer: CheckAnswer): unknown => {
  const at = answer.checkedAt ?? DEFAULT_CHECKED_AT;
  const lastCheck = { passed: answer.passed, sentence: answer.sentence, checkedAt: at, method };
  const site = servedSite({
    ...seed,
    lastCheck,
    // Only a passing check moves a site, and the platform is the one that moves it.
    ...(answer.passed ? { verified: { method, at } } : {}),
  }) as Record<string, unknown>;
  return { ...site, check: site['lastCheck'] };
};

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
  const checked: string[] = [];

  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  let releaseCheck = (): void => {};
  const heldCheck = new Promise<void>((resolve) => {
    releaseCheck = resolve;
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

    const verifying = /^\/sites\/([^/]+)\/verify$/.exec(pathname);
    if (verifying !== null && method === 'POST') {
      const asked = (JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method ?? '';
      checked.push(asked);
      const answer = behaviour.checks?.[asked];
      if (answer === undefined || site === null) {
        return json(400, { error: `"${asked}" is not a check this test serves.` });
      }
      if (answer.unreachable === true) throw new TypeError('Failed to fetch');
      if (answer.hold === true) await heldCheck;
      if (answer.answers !== undefined) {
        return json(answer.answers.status, answer.answers.body ?? {});
      }
      return json(200, checkedSite(site, asked, answer));
    }

    if (/^\/sites\/[^/]+$/.test(pathname) && method === 'GET') {
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
    releaseCheck: () => {
      releaseCheck();
    },
    created: () => created,
    checked: () => checked,
  };
}

/** The site `#screen-site` is drawn with: unverified, and never checked. */
export const THE_SITE: SiteSeed = {
  id: 'site-beta',
  url: 'https://beta.clipforge.example/create',
};

/** The token every served site carries, which is the one in the lines to copy. */
export const THE_TOKEN = 'pv_7f3c91a2d84e';
