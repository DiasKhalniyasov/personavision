import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Running the `personavision` command as a process: the real argv, the real exit code and
 * the real streams.
 *
 * It runs the source through tsx, the way the root `pnpm open` script does, rather than
 * `dist/cli.js`: `pnpm test` is specified not to need a build first, and a suite that read
 * `dist/` would either test a stale build or make the test suite depend on build order.
 * `--conditions=development` is what makes `@personavision/contract` resolve to its source
 * for the same reason.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx/esm');

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The finished command. `cwd` matters: `open` reads `./runs` from it. */
export const personavision = (args: readonly string[], cwd: string): Promise<CliResult> =>
  new Promise((finished, failed) => {
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, '--conditions=development', CLI, ...args],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', failed);
    child.on('close', (code) => finished({ code, stdout, stderr }));
  });

export interface RunningCli {
  /** Everything the command has printed to stdout so far. */
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the first line that matches, or rejects when the command exits first. */
  waitForLine: (match: RegExp) => Promise<string>;
  stop: () => Promise<void>;
}

/** A command that keeps running — `open`, which stays up serving. */
export const startPersonavision = (args: readonly string[], cwd: string): RunningCli => {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, '--conditions=development', CLI, ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.on('close', () => (exited = true));

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    waitForLine: (match) =>
      new Promise<string>((found, failed) => {
        const look = (): boolean => {
          const line = stdout.split('\n').find((candidate) => match.test(candidate));
          if (line === undefined) return false;
          found(line);
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
            failed(
              new Error(
                `the command exited before printing ${String(match)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              ),
            );
          }
        }, 25);
      }),
    stop: () =>
      new Promise<void>((stopped) => {
        if (exited) {
          stopped();
          return;
        }
        child.on('close', () => stopped());
        child.kill('SIGTERM');
      }),
  };
};
