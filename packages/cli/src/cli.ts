#!/usr/bin/env node

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIT_DEFAULTS } from '@personavision/calibration';
import { DEFAULT_PORT as DEFAULT_SERVE_PORT } from '@personavision/platform';
import { Command } from 'commander';
import { CliError } from './cli-error.js';
import {
  EXIT_CODE_HELP,
  calibrateFetchCommand,
  calibrateFitCommand,
  calibrateScoreCommand,
} from './commands/calibrate.js';
import { openCommand } from './commands/open.js';
import { runCommand } from './commands/run.js';
import { serveCommand } from './commands/serve.js';
import { validateCommand } from './commands/validate.js';
import { DEFAULT_PORT } from './server.js';

/**
 * The `personavision` executable.
 *
 * `serve` starts the product: the platform server, a signed-in workspace and the run data
 * scoped to it. `validate`, `run`, `open` and `calibrate` are **internal tools** — how the
 * team regenerates fixtures, runs the pipeline in CI, debugs an artifact and measures how
 * human-like the engine currently is.
 */

/** `packages/cli/`, whether this file is running from `src/` or from `dist/`. */
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(packageDir, '..', '..');
const defaultViewerDist = join(repoRoot, 'apps', 'viewer', 'dist');
/** `./runs`, read from wherever the command was run, as the help says. */
const runsRoot = (): string => resolve(process.cwd(), 'runs');
/** Accounts, workspaces, audiences and sessions. Never committed: see `.gitignore`. */
const DEFAULT_DATA_DIR = './.personavision';
/** Where `calibrate fit --write` writes, and the engine imports at build time. */
const defaultCalibratedConfig = join(repoRoot, 'packages', 'engine', 'config', 'calibrated.json');

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
      '`serve` starts PersonaVision: sign in, and read the tests your workspace owns.',
      'validate, run and open are internal tools over a run directory, and calibrate is how the engine is scored against human eye tracking.',
    ].join('\n'),
  )
  .showHelpAfterError();

program
  .command('serve')
  .description(
    'Start PersonaVision: the platform server, the app and the run data of the signed-in workspace. A data directory that does not exist yet is seeded with a demo workspace whose password is printed once.',
  )
  .option(
    '--port <port>',
    `the port to listen on; 0 asks for any free port (${DEFAULT_SERVE_PORT} by default)`,
    port,
    DEFAULT_SERVE_PORT,
  )
  .option('--no-open', 'start the server and print the URL without launching a browser')
  .option('--no-build', 'fail instead of building the viewer when apps/viewer/dist is missing')
  .option('--viewer <dir>', 'the built viewer to serve', defaultViewerDist)
  .option(
    '--data-dir <dir>',
    'where accounts, workspaces, audiences and sessions are kept',
    DEFAULT_DATA_DIR,
  )
  .action(
    async (options: {
      port: number;
      open: boolean;
      build: boolean;
      viewer: string;
      dataDir: string;
    }) => {
      await serveCommand({
        dataDir: resolve(options.dataDir),
        runsRoot: runsRoot(),
        viewerDist: resolve(options.viewer),
        repoRoot,
        port: options.port,
        build: options.build,
        openBrowser: options.open,
      });
    },
  );

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

const integer = (flag: string, value: string): number => {
  // Digits only, as `--port` is: `Number` would take `1e3` and `0x10`, and a seed nobody
  // typed makes a figure nobody can reproduce.
  if (!/^\d+$/.test(value)) {
    throw new CliError(`${flag} ${value} is not a whole number.`);
  }
  return Number(value);
};

const calibrate = program
  .command('calibrate')
  .description(
    [
      'Measure and fit how human-like the attention engine is, against the UEyes eye-tracking benchmark (CHI 2023).',
      'fetch brings the dataset onto this machine and converts it; score prints the figures; fit searches the engine’s weights.',
      'Every figure is printed with the record count behind it, and the web category is named rather than folded into the average.',
    ].join('\n'),
  )
  .addHelpText('after', `\n${EXIT_CODE_HELP}\n`);

calibrate
  .command('fetch')
  .description(
    'Download and verify UEyes into a cache outside this repository, then convert it into the project’s session shape. It prints the licence before it fetches a byte, resumes an interrupted transfer, does nothing twice, and names every record it rejects.',
  )
  .option(
    '--cache <dir>',
    `the cache root to use, instead of $${'PERSONAVISION_CALIBRATION_CACHE'} and the operating system’s cache directory`,
  )
  .option(
    '--manifest <file>',
    'a dataset manifest other than the committed one — a corrected layout or a staged copy. It is held to the same rules: an https download location and a recorded checksum per file',
  )
  .option(
    '--record-checksums',
    'hash a fresh download and write the result into the manifest as a reviewable change, instead of refusing a file the manifest cannot verify',
  )
  .option('--convert-only', 'skip the download and convert what is already unpacked in the cache')
  .addHelpText('after', `\n${EXIT_CODE_HELP}\n`)
  .action(
    async (options: {
      cache?: string;
      manifest?: string;
      recordChecksums?: boolean;
      convertOnly?: boolean;
    }) => {
      await calibrateFetchCommand({
        cache: options.cache,
        manifest: options.manifest,
        recordChecksums: options.recordChecksums ?? false,
        convertOnly: options.convertOnly ?? false,
      });
    },
  );

calibrate
  .command('score')
  .description(
    'Score the engine over the committed synthetic corpus, or over the converted dataset with --dataset: per category, overall, and against the centre-bias prior and random fixations. No figure is printed without the record count behind it, and an empty corpus prints a sentence rather than a number.',
  )
  .option(
    '--dataset',
    'score the converted UEyes dataset in the cache instead of the committed synthetic corpus; without one, this names the command that produces it and exits 4',
  )
  .option(
    '--cache <dir>',
    `the cache root --dataset reads, instead of $${'PERSONAVISION_CALIBRATION_CACHE'} and the operating system’s cache directory`,
  )
  .option(
    '--seed <integer>',
    'the seed every prediction is made at; the same seed reproduces the figures exactly',
    (value: string) => integer('--seed', value),
    1,
  )
  .addHelpText('after', `\n${EXIT_CODE_HELP}\n`)
  .action(async (options: { dataset?: boolean; cache?: string; seed: number }) => {
    await calibrateScoreCommand({
      dataset: options.dataset ?? false,
      cache: options.cache,
      seed: options.seed,
    });
  });

calibrate
  .command('fit')
  .description(
    'Search the engine’s configuration against the benchmark, seeded and bounded, and print the best one with its objective. Nothing is written without --write: the change it would make is printed instead.',
  )
  .option(
    '--write',
    'write the fitted configuration; without it nothing is written and the change it would make is printed',
  )
  .option('--out <file>', 'where --write writes it', defaultCalibratedConfig)
  .option(
    '--seed <integer>',
    'the candidate draw and the prediction seed in one number',
    (value: string) => integer('--seed', value),
    FIT_DEFAULTS.seed,
  )
  .option(
    '--candidates <integer>',
    'candidates drawn beside the engine’s defaults, which are always scored first',
    (value: string) => integer('--candidates', value),
    FIT_DEFAULTS.candidates,
  )
  .addHelpText('after', `\n${EXIT_CODE_HELP}\n`)
  .action(async (options: { write?: boolean; out: string; seed: number; candidates: number }) => {
    await calibrateFitCommand({
      write: options.write ?? false,
      out: resolve(options.out),
      seed: options.seed,
      candidates: options.candidates,
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode;
}
