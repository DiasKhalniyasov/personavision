import { vi } from 'vitest';
import { demoAudienceRecord, serveRunData } from '../../app';
import { A_VERIFIED_SITE, servedSite } from '../../sites/fixture';
import { clearSiteCache } from '../../../src/sites/useSites';
import { FROM_SENTENCE } from '../../../src/screens/audience/store';
import type { Audience } from '@personavision/contract';
import type { AudienceRecord } from '../../../src/screens/audience/store';
import type { SiteSeed } from '../../sites/fixture';

/**
 * The platform the audience-and-feature step talks to: the workspace's sites, its saved
 * audiences, the one call that turns a sentence into an audience, and the edit that is sent
 * when the reader goes on to the goal.
 *
 * It is faked **at the network boundary and not at the module boundary**, as the sites
 * fixture is: the screen reads its own store, which parses what comes back, so a test can
 * serve a refusal — or a body this build cannot read — and see what the screen does with it.
 */

/**
 * The audience `#screen-newtest-feature` draws, field for field: the brackets, the split,
 * the regions and languages, the mix and the hundred participants the prototype prints.
 *
 * It is the prototype's own screen as data, so a test that reads the six fields is reading
 * the design contract rather than numbers a fixture invented.
 */
export const FIRST_TIME_CREATORS: Audience = {
  id: 'first-time-creators',
  name: 'First-time creators',
  ageRange: { min: 18, max: 44 },
  roles: ['First-time creator'],
  regions: ['Kazakhstan', 'Uzbekistan'],
  languages: ['Russian', 'Kazakh', 'English'],
  genderSplit: { female: 0.54, male: 0.46 },
  ageGroups: [
    { group: '18–24', share: 0.3 },
    { group: '25–34', share: 0.45 },
    { group: '35–44', share: 0.25 },
  ],
  goals: ['Generate a first video from a prompt'],
  devices: [
    {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
      share: 0.72,
    },
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 0.28,
    },
  ],
  techSavviness: 0.2,
  priceSensitivity: 0.6,
  size: 100,
  generatedFrom: { seed: 20_261_104, generatorVersion: 'persona-gen-1' },
};

/** The sentence the prototype's box carries. */
export const THE_SENTENCE =
  'first-time creators in Kazakhstan, mostly on phones, who have never used a video tool';

/** The record id the audience above is stored under. */
export const CREATORS_RECORD_ID = 'aud-first-time-creators';

/** One stored audience, in the shape every audience route answers with. */
export const recordOf = (audience: Audience, id: string): AudienceRecord => ({
  id,
  audience,
  people: [],
  createdAt: '2026-11-04T09:00:00.000Z',
  updatedAt: '2026-11-04T09:00:00.000Z',
  deletedAt: null,
  issues: [],
});

export const creatorsRecord = (): AudienceRecord =>
  recordOf(FIRST_TIME_CREATORS, CREATORS_RECORD_ID);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A refusal shaped the way the platform shapes one: one message per offending path. */
export const refusal = (
  issues: readonly { readonly path: string; readonly message: string }[],
  error = 'That audience could not be saved.',
): Response => json(400, { error, issues });

export interface StepBehaviour {
  /** The workspace's sites. The default is the one verified site of `#screen-sites`. */
  readonly sites?: readonly SiteSeed[];
  /** The workspace's saved audiences, for the picker and for a reload. */
  readonly records?: readonly AudienceRecord[];
  /** What `POST /audiences/from-sentence` answers. The default is the audience above. */
  readonly reads?: (sentence: string) => Response;
  /** What `PATCH /audiences/:id` answers. The default stores what was sent. */
  readonly patches?: (audience: Audience) => Response;
  /** Hold the sentence call until `release` is called, for the loading state. */
  readonly hold?: boolean;
}

export interface ServedStep {
  /** Every sentence the screen asked the platform to read, in order. */
  sentences: () => readonly string[];
  /** Every audience the screen asked the platform to store, in order. */
  saved: () => readonly Audience[];
  /** Answer a held sentence call. */
  release: () => void;
}

export async function serveStep(behaviour: StepBehaviour = {}): Promise<ServedStep> {
  clearSiteCache();
  const records = behaviour.records ?? [];
  await serveRunData({ audiences: [...records] });
  const reads = globalThis.fetch;
  const sentences: string[] = [];
  const saved: Audience[] = [];

  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';

    if (pathname === '/sites' && method === 'GET') {
      const sites = behaviour.sites ?? [A_VERIFIED_SITE];
      return json(200, { sites: sites.map(servedSite) });
    }

    if (pathname === FROM_SENTENCE && method === 'POST') {
      const asked =
        (JSON.parse(String(init?.body ?? '{}')) as { sentence?: string }).sentence ?? '';
      sentences.push(asked);
      if (held !== null) await held;
      return behaviour.reads === undefined ? json(201, creatorsRecord()) : behaviour.reads(asked);
    }

    if (pathname.startsWith('/audiences/') && method === 'PATCH') {
      const audience = JSON.parse(String(init?.body ?? '{}')) as Audience;
      saved.push(audience);
      return behaviour.patches === undefined
        ? json(200, recordOf(audience, pathname.slice('/audiences/'.length)))
        : behaviour.patches(audience);
    }

    return reads(input as RequestInfo, init);
  });

  return {
    sentences: () => sentences,
    saved: () => saved,
    release: () => {
      release();
    },
  };
}

/** A saved audience of the workspace, so the picker has something to offer. */
export const savedAudienceRecord = (): AudienceRecord => {
  const demo = demoAudienceRecord();
  return { ...demo, id: 'aud-outdoor-gear', audience: { ...demo.audience, size: 100 } };
};

export { A_VERIFIED_SITE, AN_UNVERIFIED_SITE } from '../../sites/fixture';
