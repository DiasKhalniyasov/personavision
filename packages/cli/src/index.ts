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

export { openCommand } from './commands/open.js';
export type { OpenCommandOptions } from './commands/open.js';
export { serveCommand } from './commands/serve.js';
export type { ServeCommandOptions, ServeResult } from './commands/serve.js';
export { parseRunRequest, runCommand } from './commands/run.js';
export type { RunCommandArguments, RunCommandOptions } from './commands/run.js';
export { validateCommand } from './commands/validate.js';
export type { ValidateCommandOptions } from './commands/validate.js';
