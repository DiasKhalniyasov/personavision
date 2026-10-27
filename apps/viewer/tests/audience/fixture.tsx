import { vi } from 'vitest';
import { serveRunData } from '../app';
import type { AudienceRecord } from '../../src/screens/audience/store';

/**
 * The audience store, over the stubbed `fetch` the run data already goes through.
 *
 * `serveRunData` answers the two reads; what is added here is the two writes, so a test can
 * press Save and assert what a reader sees next — the record the store answers with, the
 * refusal it answers with instead, and the list on the way back. The people are not
 * generated here either: a write answers with whatever the test says the generator would
 * return for that audience, which is exactly what the browser knows about them.
 */

export interface StoreBehaviour {
  /** What the workspace holds before anything is written. */
  records?: AudienceRecord[];
  /** What a `POST` or `PATCH` answers with, in place of storing the audience. */
  answer?: (
    method: 'POST' | 'PATCH',
    body: AudienceRecord['audience'],
    recordId: string | null,
  ) => Response;
}

export interface ServedStore {
  /** Every write the screen made, in order. */
  writes: { method: string; url: string; body: AudienceRecord['audience'] }[];
  records: AudienceRecord[];
}

const AUDIENCE_PATH = /^\/audiences\/([^/]+)$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A refusal shaped the way `packages/platform`'s audience routes shape theirs. */
export const refusal = (issues: { path: string; message: string }[]): Response =>
  json({ error: 'That audience could not be saved.', issues }, 400);

export async function serveStore(behaviour: StoreBehaviour = {}): Promise<ServedStore> {
  const served = await serveRunData(
    behaviour.records === undefined ? {} : { audiences: behaviour.records },
  );
  const records = served.audiences;
  const writes: ServedStore['writes'] = [];
  const reads = globalThis.fetch;

  const stored = (audience: AudienceRecord['audience'], recordId: string | null): Response => {
    const record: AudienceRecord = {
      id: recordId ?? `aud-${audience.id}`,
      audience,
      // The store generates the people; a test says what the generator returned by naming
      // them, and by default an audience generates the people of the record it replaces.
      people: records.find((candidate) => candidate.id === recordId)?.people ?? [],
      createdAt: '2026-10-27T09:00:00.000Z',
      updatedAt: '2026-10-27T09:00:00.000Z',
      deletedAt: null,
      issues: [],
    };
    const at = records.findIndex((candidate) => candidate.id === record.id);
    if (at === -1) records.push(record);
    else records[at] = record;
    return json(record, recordId === null ? 201 : 200);
  };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET') return reads(input, init);

    const body = JSON.parse(String(init?.body)) as AudienceRecord['audience'];
    writes.push({ method, url: pathname, body });
    const recordId = AUDIENCE_PATH.exec(pathname)?.[1] ?? null;
    if (behaviour.answer === undefined) return stored(body, recordId);

    const answered = behaviour.answer(method as 'POST' | 'PATCH', body, recordId);
    // A write the store accepted is what the next read sees, whoever wrote the answer:
    // the screen goes back to the list, and the list must not be the old one.
    if (answered.ok) {
      const record = (await answered.clone().json()) as AudienceRecord;
      const at = records.findIndex((candidate) => candidate.id === record.id);
      if (at === -1) records.push(record);
      else records[at] = record;
    }
    return answered;
  });

  return { writes, records };
}
