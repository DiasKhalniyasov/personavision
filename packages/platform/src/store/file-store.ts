import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Audience } from '@personavision/contract';
import type {
  AccountRecord,
  AccountStore,
  AudienceRecord,
  AudienceStore,
  NewAccount,
  NewSession,
  NewWorkspace,
  PlatformStore,
  SessionRecord,
  SessionStore,
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
  return {
    accounts: fileAccountStore(new JsonCollection<AccountRecord>(dataDir, 'accounts')),
    workspaces: fileWorkspaceStore(new JsonCollection<WorkspaceRecord>(dataDir, 'workspaces')),
    audiences: fileAudienceStore(new JsonCollection<AudienceRecord>(dataDir, 'audiences')),
    sessions: fileSessionStore(new JsonCollection<SessionRecord>(dataDir, 'sessions')),
  };
};
