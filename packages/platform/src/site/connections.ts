import type { GithubInstallationStore } from '../store/connections.js';

/**
 * The connection seam: whether a GitHub repository is connected to a site, and which one.
 *
 * One question — _which repository deploys this site?_ — asked by the "Improve my site" step
 * (`docs/FLOW.md` section 15): a pull request has to go somewhere, and this is how
 * `@personavision/improve` finds where (#299). Nothing here answers it of itself; the GitHub
 * App, its installation and its webhooks belong to that step (#227, with the owner's own
 * registration on #231), and the record they write is `GithubInstallationStore`.
 *
 * **It decides nothing about a site.** A site is a URL and nothing more, so a connection is
 * the installation's own record of what it deploys rather than a claim about the address:
 * what the App installation buys is path 2, and it is the only proof of control this product
 * asks for.
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
   * The repository by name, as GitHub writes it and as `#screen-sites` prints it:
   * `clipforge/web`. No installation id and no URL — a name is what a screen says and what
   * `@personavision/improve` opens a pull request against, and the rest belongs to #227.
   */
  readonly repository: string;
  /** When it was connected, ISO-8601. */
  readonly connectedAt: string;
}

/**
 * The lookup a reader asks for a site's repository.
 *
 * It answers **a workspace's connections** rather than one site's: the sentence a user can
 * act on is _"that repository is connected to another site of this workspace"_, and a lookup
 * that only ever answers about the site asked for cannot tell that from "nothing is connected
 * at all". Both sentences are in the screen contract, so the seam has to be able to see the
 * sibling. The connection that names a given site is then a filter over this answer rather
 * than a second method on the interface, which is one fewer thing for #227 to implement and
 * keep consistent.
 *
 * It is scoped by workspace and that is the whole of its scoping: a connection of another
 * workspace is not in the answer. A caller never passes a workspace id of its own choosing —
 * it passes the one on the site it was handed, which the route read from the session.
 */
export interface SiteConnections {
  /**
   * Every repository connection in this workspace, in whatever order the installation holds
   * them. An empty list means none, and is not an error.
   *
   * It may reject — the real one talks to GitHub — and a caller that prints a sentence from
   * it says so rather than failing silently.
   */
  forWorkspace(workspaceId: string): Promise<readonly SiteRepositoryConnection[]>;
}

/**
 * The default lookup: **no repository is connected**, to any site, in any workspace.
 *
 * The answer where the seam is unwired — a caller with no lookup in hand, and a test that
 * wants a site with nothing connected to it. It is a truthful answer rather than a stub, and
 * the sentence a panel draws from it is the one every site gets until somebody connects a
 * repository.
 */
export const noSiteConnections: SiteConnections = {
  forWorkspace: async () => [],
};

/**
 * The real lookup: the workspace's connected repository, read from the store (#299).
 *
 * It answers at most one connection, because a workspace has at most one connected
 * repository (`GithubInstallationStore`). A caller does not care how many there are: a
 * connection naming this site is the repository that deploys it, a connection naming another
 * site of the workspace gets its own sentence, and an empty answer is "nothing is connected".
 *
 * **The installation id does not come through.** Nothing downstream of here has any use for
 * it, so it stops at the store rather than travelling into something a screen prints.
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
