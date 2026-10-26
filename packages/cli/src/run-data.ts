import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listRunDirs, runPaths, runSchema } from '@personavision/contract';

/**
 * The run-data interface, implemented once: run directories served read-only over HTTP,
 * mirroring the on-disk layout exactly, plus the one generated listing. Recorded in
 * `docs/adr/0001-run-data-over-http-as-static-files.md`.
 *
 * - `GET /runs/index.json` → `[{ runId, name, createdAt }]`, newest first
 * - `GET /runs/<runId>/run.json`, `/findings.json`, `/sessions/S-NN.json`,
 *   `/screenshots/<variant>/<step>.png` → the files on disk, byte for byte
 *
 * There is no other endpoint, no computation and no write path. `personavision open`
 * serves it beside the built viewer, `personavision serve` serves it with workspace
 * scoping above it, and `apps/viewer`'s dev server mounts this same handler — so a
 * developer running `pnpm dev` reads the identical URLs the shipped app does.
 */

/** The URL prefix the ADR fixes. The directory it reads is the caller's `runsRoot`. */
const RUNS_PREFIX = '/runs';
const INDEX_PATH = `${RUNS_PREFIX}/index.json`;

/** The layout, addressed relatively, so the file kinds below are the contract's own. */
const LAYOUT = runPaths('');

/** The two file kinds the layout holds. A path naming anything else is not run data. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  [extname(LAYOUT.run)]: 'application/json; charset=utf-8',
  [extname(LAYOUT.screenshot('variant', 'step'))]: 'image/png',
};

const JSON_CONTENT_TYPE = CONTENT_TYPES[extname(LAYOUT.run)] as string;

/** One entry of `GET /runs/index.json`. */
export interface RunSummary {
  /** The run directory's name, which is the run's id and the path its files hang under. */
  runId: string;
  /** What was tested, in the words it was asked for: `run.json`'s `task.prompt`. */
  name: string;
  createdAt: string;
}

export interface RunDataMountOptions {
  /** The directory the run directories sit in — `./runs` for `personavision open`. */
  runsRoot: string;
  /**
   * The runs one request may read. The default is every run directory under the runs root.
   * `personavision serve` passes the requesting session's workspace runs, which scopes the
   * listing and the files together rather than forking the mount (#100).
   */
  visibleRuns?: (request: IncomingMessage) => Promise<readonly string[]> | readonly string[];
}

/** A connect-style middleware, so Vite's dev server and `node:http` take the same handler. */
export type RunDataHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

const plain = (response: ServerResponse, status: number, message: string): void => {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${message}\n`);
};

/**
 * One run's listing entry, or `null` when its `run.json` cannot be read as this schema
 * version's — a run the viewer could not render is left out of the listing rather than
 * breaking it, and `personavision validate` is how a developer finds out why.
 */
const readRunSummary = async (runsRoot: string, runId: string): Promise<RunSummary | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runPaths(join(runsRoot, runId)).run, 'utf8'));
  } catch {
    return null;
  }
  const run = runSchema.safeParse(parsed);
  return run.success ? { runId, name: run.data.task.prompt, createdAt: run.data.createdAt } : null;
};

/**
 * The listing, newest first. `createdAt` is read from each `run.json` rather than from the
 * directory name, so the order is the runs' own timestamps.
 *
 * ponytail: parses every `run.json` per request; cache by mtime if a workspace ever holds
 * hundreds of runs.
 */
export const readRunIndex = async (
  runsRoot: string,
  runIds: readonly string[],
): Promise<RunSummary[]> => {
  const summaries = await Promise.all(runIds.map((runId) => readRunSummary(runsRoot, runId)));
  return summaries
    .filter((summary): summary is RunSummary => summary !== null)
    .sort((left, right) => {
      // By instant, not by string: a timestamp may carry its own offset, and two runs an
      // hour apart in different offsets do not sort as their text does.
      const gap = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return gap === 0 ? right.runId.localeCompare(left.runId) : gap;
    });
};

/**
 * The path a request asks for, decoded, or `null` if it is not run data.
 *
 * The app's own routes live under `/runs/` too — `/runs/:runId`, `/runs/:runId/breakdown`,
 * `/runs/:runId/sessions` (`docs/FLOW.md` section 3) — so run data is only the listing and
 * the paths that **name a file** of the layout. Everything else falls through to the app,
 * which is what makes a screen's route resolve on a hard refresh.
 */
const runDataPath = (request: IncomingMessage): string | null => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname !== INDEX_PATH && !pathname.startsWith(`${RUNS_PREFIX}/`)) return null;
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // A path that is not valid percent-encoding is still ours to refuse, not the app's.
  }
  if (path !== INDEX_PATH && CONTENT_TYPES[extname(path)] === undefined) return null;
  return path;
};

const sendFile = async (
  response: ServerResponse,
  file: string,
  requested: string,
  head: boolean,
): Promise<void> => {
  let size: number;
  try {
    const stats = await stat(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    // The path that was asked for, never the path on disk: under `personavision serve`
    // this mount answers whoever is on the other end, and a 404 is not a directory map.
    plain(response, 404, `There is no ${requested} in this run.`);
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    // A run directory changes without a rebuild, so nothing here may be held in a cache.
    'cache-control': 'no-store',
  });
  if (head) {
    response.end();
    return;
  }
  await new Promise<void>((settle, fail) => {
    const bytes = createReadStream(file);
    bytes.on('error', fail);
    response.on('close', () => bytes.destroy());
    bytes.pipe(response).on('finish', settle).on('error', fail);
  });
};

/**
 * `true` when `target` is `root` itself or inside it, resolved paths both.
 *
 * The step out of the root is what decides it: `..`, a path beginning `../`, or an absolute
 * path — which is what `relative` returns across Windows drives — all leave it. A child
 * whose own name begins with dots, `..keep.json`, does not, so this cannot be a prefix test.
 */
const isInside = (root: string, target: string): boolean => {
  const step = relative(root, target);
  return !isAbsolute(step) && step !== '..' && !step.startsWith(`..${sep}`);
};

export const runDataMount = (options: RunDataMountOptions): RunDataHandler => {
  const runsRoot = resolve(options.runsRoot);
  const visibleRuns = options.visibleRuns ?? (() => listRunDirs(runsRoot));

  const answer = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      plain(response, 405, 'Run data is read-only: only GET and HEAD are served.');
      return;
    }
    const head = request.method === 'HEAD';
    const runIds = await visibleRuns(request);

    if (path === INDEX_PATH) {
      const body = Buffer.from(
        `${JSON.stringify(await readRunIndex(runsRoot, runIds), null, 2)}\n`,
      );
      response.writeHead(200, {
        'content-type': JSON_CONTENT_TYPE,
        'content-length': body.byteLength,
        'cache-control': 'no-store',
      });
      response.end(head ? undefined : body);
      return;
    }

    const [runId, ...rest] = path.slice(`${RUNS_PREFIX}/`.length).split('/');
    // An id that is not one of this request's runs is 404 and not 403: whether another
    // workspace holds a run is not this mount's to disclose.
    if (runId === undefined || runId === '' || !runIds.includes(runId)) {
      plain(response, 404, `There is no run "${runId ?? ''}" here.`);
      return;
    }
    const runDir = join(runsRoot, runId);
    const file = resolve(runDir, ...rest);
    const refuse = (): void => {
      plain(response, 403, 'Only the files of a run directory are served.');
    };
    if (path.includes('\0') || !isInside(runDir, file)) {
      refuse();
      return;
    }
    // Lexically inside is not enough: a symbolic link in a run directory points wherever it
    // likes and `stat` would follow it. Both sides are resolved, because a runs root is
    // often reached through a link itself — `/tmp` on macOS is one.
    const real = await Promise.all([realpath(runDir), realpath(file)]).catch(() => null);
    if (real === null) {
      plain(response, 404, `There is no ${path} in this run.`);
      return;
    }
    if (!isInside(real[0], real[1])) {
      refuse();
      return;
    }
    await sendFile(response, real[1], path, head);
  };

  return (request, response, next) => {
    const path = runDataPath(request);
    if (path === null) {
      next();
      return;
    }
    answer(request, response, path).catch((error: unknown) => {
      // The mount reads files and nothing else, so a throw here is the server's fault and
      // is reported as one rather than being passed to the app as a missing page. Why it
      // failed goes to whoever is running the server, not to whoever asked.
      process.stderr.write(`personavision: ${path} could not be read: ${String(error)}\n`);
      if (!response.headersSent) plain(response, 500, 'Run data could not be read.');
      else response.destroy();
    });
  };
};
