import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatform } from '../src/platform.js';
import type { Platform } from '../src/platform.js';
import { SESSION_COOKIE } from '../src/server/session.js';
import { temporaryDirectories, writeRunAt } from './workspace.js';
import type { TestDirectories } from './workspace.js';

/**
 * Which runs a request may read — the scoping `personavision serve` adds above the
 * run-data mount. The mount itself turns a run that is not in this list into a 404, so
 * what is asserted here is the list.
 */

const requestWith = (cookie?: string): IncomingMessage =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;

describe('the runs a request may read', () => {
  let directories: TestDirectories;
  let platform: Platform;
  let demoRun: string;
  let theirRun: string;
  let theirWorkspaceId: string;

  beforeEach(async () => {
    directories = await temporaryDirectories();
    demoRun = await writeRunAt(directories.runsRoot, {
      stamp: '2026-10-24T14:02:00.000Z',
      name: 'northwind demo',
    });
    platform = await createPlatform(directories);

    // A second workspace, with a run of its own that the demo workspace never sees.
    theirRun = await writeRunAt(directories.runsRoot, {
      stamp: '2026-10-25T09:00:00.000Z',
      name: 'another workspace',
    });
    const theirs = await platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [],
      runIds: [theirRun],
    });
    theirWorkspaceId = theirs.id;
  });

  afterEach(() => directories.cleanup());

  const cookieFor = async (workspaceId: string): Promise<string> => {
    const session = await platform.store.sessions.create({
      accountId: 'account',
      workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return `${SESSION_COOKIE}=${platform.signSession(session.id)}`;
  };

  it('shows a signed-out request the demo run and nothing else', async () => {
    expect(await platform.visibleRuns(requestWith())).toEqual([demoRun]);
  });

  it('shows a session the runs of its own workspace', async () => {
    const mine = await cookieFor(platform.seeded?.workspaceId ?? '');
    expect(await platform.visibleRuns(requestWith(mine))).toEqual([demoRun]);

    const theirs = await cookieFor(theirWorkspaceId);
    expect(await platform.visibleRuns(requestWith(theirs))).toEqual([theirRun]);
  });

  it('treats a tampered cookie as signed out rather than as an error', async () => {
    const mine = await cookieFor(platform.seeded?.workspaceId ?? '');
    const tampered = `${mine.slice(0, -1)}${mine.endsWith('0') ? '1' : '0'}`;
    expect(await platform.visibleRuns(requestWith(tampered))).toEqual([demoRun]);
  });

  it('treats a cookie that is not valid percent-encoding as signed out', async () => {
    // `%E0%A4%A` is a truncated escape: decoding it throws, and a browser holding one
    // would otherwise get a 500 on every request until it cleared the cookie.
    expect(await platform.visibleRuns(requestWith(`${SESSION_COOKIE}=%E0%A4%A`))).toEqual([
      demoRun,
    ]);
  });

  it('treats an unknown and an expired session as signed out', async () => {
    const unknown = `${SESSION_COOKIE}=${platform.signSession('no-such-session')}`;
    expect(await platform.visibleRuns(requestWith(unknown))).toEqual([demoRun]);

    const expired = await platform.store.sessions.create({
      accountId: 'account',
      workspaceId: theirWorkspaceId,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const cookie = `${SESSION_COOKIE}=${platform.signSession(expired.id)}`;
    expect(await platform.visibleRuns(requestWith(cookie))).toEqual([demoRun]);
  });

  it('marks the cookie HTTP-only and SameSite=Lax, and Secure only over HTTPS', () => {
    expect(platform.sessionCookie('a-session', { secure: false })).toMatch(
      /HttpOnly; SameSite=Lax/,
    );
    expect(platform.sessionCookie('a-session', { secure: false })).not.toContain('Secure');
    expect(platform.sessionCookie('a-session', { secure: true })).toContain('Secure');
  });
});
