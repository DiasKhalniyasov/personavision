/**
 * The run-directory layout: `runs/<YYYY-MM-DD-HHMM-name>/` holding `run.json`,
 * `findings.json`, `sessions/S-NN.json` and `screenshots/<variant>/<step>.png`.
 *
 * This module is the only place those names are written. No other package re-derives a
 * path or globs for a file by guesswork.
 *
 * It joins the segments itself instead of through `node:path`, and reaches no file system,
 * so the same layout addresses the run data over HTTP from a browser as it addresses it on
 * disk (`docs/adr/0001-run-data-over-http-as-static-files.md`): the viewer resolves these
 * relative paths against a run's URL. Listing a runs root does need a file system, and
 * lives with the rest of the reading in `io.ts`.
 */

const RUN_FILE = 'run.json';
const FINDINGS_FILE = 'findings.json';
const SESSIONS_DIR = 'sessions';
const SCREENSHOTS_DIR = 'screenshots';
const JSON_EXTENSION = '.json';
const SCREENSHOT_EXTENSION = '.png';

/**
 * `/`, on every platform: an artifact path is part of the artifact — `run.json` records
 * screenshot paths — so it cannot be spelt one way on one machine and another elsewhere.
 * Node accepts a forward slash on Windows too.
 */
const SEPARATOR = '/';

/**
 * Only the run directory comes from a caller, so only it can arrive with a separator
 * already on the end; the rest are the names above. Trimming it keeps one spelling of one
 * file, because these strings are compared and reported as well as opened.
 */
const join = (...segments: string[]): string =>
  segments
    .filter((segment) => segment !== '')
    .map((segment, index) => (index === 0 ? segment.replace(/\/+$/, '') : segment))
    .join(SEPARATOR);

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

/**
 * The session id a session file name carries, or `null` if the file is not one. It is
 * given a directory entry's name, so a name that is nothing but the extension is not a
 * session either.
 */
export const sessionIdFromFileName = (fileName: string): string | null => {
  if (!fileName.endsWith(JSON_EXTENSION)) return null;
  const sessionId = fileName.slice(0, -JSON_EXTENSION.length);
  return sessionId === '' ? null : sessionId;
};

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
