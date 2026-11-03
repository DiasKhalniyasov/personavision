import type { GithubInstallationStore } from '../store/connections.js';

/**
 * The connection seam: whether a GitHub repository is connected to a site, and which one.
 *
 * `docs/FLOW.md` section 13's fourth verification method is the one the platform does not go
 * and look for — _"the installation exists and the connection names this site"_ — so that a
 * user who has installed the GitHub App does not prove the same thing twice. This module is
 * the **question**, and nothing here answers it: the GitHub App, its installation and its
 * webhooks belong to the "Improve my site" step (#227, with the owner's own registration on
 * #231), which #221 puts out of scope for the sites step.
 *
 * So the seam is declared here, the default answers **no connection anywhere**, and #227
 * wires its installation lookup in through `PlatformOptions.siteConnections` — the way the
 * pipeline arrives through `PlatformOptions.pipeline`. Nothing else changes when it lands:
 * the check, the route and the store's one writer of the verification block are already
 * whole, and a site becomes verifiable the moment the lookup starts answering.
 *
 * **No network call is made from here and no credential is read.** Whatever reaches GitHub
 * lives behind this interface, in the step that owns the installation.
 */

/**
 * A repository connected to one site of a workspace.
 *
 * One repository to one site: `docs/FLOW.md` section 15 is plain that path 2 connects **one
 * repository** — the one that deploys the site — and the prototype's panel says so in the
 * user's words ("One repository, read and write to pull requests, and it never merges
 * anything").
 */
export interface SiteRepositoryConnection {
  /** The site this connection is for — the id of a site of the same workspace. */
  readonly siteId: string;
  /**
   * The repository by name, as GitHub writes it and as `#screen-sites` prints it beside the
   * method: `clipforge/web`. No installation id, no token and no URL — a name is what a
   * screen says and what a check compares, and the rest belongs to #227.
   */
  readonly repository: string;
  /** When it was connected, ISO-8601. */
  readonly connectedAt: string;
}

/**
 * The lookup the `connected-repository` check asks.
 *
 * It answers **a workspace's connections** rather than one site's, although what the check
 * decides is one site's: the failing case a user can act on is _"that repository is connected
 * to another site of this workspace"_, and a lookup that only ever answers about the site
 * asked for cannot tell that from "nothing is connected at all". Both sentences are in the
 * screen contract, so the seam has to be able to see the sibling. The connection that names a
 * given site is then a filter over this answer rather than a second method on the interface,
 * which is one fewer thing for #227 to implement and keep consistent.
 *
 * It is scoped by workspace and that is the whole of its scoping: a connection of another
 * workspace is not in the answer, so it cannot verify a site here. The check never passes a
 * workspace id of its own choosing — it passes the one on the site it was handed, which the
 * route read from the session.
 */
export interface SiteConnections {
  /**
   * Every repository connection in this workspace, in whatever order the installation holds
   * them. An empty list means none, and is not an error.
   *
   * It may reject — the real one talks to GitHub — and the check turns that into a result
   * that says so, because a check reports rather than throws.
   */
  forWorkspace(workspaceId: string): Promise<readonly SiteRepositoryConnection[]>;
}

/**
 * The default lookup: **no repository is connected**, to any site, in any workspace.
 *
 * It is no longer what `personavision serve` runs — `createPlatform` hands the checks
 * `storedSiteConnections` below, which reads the workspace's own installation record (#299).
 * This stays as the answer where the seam is unwired: a check handed deps with no lookup in
 * them, and a test that wants a site with nothing connected to it. It is a truthful answer
 * rather than a stub, and the sentence the method's panel draws from it is the one every
 * site gets until somebody connects a repository.
 */
export const noSiteConnections: SiteConnections = {
  forWorkspace: async () => [],
};

/**
 * The real lookup: the workspace's connected repository, read from the store (#299).
 *
 * This is what `createPlatform` hands the checks in place of `noSiteConnections`, through the
 * `siteConnections` option #238 defined — so there is still **one** path to a verified site
 * and this file is the only thing that changed when the connection became real.
 *
 * It answers at most one connection, because a workspace has at most one connected
 * repository (`GithubInstallationStore`). The check does not care how many there are: a
 * connection naming this site verifies it, a connection naming another site of the workspace
 * gets its own sentence, and an empty answer is "nothing is connected".
 *
 * **The installation id does not come through.** Nothing downstream of here — the check, the
 * stored `lastCheck`, the site the route answers with — has any use for it, so it stops at
 * the store rather than travelling into a result a screen prints.
 */
export const storedSiteConnections = (
  installations: Pick<GithubInstallationStore, 'forWorkspace'>,
): SiteConnections => ({
  forWorkspace: async (workspaceId) => {
    const connected = await installations.forWorkspace(workspaceId);
    return connected === null
      ? []
      : [
          {
            siteId: connected.siteId,
            repository: connected.repository,
            connectedAt: connected.connectedAt,
          },
        ];
  },
});
