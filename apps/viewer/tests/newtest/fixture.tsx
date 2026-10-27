import { vi } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run, RunRequest, SessionProgress } from '@personavision/contract';
import { demoAudienceRecord, readRunFile, serveRunData } from '../app';
import type { AudienceRecord } from '../../src/screens/audience/store';

/**
 * The platform the New test screen talks to: the audience store it reads, and the one
 * request it makes.
 *
 * `serveRunData` answers every read; what is added here is `POST /runs`, so a test can
 * press Start and assert both what was submitted and where the reader lands. The run the
 * platform opens is **the repository's own example run** taken back to the moment it
 * started and parsed through `packages/contract`, so the screen the reader arrives at is
 * driven by an artifact the schema accepts rather than a fixture a test invented.
 */

/** The run directory the committed example run lives in. */
const SEED = '2026-10-24-1402-northwind-demo';

/** The id the platform answers with by default: a test that has only just been started. */
export const STARTED_RUN_ID = '2026-10-27-1100-northwind-demo';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A refusal shaped the way `packages/platform` shapes one. */
export const refusal = (error: string, status = 400): Response => json({ error }, status);

/** One finished session, in the shape a run's progress block records it. */
const finished = (index: number, variant: string): SessionProgress => ({
  sessionId: `S-${String(index).padStart(2, '0')}`,
  personaName: 'Rushed buyer',
  variant,
  seed: (index % 3) + 1,
  finishedAt: new Date(Date.now() - 30_000).toISOString(),
  durationMs: 31_000,
  status: 'success',
  step: 'confirm',
  reason: '',
  attribution: 'product',
});

/**
 * The example run as it was two sessions in: what `/runs/:runId` is handed when a test has
 * just been started, and so the artifact #18's Running state is driven by.
 */
export const runningRun = (runId: string = STARTED_RUN_ID): Run =>
  runSchema.parse({
    ...readRunFile(SEED),
    runId,
    status: 'open',
    startedAt: new Date(Date.now() - 62_000).toISOString(),
    progress: {
      totalSessions: 24,
      finishedSessions: 2,
      perVariant: [
        { variant: 'A', totalSessions: 12, finishedSessions: 2 },
        { variant: 'B', totalSessions: 12, finishedSessions: 0 },
      ],
      sessions: [finished(1, 'A'), finished(2, 'A')],
    },
  });

export interface PlatformBehaviour {
  /** The workspace's audiences. The default is the one the demo workspace is seeded with. */
  records?: AudienceRecord[];
  /** The run directories the listing holds, newest first. */
  runIds?: string[];
  /** What `POST /runs` answers with, in place of opening a run. */
  answer?: (request: RunRequest) => Response;
}

export interface ServedPlatform {
  /** Every test the screen asked the platform to start, in order. */
  started: RunRequest[];
}

/**
 * A second audience, derived from the demo workspace's own so that every field is one the
 * store would really answer with. It is a different audience, with different people.
 */
export const otherAudienceRecord = (): AudienceRecord => {
  const demo = demoAudienceRecord();
  return {
    ...demo,
    id: 'aud-trade-buyers',
    audience: {
      ...demo.audience,
      id: 'trade-buyers',
      name: 'Trade & wholesale buyers',
      ageRange: { min: 30, max: 60 },
      priceSensitivity: 0.2,
    },
    people: demo.people.slice(0, 2).map((person) => ({
      ...person,
      id: `trade-${person.id}`,
      name: `Trade ${person.name.toLowerCase()}`,
      audienceId: 'trade-buyers',
    })),
  };
};

export async function servePlatform(behaviour: PlatformBehaviour = {}): Promise<ServedPlatform> {
  await serveRunData({
    ...(behaviour.records === undefined ? {} : { audiences: behaviour.records }),
    ...(behaviour.runIds === undefined ? {} : { runIds: behaviour.runIds }),
    files: { [`/runs/${STARTED_RUN_ID}/run.json`]: JSON.stringify(runningRun()) },
  });
  const reads = globalThis.fetch;
  const started: RunRequest[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if ((init?.method ?? 'GET') === 'GET') return reads(input, init);

    const request = JSON.parse(String(init?.body)) as RunRequest;
    started.push(request);
    if (new URL(url).pathname !== '/runs') return refusal('That is not something to post.', 404);
    return behaviour.answer === undefined
      ? json({ runId: STARTED_RUN_ID }, 201)
      : behaviour.answer(request);
  });

  return { started };
}
