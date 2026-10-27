/**
 * The session loop in fixture mode, with nothing running.
 *
 * `runSession` composes a browser, an attention engine and a decision provider, and the
 * project's promise is that a cold clone with no API key and no network can run the whole
 * of it (step #8). This file is where that is checked rather than intended: for the length
 * of a whole session every way of launching a process and every way of opening a socket is
 * broken, so a loop that reached for Chromium or for a model fails inside this call instead
 * of quietly succeeding on a machine that happens to have both.
 *
 * The credential half of the promise is held elsewhere and more widely: `tests/workspace.ts`
 * scans every source file in the repository for a credential read and sanctions exactly two,
 * neither of them in this package.
 *
 * The technique is `packages/browser/test/fixture-source.test.ts`'s, applied one layer up.
 */

import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runSession } from '../src/index.js';
import { personaWho, sessionOver, sweep, temporaryRunDir } from './harness.js';

const nodeRequire = createRequire(import.meta.url);

const LAUNCHERS = ['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execFileSync', 'execSync'];

/** Runs something with every way of launching a process or opening a socket broken. */
const withNothingRunning = async <T>(body: () => Promise<T>): Promise<T> => {
  const childProcess = nodeRequire('node:child_process') as Record<string, unknown>;
  const net = nodeRequire('node:net') as { Socket: { prototype: Record<string, unknown> } };

  const saved = new Map(LAUNCHERS.map((name) => [name, childProcess[name]]));
  const savedConnect = net.Socket.prototype.connect;
  const refuse = (what: string) => (): never => {
    throw new Error(`a session in fixture mode reached for ${what}`);
  };

  for (const name of LAUNCHERS) childProcess[name] = refuse(`child_process.${name}`);
  net.Socket.prototype.connect = refuse('a socket');

  try {
    return await body();
  } finally {
    for (const [name, original] of saved) childProcess[name] = original;
    net.Socket.prototype.connect = savedConnect;
  }
};

let runDir: string;

beforeEach(async () => {
  runDir = await temporaryRunDir();
});

afterEach(async () => {
  await sweep(runDir);
});

it('walks a whole session with no browser and no socket', async () => {
  const input = sessionOver(runDir, { persona: personaWho('careful') });
  expect(input.providers.decision.mode).toBe('offline');

  const session = await withNothingRunning(() => runSession(input));

  expect(session.screens.length).toBeGreaterThan(1);
  expect(session.fixations.length).toBeGreaterThan(0);
  // A session that broke would be excluded from every score, so "it ran" is not enough.
  expect(session.outcome.attribution).toBe('product');
  expect(session.outcome.excludedFromScores).toBe(false);
});
