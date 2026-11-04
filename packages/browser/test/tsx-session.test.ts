/**
 * A browser session that survives being run from source.
 *
 * `pnpm open`, `pnpm dev` and every `tsx --conditions=development packages/cli/src/cli.ts …`
 * invocation run this package through `tsx`, which is esbuild, which rewrites named
 * functions as `__name(fn, "fn")` and declares `__name` at the top of the **module**.
 * Playwright serialises the function handed to `page.evaluate` and evaluates its *source*
 * inside the page, where no such declaration exists — so every session failed at its first
 * `page.evaluate` with `ReferenceError: __name is not defined` while the built CLI, which
 * `tsc` emits, worked. `src/session.ts` declares the helper in every document the session
 * loads; this suite is what says so out of a real browser.
 *
 * **It has to be a subprocess.** Vitest transforms this file with its own pipeline, which
 * injects no such helper, so a session opened from inside a test here cannot reproduce the
 * failure however it is written. The transpiler is the thing under test, so the test spawns
 * it: `scripts/tsx-session.ts` under `tsx`, one session against the fixture site, every one
 * of the package's six page-evaluating modules touched once.
 *
 * What this does **not** cover is stated in `src/session.ts`: the init script declares
 * esbuild's `keepNames` helper and nothing else. Another injected helper would fail exactly
 * the same way, and this suite is where it would show up.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM_INSTALLED } from './helpers/chromium.js';

/** The package's rule, nine suites old: a developer without the browser is skipped, CI is not. */
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/**
 * `tsx`'s own entry point, resolved rather than spelled as a path, and run by this very
 * Node: `tsx` is a devDependency of the **root** (it is what `pnpm open` uses) and nothing
 * is added to this package's dependencies for it. Resolving the module instead of the
 * `.bin` shim keeps a shell out of it on every platform.
 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** The script to run, and the directory `pnpm open` would be run from. */
const SCRIPT = fileURLToPath(new URL('./scripts/tsx-session.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A Chromium launch, a full extraction and a transpiler's cold start, with room to spare. */
const TSX_SESSION_TIMEOUT_MS = 120_000;

interface SpawnedRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the script the way `pnpm open` runs the CLI: `tsx --conditions=development`, so the
 * workspace's packages resolve to their TypeScript sources — which is the whole point, since
 * it is the transpiling of those sources that used to break the page.
 */
const runUnderTsx = (): Promise<SpawnedRun> =>
  new Promise((settled, failed) => {
    const child = spawn(process.execPath, [TSX_CLI, '--conditions=development', SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', failed);
    child.once('close', (code, signal) => settled({ code, signal, stdout, stderr }));
  });

/**
 * The object the script printed. The last non-empty line, because a transpiler or a driver
 * is free to write a deprecation warning above it and that is not this suite's business.
 */
const reported = (stdout: string): Record<string, unknown> => {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  return JSON.parse(lines[lines.length - 1] ?? 'null') as Record<string, unknown>;
};

describeWithChromium('a session opened and captured under tsx', () => {
  let run: SpawnedRun;

  beforeAll(async () => {
    run = await runUnderTsx();
  }, TSX_SESSION_TIMEOUT_MS);

  it('evaluates in the page without a transpiler helper the page has never heard of', () => {
    // Named rather than left to the exit code: this is the failure the init script exists
    // for, and reverting it should say so here instead of only saying "exited 1".
    expect(run.stderr).not.toMatch(/ReferenceError/);
  });

  it('exits 0, reporting one captured screen', () => {
    // The exit status, not an empty `stderr`: a transpiler or a driver is free to write a
    // deprecation notice there and that is not this suite's business either. What stderr is
    // for here is reading the failure, so it is the assertion's message.
    expect({ code: run.code, signal: run.signal }, run.stderr).toEqual({ code: 0, signal: null });
    expect(reported(run.stdout)).toMatchObject({ screens: 1 });
  });

  it('walked the page, resolved its geometry, extracted its elements and detected its step', () => {
    // `fixtures/site/LANDMARKS.md`'s cart page at the desktop viewport, quoted.
    expect(reported(run.stdout)).toMatchObject({
      viewport: { width: 1440, height: 900 },
      step: 'cart',
      pageHeight: 1400,
      foldY: 900,
      screenshot: 'screenshots/v-desktop/cart.png',
      primaryActions: 1,
    });
    expect(reported(run.stdout).elements).toBeGreaterThan(0);
  });

  it('performed one action on it', () => {
    expect(reported(run.stdout)).toMatchObject({
      action: { ok: true, step: 'cart', scrollY: 120 },
    });
  });
});
