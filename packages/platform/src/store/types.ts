import type { Audience, ModelMode } from '@personavision/contract';

/**
 * The store seam: what the platform keeps, and the five interfaces it keeps it behind.
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
 * How a site was proved to belong to its workspace: the four methods of `docs/FLOW.md`
 * section 13, named here and produced by the checks that later tickets add.
 *
 * The platform runs every one of them itself — a user ticking a box is not verification —
 * so nothing a request submits can name one.
 */
export type SiteVerificationMethod =
  'dns-txt' | 'meta-tag' | 'well-known-file' | 'connected-repository';

/**
 * Whether this site is proved to be its workspace's, by which method, and when.
 *
 * A **passing check is the only writer**, and the first of those checks is a later ticket:
 * a site created today reads `unverified`, `method` of `null` and `verifiedAt` of `null`, and
 * no code path moves it by writing a field (`docs/FLOW.md` section 13).
 */
export interface SiteVerification {
  readonly state: 'unverified' | 'verified';
  readonly method: SiteVerificationMethod | null;
  readonly verifiedAt: string | null;
}

export interface SiteRecord {
  readonly id: string;
  readonly workspaceId: string;
  /**
   * The URL as the user typed it. The platform does not normalise it: credentials in it and
   * a non-default port are stored as given, because the address a user proved they control
   * is the address they wrote down.
   */
  readonly url: string;
  /**
   * This site's verification token — `pv_` and hex, per site, minted by the platform.
   *
   * It is a **public proof of control, not a secret**: it is answered by the API and printed
   * on screen with the exact line to copy, so no hashing, no redaction and no credential
   * handling applies to it. Two workspaces that add the same URL get two tokens, so a token
   * is not reusable across workspaces.
   */
  readonly token: string;
  readonly verification: SiteVerification;
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

/** What a caller hands the store to open a site. The verification block is not among them. */
export interface NewSite {
  /** Absolute `http:` or `https:`, checked before it gets here (`parseSiteUrl`). */
  url: string;
  /** Minted by the platform (`mintSiteToken`), never taken from a request. */
  token: string;
}

/**
 * The workspace's sites.
 *
 * There is **no writer for `verification`** here, and that is the point: the one thing that
 * may move a site to verified is a passing check, which is a later ticket of #221. Until it
 * lands this interface cannot express the verified state at all, so no route, no screen and
 * no submitted body can reach it.
 */
export interface SiteStore {
  /** Unverified, with the token given, in the workspace given. */
  create(workspaceId: string, site: NewSite): Promise<SiteRecord>;
  /** The site, or `null` for an id of another workspace or of no workspace — never a throw. */
  byId(workspaceId: string, siteId: string): Promise<SiteRecord | null>;
  /** The workspace's sites; a soft-deleted one is left out unless asked for. */
  list(workspaceId: string, options?: { includeDeleted?: boolean }): Promise<SiteRecord[]>;
  /** Records the removal and keeps the record. Removing one twice does not move `deletedAt`. */
  softDelete(workspaceId: string, siteId: string): Promise<SiteRecord>;
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
}
