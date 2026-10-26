#!/usr/bin/env node

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { CliError } from './cli-error.js';
import { openCommand } from './commands/open.js';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { DEFAULT_PORT } from './server.js';

/**
 * The `personavision` executable: `validate`, `run` and `open`.
 *
 * All three are **internal tools** — how the team regenerates fixtures, runs the pipeline
 * in CI and debugs an artifact. The product's entry point is `personavision serve`.
 */

/** `packages/cli/`, whether this file is running from `src/` or from `dist/`. */
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(packageDir, '..', '..');
const defaultViewerDist = join(repoRoot, 'apps', 'viewer', 'dist');
/** `./runs`, read from wherever the command was run, as the help says. */
const runsRoot = (): string => resolve(process.cwd(), 'runs');

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const port = (value: string): number => {
  // Digits only: `Number` would take `1e3` and `0x10` and bind a port nobody typed.
  if (!/^\d+$/.test(value) || Number(value) > 65_535) {
    throw new CliError(`--port ${value} is not a port: pass 0..65535, or 0 for any free port.`);
  }
  return Number(value);
};

const program = new Command();

program
  .name('personavision')
  .description(
    [
      'Internal tools over a run directory: validate it, parse a test request, and look at it in a browser.',
      'The product itself starts with `personavision serve`.',
    ].join('\n'),
  )
  .showHelpAfterError();

program
  .command('validate')
  .description('Report every schema violation in a run directory, each with its JSON path.')
  .argument('<runDir>', 'the run directory to check, such as runs/2026-10-24-1402-northwind-demo')
  .action(async (runDir: string) => {
    await validateCommand({ runDir });
  });

program
  .command('run')
  .description(
    'Parse the arguments the New test form submits into a RunRequest. It does not run a test yet.',
  )
  .option(
    '--url <url>',
    'the URL of a version to test; pass it twice to compare two (the first is variant A, Current checkout, the second variant B, Redesign candidate)',
    collect,
    [],
  )
  .option(
    '--task <sentence>',
    'one sentence, in the user’s words, saying what to do; it must say what counts as finishing',
    '',
  )
  .option(
    '--personas <audienceId>',
    'the audience the test is for, by id; the people are generated from it',
    'default',
  )
  .option('--repeats <count>', 'sessions per person per version', '3')
  .option(
    '--seed <integer>',
    'base seed; the same seed and the same person reproduce a session exactly',
    '1',
  )
  .option('--engine <mode>', 'offline (deterministic, no API key) or model', 'offline')
  .action(
    (options: {
      url: string[];
      task: string;
      personas: string;
      repeats: string;
      seed: string;
      engine: string;
    }) => {
      runCommand(options);
    },
  )
  .addHelpText(
    'after',
    '\nExample:\n  personavision run --url http://localhost:4173/checkout-a --task "Buy the boots" --personas default --repeats 3\n',
  );

program
  .command('open')
  .description(
    'Serve the built viewer and ./runs over HTTP, and open it in a browser at / — which the app resolves to the most recent test.',
  )
  .option(
    '--port <port>',
    `the port to listen on; 0 asks for any free port (${DEFAULT_PORT} by default)`,
    port,
    DEFAULT_PORT,
  )
  .option('--no-open', 'start the server and print the URL without launching a browser')
  .option('--no-build', 'fail instead of building the viewer when apps/viewer/dist is missing')
  .option('--viewer <dir>', 'the built viewer to serve', defaultViewerDist)
  .action(async (options: { port: number; open: boolean; build: boolean; viewer: string }) => {
    await openCommand({
      runsRoot: runsRoot(),
      viewerDist: resolve(options.viewer),
      repoRoot,
      port: options.port,
      build: options.build,
      openBrowser: options.open,
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode;
}
