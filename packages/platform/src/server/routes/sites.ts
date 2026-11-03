import type { IncomingMessage, ServerResponse } from 'node:http';
import { addSite, SiteUrlNotAcceptedError } from '../../site/index.js';
import type { SiteIssue } from '../../site/index.js';
import type {
  PlatformStore,
  SessionRecord,
  SiteRecord,
  SiteVerification,
} from '../../store/types.js';
import { readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * The sites of a workspace: `GET /sites`, `POST /sites`, `GET /sites/:siteId` and
 * `DELETE /sites/:siteId`.
 *
 * Four routes, all of them the session's own workspace and no other. A site of another
 * workspace answers **404 and not 403** — that another workspace holds this URL is not
 * disclosed, which is the rule `visibleRuns` already follows for runs.
 *
 * The two `GET`s are `jsonOnly`, because `/sites` and `/sites/:siteId` are both the app's own
 * screens — `docs/FLOW.md` section 13 lists them as Sites and Add-a-site — and a browser
 * navigating to one wants the screen, exactly as `/audiences` and `/audiences/:audienceId`
 * are. Without it a hard refresh on either screen would answer with the API.
 *
 * **Nothing here can verify anything.** `POST /sites` reads one field, `url`, and the record
 * is opened by `addSite`, which mints the token itself; `SiteStore` publishes no writer for
 * the verification block at all. The one thing that may move a site to verified is a passing
 * check, which is a later ticket of #221 (`docs/FLOW.md` section 13).
 */

/** Matched by the router, and read here for the id it captures. */
const SITE_PATH = /^\/sites\/([^/]+)$/;

export interface SiteRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
}

/**
 * The one sentence a request with no session gets. The guard in front of these routes answers
 * it first for a signed-out request; this is the same answer where the handler is reached
 * directly, so the seam does not depend on something above it having run.
 */
const SIGNED_OUT = 'Sign in to read this.';

/** A site of another workspace is missing, not forbidden: that it exists is not news. */
const NO_SUCH_SITE = 'There is no such site.';

const siteIdOf = (request: IncomingMessage): string => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const captured = SITE_PATH.exec(pathname)?.[1] ?? '';
  try {
    return decodeURIComponent(captured);
  } catch {
    // A half-escaped path names no site, and it is not worth a 500 to say so.
    return captured;
  }
};

/** A site as every one of these routes answers with it. */
export interface SiteBody {
  readonly id: string;
  /** The URL as the user typed it. */
  readonly url: string;
  /** The public proof of control, so the Add-a-site screen can print the line to copy. */
  readonly token: string;
  readonly verification: SiteVerification;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Soft-deleted: still readable, no longer offered for a new test. */
  readonly deletedAt: string | null;
}

/**
 * `workspaceId` is not in the answer: a request reads its own session's workspace and no
 * other, so naming it back would state what the reader already is — the reason `withPeople`
 * leaves it out of an audience.
 */
const body = (record: SiteRecord): SiteBody => ({
  id: record.id,
  url: record.url,
  token: record.token,
  verification: record.verification,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
});

const answer = (response: ServerResponse, status: number, record: SiteRecord): void =>
  sendJson(response, status, body(record));

const notFound = (response: ServerResponse): void =>
  sendJson(response, 404, { error: NO_SUCH_SITE });

/**
 * A site that cannot be saved, with every reason at the path it is wrong at, so the
 * Add-a-site form renders each sentence against its own field rather than as a banner.
 */
const refuse = (response: ServerResponse, issues: readonly SiteIssue[]): void =>
  sendJson(response, 400, { error: 'That site could not be saved.', issues });

/**
 * A handler that needs a workspace: the session's, or 401.
 *
 * Declared here rather than shared with the audience routes: the two are four lines each and
 * the shared one would be a module neither ticket owns.
 */
const inWorkspace =
  (
    { readSession }: SiteRouteOptions,
    handle: (
      workspaceId: string,
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      sendJson(response, 401, { error: SIGNED_OUT, signedIn: false });
      return;
    }
    await handle(session.workspaceId, request, response);
  };

export const siteRoutes = (options: SiteRouteOptions): Route[] => {
  const { sites } = options.store;

  return [
    {
      method: 'GET',
      path: /^\/sites$/,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, _request, response) => {
        // Soft-deleted sites are left out, and a workspace with none answers an empty list
        // rather than 404: `#screen-sites` draws its "+ Add a site" card alone on that.
        const records = await sites.list(workspaceId);
        sendJson(response, 200, { sites: records.map(body) });
      }),
    },
    {
      method: 'POST',
      path: /^\/sites$/,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const submitted = await readJsonBody(request);
        if (submitted === null) {
          sendJson(response, 400, { error: 'That site could not be read.' });
          return;
        }
        // One field is read, and the rest of the body is not consulted: a submitted
        // `verification`, `token` or `id` is not refused, it is simply nothing this route
        // can see. `addSite` mints the token and the store states the unverified block.
        const { url } = (submitted.value ?? {}) as { url?: unknown };
        try {
          answer(response, 201, await addSite({ sites, workspaceId, url }));
        } catch (error) {
          if (error instanceof SiteUrlNotAcceptedError) {
            refuse(response, error.issues);
            return;
          }
          throw error;
        }
      }),
    },
    {
      method: 'GET',
      path: SITE_PATH,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        // A soft-deleted site is readable here: a finished test ran against it, and the
        // screen reporting that test has to be able to say which site it was.
        const record = await sites.byId(workspaceId, siteIdOf(request));
        if (record === null) {
          notFound(response);
          return;
        }
        answer(response, 200, record);
      }),
    },
    {
      method: 'DELETE',
      path: SITE_PATH,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const siteId = siteIdOf(request);
        // Checked before the write rather than catching the store's throw, so that a site of
        // another workspace answers the same 404 as one that was never there.
        if ((await sites.byId(workspaceId, siteId)) === null) {
          notFound(response);
          return;
        }
        // The record, not an empty 204: the removal is soft, so there is something to answer
        // with, and the screen that asked gets back the card it should now draw as removed.
        answer(response, 200, await sites.softDelete(workspaceId, siteId));
      }),
    },
  ];
};
