/**
 * `@personavision/cli` — the `personavision` command line, as a library.
 *
 * The commands (`serve`, `open`, `run`, `validate`) and the read-only run-data mount that
 * serves a run directory over HTTP. `apps/viewer` mounts the same middleware in its Vite dev server
 * and `personavision serve` mounts it with workspace scoping above it, so a developer
 * running `pnpm dev` reads the identical URLs the shipped app does.
 *
 * The executable lives in `./cli.ts`.
 */

export { readRunIndex, runDataMount } from './run-data.js';
export type { RunDataHandler, RunDataMountOptions, RunSummary } from './run-data.js';

export { DEFAULT_PORT, startRunServer } from './server.js';
export type { RunServer, RunServerOptions } from './server.js';

export { CliError } from './cli-error.js';

export { ensureViewerBuilt } from './viewer-build.js';
export type { EnsureViewerBuiltOptions } from './viewer-build.js';

/**
 * `calibrate` is **deliberately absent from this barrel**. `apps/viewer` imports it for
 * `runDataMount`, and `./commands/calibrate.js` reads `@personavision/calibration`, which
 * reads the engine, `sharp` and the committed corpus off the filesystem — none of which
 * belongs in a Vite dev server or a jsdom suite. The executable imports that module
 * directly; nothing else needs to. `packages/calibration/test/dependency-direction.test.ts`
 * is the test that says why the direction matters.
 */

export { openCommand } from './commands/open.js';
export type { OpenCommandOptions } from './commands/open.js';
export { serveCommand } from './commands/serve.js';
export type { ServeCommandOptions, ServeResult } from './commands/serve.js';

/**
 * `run` is **deliberately absent from this barrel too**, for the same reason `calibrate`
 * is. `./commands/run.js` reaches `@personavision/swarm`, which reaches
 * `@personavision/browser` and so Playwright: a module that launches Chromium has no
 * business in a Vite dev server or a jsdom suite, and `apps/viewer` imports this file. The
 * executable imports that module directly, and `../run/start.js` is where the swarm itself
 * lives for anything that wants to drive a run from code.
 */
export { validateCommand } from './commands/validate.js';
export type { ValidateCommandOptions } from './commands/validate.js';
