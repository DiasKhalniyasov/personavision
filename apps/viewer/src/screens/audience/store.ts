import { audienceSchema, personaSchema } from '@personavision/contract';
import { z } from 'zod';
import type { Audience } from '@personavision/contract';

/**
 * The audience store, as the screens read and write it: **#102's four routes and nothing
 * else**.
 *
 * - `GET /audiences` — the workspace's audiences, each with the people it generates
 * - `GET /audiences/:id` — one of them
 * - `POST /audiences` — a new one
 * - `PATCH /audiences/:id` — an edit to one that exists
 *
 * Every answer carries the audience **and its people**, because the people are generated
 * rather than stored: the server runs `@personavision/personas` and the browser never
 * does, so "the people this generates" is the generator's own output for this audience and
 * its seed and not a second implementation of it.
 *
 * A refusal is read as carefully as an answer. `400` carries one message per offending
 * path, which the form renders against the field it concerns; anything else is a sentence
 * the screen can print without pretending to know more than it does. Nothing here throws:
 * a failed save must leave the form standing with what was typed still in it.
 *
 * Both `GET`s share their path with one of the app's own screens, so every request here
 * asks for JSON explicitly — the router answers the screen to a request that does not
 * (`packages/platform/src/server/router.ts`).
 */

const AUDIENCES = '/audiences';

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

const audienceUrl = (recordId: string): string => `${AUDIENCES}/${encodeURIComponent(recordId)}`;

/** One thing wrong with an audience, at the path in the audience it is wrong at. */
export interface AudienceIssue {
  /** `devices`, `ageRange.min`, `name` — the offending field, as the server names it. */
  readonly path: string;
  readonly message: string;
}

const issueSchema = z.object({ path: z.string(), message: z.string() });

/**
 * A stored audience as every route answers with it: the record's id, the audience, the
 * people it generates, and why it generates none when it does not.
 *
 * The id is the **record's**, which is what a URL carries and what a test names; the
 * audience's own `id` is the one a run artifact records. They are two ids on purpose.
 */
const recordSchema = z.object({
  id: z.string().min(1),
  audience: audienceSchema,
  people: z.array(personaSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  issues: z.array(issueSchema),
});

export type AudienceRecord = z.infer<typeof recordSchema>;

const listSchema = z.object({ audiences: z.array(recordSchema) });

/** What a call to the store answers with: the record, or why there is none. */
export type StoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  /** The audience was refused, with one message per offending field. */
  | { readonly ok: false; readonly kind: 'refused'; readonly issues: readonly AudienceIssue[] }
  /** There is no such audience in this workspace. */
  | { readonly ok: false; readonly kind: 'not-found'; readonly problem: string }
  /** The store could not be reached, or answered something this build cannot read. */
  | { readonly ok: false; readonly kind: 'unreachable'; readonly problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The first thing wrong with what the server sent, at the place it is wrong. */
const firstViolation = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return 'it is not an audience this build can read';
  const at = issue.path.length === 0 ? 'the answer itself' : issue.path.map(String).join('.');
  return `${at}: ${issue.message}`;
};

const refusalSchema = z.object({
  error: z.string().optional(),
  issues: z.array(issueSchema).optional(),
});

/** The sentence a reader is given when the store itself is the problem. */
const UNREACHABLE = 'The audience store could not be reached.';

interface Attempt {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly body?: unknown;
}

const ask = async <Value>(
  attempt: Attempt,
  schema: z.ZodType<Value>,
): Promise<StoreResult<Value>> => {
  let response: Response;
  try {
    response = await fetch(absolute(attempt.url), {
      method: attempt.method,
      // Both `GET`s share a path with a screen of this app, and the router answers the
      // screen to anything that reads like a navigation. This says what it wants.
      headers:
        attempt.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }),
    });
  } catch (error) {
    return { ok: false, kind: 'unreachable', problem: `${UNREACHABLE} ${reason(error)}` };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: 'unreachable',
      problem: response.ok
        ? `The audience store answered something that is not JSON: ${reason(error)}`
        : `${UNREACHABLE} It answered ${String(response.status)}.`,
    };
  }

  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    const stated = refusal.success ? refusal.data : { error: undefined, issues: undefined };
    if (response.status === 400 && stated.issues !== undefined && stated.issues.length > 0) {
      return { ok: false, kind: 'refused', issues: stated.issues };
    }
    if (response.status === 404) {
      return {
        ok: false,
        kind: 'not-found',
        problem: stated.error ?? 'There is no such audience.',
      };
    }
    return {
      ok: false,
      kind: 'unreachable',
      problem: stated.error ?? `${UNREACHABLE} It answered ${String(response.status)}.`,
    };
  }

  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, kind: 'unreachable', problem: firstViolation(parsed.error) };
};

/** The workspace's audiences, newest answer first as the store lists them. */
export const listAudiences = async (): Promise<StoreResult<readonly AudienceRecord[]>> => {
  const answer = await ask({ method: 'GET', url: AUDIENCES }, listSchema);
  return answer.ok ? { ok: true, value: answer.value.audiences } : answer;
};

export const readAudience = async (recordId: string): Promise<StoreResult<AudienceRecord>> =>
  ask({ method: 'GET', url: audienceUrl(recordId) }, recordSchema);

export const createAudience = async (audience: Audience): Promise<StoreResult<AudienceRecord>> =>
  ask({ method: 'POST', url: AUDIENCES, body: audience }, recordSchema);

export const updateAudience = async (
  recordId: string,
  audience: Audience,
): Promise<StoreResult<AudienceRecord>> =>
  ask({ method: 'PATCH', url: audienceUrl(recordId), body: audience }, recordSchema);
