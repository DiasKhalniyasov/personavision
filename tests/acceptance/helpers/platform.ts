/**
 * The mechanics the demo walk-through runs on: the product started the way the demo's first
 * beat starts it, and a Chromium page pointed at it.
 *
 * Nothing here asserts anything. What lives here is the plumbing that would otherwise crowd
 * out the beats in `../demo-walkthrough.test.ts`: starting `personavision serve` on a fresh
 * data directory with an environment that holds no credential, reading the address and the
 * seeded workspace's own credentials off its output, opening one browser over it, and
 * refusing any request that tries to leave the machine.
 *
 * The browser is `@personavision/browser`'s own `openSession`, used rather than forked: the
 * swarm's launcher is the one place this repository launches Chromium, and the walk is
 * another caller of it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSession, openSession } from '@personavision/browser';
import type { Device, PageHandle } from '@personavision/browser';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The `personavision` binary as `pnpm build` leaves it — `packages/cli/package.json`'s `bin`. */
const CLI = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

/**
 * What the command is given: the two variables a process needs to find its interpreter and
 * its home, and nothing else.
 *
 * "No API key" is a claim about this sequence, and the way to assert it is to run the
 * sequence with an environment that holds none — a `PERSONAVISION_*` variable included, so
 * a cold start that had come to need one fails here rather than in a demo.
 */
const PASSED_THROUGH = ['PATH', 'HOME'] as const;

export const bareEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(PASSED_THROUGH.map((name) => [name, process.env[name]]));

/** The line `serve` prints last, and the only place this file learns which port it is on. */
const URL_LINE = /^http:\/\/127\.0\.0\.1:\d+\/$/;

/** The two lines of the one-time credentials block the first start prints. */
const EMAIL_LINE = /^ {2}Sign in as {2}(\S.*)$/m;
const PASSWORD_LINE = /^ {2}Password {4}(\S.*)$/m;

/**
 * The seeded demo workspace's credentials, as the start that seeded printed them once.
 *
 * They are generated per data directory and this object is the only copy the walk holds.
 * Nothing in this module writes either value into a message: a failure says which line was
 * missing, never what the output said, because the output carries a password.
 */
export interface SeededCredentials {
  readonly email: string;
  readonly password: string;
}

export interface ServedPlatform {
  /** The address the command printed, on the port it was actually given. */
  readonly base: string;
  /** The credentials the seeding start printed, or `null` for a start that seeded nothing. */
  readonly credentials: SeededCredentials | null;
  /** Everything the command wrote that is not the credentials block. */
  readonly log: () => string;
  /** `true` once the process is gone. */
  readonly exited: () => boolean;
  readonly stop: () => Promise<void>;
}

export interface ServeOptions {
  /** Where accounts, workspaces and sessions go. A directory that does not exist is seeded. */
  readonly dataDir: string;
}

/**
 * `personavision serve --no-open`, on a port the operating system picks.
 *
 * `--no-build` is deliberate: the acceptance job builds before it runs this suite, and a
 * viewer missing at this point is a failure of that build rather than something for the walk
 * to paper over by quietly rebuilding one.
 */
export const servePlatform = async ({ dataDir }: ServeOptions): Promise<ServedPlatform> => {
  const child = spawn(
    process.execPath,
    [CLI, 'serve', '--no-open', '--no-build', '--port', '0', '--data-dir', dataDir],
    { cwd: repoRoot, env: bareEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let exited = false;
  let failedToStart: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
  child.on('close', () => void (exited = true));
  // A spawn that never starts emits `error`, and an unheard one would take the whole test
  // worker down with it rather than failing the start this function is reporting on.
  child.on('error', (error: Error) => {
    failedToStart = error;
    exited = true;
  });

  const stop = (): Promise<void> =>
    new Promise<void>((stopped) => {
      if (exited) {
        stopped();
        return;
      }
      child.on('close', () => stopped());
      child.kill('SIGTERM');
    });

  const base = await new Promise<string>((printed, failed) => {
    const look = (): boolean => {
      const found = stdout.split('\n').find((candidate) => URL_LINE.test(candidate.trim()));
      if (found === undefined) return false;
      printed(found.trim());
      return true;
    };
    if (look()) return;
    const poll = setInterval(() => {
      if (look()) {
        clearInterval(poll);
        return;
      }
      if (exited) {
        clearInterval(poll);
        // Deliberately without `stdout`: it holds the one-time password.
        const why =
          failedToStart === undefined
            ? `exited before printing its URL; stderr:\n${stderr}`
            : `could not be started: ${failedToStart.message}`;
        failed(new Error(`personavision serve ${why}`));
      }
    }, 25);
  });

  const email = EMAIL_LINE.exec(stdout)?.[1];
  const password = PASSWORD_LINE.exec(stdout)?.[1];
  const credentials =
    email === undefined || password === undefined ? null : { email, password: password.trim() };

  return {
    base,
    credentials,
    // The credentials block is removed line by line, so a failure may print the log.
    log: () =>
      stdout
        .split('\n')
        .filter((line) => !EMAIL_LINE.test(line) && !PASSWORD_LINE.test(line))
        .join('\n'),
    exited: () => exited,
    stop,
  };
};

/** A temporary directory of this suite's, named so that a leftover says whose it was. */
export const scratch = (what: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `personavision-walkthrough-${what}-`));

/** Remove a temporary directory, and nothing at all when there is nothing to remove. */
export const discard = async (directory: string | undefined): Promise<void> => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
};

export interface OpenedBrowser {
  readonly handle: PageHandle;
  /** Every request the page made to somewhere other than the server under test. */
  readonly offMachine: () => string[];
  readonly close: () => Promise<void>;
}

/**
 * One Chromium page over the served product, with everything that is not this server
 * refused.
 *
 * The refusal is the assertion that nothing is crawled and nothing is paid for, made where
 * it can be seen: a request that leaves the loopback port is aborted and recorded, so a
 * screen that had come to fetch a font, a map tile or a model from the internet fails the
 * walk instead of quietly working on a machine that happens to be online.
 */
export const openBrowserOver = async (base: string, device: Device): Promise<OpenedBrowser> => {
  const handle = await openSession({ id: 'demo-walkthrough', url: base }, device);
  const offMachine: string[] = [];
  const origin = new URL(base).origin;

  try {
    await handle.context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
        void route.continue();
        return;
      }
      offMachine.push(url);
      void route.abort();
    });
  } catch (error) {
    await closeSession(handle);
    throw error;
  }

  return {
    handle,
    offMachine: () => [...offMachine],
    close: () => closeSession(handle),
  };
};
