import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  listRunDirs,
  NO_LONGER_KEPT_STATE,
  runPaths,
  runSchema,
  selectVideoStore,
  videoObjectName,
} from '@personavision/contract';
import type { VideoStore } from '@personavision/contract';

/**
 * The run-data interface, implemented once: run directories served read-only over HTTP,
 * mirroring the on-disk layout exactly, plus the one generated listing. Recorded in
 * `docs/adr/0001-run-data-over-http-as-static-files.md`.
 *
 * - `GET /runs/index.json` → `[{ runId, name, createdAt }]`, newest first
 * - `GET /runs/<runId>/run.json`, `/findings.json`, `/aggregate.json`,
 *   `/recommendations.json`, `/sessions/S-NN.json`, `/screenshots/<variant>/<step>.png`,
 *   `/videos/S-NN.webm` → the
 *   files on disk, byte for byte. A new artifact file of the layout is reachable the moment
 *   it is written: the mount answers for the file kinds below and holds no list of names.
 * - A `Range: bytes=…` request for any of them is answered with that slice, so a `<video>`
 *   element asked to open paused on one frame seeks to it instead of downloading the whole
 *   recording first. A range is an offset into the same read, not a computation.
 *
 * **A recording may not be on this disk at all.** `PV_VIDEO_BUCKET` selects where session
 * videos live (`@personavision/contract`'s `selectVideoStore`, and
 * `docs/adr/0005-where-session-videos-live.md`); with one set, the video path above answers a
 * **302 to a short-lived signed URL** instead of streaming the bytes through this process, so a
 * 1.4 GB recording does not cross Node twice and the `Range` a scrubber asks for is served by
 * the store. The URL a browser fetches is the same either way, which is what `docs/adr/0001`
 * fixes. A recording the store no longer holds — the thirty-day lifecycle rule of #228 — is
 * answered as the typed, worded "no longer kept" state, never a 500 and never an empty body.
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

/**
 * The three file kinds the layout holds, each keyed by the extension the paths module
 * itself spells — so a video is `video/webm` because `runPaths` says a recording is a
 * `.webm`, and not because a second list here repeats it. A path naming anything else is
 * not run data.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  [extname(LAYOUT.run)]: 'application/json; charset=utf-8',
  [extname(LAYOUT.screenshot('variant', 'step'))]: 'image/png',
  [extname(LAYOUT.video('sessionId'))]: 'video/webm',
};

const JSON_CONTENT_TYPE = CONTENT_TYPES[extname(LAYOUT.run)] as string;

/** What a recording is called, by the layout's own spelling and not by a second list. */
const VIDEO_EXTENSION = extname(LAYOUT.video('sessionId'));

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
  /**
   * Where session videos live. Omitted — which is every caller in this repository — means the
   * store `PV_VIDEO_BUCKET` selects, and that is `null` wherever the variable is unset: the
   * files in the run directory, which is what every test, the acceptance suite and the demo
   * read. `null` is that same answer, said explicitly, and a test passes its own store.
   */
  videoStore?: VideoStore | null;
}

/** A connect-style middleware, so Vite's dev server and `node:http` take the same handler. */
export type RunDataHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

const plain = (
  response: ServerResponse,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
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

/** The bytes of a file one answer carries. */
interface Slice {
  start: number;
  /** Inclusive, as a `content-range` spells it, so an empty file ends at `-1`. */
  end: number;
  /** `true` when a range header picked it, which is what makes the answer a 206. */
  partial: boolean;
}

/** One `bytes=` range and nothing else: a list of them is a body this mount does not write. */
const ONE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Declared on every file the mount streams, whole or partial, because a player looks for it
 * before it asks for a frame in the middle of one. Every one of those files is read off
 * disk, so a slice of any of them is an offset into that read and nothing more.
 */
const ACCEPT_RANGES = { 'accept-ranges': 'bytes' } as const;

/**
 * The slice a `Range` header asks for out of a file of `size` bytes, or `null` when the
 * range is valid and the file has no such bytes — the one request answered with neither the
 * file nor a part of it.
 *
 * The two ways a range is not served are not the same answer, because only one of them is
 * the client's last word (RFC 9110 §§14.1.1, 14.2):
 *
 * - **Not understood, so ignored**: another unit, a list of ranges, nothing parseable, or a
 *   last byte before the first — an invalid spec, which invalidates the header rather than
 *   describing bytes. The whole file is the answer, and a player that transposed its two
 *   numbers still plays rather than erroring out on a 416 it cannot retry past.
 * - **Satisfiable by nothing**: a first byte at or past the end, or a suffix of zero bytes.
 *   That range is about this file and is wrong about it, which is what a 416 says.
 */
const sliceOf = (header: string | undefined, size: number): Slice | null => {
  const whole: Slice = { start: 0, end: size - 1, partial: false };
  const asked = header === undefined ? null : ONE_BYTE_RANGE.exec(header.trim());
  if (asked === null) return whole;
  const [, from = '', to = ''] = asked;
  const inverted = from !== '' && to !== '' && Number(to) < Number(from);
  if ((from === '' && to === '') || inverted) return whole;
  // `bytes=-N` asks for the last N bytes, which is the whole file when it holds fewer and
  // nothing at all when N is zero; a last byte past the end is the end.
  const start = from === '' ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start > end ? null : { start, end, partial: true };
};

/**
 * A recording the store no longer holds: `410`, and a body that **states** it.
 *
 * The thirty-day lifecycle rule of #228 is the normal end of a recording's life, so this is a
 * state the results screens render rather than a failure — which is why it carries the typed
 * word and the sentence in a body a screen can read, and not a bare status a `<video>` element
 * turns into "something went wrong".
 */
const stateGone = (response: ServerResponse, reason: string, head: boolean): void => {
  const body = Buffer.from(`${JSON.stringify({ state: NO_LONGER_KEPT_STATE, reason }, null, 2)}\n`);
  response.writeHead(410, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(head ? undefined : body);
};

/**
 * One stored recording: where to fetch it, or that it is no longer kept.
 *
 * The redirect is a **302**, so the method and the headers of the request are carried to the
 * signed URL — a `Range` among them, which is what makes a scrubber seek. Nothing is streamed
 * through this process, and no `Range` is parsed here: the store answers it.
 */
const sendStoredVideo = async (
  response: ServerResponse,
  store: VideoStore,
  objectName: string,
  head: boolean,
): Promise<void> => {
  const location = await store.locate(objectName);
  if (location.kind === 'gone') {
    stateGone(response, location.reason, head);
    return;
  }
  response.writeHead(302, {
    location: location.url,
    'content-length': 0,
    // A signed URL expires, and a run directory changes without a rebuild.
    'cache-control': 'no-store',
  });
  response.end();
};

const sendFile = async (
  response: ServerResponse,
  file: string,
  requested: string,
  head: boolean,
  range: string | undefined,
): Promise<void> => {
  let size: number;
  try {
    const stats = await stat(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    // The path that was asked for, never the path on disk: under `personavision serve`
    // this mount answers whoever is on the other end, and a 404 is not a directory map.
    // An absent file is this, and never an empty body: a recording that was never made
    // and one that is zero bytes long must not look the same to a client.
    plain(response, 404, `There is no ${requested} in this run.`);
    return;
  }
  const slice = sliceOf(range, size);
  if (slice === null) {
    plain(response, 416, `${requested} is ${size} bytes long: that range is not inside it.`, {
      ...ACCEPT_RANGES,
      'content-range': `bytes */${size}`,
    });
    return;
  }
  const length = slice.end - slice.start + 1;
  response.writeHead(slice.partial ? 206 : 200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': length,
    ...ACCEPT_RANGES,
    ...(slice.partial ? { 'content-range': `bytes ${slice.start}-${slice.end}/${size}` } : {}),
    // A run directory changes without a rebuild, so nothing here may be held in a cache.
    'cache-control': 'no-store',
  });
  if (head || length === 0) {
    response.end();
    return;
  }
  await new Promise<void>((settle, fail) => {
    const bytes = createReadStream(file, { start: slice.start, end: slice.end });
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
  // Chosen once, where the mount is built, by the one function that reads the variable.
  const videoStore = options.videoStore === undefined ? selectVideoStore() : options.videoStore;

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
    if (videoStore !== null && extname(file) === VIDEO_EXTENSION) {
      const sessionId = basename(file, VIDEO_EXTENSION);
      // A `.webm` under some other name is not a session's recording, and the store holds no
      // object for it: 404 rather than a redirect to a signature over a guess.
      if (rest.join('/') !== LAYOUT.video(sessionId)) {
        plain(response, 404, `There is no ${path} in this run.`);
        return;
      }
      await sendStoredVideo(response, videoStore, videoObjectName(runId, sessionId), head);
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
    await sendFile(response, real[1], path, head, request.headers.range);
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
