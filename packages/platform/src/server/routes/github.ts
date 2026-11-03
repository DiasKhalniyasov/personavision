import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlatformStore, SessionRecord } from '../../store/types.js';
import { sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * The GitHub connection: `GET /github/connection` and `POST /github/connect`.
 *
 * What a screen reads here is one question — _where would the pull request go?_
 * (`docs/FLOW.md` section 13) — answered in two parts: the repository this workspace has
 * connected, or its absence, and whether there is a GitHub App to connect to at all. Both are
 * what `/new`'s locked path-2 card and `/settings/github` render from (#271), which read this
 * state and never decide it for themselves.
 *
 * **Nothing a request submits can create a connection**, and that is why there is no route
 * that writes one. A connection counts as ownership verification for the site the repository
 * deploys (section 13), so a body that could file one would be a user ticking a box to verify
 * their own site — the one thing section 13 rules out. The record is written by the
 * installation itself, through `GithubInstallationStore`, when the GitHub App of #227 hands
 * back an installation; `POST /github/connect` is where a user **starts** that, and until the
 * App exists (#231) it is also the route that says so.
 *
 * **No credential is read or answered here.** Whether the App is registered arrives through
 * the `app` seam, which #319 fills from the environment in the one module that reads it; this
 * file reads nothing and holds nothing.
 */

/**
 * Where a user installs the App, or that there is no App to install.
 *
 * One method, and `null` means **not registered** — the state #319 answers from
 * `GITHUB_APP_ID`, through one function, so that no screen and no route decides it for
 * itself. A URL is only ever returned when it leads somewhere: the route answers the
 * not-registered sentence instead of a dead link.
 */
export interface GithubAppRegistration {
  /**
   * The installation URL for this workspace, or `null` while no App is registered. It may
   * name the workspace in its `state`, which is why the workspace is passed.
   */
  installationUrl(options: { workspaceId: string }): Promise<string | null>;
}

/**
 * The default: **no App is registered**, which is true until the owner registers one (#231).
 *
 * A truthful answer rather than a stub, and the same shape `noSiteConnections` has for the
 * other half of this connection: the product says what it cannot do yet instead of offering a
 * control that leads nowhere.
 */
export const unregisteredGithubApp: GithubAppRegistration = {
  installationUrl: async () => null,
};

/** The ticket that registers the App, named in the answer so the reason is findable. */
export const GITHUB_APP_TICKET = 231;

/**
 * The sentence for "there is nothing to connect to yet", in one place because two answers
 * carry it: the connection state a screen renders, and the refusal of starting a connection.
 */
export const GITHUB_APP_NOT_REGISTERED =
  'PersonaVision’s GitHub App is not registered yet, so there is no repository to connect — ' +
  'Test my site needs nothing from GitHub.';

/** No connection, said as a sentence rather than left to a screen to invent for a blank. */
export const NO_CONNECTION = 'No GitHub repository is connected to this workspace.';

/** The one sentence a request with no session gets, as the other route families answer it. */
const SIGNED_OUT = 'Sign in to read this.';

/** The connection a route answers with: what a screen prints, and nothing else. */
export interface GithubConnectionBody {
  /** The repository and the site it deploys, or `null` for a workspace with no connection. */
  readonly connection: {
    readonly repository: string;
    readonly siteId: string;
    readonly connectedAt: string;
  } | null;
  /** The state in words, for either case — the empty one included. */
  readonly sentence: string;
  /** Whether there is an App to connect to, and why not when there is not. */
  readonly application: {
    readonly registered: boolean;
    readonly reason: string | null;
  };
}

export interface GithubRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /**
   * Whether a GitHub App is registered, and where it is installed from. Absent means the
   * default: not registered, which is the state today (#231, and #319 for the read).
   */
  app?: GithubAppRegistration;
}

/** A handler that needs a workspace: the session's, or 401. */
const inWorkspace =
  (
    { readSession }: GithubRouteOptions,
    handle: (workspaceId: string, response: ServerResponse) => Promise<void>,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      sendJson(response, 401, { error: SIGNED_OUT, signedIn: false });
      return;
    }
    await handle(session.workspaceId, response);
  };

export const githubRoutes = (options: GithubRouteOptions): Route[] => {
  const { githubInstallations } = options.store;
  const app = options.app ?? unregisteredGithubApp;

  return [
    {
      method: 'GET',
      path: /^\/github\/connection$/,
      handle: inWorkspace(options, async (workspaceId, response) => {
        const connected = await githubInstallations.forWorkspace(workspaceId);
        const installationUrl = await app.installationUrl({ workspaceId });
        // The installation id is not in the answer: a screen prints the repository, and the
        // id is of use only to the module that mints a token for it (#319).
        const body: GithubConnectionBody = {
          connection:
            connected === null
              ? null
              : {
                  repository: connected.repository,
                  siteId: connected.siteId,
                  connectedAt: connected.connectedAt,
                },
          sentence:
            connected === null
              ? NO_CONNECTION
              : `${connected.repository} is connected to this workspace.`,
          application:
            installationUrl === null
              ? { registered: false, reason: GITHUB_APP_NOT_REGISTERED }
              : { registered: true, reason: null },
        };
        sendJson(response, 200, body);
      }),
    },
    {
      method: 'POST',
      path: /^\/github\/connect$/,
      handle: inWorkspace(options, async (workspaceId, response) => {
        const installationUrl = await app.installationUrl({ workspaceId });
        if (installationUrl === null) {
          // 501 and the ticket, as `POST /runs` answers for the pipeline it has not been
          // given: the product cannot do this yet, the reason is a sentence, and what is
          // missing is findable. Never a URL that leads nowhere.
          sendJson(response, 501, {
            error: GITHUB_APP_NOT_REGISTERED,
            ticket: GITHUB_APP_TICKET,
            registered: false,
          });
          return;
        }
        // Where the user goes to install it. Nothing is written here: the record is written
        // when the installation comes back, and a request cannot file one (#227).
        sendJson(response, 200, { installationUrl, registered: true });
      }),
    },
  ];
};
