import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validArtifact } from '../../contract/tests/fixtures.js';
import { openFileStore } from '../src/store/file-store.js';
import { generatePassword, hashPassword, verifyPassword } from '../src/store/password.js';
import type { PlatformStore } from '../src/store/types.js';

/**
 * The store seam over its one implementation. Every assertion goes through the
 * interfaces, so the managed-database implementation a later ticket adds inherits the
 * suite rather than needing one of its own.
 */

const audience = validArtifact().run.audience;

describe('the file-backed store', () => {
  let dataDir: string;
  let store: PlatformStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'personavision-store-'));
    store = await openFileStore(dataDir);
  });

  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

  const anAccount = async (email = 'owner@northwind.example') =>
    store.accounts.create({
      email,
      displayName: 'Northwind Outdoors owner',
      password: await hashPassword('correct horse battery staple'),
    });

  describe('accounts', () => {
    it('reads an account back by id and by email', async () => {
      const created = await anAccount();
      expect(await store.accounts.byId(created.id)).toEqual(created);
      expect(await store.accounts.byEmail('owner@northwind.example')).toEqual(created);
    });

    it('does not treat capitals as a different address', async () => {
      const created = await anAccount();
      expect(await store.accounts.byEmail('Owner@Northwind.Example')).toEqual(created);
    });

    it('is nothing for an email nobody has', async () => {
      expect(await store.accounts.byEmail('nobody@northwind.example')).toBeNull();
    });

    it('stores a verifier and its parameters, never the password', async () => {
      const created = await anAccount();
      expect(created.password.algorithm).toBe('scrypt');
      expect(created.password.cost).toBeGreaterThanOrEqual(16_384);
      expect(created.password.salt).toMatch(/^[0-9a-f]+$/);
      expect(JSON.stringify(created)).not.toContain('correct horse battery staple');
    });

    it('writes no password into the files on disk', async () => {
      await anAccount();
      const files = await readdir(dataDir);
      for (const file of files) {
        expect(await readFile(join(dataDir, file), 'utf8')).not.toContain(
          'correct horse battery staple',
        );
      }
    });

    it('verifies the right password and refuses the wrong one', async () => {
      const created = await anAccount();
      expect(await verifyPassword('correct horse battery staple', created.password)).toBe(true);
      expect(await verifyPassword('correct horse battery stapl', created.password)).toBe(false);
    });

    it('generates a password that is not the same twice', () => {
      expect(generatePassword()).not.toBe(generatePassword());
      expect(generatePassword()).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    });
  });

  describe('workspaces', () => {
    it('belongs to its members and carries the runs it owns', async () => {
      const account = await anAccount();
      const workspace = await store.workspaces.create({
        name: 'Northwind Outdoors',
        memberAccountIds: [account.id],
        runIds: ['2026-10-24-1402-northwind-demo'],
        demoRunId: '2026-10-24-1402-northwind-demo',
      });
      expect(await store.workspaces.byId(workspace.id)).toEqual(workspace);
      expect(await store.workspaces.forAccount(account.id)).toEqual([workspace]);
      expect(await store.workspaces.publicRunIds()).toEqual(['2026-10-24-1402-northwind-demo']);
    });

    it('registers a run once, however often it is added', async () => {
      const workspace = await store.workspaces.create({ name: 'Northwind', memberAccountIds: [] });
      await store.workspaces.addRun(workspace.id, '2026-10-25-0900-second');
      const twice = await store.workspaces.addRun(workspace.id, '2026-10-25-0900-second');
      expect(twice.runIds).toEqual(['2026-10-25-0900-second']);
    });

    it('names a demo run once however many workspaces point at it', async () => {
      for (const name of ['One', 'Two']) {
        await store.workspaces.create({
          name,
          memberAccountIds: [],
          demoRunId: '2026-10-24-1402-northwind-demo',
        });
      }
      expect(await store.workspaces.publicRunIds()).toEqual(['2026-10-24-1402-northwind-demo']);
    });

    it('refuses to register a run against a workspace that does not exist', async () => {
      await expect(store.workspaces.addRun('nobody', 'a-run')).rejects.toThrow(/nobody/);
    });
  });

  describe('audiences', () => {
    it('round-trips an audience and lists it for its own workspace only', async () => {
      const mine = await store.workspaces.create({ name: 'Mine', memberAccountIds: [] });
      const theirs = await store.workspaces.create({ name: 'Theirs', memberAccountIds: [] });
      const saved = await store.audiences.create(mine.id, audience);

      expect(saved.audience).toEqual(audience);
      expect(await store.audiences.list(mine.id)).toEqual([saved]);
      expect(await store.audiences.list(theirs.id)).toEqual([]);
      expect(await store.audiences.byId(theirs.id, saved.id)).toBeNull();
    });

    it('keeps a soft-deleted audience readable and leaves it out of the list', async () => {
      const workspace = await store.workspaces.create({ name: 'Mine', memberAccountIds: [] });
      const saved = await store.audiences.create(workspace.id, audience);
      const deleted = await store.audiences.softDelete(workspace.id, saved.id);

      expect(deleted.deletedAt).not.toBeNull();
      expect(await store.audiences.byId(workspace.id, saved.id)).toEqual(deleted);
      expect(await store.audiences.list(workspace.id)).toEqual([]);
      expect(await store.audiences.list(workspace.id, { includeDeleted: true })).toEqual([deleted]);
    });

    it('refuses to edit another workspace’s audience', async () => {
      const mine = await store.workspaces.create({ name: 'Mine', memberAccountIds: [] });
      const theirs = await store.workspaces.create({ name: 'Theirs', memberAccountIds: [] });
      const saved = await store.audiences.create(mine.id, audience);
      await expect(store.audiences.update(theirs.id, saved.id, audience)).rejects.toThrow(
        /audience/,
      );
    });
  });

  describe('sessions', () => {
    it('reads a session back and forgets it when it is deleted', async () => {
      const session = await store.sessions.create({
        accountId: 'account',
        workspaceId: 'workspace',
        expiresAt: inAnHour(),
      });
      expect(await store.sessions.byId(session.id)).toEqual(session);
      await store.sessions.delete(session.id);
      expect(await store.sessions.byId(session.id)).toBeNull();
    });

    it('treats an expired session as signed out', async () => {
      const session = await store.sessions.create({
        accountId: 'account',
        workspaceId: 'workspace',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(await store.sessions.byId(session.id)).toBeNull();
    });
  });

  it('loses neither of two records written at the same moment', async () => {
    // Both creates find the collection's cache cold and race its first read. Sharing one
    // read is what keeps the second from overwriting the first's map and its file.
    const [first, second] = await Promise.all([
      store.sessions.create({ accountId: 'a', workspaceId: 'w', expiresAt: inAnHour() }),
      store.sessions.create({ accountId: 'b', workspaceId: 'w', expiresAt: inAnHour() }),
    ]);

    expect(await store.sessions.byId(first.id)).toEqual(first);
    expect(await store.sessions.byId(second.id)).toEqual(second);

    const reopened = await openFileStore(dataDir);
    expect(await reopened.sessions.byId(first.id)).toEqual(first);
    expect(await reopened.sessions.byId(second.id)).toEqual(second);
  });

  it('finds an account created with stray capitals and spaces', async () => {
    const created = await anAccount('  Owner@Northwind.Example  ');
    expect(created.email).toBe('owner@northwind.example');
    expect(await store.accounts.byEmail('owner@northwind.example')).toEqual(created);
  });

  it('keeps what it stored across a restart', async () => {
    const account = await anAccount();
    const workspace = await store.workspaces.create({
      name: 'Northwind Outdoors',
      memberAccountIds: [account.id],
    });

    const reopened = await openFileStore(dataDir);
    expect(await reopened.accounts.byEmail(account.email)).toEqual(account);
    expect(await reopened.workspaces.byId(workspace.id)).toEqual(workspace);
  });
});
