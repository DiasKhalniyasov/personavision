import type { Audience } from '@personavision/contract';

/**
 * The store seam: what the platform keeps, and the four interfaces it keeps it behind.
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
  readonly sessions: SessionStore;
}
