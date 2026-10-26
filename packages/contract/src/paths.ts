import { basename, extname, join } from 'node:path';
import { readdir } from 'node:fs/promises';

/**
 * The run-directory layout: `runs/<YYYY-MM-DD-HHMM-name>/` holding `run.json`,
 * `findings.json`, `sessions/S-NN.json` and `screenshots/<variant>/<step>.png`.
 *
 * This module is the only place those names are written. No other package re-derives a
 * path or globs for a file by guesswork.
 */

const RUN_FILE = 'run.json';
const FINDINGS_FILE = 'findings.json';
const SESSIONS_DIR = 'sessions';
const SCREENSHOTS_DIR = 'screenshots';
const JSON_EXTENSION = '.json';
const SCREENSHOT_EXTENSION = '.png';

/** `2026-10-24-1402-northwind-demo` — the name of a run directory, and the run's id. */
const RUN_DIR_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RunPaths {
  /** The run directory itself, exactly as it was passed in. */
  readonly dir: string;
  readonly run: string;
  readonly findings: string;
  readonly sessionsDir: string;
  readonly screenshotsDir: string;
  /** `sessions/S-01.json` for session id `S-01`. */
  session(sessionId: string): string;
  /** `screenshots/<variant>/<step>.png`. */
  screenshot(variant: string, step: string): string;
}

/**
 * Every file of one run directory. `runDir` may be absolute or relative; passing `''`
 * yields the run-directory-relative paths that `run.json` itself records.
 */
export const runPaths = (runDir: string): RunPaths => ({
  dir: runDir,
  run: join(runDir, RUN_FILE),
  findings: join(runDir, FINDINGS_FILE),
  sessionsDir: join(runDir, SESSIONS_DIR),
  screenshotsDir: join(runDir, SCREENSHOTS_DIR),
  session: (sessionId) => join(runDir, SESSIONS_DIR, `${sessionId}${JSON_EXTENSION}`),
  screenshot: (variant, step) =>
    join(runDir, SCREENSHOTS_DIR, variant, `${step}${SCREENSHOT_EXTENSION}`),
});

/** The session id a session file name carries, or `null` if the file is not one. */
export const sessionIdFromFileName = (fileName: string): string | null =>
  extname(fileName) === JSON_EXTENSION ? basename(fileName, JSON_EXTENSION) : null;

/**
 * The name of the run directory for a run created at `createdAt` — in UTC, so that the
 * same run is named the same on every machine.
 */
export const runDirName = (createdAt: Date, runName: string): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    createdAt.getUTCFullYear(),
    pad(createdAt.getUTCMonth() + 1),
    pad(createdAt.getUTCDate()),
    `${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}`,
  ].join('-');
  // The slug has to leave a name `listRunDirs` recognises, so a name with nothing
  // ASCII-alphanumeric in it falls back rather than producing a bare stamp.
  const slug =
    runName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'run';
  return `${stamp}-${slug}`;
};

/**
 * The run directories under a runs root, newest first. The names sort as dates do, so the
 * order is the names reversed; a directory that is not named like a run is left out, and a
 * missing runs root is no runs rather than an error.
 */
export const listRunDirs = async (runsRoot: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_DIR_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
};
