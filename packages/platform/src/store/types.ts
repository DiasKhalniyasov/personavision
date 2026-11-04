import type { Audience, ModelMode } from '@personavision/contract';
import type { GithubInstallationStore } from './connections.js';

export type {
  GithubInstallationRecord,
  GithubInstallationStore,
  NewGithubInstallation,
} from './connections.js';

/**
 * The store seam: what the platform keeps, and the six interfaces it keeps it behind.
 *
 * There is one implementation here — file-backed, under a data directory, with no ORM, no
 * migration framework and nothing that reaches the network. A managed database later is a
 * second implementation of these interfaces and nothing else (`docs/FLOW.md` section 1).
 *
 * Nothing in here is ever written into a run artifact: a run directory belongs to a
 * workspace by what `WorkspaceRecord.runIds` says, not by a field inside the artifact.
 */

/** What is stored in place of a password: the output of a slow hash, and its parameters. */
export interface PasswordVerifier {
  algorithm: 'scrypt';
  /** Hexadecimal, per account. */
  salt: string;
  /** Recorded with the record so they can be raised later without invalidating it. */
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  /** Hexadecimal. The password itself is nowhere, in this record or any other. */
  verifier: string;
}

export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: PasswordVerifier;
  readonly createdAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  /** "A member of this workspace" is the only role there is. */
  readonly memberAccountIds: readonly string[];
  /** The run directories this workspace owns, by run id. */
  readonly runIds: readonly string[];
  /**
   * The seeded example run, which `/demo` and the landing page read with no session, or
   * `null` for a workspace that has none. It is the one run readable signed out, and only
   * ever read-only (`docs/FLOW.md` section 3).
   */
  readonly demoRunId: string | null;
  /**
   * The model mode this workspace's tests run in (#144): `contributor` is cheap and Meta
   * may train on the content, `standard` is the published price and is not trained on.
   *
   * It hangs off the workspace and nowhere else, because the choice is about who pays and
   * whose content it is rather than about the test — no screen offers it, and the person
   * starting a test does not pick it. One field, and no plan, tier or entitlement around
   * it: `docs/FLOW.md` section 9 defers anything finer.
   */
  readonly modelMode: ModelMode;
  readonly createdAt: string;
}

export interface AudienceRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** The shape is `@personavision/contract`'s; this package restates no field of it. */
  readonly audience: Audience;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** A soft delete: an audience a finished test used stays readable. */
  readonly deletedAt: string | null;
}

/**
 * One launch against a site: which run it opened, and when the browsers started on it.
 *
 * The ledger this belongs to is what the runs-per-site-per-hour cap is counted off (`caps.ts`),
 * which is why `at` is **when the launch happened** rather than when the row was written: a
 * run that took twenty minutes still used the hour it started in.
 */
export interface SiteLaunch {
  /**
   * This launch, minted where the launch is reserved. It is the ledger's key: one launch is
   * written twice — reserved before anything runs, then annotated with the run it opened —
   * and the second write must replace the first rather than count as a second launch.
   */
  readonly id: string;
  /**
   * The run directory this launch opened, or `null` for a launch whose run was never
   * opened: the entry is written **before** the pipeline is called, so that a run still in
   * flight is already counted against the site, and a launch whose pipeline crashed stays
   * counted rather than freeing a slot for a retry loop.
   */
  readonly runId: string | null;
  /** When the launch happened, ISO-8601 — the instant the cap's window is measured from. */
  readonly at: string;
}

export interface SiteRecord {
  readonly id: string;
  readonly workspaceId: string;
  /**
   * The URL as the user typed it. The platform does not normalise it: credentials in it and
   * a non-default port are stored as given, because the address stored is the address that
   * was written down.
   */
  readonly url: string;
  /**
   * Every launch against this site, oldest first, **trimmed to the last 24 hours on write**
   * (`withLaunchRecorded`).
   *
   * The runs-per-site-per-hour cap reads the trailing hour off this list, so it is a ledger
   * rather than a counter: a count would have to be reset by something, and nothing here
   * runs on a timer. Twenty-four hours is kept rather than one so that a reader — a support
   * question, a screen showing a site's day — can see more than the window the cap uses, and
   * it is bounded so the record cannot grow without end.
   *
   * **Optional, because records already on disk do not carry it.** A site added before this
   * field existed reads as `undefined`, which every reader resolves to an empty ledger —
   * nothing is known to have launched against it. Declaring it required would make those
   * `?? []` guards look like dead code to the next reader, who would then write
   * `site.launches.length` and get `undefined` for every pre-existing site.
   */
  readonly launches?: readonly SiteLaunch[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** A soft delete, as `AudienceRecord`'s is: the site a finished test ran against stays readable. */
  readonly deletedAt: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  /** Absolute, not sliding: a session ends when it ends. */
  readonly expiresAt: string;
}

export interface NewAccount {
  email: string;
  displayName: string;
  password: PasswordVerifier;
}

export interface AccountStore {
  /** The email is normalised: trimmed and lower-cased, so it is stored as it is looked up. */
  create(account: NewAccount): Promise<AccountRecord>;
  byId(accountId: string): Promise<AccountRecord | null>;
  /**
   * The account for an email, normalised the same way, or `null`.
   *
   * One email can carry more than one record: a first start interrupted between creating
   * the demo account and finishing the seed leaves one behind whose password was never
   * printed, and the next start seeds again. **The newest record wins** — every
   * implementation owes that, because it is the one whose password somebody has.
   */
  byEmail(email: string): Promise<AccountRecord | null>;
}

export interface NewWorkspace {
  name: string;
  memberAccountIds: readonly string[];
  runIds?: readonly string[];
  demoRunId?: string | null;
  /**
   * Omitted means `standard`, which is the only safe way round: a workspace whose mode
   * nobody stated is refused a test it cannot pay for rather than quietly answered by the
   * model Meta may train on. The seeded demo workspace states `contributor`.
   */
  modelMode?: ModelMode;
}

export interface WorkspaceStore {
  create(workspace: NewWorkspace): Promise<WorkspaceRecord>;
  byId(workspaceId: string): Promise<WorkspaceRecord | null>;
  forAccount(accountId: string): Promise<WorkspaceRecord[]>;
  /** Registers a run directory as this workspace's. Adding one twice changes nothing. */
  addRun(workspaceId: string, runId: string): Promise<WorkspaceRecord>;
  /** Every workspace holding a run readable with no session — the seeded demo run. */
  publicRunIds(): Promise<string[]>;
}

export interface AudienceStore {
  create(workspaceId: string, audience: Audience): Promise<AudienceRecord>;
  byId(workspaceId: string, audienceId: string): Promise<AudienceRecord | null>;
  /** The workspace's audiences; a soft-deleted one is left out unless asked for. */
  list(workspaceId: string, options?: { includeDeleted?: boolean }): Promise<AudienceRecord[]>;
  update(workspaceId: string, audienceId: string, audience: Audience): Promise<AudienceRecord>;
  softDelete(workspaceId: string, audienceId: string): Promise<AudienceRecord>;
}

/** What a caller hands the store to open a site: a URL, which is all a site is. */
export interface NewSite {
  /** Absolute `http:` or `https:`, checked before it gets here (`parseSiteUrl`). */
  url: string;
}

/**
 * The workspace's sites.
 *
 * A record is its id, its URL, its workspace, its soft delete and its launch ledger
 * (`docs/FLOW.md` section 13) — so the only thing any method here writes after `create` is
 * the ledger, and there is no state on a site for a route, a screen or a submitted body to
 * reach through.
 */
export interface SiteStore {
  /** The URL given, in the workspace given, with nothing launched against it yet. */
  create(workspaceId: string, site: NewSite): Promise<SiteRecord>;
  /** The site, or `null` for an id of another workspace or of no workspace — never a throw. */
  byId(workspaceId: string, siteId: string): Promise<SiteRecord | null>;
  /** The workspace's sites; a soft-deleted one is left out unless asked for. */
  list(workspaceId: string, options?: { includeDeleted?: boolean }): Promise<SiteRecord[]>;
  /** Records the removal and keeps the record. Removing one twice does not move `deletedAt`. */
  softDelete(workspaceId: string, siteId: string): Promise<SiteRecord>;
  /**
   * Records a launch in the ledger and drops everything older than 24 hours, so the record
   * stays bounded without anything having to sweep it.
   *
   * An **upsert on the launch's `id`**: called once to reserve a launch before anything runs
   * and again to note the run it opened, and the second call must replace the first rather
   * than count as a second launch. Implementations must **serialise these writes per site** —
   * two launches read-modify-writing one record would otherwise lose one of them, and a lost
   * entry is a run the cap does not count.
   *
   * It writes **only** the ledger. Nothing else on a site record changes after it is
   * created, so a launch has one field to touch and no other.
   */
  recordLaunch(workspaceId: string, siteId: string, launch: SiteLaunch): Promise<SiteRecord>;
}

export interface NewSession {
  accountId: string;
  workspaceId: string;
  expiresAt: string;
}

export interface SessionStore {
  create(session: NewSession): Promise<SessionRecord>;
  /** `null` for an unknown session and for one that has expired, which are the same thing. */
  byId(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
}

export interface PlatformStore {
  readonly accounts: AccountStore;
  readonly workspaces: WorkspaceStore;
  readonly audiences: AudienceStore;
  readonly sites: SiteStore;
  readonly sessions: SessionStore;
  /**
   * The repository each workspace has connected, which is what unlocks path 2 and what
   * `@personavision/improve` opens a pull request against (`docs/FLOW.md` section 15, #299).
   * Declared in `connections.ts`, beside the record it keeps.
   */
  readonly githubInstallations: GithubInstallationStore;
}
