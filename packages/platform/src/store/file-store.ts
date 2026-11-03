import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Audience } from '@personavision/contract';
import { withLaunchRecorded } from '../caps.js';
import type {
  AccountRecord,
  AccountStore,
  AudienceRecord,
  AudienceStore,
  GithubInstallationRecord,
  GithubInstallationStore,
  NewAccount,
  NewGithubInstallation,
  NewSession,
  NewSite,
  NewWorkspace,
  PlatformStore,
  SessionRecord,
  SessionStore,
  SiteRecord,
  SiteStore,
  WorkspaceRecord,
  WorkspaceStore,
} from './types.js';

/**
 * The one implementation of the store seam: JSON files under a data directory.
 *
 * One file per collection, rewritten whole, held in memory after the first read — a
 * single server process owns its data directory, and a shop's workspace holds tens of
 * records, not millions. No ORM, no migration framework, nothing that reaches the network.
 *
 * ponytail: rewrites a whole collection per write and serialises nothing across processes.
 * A managed database is the second implementation of these interfaces, not a change here.
 */

const FILE_MODE = 0o600;

/** A collection of records on disk, addressed by id. */
class JsonCollection<T extends { readonly id: string }> {
  readonly #file: string;
  /**
   * The read, not the result: two callers arriving while the first read is still in
   * flight would otherwise each build a map of their own, and whichever wrote last would
   * drop the other's record. They share this promise and so share one map.
   */
  #records: Promise<Map<string, T>> | null = null;
  /** Writes run one after another, so the file ends as the last writer left the map. */
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string, name: string) {
    this.#file = join(dataDir, `${name}.json`);
  }

  async #read(): Promise<Map<string, T>> {
    let body: string;
    try {
      body = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new Map();
    }
    // A corrupt file throws rather than being read as "no records": losing a workspace
    // silently is worse than failing to start.
    const parsed = JSON.parse(body) as T[];
    return new Map(parsed.map((record) => [record.id, record]));
  }

  #load(): Promise<Map<string, T>> {
    this.#records ??= this.#read();
    return this.#records;
  }

  #write(records: Map<string, T>): Promise<void> {
    const body = `${JSON.stringify([...records.values()], null, 2)}\n`;
    // Written beside the file and renamed over it, so a crash mid-write leaves the
    // previous collection intact rather than half of the new one.
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    return writeFile(temporary, body, { encoding: 'utf8', mode: FILE_MODE }).then(() =>
      rename(temporary, this.#file),
    );
  }

  #flush(records: Map<string, T>): Promise<void> {
    // Queued rather than started: two renames racing could leave the earlier state on
    // disk while the map in memory holds both records.
    this.#writes = this.#writes.then(() => this.#write(records));
    return this.#writes;
  }

  async all(): Promise<T[]> {
    return [...(await this.#load()).values()];
  }

  async get(id: string): Promise<T | null> {
    return (await this.#load()).get(id) ?? null;
  }

  async put(record: T): Promise<T> {
    const records = await this.#load();
    records.set(record.id, record);
    await this.#flush(records);
    return record;
  }

  async remove(id: string): Promise<void> {
    const records = await this.#load();
    if (!records.delete(id)) return;
    await this.#flush(records);
  }
}

const now = (): string => new Date().toISOString();

/** An email address is one address whatever its capitals or the spaces around it. */
const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const missing = (what: string, id: string): Error => new Error(`There is no ${what} "${id}".`);

const fileAccountStore = (collection: JsonCollection<AccountRecord>): AccountStore => ({
  create: async (account: NewAccount) =>
    collection.put({
      id: randomUUID(),
      email: normaliseEmail(account.email),
      displayName: account.displayName,
      password: account.password,
      createdAt: now(),
    }),
  byId: (accountId) => collection.get(accountId),
  byEmail: async (email) => {
    const wanted = normaliseEmail(email);
    const matches = (await collection.all()).filter((account) => account.email === wanted);
    // The newest wins, as `AccountStore` states: a first start interrupted between
    // creating the account and writing the settings file seeds again, and the account
    // that works is the one the seed that finished wrote. The sort is stable, so two
    // records created in the same millisecond fall back to the order they were written.
    return (
      [...matches].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1) ??
      null
    );
  },
});

/**
 * A stored workspace as this build declares it.
 *
 * A record written before the model mode existed carries none, and `NewWorkspace.modelMode`
 * promises that an unstated mode is `standard`. That is a promise about the record and not
 * only about the moment it was created, so it is kept here, where every reader goes
 * through: a workspace nobody stated a mode for is refused a test it has no key for rather
 * than quietly answered by the model Meta may train on (#144).
 */
const stored = (workspace: WorkspaceRecord): WorkspaceRecord =>
  // The cast is the point: the declared type says the mode is there, and a record written
  // before the field existed does not carry it.
  (workspace as { modelMode?: unknown }).modelMode === undefined
    ? { ...workspace, modelMode: 'standard' }
    : workspace;

const fileWorkspaceStore = (collection: JsonCollection<WorkspaceRecord>): WorkspaceStore => ({
  create: async (workspace: NewWorkspace) =>
    collection.put({
      id: randomUUID(),
      name: workspace.name,
      memberAccountIds: [...workspace.memberAccountIds],
      runIds: [...(workspace.runIds ?? [])],
      demoRunId: workspace.demoRunId ?? null,
      // Standard unless this workspace says contributor: see `NewWorkspace.modelMode`.
      modelMode: workspace.modelMode ?? 'standard',
      createdAt: now(),
    }),
  byId: async (workspaceId) => {
    const workspace = await collection.get(workspaceId);
    return workspace === null ? null : stored(workspace);
  },
  forAccount: async (accountId) =>
    (await collection.all())
      .filter((workspace) => workspace.memberAccountIds.includes(accountId))
      .map(stored),
  addRun: async (workspaceId, runId) => {
    const workspace = await collection.get(workspaceId);
    if (workspace === null) throw missing('workspace', workspaceId);
    // Normalised before it is written back, so a record that predates the field gains it
    // the first time anything touches it rather than being rewritten without it.
    if (workspace.runIds.includes(runId)) return stored(workspace);
    return collection.put({ ...stored(workspace), runIds: [...workspace.runIds, runId] });
  },
  publicRunIds: async () => [
    // A set, so that two workspaces naming the same demo run do not list it twice.
    ...new Set(
      (await collection.all())
        .map((workspace) => workspace.demoRunId)
        .filter((runId): runId is string => runId !== null),
    ),
  ],
});

const fileAudienceStore = (collection: JsonCollection<AudienceRecord>): AudienceStore => {
  const owned = async (workspaceId: string, audienceId: string): Promise<AudienceRecord> => {
    const record = await collection.get(audienceId);
    // A record of another workspace is not this workspace's to see, so it is missing
    // rather than forbidden — the same answer the run mount gives.
    if (record === null || record.workspaceId !== workspaceId)
      throw missing('audience', audienceId);
    return record;
  };
  return {
    create: async (workspaceId, audience: Audience) =>
      collection.put({
        id: randomUUID(),
        workspaceId,
        audience,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      }),
    byId: async (workspaceId, audienceId) => {
      const record = await collection.get(audienceId);
      return record !== null && record.workspaceId === workspaceId ? record : null;
    },
    list: async (workspaceId, options) =>
      (await collection.all()).filter(
        (record) =>
          record.workspaceId === workspaceId &&
          (options?.includeDeleted === true || record.deletedAt === null),
      ),
    update: async (workspaceId, audienceId, audience) =>
      collection.put({ ...(await owned(workspaceId, audienceId)), audience, updatedAt: now() }),
    softDelete: async (workspaceId, audienceId) =>
      collection.put({ ...(await owned(workspaceId, audienceId)), deletedAt: now() }),
  };
};

const fileSiteStore = (collection: JsonCollection<SiteRecord>): SiteStore => {
  /**
   * One ledger write at a time, so a read-modify-write of `launches` cannot interleave with
   * another. A rejection does not break the chain: the next writer runs either way, and the
   * caller still sees its own failure.
   */
  let ledgerWrites: Promise<unknown> = Promise.resolve();
  const queued = <T>(write: () => Promise<T>): Promise<T> => {
    const next = ledgerWrites.then(write, write);
    ledgerWrites = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const owned = async (workspaceId: string, siteId: string): Promise<SiteRecord> => {
    const record = await collection.get(siteId);
    // A site of another workspace is not this workspace's to see, so it is missing rather
    // than forbidden — that another workspace holds this URL is not disclosed, which is the
    // rule `visibleRuns` already follows for runs.
    if (record === null || record.workspaceId !== workspaceId) throw missing('site', siteId);
    return record;
  };
  return {
    create: async (workspaceId, site: NewSite) =>
      collection.put({
        id: randomUUID(),
        workspaceId,
        url: site.url,
        token: site.token,
        // Unverified, stated here rather than taken from an argument: a created site has
        // passed no check, and the only writer of this block refuses a check that did not pass.
        verification: { state: 'unverified', method: null, verifiedAt: null },
        // Never checked, which is the empty state `#screen-site` draws per method.
        lastCheck: null,
        // Nothing has launched against it yet, which is what the caps read.
        launches: [],
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      }),
    byId: async (workspaceId, siteId) => {
      const record = await collection.get(siteId);
      return record !== null && record.workspaceId === workspaceId ? record : null;
    },
    list: async (workspaceId, options) =>
      (await collection.all()).filter(
        (record) =>
          record.workspaceId === workspaceId &&
          (options?.includeDeleted === true || record.deletedAt === null),
      ),
    softDelete: async (workspaceId, siteId) => {
      const record = await owned(workspaceId, siteId);
      // Removing a site twice is the same removal: the second one answers the record as it
      // stands rather than moving `deletedAt` off the moment the site was actually removed.
      if (record.deletedAt !== null) return record;
      return collection.put({ ...record, deletedAt: now(), updatedAt: now() });
    },
    verify: async (workspaceId, siteId, result) => {
      // The invariant, enforced before the record is even read: a site is verified by a
      // check that passed and by nothing else. A caller handing this a failed result has a
      // bug — storing it as a verification would make the state a matter of who called what.
      if (!result.passed) {
        throw new Error(
          `A site is verified only by a check that passed, and this ${result.method} check did not: ${result.sentence}.`,
        );
      }
      const record = await owned(workspaceId, siteId);
      return collection.put({
        ...record,
        verification: {
          state: 'verified',
          method: result.method,
          // The check's own clock, so the moment stored is the moment it was proved.
          verifiedAt: result.checkedAt,
        },
        lastCheck: result,
        updatedAt: now(),
      });
    },
    recordCheck: async (workspaceId, siteId, result) =>
      // `verification` is not in the spread's overrides and cannot be: this writes what the
      // last check found and leaves the state where it was, for a passing result as much as
      // for a failed one.
      collection.put({
        ...(await owned(workspaceId, siteId)),
        lastCheck: result,
        updatedAt: now(),
      }),
    // Queued, not merely awaited. Every other writer here reads a record and writes it back,
    // and two of those racing lose one of the two changes — which for most of them means a
    // field written twice with the same value. For the ledger it means a **lost launch**,
    // and a lost launch is a run the cap does not count: two requests arriving together
    // would both read a ledger of three and both write a ledger of four, leaving the site
    // one run short of its limit after five. So these writes run one after another, and the
    // read that each is built from happens inside its own turn.
    recordLaunch: (workspaceId, siteId, launch) =>
      queued(async () => {
        const record = await owned(workspaceId, siteId);
        return collection.put({
          ...record,
          // Written by the same function the cap reads with, so the ledger the cap counts
          // and the ledger the store keeps can never be two different rules. Like
          // `recordCheck`, `verification` is not among the overrides: a launch reads that
          // block and never writes it.
          launches: withLaunchRecorded(record.launches ?? [], launch, new Date(now())),
          updatedAt: now(),
        });
      }),
  };
};

/**
 * The workspace's connected repository, filed under the workspace's own id.
 *
 * That key is the "one repository per workspace" rule rather than a check on top of it: a
 * second connection writes the same record, so there is never a second to read, and nothing
 * under another workspace's key is reachable from here (#299).
 */
const fileGithubInstallationStore = (
  collection: JsonCollection<GithubInstallationRecord>,
  sites: Pick<SiteStore, 'byId'>,
): GithubInstallationStore => ({
  connect: async (workspaceId, installation: NewGithubInstallation) => {
    // The site has to be **this workspace's**, checked at the one writer rather than trusted
    // of every caller: the record is ownership proof for the site it names, so a connection
    // naming a site of another workspace would put a foreign site id into this workspace's
    // check result — and name it back to them in a sentence.
    if ((await sites.byId(workspaceId, installation.siteId)) === null) {
      throw missing('site', installation.siteId);
    }
    return collection.put({
      id: workspaceId,
      workspaceId,
      installationId: installation.installationId,
      repository: installation.repository,
      siteId: installation.siteId,
      // The store's clock, so the moment stored is the moment it was connected rather than
      // whatever reached the store in a body.
      connectedAt: now(),
    });
  },
  forWorkspace: async (workspaceId) => {
    const record = await collection.get(workspaceId);
    // The id is the workspace, so this comparison can only fail on a record written by hand
    // into the file — and then it fails closed: another workspace's connection verifies
    // nothing here.
    return record !== null && record.workspaceId === workspaceId ? record : null;
  },
});

const fileSessionStore = (collection: JsonCollection<SessionRecord>): SessionStore => ({
  create: async (session: NewSession) =>
    collection.put({
      id: randomUUID(),
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      createdAt: now(),
      expiresAt: session.expiresAt,
    }),
  byId: async (sessionId) => {
    const session = await collection.get(sessionId);
    if (session === null) return null;
    if (Date.parse(session.expiresAt) > Date.now()) return session;
    // An expired session is signed out, and its record is of no further use.
    await collection.remove(sessionId);
    return null;
  },
  delete: (sessionId) => collection.remove(sessionId),
});

/** The file-backed store under `dataDir`, creating the directory if it is not there. */
export const openFileStore = async (dataDir: string): Promise<PlatformStore> => {
  await mkdir(dataDir, { recursive: true });
  const sites = fileSiteStore(new JsonCollection<SiteRecord>(dataDir, 'sites'));
  return {
    accounts: fileAccountStore(new JsonCollection<AccountRecord>(dataDir, 'accounts')),
    workspaces: fileWorkspaceStore(new JsonCollection<WorkspaceRecord>(dataDir, 'workspaces')),
    audiences: fileAudienceStore(new JsonCollection<AudienceRecord>(dataDir, 'audiences')),
    sites,
    sessions: fileSessionStore(new JsonCollection<SessionRecord>(dataDir, 'sessions')),
    githubInstallations: fileGithubInstallationStore(
      new JsonCollection<GithubInstallationRecord>(dataDir, 'github-installations'),
      sites,
    ),
  };
};
