import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addSite,
  defaultSiteCheckDeps,
  SiteCheckNotAvailableError,
  SiteUrlNotAcceptedError,
  verifySite,
} from '../../site/index.js';
import type { SiteCheckDeps, SiteConnections, SiteIssue } from '../../site/index.js';
import type {
  PlatformStore,
  SessionRecord,
  SiteCheckResult,
  SiteRecord,
  SiteVerification,
} from '../../store/types.js';
import { readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * The sites of a workspace: `GET /sites`, `POST /sites`, `GET /sites/:siteId`,
 * `DELETE /sites/:siteId` and `POST /sites/:siteId/verify`.
 *
 * Five routes, all of them the session's own workspace and no other. A site of another
 * workspace answers **404 and not 403** — that another workspace holds this URL is not
 * disclosed, which is the rule `visibleRuns` already follows for runs, and it holds for the
 * verify route as much as for reading one.
 *
 * The two `GET`s are `jsonOnly`, because `/sites` and `/sites/:siteId` are both the app's own
 * screens — `docs/FLOW.md` section 13 lists them as Sites and Add-a-site — and a browser
 * navigating to one wants the screen, exactly as `/audiences` and `/audiences/:audienceId`
 * are. Without it a hard refresh on either screen would answer with the API.
 *
 * **Nothing here writes the verification block.** `POST /sites` reads one field, `url`, and
 * the record is opened by `addSite`, which mints the token itself. The verify route reads one
 * field too — `method` — and hands it to `verifySite`, which runs the check and is the only
 * caller of the store's one writer; what the route decides is **nothing about the outcome**.
 * A check that failed is a **200** with a result that did not pass, because the user asked us
 * to look and we looked (`docs/FLOW.md` section 13).
 */

/** Matched by the router, and read here for the id it captures. */
const SITE_PATH = /^\/sites\/([^/]+)$/;

/** `POST` only: asking us to check a site is not a screen, so nothing navigates here. */
const SITE_VERIFY_PATH = /^\/sites\/([^/]+)\/verify$/;

export interface SiteRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /**
   * What the checks resolve and read the clock with. Absent means the real resolver and the
   * real clock, which is what `personavision serve` runs; a test passes its own, so no suite
   * reaches the network.
   */
  siteChecks?: SiteCheckDeps;
  /**
   * Whether a GitHub repository is connected to a site (#238), which the fourth check asks
   * instead of looking for. Absent means the default lookup: no repository is connected to
   * any site, which is the state every site is in until #227 installs an app.
   */
  siteConnections?: SiteConnections;
}

/**
 * The one sentence a request with no session gets. The guard in front of these routes answers
 * it first for a signed-out request; this is the same answer where the handler is reached
 * directly, so the seam does not depend on something above it having run.
 */
const SIGNED_OUT = 'Sign in to read this.';

/** A site of another workspace is missing, not forbidden: that it exists is not news. */
const NO_SUCH_SITE = 'There is no such site.';

const siteIdOf = (request: IncomingMessage, path: RegExp = SITE_PATH): string => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const captured = path.exec(pathname)?.[1] ?? '';
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
  /**
   * The last check this site was put through, or `null` for one nobody has checked — the
   * empty state `#screen-site` draws, and the _"Last check: …"_ line it prints otherwise.
   */
  readonly lastCheck: SiteCheckResult | null;
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
  // `?? null` for a record written before this field existed: a reader is promised the key,
  // and `JSON.stringify` drops an `undefined` one altogether.
  lastCheck: record.lastCheck ?? null,
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
 * This, `siteIdOf`, `refuse` and `SIGNED_OUT` above are copied from `audiences.ts` rather
 * than shared with it — about forty-five lines of it, not a handful. That is a deliberate
 * cost and not a claim that it is small: extracting them means editing `audiences.ts`, which
 * #235's Touches section promises other workers this branch leaves alone. The two have
 * already begun to diverge (the audience routes carry a rule about editing a soft-deleted
 * record that has no counterpart here), so whoever next has both files in their Touches
 * should lift `inWorkspace` and the id reader beside `routes/types.ts` and delete both copies.
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
  // Built once rather than per request: the real resolver holds one `Resolver` with this
  // check's own timeout, and a test's own deps are passed straight through.
  //
  // `siteConnections` is folded in here rather than being a fifth thing a caller composes:
  // it arrives on its own option because it is the one seam #227 fills, and when it is given
  // it wins over any lookup inside `siteChecks`.
  const siteChecks: SiteCheckDeps = {
    ...(options.siteChecks ?? defaultSiteCheckDeps()),
    ...(options.siteConnections === undefined ? {} : { connections: options.siteConnections }),
  };

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
    {
      method: 'POST',
      path: SITE_VERIFY_PATH,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        // The site first, so that a site of another workspace answers the same 404 as one
        // that was never there — before the body is read and whatever method it names. A
        // 400 about the method would otherwise tell the asker that the site exists.
        const site = await sites.byId(workspaceId, siteIdOf(request, SITE_VERIFY_PATH));
        // A removed site is readable and is not checkable, which is the answer the audiences
        // routes give for editing a removed audience: the user said they were done with this
        // address, and proving control of one they have taken away verifies nothing.
        if (site === null || site.deletedAt !== null) {
          notFound(response);
          return;
        }
        const submitted = await readJsonBody(request);
        if (submitted === null) {
          sendJson(response, 400, { error: 'That check could not be read.' });
          return;
        }
        // One field, `method`. Nothing else in the body is consulted — a submitted
        // `verification`, `passed` or `lastCheck` is not refused, it is simply nothing this
        // route can see, and the result is the check's own.
        const { method } = (submitted.value ?? {}) as { method?: unknown };
        try {
          const { site: checked, check } = await verifySite({
            sites,
            workspaceId,
            site,
            method,
            deps: siteChecks,
          });
          // 200 whether or not it passed, and the whole site beside the result: the screen
          // redraws the method's state from `check` and the card from the site, and a check
          // that found nothing is an answer rather than an error.
          sendJson(response, 200, { ...body(checked), check });
        } catch (error) {
          if (error instanceof SiteCheckNotAvailableError) {
            sendJson(response, 400, { error: error.message, available: error.available });
            return;
          }
          throw error;
        }
      }),
    },
  ];
};
