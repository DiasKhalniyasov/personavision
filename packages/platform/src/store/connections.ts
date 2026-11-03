/**
 * The connected repository, as the workspace remembers it.
 *
 * `docs/FLOW.md` section 15's first point is a **GitHub App installed on one repository**,
 * and section 13 counts that installation as ownership verification for the site the
 * repository deploys. This file is the record behind both: which repository, which site of
 * this workspace it deploys, which installation it is, and when it was connected.
 *
 * **One connected repository per workspace to begin with**, and that is structural rather
 * than a rule a caller has to remember: the record is filed under the workspace's own id, so
 * a second connection replaces the first and two cannot accumulate. Nothing here says
 * anything about more than one — when the product grows to several, the record gains its own
 * id and this interface gains a list, which is a change to these two declarations and to the
 * one implementation of them.
 *
 * **No credential is in it.** Not the App's private key, not an installation token, not a
 * webhook secret. The record **names** an installation; the token is minted at call time
 * from the App's credentials, by the one module that reads them (#319), and is never written
 * to a file, a run artifact, a log line or an error (`CONTEXT.md`'s credential rule, and
 * #227's own). An installation id is a public identifier, like a repository name: it is
 * printed back to the workspace that connected it and proves nothing on its own.
 */

/**
 * What a caller hands the store to connect a repository.
 *
 * The workspace is the method's first argument rather than a field here, as every other store
 * takes it, and `connectedAt` is the store's clock — so neither can be stated by whatever
 * submitted the connection.
 */
export interface NewGithubInstallation {
  /**
   * The installation, by the id GitHub gives it. A name for a thing on GitHub's side, and
   * not a credential: a token for it is minted per call and stored nowhere (#319).
   */
  readonly installationId: string;
  /**
   * The repository by name, as GitHub writes it and as `#screen-sites` prints it beside the
   * verification method: `clipforge/web`.
   */
  readonly repository: string;
  /**
   * The site this repository deploys — the id of a site of the same workspace, which is what
   * makes the connection verify that site and no other (`docs/FLOW.md` section 13).
   */
  readonly siteId: string;
}

/** A workspace's connected repository, stored. */
export interface GithubInstallationRecord {
  /**
   * **The workspace's own id.** One connected repository per workspace, so the workspace is
   * the key: a second connection overwrites this record rather than sitting beside it, and a
   * record of another workspace cannot be reached from this one.
   */
  readonly id: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly repository: string;
  readonly siteId: string;
  /** When it was connected, ISO-8601, by the store's clock. */
  readonly connectedAt: string;
}

/**
 * The workspace's connected repository: write one, read it back, or read that there is none.
 *
 * There is no method that takes a verification state, a method or a timestamp — a connection
 * verifies a site by being **asked for** through the `connected-repository` check, which
 * calls `SiteStore.verify`, the one writer of that block (`site/verify.ts`). Connecting a
 * repository writes this record and nothing on a site.
 */
export interface GithubInstallationStore {
  /**
   * Records the connection for this workspace, **replacing** whatever it had connected
   * before. Connecting twice leaves one record, with the later `connectedAt`.
   */
  connect(
    workspaceId: string,
    installation: NewGithubInstallation,
  ): Promise<GithubInstallationRecord>;
  /**
   * This workspace's connection, or `null` for a workspace that has none — which is the
   * normal state and not an error, and is what the locked path-2 card and
   * `/settings/github` read (#271).
   */
  forWorkspace(workspaceId: string): Promise<GithubInstallationRecord | null>;
}
