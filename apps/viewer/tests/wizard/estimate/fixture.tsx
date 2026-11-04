import { vi } from 'vitest';
import { demoAudienceRecord, serveRunData } from '../../app';
import { servedSite } from '../../sites/fixture';
import type { SiteSeed } from '../../sites/fixture';
import { clearSiteCache } from '../../../src/sites/useSites';
import { SITES_PATH } from '../../../src/sites/store';
import type { AudienceRecord } from '../../../src/screens/audience/store';
import type { WizardDraft } from '../../../src/screens/newtest/wizard/draft';

/**
 * The platform the launch step talks to: the audience it reads the participants off, the
 * site it reads the per-site cap off, the estimate it prints and the one request that starts
 * a test.
 *
 * Faked **at the network boundary**, like every other screen suite here: the screen reads
 * its own modules, which parse what comes back, so a test can serve a figure this build has
 * never seen and watch what the screen does with it.
 *
 * **Every figure served here is the fixture's own.** `packages/platform` computes the real
 * ones (#283) and `packages/platform/src/caps.ts` is the only place the caps are defined —
 * what these tests assert is that the screen prints *what it was handed*, which is the whole
 * claim of "no figure on this screen is computed in the browser".
 */

/** The audience `#screen-newtest-estimate` is drawn with: a hundred first-time creators. */
export const THE_AUDIENCE = (): AudienceRecord => {
  const demo = demoAudienceRecord();
  return {
    ...demo,
    id: 'aud-first-time-creators',
    audience: {
      ...demo.audience,
      id: 'first-time-creators',
      name: 'First-time creators',
      // The participants the heading and the Agents cell print. It is the store's figure and
      // the screen reads it; the people below are the demo workspace's, which this screen
      // never looks at.
      size: 100,
    },
  };
};

/** The site the prototype's heading names, as `GET /sites` answers it. */
export const THE_SITE: SiteSeed = {
  id: 'site-clipforge',
  url: 'https://app.clipforge.example/create',
  createdAt: '2026-11-02T10:00:00.000Z',
};

/** The draft a user arrives at this step with: a site, a feature, an audience and a goal. */
export const filledDraft = (): WizardDraft => ({
  site: { id: THE_SITE.id ?? '', url: THE_SITE.url },
  feature: 'generating a video from a prompt',
  audience: {
    sentence: 'first-time creators in Kazakhstan, mostly on phones',
    audienceId: 'aud-first-time-creators',
    reviewed: true,
  },
  goal: {
    task: 'Generate a video from a text prompt, and wait until it is ready to watch.',
    success: 'A video preview is visible on the page.',
    author: 'model',
    writtenAt: '2026-11-03T09:08:00.000Z',
    // What the model was told: this draft's own site and sentence, so the goal step before
    // this one would read the stored goal as current and ask for nothing (#276).
    askedFor: { siteUrl: THE_SITE.url, feature: 'generating a video from a prompt' },
  },
});

/** What the screen asks for: the body of its one `POST /runs/estimate`. */
export interface Quoted {
  readonly participants?: number;
  readonly siteUrl?: string;
  readonly concurrency?: number;
  readonly engineMode?: string;
}

/**
 * A site with a history of its own, on a model: the first worked example of #283's response
 * shape. Every total is already multiplied up, as the platform sends them.
 */
export const knownEstimate = (quoted: Quoted): Record<string, unknown> => {
  const participants = quoted.participants ?? 0;
  const concurrency = quoted.concurrency ?? 1;
  return {
    siteUrl: quoted.siteUrl,
    engineMode: 'model',
    agents: { participants, sessions: participants, concurrency },
    time: {
      state: 'known',
      sessions: participants,
      concurrency,
      batches: 10,
      medianSessionMs: 110_000,
      sessionMs: { low: 90_000, high: 150_000 },
      measuredFrom: 'this-site',
      sessionsMeasured: 5,
      browserStartupMs: null,
      ms: { low: 900_000, high: 1_500_000 },
    },
    cost: {
      state: 'known',
      sessions: participants,
      modelId: 'muse-spark-1.3',
      prices: {
        inputPerMillionUsd: 1.25,
        cachedInputPerMillionUsd: 0.15,
        outputPerMillionUsd: 4.25,
        acceptsImages: true,
        acceptsReasoningEffort: false,
        ratesReadOn: '2026-10-27',
      },
      tokensPerSession: {
        low: { inputTokens: 6000, cachedInputTokens: 1000, outputTokens: 400 },
        median: { inputTokens: 6800, cachedInputTokens: 1000, outputTokens: 500 },
        high: { inputTokens: 9000, cachedInputTokens: 2000, outputTokens: 700 },
      },
      measuredFrom: 'this-site',
      runsMeasured: 5,
      usdPerSession: { low: 0.0081, high: 0.012025 },
      usd: { low: 0.81, high: 1.2025 },
    },
    storage: {
      state: 'known',
      sessions: participants,
      medianBytesPerSession: 14_000_000,
      measuredFrom: 'this-site',
      runsMeasured: 5,
      bytes: 1_400_000_000,
    },
  };
};

/**
 * The same site before anybody has tested it, on the offline engine: the second worked
 * example — a time borrowed from other sites, **no cost at all** and a storage figure
 * nobody has measured.
 */
export const offlineEstimate = (quoted: Quoted): Record<string, unknown> => {
  const known = knownEstimate(quoted);
  return {
    ...known,
    engineMode: 'offline',
    time: {
      ...(known.time as Record<string, unknown>),
      measuredFrom: 'other-sites',
      sessionMs: { low: 60_000, high: 240_000 },
      ms: { low: 600_000, high: 2_400_000 },
    },
    cost: {
      state: 'nothing-to-pay',
      reason: 'the offline deterministic engine calls no model, so this test is billed nothing',
    },
    storage: {
      state: 'unknown',
      reason: 'no finished test on the offline engine has recorded the video a session writes',
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A refusal in the shape `packages/platform` answers one: a sentence, and its figures. */
export const refusal = (body: Record<string, unknown>, status: number): Response =>
  json(body, status);

export interface LaunchBehaviour {
  /** The workspace's sites. The default is the one the prototype's heading names. */
  readonly sites?: readonly SiteSeed[];
  /** The workspace's audiences. The default is the hundred first-time creators. */
  readonly audiences?: readonly AudienceRecord[];
  /** What `POST /runs/estimate` answers. The default is a site with a history of its own. */
  readonly estimate?: (quoted: Quoted) => Response;
  /** What `POST /runs` answers. The default is a run that was opened. */
  readonly run?: (body: Record<string, unknown>) => Response;
  /** Hold the estimate until `release` is called, for a test about the loading state. */
  readonly holdEstimate?: boolean;
  /** `GET /sites` answers this status instead, so the per-site cap cannot be read. */
  readonly sitesAnswer?: number;
}

export interface ServedLaunch {
  /** Every estimate the screen asked for, in order. */
  readonly quoted: () => readonly Quoted[];
  /** Every test the screen asked the platform to start, in order. */
  readonly started: () => readonly Record<string, unknown>[];
  /** Everything posted anywhere, by path: this screen must start nothing else. */
  readonly posted: () => readonly string[];
  /** Answer a held estimate. */
  readonly release: () => void;
}

/** The run the platform opens by default, which `/runs/:runId` is then driven by. */
export const STARTED_RUN_ID = '2026-10-24-1402-northwind-demo';

export async function serveLaunch(behaviour: LaunchBehaviour = {}): Promise<ServedLaunch> {
  // Anything read before this test is another test's answer.
  clearSiteCache();
  await serveRunData({ audiences: [...(behaviour.audiences ?? [THE_AUDIENCE()])] });
  const runData = globalThis.fetch;

  const quoted: Quoted[] = [];
  const started: Record<string, unknown>[] = [];
  const posted: string[] = [];

  let release = (): void => {};
  const held =
    behaviour.holdEstimate === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';

    if (method === 'GET' && pathname === SITES_PATH) {
      if (behaviour.sitesAnswer !== undefined) {
        return json({ error: 'There are no sites here.' }, behaviour.sitesAnswer);
      }
      return json({ sites: (behaviour.sites ?? [THE_SITE]).map(servedSite) });
    }
    if (method === 'GET') return runData(input as RequestInfo, init);

    posted.push(pathname);

    if (pathname === '/runs/estimate') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Quoted;
      quoted.push(body);
      if (held !== null) await held;
      return behaviour.estimate === undefined
        ? json(knownEstimate(body))
        : behaviour.estimate(body);
    }

    if (pathname === '/runs') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      started.push(body);
      return behaviour.run === undefined
        ? json({ runId: STARTED_RUN_ID }, 201)
        : behaviour.run(body);
    }

    return json({ error: 'That is not something to post.' }, 404);
  });

  return {
    quoted: () => quoted,
    started: () => started,
    posted: () => posted,
    release: () => {
      release();
    },
  };
}
