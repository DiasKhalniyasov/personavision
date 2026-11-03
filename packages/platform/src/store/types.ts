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

/**
 * One place a check looked, named as a screen names it: `clipforge.example`,
 * `https://beta.clipforge.example/.well-known/…`, `clipforge/web`.
 */
export interface SiteCheckTarget {
  readonly kind: 'domain' | 'url' | 'repository';
  readonly value: string;
}

/**
 * What a check found instead, which is the half of `docs/FLOW.md` section 13's promise that
 * a screen cannot guess: "what it looked for, where, and what it found instead".
 *
 * Four outcomes and no fifth, because **"something went wrong" is not one of them**: a host
 * that does not answer is `no-answer`, which is a finding with its own sentence rather than a
 * failure of ours. Only `found` passes.
 */
export type SiteCheckOutcome =
  /** The line was published where we looked. The one outcome that verifies a site. */
  | 'found'
  /** Something is published there, and none of it is this line. */
  | 'other-values'
  /** The address answered, and publishes nothing of this kind at all. */
  | 'nothing-published'
  /** The address did not answer: no such domain, a timeout, a name server that refused. */
  | 'no-answer';

export interface SiteCheckFinding {
  readonly outcome: SiteCheckOutcome;
  /**
   * The addresses **this outcome** is about — where the line was found, or which addresses
   * published something else, or which did not answer. `SiteCheckResult.lookedIn` is the
   * whole list of places the check visited; this is the subset the sentence names.
   */
  readonly at: readonly string[];
  /** What is published there instead, for `other-values`. Empty for every other outcome. */
  readonly values: readonly string[];
  /** Why the address did not answer, for `no-answer`. `null` for every other outcome. */
  readonly because: string | null;
}

/**
 * One run of one check: what it looked for, where it looked, what it found, whether it
 * passed, and when — stored on the site as `lastCheck` so that the screen can print
 * _"Last check: no TXT record found on clipforge.example at 09:04."_ without composing it.
 *
 * It is **data a screen prints**, not an error a screen interprets. A check that fails
 * returns one of these; it does not throw (`docs/FLOW.md` section 13).
 */
export interface SiteCheckResult {
  readonly method: SiteVerificationMethod;
  /** `true` exactly when `found.outcome` is `found`. The store's `verify` refuses anything else. */
  readonly passed: boolean;
  /**
   * The line the user was told to publish, spelled as they were told to spell it —
   * `personavision-site-verification=pv_7f3c91a2d84e`. The line the screen prints to copy is
   * composed from this field, so the line shown and the line searched for are one string.
   */
  readonly lookedFor: string;
  /**
   * Every address this check was prepared to ask, in the order it would ask them — the whole
   * walk and not the part of it that was reached, since a check that finds the line on the
   * first address stops there.
   *
   * What a sentence names is `found.at`, which is only ever where the outcome actually
   * happened. A screen printing "we looked at …" should print that.
   */
  readonly lookedIn: readonly SiteCheckTarget[];
  readonly found: SiteCheckFinding;
  /**
   * The one sentence the screen prints after "Last check: " and before the time — _"no TXT
   * record found on clipforge.example"_. No full stop and no clock: the screen owns the
   * punctuation and the reader's time zone, and `checkedAt` is the instant.
   */
  readonly sentence: string;
  readonly checkedAt: string;
}

/**
 * One launch against a site: which run it opened, and when the browsers started on it.
 *
 * The ledger this belongs to is what the runs-per-site-per-hour cap is counted off (`caps.ts`),
 * which is why `at` is **when the launch happened** rather than when the row was written: a
 * run that took twenty minutes still used the hour it started in.
 */
export interface SiteLaunch {
  /** The run directory the launch opened. */
  readonly runId: string;
  /** When the launch happened, ISO-8601 — the instant the cap's window is measured from. */
  readonly at: string;
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
  /**
   * The last check this site was put through, or `null` for a site nobody has checked —
   * which is the **empty** state `#screen-site` draws as the method's unchecked state.
   *
   * One per site rather than one per method: a screen drawing a method compares
   * `lastCheck.method` with its own, so "never checked" and "last checked by another
   * method" are told apart without four stored slots.
   */
  readonly lastCheck: SiteCheckResult | null;
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
   * A record written before this field existed reads as an empty ledger, which is the truth
   * a reader needs: nothing is known to have launched against it.
   */
  readonly launches: readonly SiteLaunch[];
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
 * **`verify` is the only writer of `verification`**, and that is structural rather than a
 * convention: no other method on this interface takes a verification state, a method or a
 * timestamp, so a route, a screen or a submitted body has nothing to write it through. The
 * one argument `verify` does take is a check result, and it **refuses one that did not
 * pass** — so the state cannot be reached by inventing a result either (`docs/FLOW.md`
 * section 13).
 *
 * `recordCheck` is the other half of that split: a check that failed is still news the
 * screen needs, so it is stored, and the method that stores it cannot change the state.
 */
export interface SiteStore {
  /** Unverified, never checked, with the token given, in the workspace given. */
  create(workspaceId: string, site: NewSite): Promise<SiteRecord>;
  /** The site, or `null` for an id of another workspace or of no workspace — never a throw. */
  byId(workspaceId: string, siteId: string): Promise<SiteRecord | null>;
  /** The workspace's sites; a soft-deleted one is left out unless asked for. */
  list(workspaceId: string, options?: { includeDeleted?: boolean }): Promise<SiteRecord[]>;
  /** Records the removal and keeps the record. Removing one twice does not move `deletedAt`. */
  softDelete(workspaceId: string, siteId: string): Promise<SiteRecord>;
  /**
   * Moves the site to verified, by the method that proved it and at the moment it was
   * proved, and stores the result as `lastCheck`.
   *
   * **Throws on a result that did not pass**, rather than storing it or quietly declining:
   * a caller handing this a failed check has a bug, and a site must never be verified by
   * one. A failed check belongs in `recordCheck`.
   */
  verify(workspaceId: string, siteId: string, result: SiteCheckResult): Promise<SiteRecord>;
  /**
   * Stores the result as `lastCheck` and **leaves `verification` exactly as it was**, even
   * for a result that passed. The screen's _"Last check: …"_ line is written through here.
   */
  recordCheck(workspaceId: string, siteId: string, result: SiteCheckResult): Promise<SiteRecord>;
  /**
   * Appends a launch to the ledger and drops everything older than 24 hours, so the record
   * stays bounded without anything having to sweep it.
   *
   * It writes **only** the ledger: no implementation of this may touch `verification`, which
   * keeps `verify` the one writer of that block even though a launch reads it. Starting a
   * test is not a way to prove you own a site.
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
   * verifies the site that repository deploys (`docs/FLOW.md` sections 15 and 13, #299).
   * Declared in `connections.ts`, beside the record it keeps.
   */
  readonly githubInstallations: GithubInstallationStore;
}
