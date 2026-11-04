import { z } from 'zod';

/**
 * The site store, as the screens read and write it: **#221's site routes and nothing else**.
 *
 * - `GET /sites` — the workspace's sites, each with what binds it
 * - `GET /sites/:siteId` — one of them
 * - `POST /sites` — a new one, by URL
 * - `DELETE /sites/:siteId` — removing one
 *
 * **One module per interface**, which is why all four live here beside the list the Sites
 * screen reads: a site is read and written in one place in this app the way an audience is
 * (`screens/audience/store.ts`).
 *
 * **A site is a URL and nothing more** (`docs/FLOW.md` section 13, and the owner's input of
 * **2026-11-04**). Nothing on a site record says anything about who controls the address —
 * not here and not in the platform — and no route could put it there: what a site has is its
 * id, its URL, the caps every site is bound by, and the last test it ran.
 *
 * **No cap is written here.** Every figure a screen states about a site — the agents a run
 * may drive, the runs an hour, the browsers at a time — is `caps` on the answer, which the
 * platform composes from `packages/platform/src/caps.ts`. A screen that printed a number of
 * its own would be a screen that one day disagrees with the thing that enforces it, so the
 * numbers arrive as data and the schema below is where they enter the app.
 *
 * A refusal is read as carefully as an answer. `400` carries one message per offending path,
 * which the Add-a-site form renders against the field it concerns; anything else is a
 * sentence a screen can print without pretending to know more than it does. Nothing here
 * throws: a failed save must leave the form standing with what was typed still in it.
 *
 * Both `GET`s share their path with one of the app's own screens, so every request here asks
 * for JSON explicitly — the router answers the screen to a request that does not
 * (`packages/platform/src/server/router.ts`).
 */

/** `/sites`: the list, and where a new site is posted. Exported so no test spells it again. */
export const SITES_PATH = '/sites';

/** `/sites/<id>`: one site. */
export const sitePath = (siteId: string): string => `${SITES_PATH}/${encodeURIComponent(siteId)}`;

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/** One thing wrong with a site, at the path in the submission it is wrong at. */
export interface SiteIssue {
  /** `url` — the offending field, as the server names it. */
  readonly path: string;
  readonly message: string;
}

const issueSchema = z.object({ path: z.string(), message: z.string() });

/**
 * What binds this site: the three caps, by the names the platform answers them under.
 *
 * Identical for every site, because the caps protect the site being driven rather than the
 * person who asked — decision 71, settled **2026-11-03** as _no gate on testing_, and there
 * is nothing about a site that could make them larger or smaller.
 */
const capsSchema = z.object({
  agentsPerRun: z.number(),
  concurrentSessionsPerSite: z.number(),
  runsPerSitePerHour: z.number(),
});

export type SiteCaps = z.infer<typeof capsSchema>;

/**
 * The most recent launch against this site that opened a run, or `null` for a site nothing
 * has been tested on.
 *
 * Which run and when — **never what it was called**. The run's own words live in its
 * artifact, which `GET /runs/index.json` lists it by, so a screen that wants the sentence
 * joins `runId` against that listing (`shell/useRun.ts`'s `useRunIndex`) and one that does
 * not has the instant.
 */
const lastTestSchema = z.object({ runId: z.string().min(1), at: z.string() });

export type SiteLastTest = z.infer<typeof lastTestSchema>;

/**
 * A site as every one of these routes answers with it.
 *
 * No `workspaceId`: a request reads its own session's workspace and no other, so the
 * platform does not name back what the reader already is.
 */
const siteSchema = z.object({
  id: z.string().min(1),
  /** The URL as the user typed it. The platform does not normalise it, and neither do we. */
  url: z.string().min(1),
  caps: capsSchema,
  // `.default(null)` rather than required: a platform that predates the field leaves the
  // key out, and a site with nothing to say about its last test is not an unreadable site.
  lastTest: lastTestSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Soft-deleted: still readable, no longer offered for a new test. */
  deletedAt: z.string().nullable(),
});

export type SiteRecord = z.infer<typeof siteSchema>;

const listSchema = z.object({ sites: z.array(siteSchema) });

/** What a call to the store answers with: the site, or why there is none. */
export type StoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  /** The site was refused, with one message per offending field. */
  | { readonly ok: false; readonly kind: 'refused'; readonly issues: readonly SiteIssue[] }
  /** There is no such site in this workspace. */
  | { readonly ok: false; readonly kind: 'not-found'; readonly problem: string }
  /** The store could not be reached, or answered something this build cannot read. */
  | {
      readonly ok: false;
      readonly kind: 'unreachable';
      readonly problem: string;
      /**
       * Whether the platform **answered** — a considered refusal (a `4xx` carrying its own
       * sentence, such as a method it does not run yet) rather than a platform that is away.
       * A screen uses it to decide whether to tell a reader to try again when it is back:
       * a platform that just answered them is not away, and saying so would be the generic
       * wording `docs/FLOW.md` section 13 rules out.
       *
       * **Present only when it is true.** A platform that is away, and a `5xx` from one
       * that is having a problem of its own, leave it off: the reader is asked to try again
       * when it is back, which is the default a screen gets by not reading this at all.
       */
      readonly answered?: true;
    };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The first thing wrong with what the server sent, at the place it is wrong. */
const firstViolation = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return 'it is not a site this build can read';
  const at = issue.path.length === 0 ? 'the answer itself' : issue.path.map(String).join('.');
  return `${at}: ${issue.message}`;
};

const refusalSchema = z.object({
  error: z.string().optional(),
  issues: z.array(issueSchema).optional(),
});

/**
 * The sentence a reader is given when the platform itself is the problem — **one per call**,
 * because a reader who pressed "Remove this site" is not owed a sentence about their sites.
 * It is the whole of what a screen prints above its form, so it names what was asked.
 */
const UNREACHABLE = {
  list: 'Your sites could not be read.',
  site: 'That site could not be read.',
  create: 'That site could not be saved.',
  remove: 'That site could not be removed.',
} as const;

interface Attempt {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly body?: unknown;
  /** What the reader asked for, for the one sentence an unreachable platform gets. */
  readonly subject: string;
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
    return { ok: false, kind: 'unreachable', problem: `${attempt.subject} ${reason(error)}` };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: 'unreachable',
      problem: response.ok
        ? `The platform answered something that is not JSON: ${reason(error)}`
        : `${attempt.subject} It answered ${String(response.status)}.`,
      ...(response.ok || response.status < 500 ? { answered: true as const } : {}),
    };
  }

  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    const stated = refusal.success ? refusal.data : { error: undefined, issues: undefined };
    if (response.status === 400 && stated.issues !== undefined && stated.issues.length > 0) {
      return { ok: false, kind: 'refused', issues: stated.issues };
    }
    if (response.status === 404) {
      return { ok: false, kind: 'not-found', problem: stated.error ?? 'There is no such site.' };
    }
    return {
      ok: false,
      kind: 'unreachable',
      problem: stated.error ?? `${attempt.subject} It answered ${String(response.status)}.`,
      // A `4xx` is the platform's own answer about what was asked; a `5xx` is the platform
      // itself having a problem, which is the one a reader is asked to wait out.
      ...(response.status < 500 ? { answered: true as const } : {}),
    };
  }

  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, kind: 'unreachable', problem: firstViolation(parsed.error), answered: true };
};

/** The workspace's sites, as the platform lists them. A soft-deleted one is not among them. */
export const listSites = async (): Promise<StoreResult<readonly SiteRecord[]>> => {
  const answer = await ask(
    { method: 'GET', url: SITES_PATH, subject: UNREACHABLE.list },
    listSchema,
  );
  return answer.ok ? { ok: true, value: answer.value.sites } : answer;
};

/**
 * One site, by the id its URL carries.
 *
 * Read by the site's own screen, which opens on `/sites/:siteId` and has to show what is
 * stored rather than what was listed before somebody else changed it.
 */
export const readSite = async (siteId: string): Promise<StoreResult<SiteRecord>> =>
  ask({ method: 'GET', url: sitePath(siteId), subject: UNREACHABLE.site }, siteSchema);

/**
 * A new site, by URL.
 *
 * One field is sent, because one field is read: a site record has nothing else on it for a
 * submission to reach (`docs/FLOW.md` section 13). A URL with no scheme, one that is not a
 * URL, and one already in this workspace each come back as a `refused` result carrying the
 * message for the `url` field.
 */
export const createSite = async (url: string): Promise<StoreResult<SiteRecord>> =>
  ask({ method: 'POST', url: SITES_PATH, body: { url }, subject: UNREACHABLE.create }, siteSchema);

/**
 * Remove this site from the workspace.
 *
 * The removal is **soft**, which is why the route answers the record rather than an empty
 * `204`: a finished test ran against this site and the screen reporting that test still has
 * to be able to say which site it was. The site's own screen takes the reader back to the
 * list, so what it does with the answer is drop the remembered list and go.
 */
export const removeSite = async (siteId: string): Promise<StoreResult<SiteRecord>> =>
  ask({ method: 'DELETE', url: sitePath(siteId), subject: UNREACHABLE.remove }, siteSchema);
