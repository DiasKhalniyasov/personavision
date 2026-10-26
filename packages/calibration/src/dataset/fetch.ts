/**
 * Bringing UEyes onto the machine: one command, resumable, verified, and outside the
 * repository.
 *
 * Calibration data is meant to be one command away rather than a manual download ritual, so
 * this is the whole of it — fetch every file the manifest lists, resume an interrupted
 * transfer from the bytes already on disk, check each file against its recorded checksum,
 * compare the archive's real tree with the layout the manifest declares, and unpack it into
 * the cache. The repository gains no dataset byte: every path here comes from
 * `cache.ts`, which resolves under the OS cache directory.
 *
 * Four rules the code keeps, each of them a thing that could otherwise go quietly wrong:
 *
 * - **No URL query string is ever logged.** A download link can carry a token; this product
 *   keeps secrets out of its output, so every URL that reaches the log or an error goes
 *   through `withoutSecrets` first. Nothing here reads a credential, and none is needed:
 *   the dataset is open access.
 * - **Verification never silently passes.** A file whose checksum the manifest records as
 *   unverified is refused, and `--record-checksums` turns a fresh local hash into a
 *   reviewable change to `manifest.json` rather than a pass.
 * - **A failure leaves no half-extracted tree.** Downloads are all completed and verified
 *   before anything is unpacked, and an archive is unpacked into a staging directory that
 *   is moved into place only once it is whole.
 * - **A second run over a complete cache does nothing and says so.** A verified file leaves
 *   a receipt, so being already present is cheap to establish and is reported rather than
 *   being an absence of output.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractArchive, readArchiveDirectory } from './archive.js';
import type { ArchiveEntry } from './archive.js';
import { datasetCachePaths } from './cache.js';
import type { CacheEnvironment } from './cache.js';
import { loadManifest, recordedChecksum } from './manifest.js';
import type { ArchiveRoot, DatasetManifest, ManifestFile, RecordedChecksum } from './manifest.js';
import {
  compareArchiveLayout,
  localChecksum,
  quarantineFile,
  readReceipt,
  readReceiptFile,
  recordChecksum,
  verifyFile,
  writeReceipt,
} from './verify.js';
import type { LayoutComparison, ManifestChecksumChange } from './verify.js';

/** Where the dataset is unpacked while it is still incomplete. */
const STAGING_DIRECTORY = '.staging';

/** What one manifest file cost, and what became of it. */
export interface FileOutcome {
  /** The manifest's path for the file. */
  readonly path: string;
  readonly state: 'downloaded' | 'already-present';
  readonly sizeBytes: number;
  /** The byte the transfer resumed from, or zero when it ran from the start. */
  readonly resumedFromBytes: number;
  /** How many times the transfer had to be picked up again. */
  readonly interruptions: number;
  /** What the bytes on disk hash to, and under which algorithm. */
  readonly checksum: { readonly algorithm: string; readonly value: string };
  /** Whether that hash was compared with one the manifest records. */
  readonly verifiedAgainstManifest: boolean;
}

/** One reason the command could not finish. Every file is tried before any is reported. */
export interface FetchFailure {
  readonly path: string;
  readonly reason: string;
}

/** The command could not bring the dataset into the cache, and these are the reasons. */
export class DatasetFetchError extends Error {
  readonly failures: readonly FetchFailure[];

  constructor(datasetName: string, failures: readonly FetchFailure[], closing: string) {
    super(
      [
        `could not bring ${datasetName} into the cache (${failures.length} problem${failures.length === 1 ? '' : 's'}):`,
        ...failures.map((failure) => `  ${failure.path} — ${failure.reason}`),
        closing,
      ].join('\n'),
    );
    this.name = 'DatasetFetchError';
    this.failures = failures;
  }
}

/** What the archive turned out to hold, reported whether or not it had to be unpacked. */
export interface ExtractionOutcome {
  readonly path: string;
  readonly state: 'unpacked' | 'already-unpacked';
  /** Where the entries really sit inside the archive, read from its own directory. */
  readonly root: ArchiveRoot;
  readonly entries: number;
}

export interface FetchDatasetResult {
  readonly cacheRoot: string;
  readonly downloads: string;
  readonly extracted: string;
  readonly files: readonly FileOutcome[];
  readonly extractions: readonly ExtractionOutcome[];
  /** The manifest edits `--record-checksums` produced. Empty without it. */
  readonly manifestChanges: readonly ManifestChecksumChange[];
}

export interface FetchDatasetOptions {
  /** The committed manifest by default; a test passes one pointed at its own origin. */
  readonly manifest?: DatasetManifest;
  /** Overrides for the ambient values the cache path is derived from. */
  readonly environment?: Partial<CacheEnvironment>;
  readonly log?: (line: string) => void;
  /**
   * Hash a freshly downloaded copy and write the result into `manifest.json` as a
   * reviewable change. Without it, a file the manifest records as unverified is refused.
   */
  readonly recordChecksums?: boolean;
  /** The manifest file a recorded checksum is written to. */
  readonly manifestPath?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  /** How often an interrupted transfer is picked up again, and how long it waits first. */
  readonly retry?: { readonly attempts?: number; readonly delayMs?: number };
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * The committed manifest, for a checkout where `--record-checksums` edits it.
 *
 * Resolved beside this module, so a package running from `dist/` would point at the copy
 * built there rather than at the source. Recording a checksum is a change to a source
 * checkout, so a caller that is not running from `src/` passes `manifestPath` itself.
 */
export const COMMITTED_MANIFEST_PATH = fileURLToPath(new URL('./manifest.json', import.meta.url));

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** Bytes as a person reads them, in the units the manifest and the README use. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const places = unit === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(places)} ${UNITS[unit] as string}`;
};

/**
 * A URL with everything a secret could hide in taken off it.
 *
 * A publisher's download link can carry a token in its query string, and this product keeps
 * secrets out of its output — so the log and every error message say where a request went
 * without saying what it carried.
 */
export const withoutSecrets = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[an unparseable URL]';
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A URL this command will fetch from.
 *
 * HTTPS, or plain HTTP to the loopback interface — which is how the tests serve a stub
 * origin from the test process without a certificate, and is the only case where there is
 * no network between the two ends to eavesdrop on.
 */
const checkUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL this command can fetch';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return `is served over ${parsed.protocol.replace(':', '')}, and a dataset is fetched over https (or http on loopback, for a test origin)`;
};

const fileSizeOf = async (path: string): Promise<number | null> => {
  try {
    const found = await stat(path);
    return found.isFile() ? found.size : null;
  } catch {
    return null;
  }
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Reports a file's progress at each whole percentage point, and never more often. */
const progressReporter = (
  file: ManifestFile,
  log: (line: string) => void,
): ((received: number) => void) => {
  let lastPercent = -1;
  return (received) => {
    const percent = file.sizeBytes === 0 ? 100 : Math.floor((received / file.sizeBytes) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    log(`  ${file.path}  ${formatBytes(received)} of ${formatBytes(file.sizeBytes)} (${percent}%)`);
  };
};

/** The network error's own code, which names the cause without naming the URL. */
const networkReason = (error: unknown): string => {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const code = (error as { code?: string } | undefined)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
};

/**
 * Waits, and stops waiting if the run is cancelled.
 *
 * The listener is removed whichever way the wait ends. A caller's signal outlives this
 * command, and one listener left behind per retry per file is a leak with a warning
 * attached.
 */
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
      });

interface DownloadContext {
  readonly fetchImpl: typeof globalThis.fetch;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal | undefined;
  readonly attempts: number;
  readonly delayMs: number;
}

interface TransferResult {
  readonly resumedFromBytes: number;
  readonly interruptions: number;
}

/** One request's worth of bytes, appended to the part file. Throws on anything unexpected. */
/** Beyond this many hops a redirect is a loop, not a location. */
const MOST_REDIRECTS = 5;

/**
 * One request, following redirects by hand.
 *
 * `fetch` follows them itself and applies no rule about the scheme it lands on, so a
 * publisher's HTTPS URL redirecting to a plain-HTTP storage host would pull 12.9 GB in
 * clear while the README said otherwise. Each hop is put through `checkUrl` before it is
 * followed, so the rule the manifest's own URL is held to holds all the way down.
 */
const request = async (
  context: DownloadContext,
  file: ManifestFile,
  headers: Record<string, string>,
): Promise<Response> => {
  let current = file.url;
  for (let hop = 0; hop <= MOST_REDIRECTS; hop += 1) {
    const response = await context.fetchImpl(current, {
      headers,
      redirect: 'manual',
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (location === null) {
      throw new Error(
        `${withoutSecrets(current)} answered ${response.status} with no location to follow`,
      );
    }
    const next = new URL(location, current).toString();
    const problem = checkUrl(next);
    if (problem !== null) {
      throw new Error(`${withoutSecrets(current)} redirects to a location that ${problem}`);
    }
    context.log(`  ${file.path}  following a redirect to ${withoutSecrets(next)}`);
    current = next;
  }
  throw new Error(
    `${withoutSecrets(file.url)} redirects more than ${MOST_REDIRECTS} times without serving anything`,
  );
};

const transferOnce = async (
  context: DownloadContext,
  file: ManifestFile,
  partPath: string,
  already: number,
  onBytes: (received: number) => void,
): Promise<void> => {
  const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {};
  const response = await request(context, file, headers);

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${withoutSecrets(file.url)} answered ${response.status} ${response.statusText}`.trim(),
    );
  }

  let from = already;
  if (already > 0) {
    if (response.status === 206) {
      const range = response.headers.get('content-range') ?? '';
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (match === null) {
        await response.body?.cancel();
        throw new Error(`the origin answered 206 with an unreadable Content-Range: ${range}`);
      }
      const start = Number(match[1]);
      const total = match[3] === '*' ? file.sizeBytes : Number(match[3]);
      if (start !== already) {
        await response.body?.cancel();
        throw new Error(`asked to resume at byte ${already} and the origin sent byte ${start}`);
      }
      if (total !== file.sizeBytes) {
        await response.body?.cancel();
        throw new Error(
          `the origin serves ${total} bytes where the manifest records ${file.sizeBytes}`,
        );
      }
    } else {
      // A 200 to a ranged request means the origin ignores ranges: the part file is of no
      // use and the transfer starts again rather than appending to the middle of a file.
      context.log(
        `  ${file.path}  the origin does not support resuming; starting again from the first byte`,
      );
      from = 0;
    }
  } else {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== file.sizeBytes) {
      await response.body?.cancel();
      throw new Error(
        `the origin serves ${Number(length)} bytes where the manifest records ${file.sizeBytes}`,
      );
    }
  }

  if (response.body === null) throw new Error('the origin answered with no body');

  let received = from;
  onBytes(received);

  // Written chunk by chunk rather than piped, so that a transfer cut off mid-file keeps
  // every byte that did arrive: a pipeline destroys its writable on the read error, and
  // whatever it was still holding would be lost — which is exactly the bytes the next
  // attempt is meant to resume after.
  const sink = createWriteStream(partPath, { flags: from > 0 ? 'a' : 'w' });
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const bytes = chunk as Buffer;
      received += bytes.length;
      onBytes(received);
      if (!sink.write(bytes)) await once(sink, 'drain');
    }
  } catch (error) {
    sink.end();
    await finished(sink).catch(() => undefined);
    throw error;
  }
  sink.end();
  await finished(sink);
};

/**
 * Fetches one file into the cache, picking an interrupted transfer up from the bytes
 * already written rather than starting over.
 */
const download = async (
  context: DownloadContext,
  file: ManifestFile,
  targetPath: string,
): Promise<TransferResult> => {
  const partPath = `${targetPath}.part`;
  await mkdir(dirname(targetPath), { recursive: true });

  let resumedFromBytes = 0;
  let interruptions = 0;
  const report = progressReporter(file, context.log);
  let lastError: unknown;
  let attempted = 0;

  for (let attempt = 1; attempt <= context.attempts; attempt += 1) {
    attempted = attempt;
    const onDisk = (await fileSizeOf(partPath)) ?? 0;
    let already = onDisk;
    if (onDisk > file.sizeBytes) {
      // A part file longer than the manifest's size belongs to something else: it goes, and
      // the transfer starts from the first byte rather than asking the origin to resume
      // past the end of a file that is no longer there.
      await rm(partPath, { force: true });
      already = 0;
    } else if (onDisk === file.sizeBytes && onDisk > 0) {
      await rename(partPath, targetPath);
      return { resumedFromBytes, interruptions };
    }

    const from = already;
    if (from > 0) {
      if (resumedFromBytes === 0) resumedFromBytes = from;
      context.log(
        `  ${file.path}  resuming at ${formatBytes(from)} of ${formatBytes(file.sizeBytes)}`,
      );
    }

    try {
      await transferOnce(context, file, partPath, from, report);
      const written = (await fileSizeOf(partPath)) ?? 0;
      if (written !== file.sizeBytes) {
        throw new Error(`the transfer ended after ${written} of ${file.sizeBytes} bytes`);
      }
      await rename(partPath, targetPath);
      return { resumedFromBytes, interruptions };
    } catch (error) {
      lastError = error;
      interruptions += 1;
      if (context.signal?.aborted === true) {
        throw new Error(`the transfer of ${file.path} was cancelled`);
      }
      if (attempt < context.attempts) {
        context.log(
          `  ${file.path}  the transfer stopped (${networkReason(error)}); picking it up again`,
        );
        await delay(context.delayMs, context.signal);
      }
    }
  }

  throw new Error(
    `could not fetch ${withoutSecrets(file.url)} after ${attempted} attempt${attempted === 1 ? '' : 's'}: ${networkReason(lastError)}`,
  );
};

/** What obtaining one file established, including the hash its bytes really have. */
interface ObtainedFile {
  readonly outcome: FileOutcome;
  /** Set when the hash was computed here and the manifest could record it. */
  readonly recordable: RecordedChecksum | null;
}

interface FileContext extends DownloadContext {
  readonly quarantine: string;
  readonly recordChecksums: boolean;
  readonly now: () => Date;
}

const obtainFile = async (
  context: FileContext,
  file: ManifestFile,
  targetPath: string,
): Promise<ObtainedFile> => {
  const recorded = recordedChecksum(file);
  const present = await fileSizeOf(targetPath);
  let transfer: TransferResult = { resumedFromBytes: 0, interruptions: 0 };
  let state: FileOutcome['state'] = 'already-present';

  if (present !== null && present !== file.sizeBytes) {
    const moved = await quarantineFile(targetPath, context.quarantine, file.path, context.now());
    throw new Error(
      `the copy in the cache is ${present} bytes where the manifest records ${file.sizeBytes}; it has been moved to ${moved} and a second run will fetch it again`,
    );
  }

  if (present === null) {
    context.log(
      `  ${file.path}  fetching ${formatBytes(file.sizeBytes)} from ${withoutSecrets(file.url)}`,
    );
    transfer = await download(context, file, targetPath);
    state = 'downloaded';
  } else if (recorded !== null && !context.recordChecksums) {
    const receipt = await readReceipt(targetPath);
    if (
      receipt !== null &&
      receipt.algorithm === recorded.algorithm &&
      receipt.value === recorded.value
    ) {
      context.log(
        `  ${file.path}  already present and verified (${receipt.algorithm} ${receipt.value}, checked on ${receipt.verifiedOn})`,
      );
      return {
        outcome: {
          path: file.path,
          state: 'already-present',
          sizeBytes: file.sizeBytes,
          resumedFromBytes: 0,
          interruptions: 0,
          checksum: { algorithm: receipt.algorithm, value: receipt.value },
          verifiedAgainstManifest: true,
        },
        recordable: null,
      };
    }
  }

  const verdict = await verifyFile(targetPath, file.checksum);
  if (verdict.state === 'mismatch') {
    const moved = await quarantineFile(targetPath, context.quarantine, file.path, context.now());
    throw new Error(
      `the bytes do not match the checksum the manifest records: expected ${verdict.algorithm} ${verdict.expected}, the download hashes to ${verdict.actual}. The file has been moved to ${moved} and a second run will fetch it again`,
    );
  }

  const onDisk = await stat(targetPath);
  await writeReceipt(targetPath, {
    algorithm: verdict.algorithm,
    value: verdict.value,
    sizeBytes: onDisk.size,
    mtimeMs: onDisk.mtimeMs,
    verifiedOn: context.now().toISOString().slice(0, 10),
  });

  if (verdict.state === 'verified') {
    context.log(`  ${file.path}  verified (${verdict.algorithm} ${verdict.value})`);
  } else {
    context.log(
      `  ${file.path}  the manifest records no checksum for this file (${verdict.reason}); its bytes hash to ${verdict.algorithm} ${verdict.value}, and the manifest change below records that — review it before trusting this copy`,
    );
  }

  const note =
    verdict.state === 'verified'
      ? "Computed from a local copy of the file and equal to the checksum the publisher's record states."
      : 'Computed from a local copy of the file. Nothing has compared it with a checksum from the publisher.';

  return {
    outcome: {
      path: file.path,
      state,
      sizeBytes: file.sizeBytes,
      resumedFromBytes: transfer.resumedFromBytes,
      interruptions: transfer.interruptions,
      checksum: { algorithm: verdict.algorithm, value: verdict.value },
      verifiedAgainstManifest: verdict.state === 'verified',
    },
    recordable: localChecksum(verdict.algorithm, verdict.value, context.now(), note),
  };
};

/** Where the entries sit, as one line a person can copy into the manifest. */
const describeResolvedRoot = (root: ArchiveRoot): string =>
  root.state === 'directory'
    ? `under \`${root.path}/\`, which this unpacking strips`
    : 'at the archive root';

interface ExtractionContext {
  readonly log: (line: string) => void;
  readonly extracted: string;
  readonly staging: string;
  readonly manifest: DatasetManifest;
}

/** Something went wrong unpacking one named archive. */
class UnpackError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = 'UnpackError';
    this.filePath = filePath;
  }
}

/** One archive of the manifest, with the bytes that verified. */
interface ArchiveToUnpack {
  readonly file: ManifestFile;
  readonly targetPath: string;
  readonly checksumValue: string;
}

/** An archive of twenty thousand images takes a while; this says how far along it is. */
const SILENT_BELOW_ENTRIES = 200;
const PROGRESS_EVERY_PERCENT = 10;

const unpackingProgress = (
  file: ManifestFile,
  total: number,
  log: (line: string) => void,
): ((entry: ArchiveEntry, done: number) => void) | undefined => {
  if (total < SILENT_BELOW_ENTRIES) return undefined;
  let lastReported = 0;
  return (_entry, done) => {
    const percent = Math.floor((done / total) * 100);
    if (percent < lastReported + PROGRESS_EVERY_PERCENT) return;
    lastReported = percent;
    log(`  ${file.path}  unpacked ${done} of ${total} entries (${percent}%)`);
  };
};

/** What the receipt beside an unpacked archive records. */
interface ExtractionReceipt {
  readonly checksum: string;
  readonly root: ArchiveRoot;
  readonly entries: number;
}

const asExtractionReceipt = (value: unknown): ExtractionReceipt | null => {
  if (typeof value !== 'object' || value === null) return null;
  const receipt = value as Partial<ExtractionReceipt>;
  if (typeof receipt.checksum !== 'string' || typeof receipt.entries !== 'number') return null;
  if (typeof receipt.root !== 'object' || receipt.root === null) return null;
  return receipt as ExtractionReceipt;
};

/**
 * Puts a finished tree where the dataset lives, in one move.
 *
 * The tree it replaces goes aside first and is removed afterwards, so `dataset/` is never
 * half of one unpacking and half of another — and if the move fails, what was there is put
 * back. Merging the new tree into the old one directory at a time was the alternative, and
 * it both fails outright when a directory already exists and leaves a mixture behind when
 * it fails part-way.
 */
const swapIntoPlace = async (staging: string, extracted: string): Promise<void> => {
  const superseded = `${extracted}.superseded`;
  await rm(superseded, { recursive: true, force: true });
  await mkdir(dirname(extracted), { recursive: true });

  const replacing = await directoryExists(extracted);
  if (replacing) await rename(extracted, superseded);
  try {
    await rename(staging, extracted);
  } catch (error) {
    if (replacing) await rename(superseded, extracted);
    throw error;
  }
  await rm(superseded, { recursive: true, force: true });
};

const layoutDifference = (comparison: LayoutComparison): string =>
  [
    `the archive's layout is not the one the manifest declares, so nothing was unpacked:`,
    ...comparison.differences.map((difference) => `      - ${difference}`),
    `      the entries sit ${describeResolvedRoot(comparison.root)}; correct \`layout\` in the manifest and run this again`,
  ].join('\n');

/**
 * Unpacks every archive the manifest lists into the cache.
 *
 * All of them together, into one staging tree that replaces `dataset/` in a single move:
 * the dataset is one tree however many archives it arrives in, so it is replaced as one.
 * An archive already unpacked is re-unpacked when any of its siblings is not, because the
 * tree they share is being rebuilt — with the one archive this manifest declares, that
 * never arises, and with more it is the only answer that cannot leave a mixture behind.
 *
 * Nothing is written until every archive's directory has been read and compared with the
 * declared layout, so an archive that contradicts the manifest leaves the cache untouched.
 */
const unpackAll = async (
  context: ExtractionContext,
  archives: readonly ArchiveToUnpack[],
): Promise<readonly ExtractionOutcome[]> => {
  const receipts = await Promise.all(
    archives.map(async ({ targetPath }) =>
      asExtractionReceipt(await readReceiptFile(targetPath, 'extracted')),
    ),
  );
  const upToDate =
    (await directoryExists(context.extracted)) &&
    receipts.every((receipt, position) => receipt?.checksum === archives[position]?.checksumValue);

  if (upToDate) {
    return archives.map(({ file }, position) => {
      const receipt = receipts[position] as ExtractionReceipt;
      context.log(`  ${file.path}  already unpacked into ${context.extracted}`);
      return {
        path: file.path,
        state: 'already-unpacked',
        root: receipt.root,
        entries: receipt.entries,
      };
    });
  }

  const read = [];
  for (const archive of archives) {
    try {
      const entries = await readArchiveDirectory(archive.targetPath);
      const comparison = compareArchiveLayout(context.manifest.layout, entries);
      if (comparison.differences.length > 0) {
        throw new Error(layoutDifference(comparison));
      }
      context.log(
        `  ${archive.file.path}  ${entries.length} entries, ${describeResolvedRoot(comparison.root)}`,
      );
      read.push({ archive, entries, root: comparison.root });
    } catch (error) {
      throw new UnpackError(archive.file.path, (error as Error).message);
    }
  }

  await rm(context.staging, { recursive: true, force: true });
  try {
    for (const { archive, entries, root } of read) {
      try {
        await extractArchive({
          archivePath: archive.targetPath,
          entries,
          into: context.staging,
          ...(root.state === 'directory' ? { stripPrefix: root.path } : {}),
          onEntry: unpackingProgress(archive.file, entries.length, context.log),
        });
      } catch (error) {
        throw new UnpackError(archive.file.path, (error as Error).message);
      }
    }
    await swapIntoPlace(context.staging, context.extracted);
  } finally {
    await rm(context.staging, { recursive: true, force: true });
  }

  const outcomes: ExtractionOutcome[] = [];
  for (const { archive, entries, root } of read) {
    await writeReceipt(
      archive.targetPath,
      { checksum: archive.checksumValue, root, entries: entries.length },
      'extracted',
    );
    context.log(`  ${archive.file.path}  unpacked into ${context.extracted}`);
    outcomes.push({
      path: archive.file.path,
      state: 'unpacked',
      root,
      entries: entries.length,
    });
  }
  return outcomes;
};

const licencePreamble = (manifest: DatasetManifest, cacheRoot: string): readonly string[] => {
  const { dataset } = manifest;
  const total = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return [
    `${dataset.name} — ${dataset.title}`,
    `  ${dataset.source.recordUrl} (${dataset.source.host}, no account, no credential, no payment)`,
    `  Licence: ${dataset.licence.name} (${dataset.licence.spdxId}) — ${dataset.licence.url}`,
    '  Downloading it is accepting that licence. It requires:',
    ...dataset.licence.requires.map((line) => `    - ${line}`),
    '  And it does not permit:',
    ...dataset.licence.forbids.map((line) => `    - ${line}`),
    `  Credit to carry with any published figure: ${dataset.licence.attribution}`,
    `  ${formatBytes(total)} will be written to ${cacheRoot}, and nothing into this repository.`,
  ];
};

/**
 * Brings the dataset the manifest describes into the cache: fetch, verify, unpack.
 *
 * Resolves with what it did, and rejects with a `DatasetFetchError` naming every file it
 * could not fetch — which is how the command exits non-zero. Nothing is unpacked unless
 * every file verified, so a failed run leaves the cache with its partial downloads and no
 * half-extracted tree.
 */
export const fetchDataset = async (
  options: FetchDatasetOptions = {},
): Promise<FetchDatasetResult> => {
  const manifest = options.manifest ?? loadManifest();
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const recordChecksums = options.recordChecksums ?? false;
  const paths = datasetCachePaths(manifest.dataset.id, options.environment ?? {});
  const staging = join(paths.root, STAGING_DIRECTORY);

  const context: FileContext = {
    fetchImpl: options.fetch ?? globalThis.fetch,
    log,
    signal: options.signal,
    attempts: Math.max(1, options.retry?.attempts ?? DEFAULT_ATTEMPTS),
    delayMs: options.retry?.delayMs ?? DEFAULT_RETRY_DELAY_MS,
    quarantine: paths.quarantine,
    recordChecksums,
    now,
  };

  for (const line of licencePreamble(manifest, paths.root)) log(line);

  const refused: FetchFailure[] = [];
  for (const file of manifest.files) {
    const urlProblem = checkUrl(file.url);
    if (urlProblem !== null) {
      refused.push({ path: file.path, reason: `its download location ${urlProblem}` });
    }
    if (file.checksum.state === 'unverified' && !recordChecksums) {
      refused.push({
        path: file.path,
        reason: `the manifest records no checksum for it (${file.checksum.reason}), so a download cannot be verified. Run this again with --record-checksums to hash a fresh copy and write the result into the manifest as a reviewable change`,
      });
    }
  }
  if (refused.length > 0) {
    throw new DatasetFetchError(manifest.dataset.name, refused, 'Nothing was fetched.');
  }

  log(`Fetching ${manifest.files.length} file${manifest.files.length === 1 ? '' : 's'}:`);

  const obtained: ObtainedFile[] = [];
  const failures: FetchFailure[] = [];
  for (const file of manifest.files) {
    if (options.signal?.aborted === true) {
      failures.push({ path: file.path, reason: 'the run was cancelled before this file' });
      continue;
    }
    try {
      obtained.push(await obtainFile(context, file, paths.download(file.path)));
    } catch (error) {
      failures.push({
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new DatasetFetchError(
      manifest.dataset.name,
      failures,
      `Nothing was unpacked and ${paths.extracted} is unchanged; a part-downloaded file is kept so that a second run resumes rather than starting over.`,
    );
  }

  const manifestChanges: ManifestChecksumChange[] = [];
  if (recordChecksums) {
    const manifestPath = options.manifestPath ?? COMMITTED_MANIFEST_PATH;
    for (const [index, file] of manifest.files.entries()) {
      const entry = obtained[index];
      if (entry?.recordable == null) continue;
      const recorded = recordedChecksum(file);
      if (
        recorded !== null &&
        recorded.source === 'local-download' &&
        recorded.value === entry.recordable.value
      ) {
        log(
          `  ${file.path}  its checksum is already recorded from a local copy; nothing to change`,
        );
        continue;
      }
      manifestChanges.push(
        await recordChecksum({
          manifestPath,
          filePath: file.path,
          checksum: entry.recordable,
        }),
      );
    }

    for (const change of manifestChanges) {
      log(
        change.written
          ? `Recorded the checksum of ${change.filePath} in ${manifestPath}; commit this change:`
          : `Did not write ${manifestPath}: ${change.notWrittenBecause ?? 'unknown reason'}. The change is:`,
      );
      for (const line of change.diff) log(`  ${line}`);
    }
  }

  const archives: ArchiveToUnpack[] = [];
  for (const [index, file] of manifest.files.entries()) {
    const entry = obtained[index];
    if (file.archive === null || entry === undefined) continue;
    archives.push({
      file,
      targetPath: paths.download(file.path),
      checksumValue: entry.outcome.checksum.value,
    });
  }

  let extractions: readonly ExtractionOutcome[] = [];
  if (archives.length > 0) {
    log('Unpacking:');
    try {
      extractions = await unpackAll(
        { log, extracted: paths.extracted, staging, manifest },
        archives,
      );
    } catch (error) {
      const failure =
        error instanceof UnpackError
          ? { path: error.filePath, reason: error.message }
          : { path: manifest.dataset.id, reason: (error as Error).message };
      throw new DatasetFetchError(
        manifest.dataset.name,
        [failure],
        `${paths.extracted} is unchanged: the archives are unpacked into ${staging} and moved into place in one step, once the tree is whole.`,
      );
    }
  }

  const downloaded = obtained.filter(({ outcome }) => outcome.state === 'downloaded');
  const count = manifest.files.length;
  log(
    downloaded.length === 0 && extractions.every((entry) => entry.state === 'already-unpacked')
      ? `Nothing to do: ${count === 1 ? 'the file is' : `all ${count} files are`} already present, verified and unpacked in ${paths.root}.`
      : `${manifest.dataset.name} is in ${paths.extracted}.`,
  );

  return {
    cacheRoot: paths.root,
    downloads: paths.downloads,
    extracted: paths.extracted,
    files: obtained.map(({ outcome }) => outcome),
    extractions,
    manifestChanges,
  };
};
