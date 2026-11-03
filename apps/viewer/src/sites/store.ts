import { z } from 'zod';

/**
 * The site store, as the screens read and write it: **#221's site routes and nothing else**.
 *
 * - `GET /sites` — the workspace's sites, each with what binds it
 * - `GET /sites/:siteId` — one of them
 * - `POST /sites` — a new one, by URL
 *
 * **One module per interface**, which is why `readSite` and `createSite` live here beside
 * the list the Sites screen reads: the Add-a-site screen (#269) is the caller of both, and
 * it adds the verification call — `POST /sites/:siteId/verify` — to this module rather than
 * opening a second one beside it. A site is read and written in one place in this app the
 * way an audience is (`screens/audience/store.ts`).
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
 * Whether this site is proved to be the workspace's, by which method, and when.
 *
 * `method` and `kind` below are read as plain strings rather than as the platform's closed
 * lists. No screen branches on them — a card prints the method in the reader's words and
 * the platform's own `sentence` for a check — so narrowing them here would buy nothing and
 * would take the whole list down the day the platform learns a fifth way to prove a site.
 */
const verificationSchema = z.object({
  state: z.union([z.literal('unverified'), z.literal('verified')]),
  method: z.string().nullable(),
  verifiedAt: z.string().nullable(),
});

export type SiteVerification = z.infer<typeof verificationSchema>;

/**
 * What binds this site: the three caps, by the names the platform answers them under.
 *
 * Identical for every site, verified or not — the owner settled decision 71 as _no gate on
 * testing_ on **2026-11-03**, because the caps protect the site being driven rather than the
 * person who asked. What verification is worth is **Improve my site**.
 */
const capsSchema = z.object({
  agentsPerRun: z.number(),
  concurrentSessionsPerSite: z.number(),
  runsPerSitePerHour: z.number(),
});

export type SiteCaps = z.infer<typeof capsSchema>;

/**
 * The last check this site was put through: what it looked for, where it looked, what it
 * found, whether it passed, and the one sentence the platform wrote about it.
 *
 * It is **data a screen prints**, not an error a screen interprets: `sentence` is written in
 * `packages/platform` so that the card, the Add-a-site screen and the CLI say the same
 * words, and it carries no full stop and no clock — the screen owns the punctuation and the
 * reader's time zone, and `checkedAt` is the instant.
 */
const checkSchema = z.object({
  method: z.string(),
  passed: z.boolean(),
  lookedFor: z.string(),
  lookedIn: z.array(z.object({ kind: z.string(), value: z.string() })),
  found: z.object({
    outcome: z.string(),
    at: z.array(z.string()),
    values: z.array(z.string()),
    because: z.string().nullable(),
  }),
  sentence: z.string(),
  checkedAt: z.string(),
});

export type SiteCheck = z.infer<typeof checkSchema>;

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
  /** The public proof of control, which the Add-a-site screen prints as the line to copy. */
  token: z.string(),
  verification: verificationSchema,
  caps: capsSchema,
  lastCheck: checkSchema.nullable(),
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
  | { readonly ok: false; readonly kind: 'unreachable'; readonly problem: string };

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

/** The sentence a reader is given when the platform itself is the problem. */
const UNREACHABLE = 'Your sites could not be read.';

interface Attempt {
  readonly method: 'GET' | 'POST';
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
        ? `The platform answered something that is not JSON: ${reason(error)}`
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
      return { ok: false, kind: 'not-found', problem: stated.error ?? 'There is no such site.' };
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

/** The workspace's sites, as the platform lists them. A soft-deleted one is not among them. */
export const listSites = async (): Promise<StoreResult<readonly SiteRecord[]>> => {
  const answer = await ask({ method: 'GET', url: SITES_PATH }, listSchema);
  return answer.ok ? { ok: true, value: answer.value.sites } : answer;
};

/**
 * One site, by the id its URL carries.
 *
 * Read by the Add-a-site screen (#269), which opens on `/sites/:siteId` and has to show
 * what is stored rather than what was listed before somebody else changed it.
 */
export const readSite = async (siteId: string): Promise<StoreResult<SiteRecord>> =>
  ask({ method: 'GET', url: sitePath(siteId) }, siteSchema);

/**
 * A new site, by URL.
 *
 * One field is sent, because one field is read: the platform mints the token and states the
 * unverified block, and nothing a submission says can verify a site (`docs/FLOW.md` section
 * 13). A URL with no scheme, one that is not a URL, and one already in this workspace each
 * come back as a `refused` result carrying the message for the `url` field.
 */
export const createSite = async (url: string): Promise<StoreResult<SiteRecord>> =>
  ask({ method: 'POST', url: SITES_PATH, body: { url } }, siteSchema);

/** `/sites/<id>/verify`: where a check is asked for. `POST` only — nothing navigates here. */
export const siteVerifyPath = (siteId: string): string => `${sitePath(siteId)}/verify`;

/** The site as it now stands, and what the check that was just run found. */
export interface CheckedSite {
  readonly site: SiteRecord;
  readonly check: SiteCheck;
}

// The route answers the whole site with the result beside it, so the screen redraws its
// state from one and the method's own line from the other.
const checkedSiteSchema = siteSchema.extend({ check: checkSchema });

/**
 * Run one of the four checks of `docs/FLOW.md` section 13 against this site.
 *
 * **The platform does the checking.** What is sent is the name of the method and nothing
 * else: a body cannot verify a site, and there is no field here that could — the platform
 * resolves the TXT record, fetches the page, reads the file or asks after the installation,
 * and only a passing check moves the site (`packages/platform/src/site/verify.ts`).
 *
 * A check that **failed is an answer, not an error**: it comes back `ok` with the site
 * unverified and `check` carrying what it looked for, where it looked and what it found
 * instead. The `unreachable` result is for the other thing — a platform that could not be
 * reached, or one that does not run this method yet, which answers its own sentence naming
 * the methods it does run.
 */
export const verifySite = async (
  siteId: string,
  method: string,
): Promise<StoreResult<CheckedSite>> => {
  const answer = await ask(
    { method: 'POST', url: siteVerifyPath(siteId), body: { method } },
    checkedSiteSchema,
  );
  if (!answer.ok) return answer;
  const { check, ...site } = answer.value;
  return { ok: true, value: { site, check } };
};
