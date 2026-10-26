import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validArtifact } from '../../contract/tests/fixtures.js';
import { createPlatform } from '../src/platform.js';
import { DEMO_ACCOUNT_EMAIL, DEMO_WORKSPACE_NAME } from '../src/seed.js';
import { verifyPassword } from '../src/store/password.js';
import { temporaryDirectories, writeRunAt } from './workspace.js';
import type { TestDirectories } from './workspace.js';

/**
 * The seeded demo workspace: what a fresh data directory comes up with, and what a
 * restart against the same one does not do again.
 */

describe('seeding a fresh data directory', () => {
  let directories: TestDirectories;
  let newest: string;
  let older: string;

  beforeEach(async () => {
    directories = await temporaryDirectories();
    older = await writeRunAt(directories.runsRoot, {
      stamp: '2026-10-20T09:00:00.000Z',
      name: 'an earlier test',
    });
    newest = await writeRunAt(directories.runsRoot, {
      stamp: '2026-10-24T14:02:00.000Z',
      name: 'northwind demo',
    });
  });

  afterEach(() => directories.cleanup());

  it('creates the demo workspace, its account and its audience', async () => {
    const platform = await createPlatform(directories);
    const seeded = platform.seeded;

    expect(seeded).not.toBeNull();
    expect(seeded?.workspaceName).toBe(DEMO_WORKSPACE_NAME);
    expect(seeded?.email).toBe(DEMO_ACCOUNT_EMAIL);
    expect(seeded?.audienceId).not.toBeNull();

    const audiences = await platform.store.audiences.list(seeded?.workspaceId ?? '');
    expect(audiences).toHaveLength(1);
    // The demo audience is the one the committed example run was run for, taken from the
    // artifact rather than restated: *Outdoor-gear shoppers*.
    expect(audiences[0]?.audience).toEqual(validArtifact().run.audience);
  });

  it('registers the runs it found, and the newest as the public demo run', async () => {
    const platform = await createPlatform(directories);
    const workspace = await platform.store.workspaces.byId(platform.seeded?.workspaceId ?? '');

    expect(workspace?.runIds).toEqual([newest, older]);
    expect(workspace?.demoRunId).toBe(newest);
    expect(await platform.store.workspaces.publicRunIds()).toEqual([newest]);
  });

  it('generates a password that verifies against the stored record', async () => {
    const platform = await createPlatform(directories);
    const account = await platform.store.accounts.byEmail(DEMO_ACCOUNT_EMAIL);

    expect(account).not.toBeNull();
    expect(await verifyPassword(platform.seeded?.password ?? '', account!.password)).toBe(true);
  });

  it('writes the password into no file of the data directory', async () => {
    const platform = await createPlatform(directories);
    const password = platform.seeded?.password ?? '';

    expect(password).not.toBe('');
    for (const file of await readdir(platform.dataDir)) {
      expect(await readFile(join(platform.dataDir, file), 'utf8')).not.toContain(password);
    }
  });

  it('seeds a workspace with no run when there is no run to find', async () => {
    const empty = await temporaryDirectories();
    try {
      const platform = await createPlatform({ dataDir: empty.dataDir, runsRoot: empty.runsRoot });
      expect(platform.seeded?.demoRunId).toBeNull();
      expect(platform.seeded?.audienceId).toBeNull();
      expect(platform.seeded?.runIds).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });
});

describe('restarting against the same data directory', () => {
  let directories: TestDirectories;

  beforeEach(async () => {
    directories = await temporaryDirectories();
    await writeRunAt(directories.runsRoot, {
      stamp: '2026-10-24T14:02:00.000Z',
      name: 'northwind demo',
    });
  });

  afterEach(() => directories.cleanup());

  it('seeds nothing, prints no new password and keeps the workspace', async () => {
    const first = await createPlatform(directories);
    const workspaceId = first.seeded?.workspaceId;
    const accounts = await first.store.accounts.byEmail(DEMO_ACCOUNT_EMAIL);

    const second = await createPlatform(directories);

    expect(second.seeded).toBeNull();
    expect((await second.store.workspaces.byId(workspaceId ?? ''))?.name).toBe(DEMO_WORKSPACE_NAME);
    expect(await second.store.accounts.byEmail(DEMO_ACCOUNT_EMAIL)).toEqual(accounts);
  });

  it('keeps signing with the same key, so a session survives the restart', async () => {
    const first = await createPlatform(directories);
    const session = await first.store.sessions.create({
      accountId: first.seeded?.accountId ?? '',
      workspaceId: first.seeded?.workspaceId ?? '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const second = await createPlatform(directories);
    expect(second.signSession(session.id)).toBe(first.signSession(session.id));
  });
});
