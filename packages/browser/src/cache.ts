/**
 * Content-addressed capture caching, inside the run directory.
 *
 * Twelve sessions over the same variant see the same screen twelve times, and a screen is a
 * full-page screenshot: without a cache that is twelve identical PNGs and twelve
 * extractions. The key is built by the caller from the variant URL, the step, the device
 * and the page's content hash (`captureCacheKey` in `capture.ts`), so two pages that differ
 * by a single byte of markup are two captures and the same page at two devices is two more.
 *
 * **It lives in the run directory.** One entry per key under `.capture-cache/`, so the
 * cache travels with the run it belongs to, a fresh run starts cold, and nothing is written
 * anywhere else. The directory is dotted because it is not artifact data: `run.json`
 * records no path into it, the viewer never fetches it, and only this file reads it. For
 * the same reason it is the one run-directory path not spelt by the contract's `runPaths` —
 * those are the paths a run *publishes*, over HTTP as well as on disk, and this one is
 * private to this module and local to a file system.
 *
 * **A hit is indistinguishable from a miss** except in speed and in the number of files on
 * disk. The stored value is the whole `Capture` the work produced — its geometry, its
 * element ids and the path of the screenshot the first capture wrote — so a hit returns
 * that same screenshot path rather than taking a second picture of the same screen.
 *
 * **Nothing the cache does can fail a session.** An entry that is truncated, half-written,
 * from an older format or hashed onto another key's file is a miss; a run directory that
 * cannot be written to is a capture that is merely slow next time. Losing a cache entry
 * costs one screenshot. Reading one wrong, or throwing out of a lookup, would cost the run.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where the cache lives inside the run directory. */
const CACHE_DIR = '.capture-cache';

const ENTRY_EXTENSION = '.json';

/**
 * The entry format on disk. A reader that does not recognise the version it finds has a
 * miss, so the shape can change without a run's leftovers being read as the new one.
 */
const ENTRY_VERSION = 1;

interface CacheEntry<T> {
  version: number;
  /** The key this entry answers, written down so that a hit can be checked against it. */
  key: string;
  value: T;
}

export interface CaptureCacheOptions {
  /**
   * The run directory the cache lives in. Without one there is nowhere for it to be, so
   * every lookup is a miss and the work simply runs — correct, and merely repeated.
   */
  readonly runDir?: string;
}

/**
 * The file one key is stored in: the key's digest, because a key holds a URL and a URL is
 * not a file name.
 */
const entryFile = (runDir: string, key: string): string => {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  return join(runDir, CACHE_DIR, `${digest}${ENTRY_EXTENSION}`);
};

/**
 * The value stored for `key`, wrapped so that a stored `null` is a hit and an unreadable
 * entry is not.
 *
 * The key is compared and not assumed: a file is addressed by a digest of the key, and an
 * entry that names a different one — a digest collision, or a file somebody else left
 * there — is a miss rather than another screen's capture served as this one's.
 */
const readEntry = async <T>(file: string, key: string): Promise<{ value: T } | null> => {
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch {
    // The ordinary cold case: this screen has not been captured in this run yet.
    return null;
  }

  try {
    const entry: unknown = JSON.parse(body);
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = entry as Partial<CacheEntry<T>>;
    if (candidate.version !== ENTRY_VERSION || candidate.key !== key) return null;
    // A value JSON could not carry was dropped by `JSON.stringify` rather than stored, so
    // an entry without one has nothing to return.
    if (!('value' in candidate)) return null;
    return { value: candidate.value as T };
  } catch {
    // Truncated or not JSON at all: a half-written entry from a session that died.
    return null;
  }
};

/**
 * Stores `value` for `key`.
 *
 * Written beside the entry and renamed over it — `platform`'s file store does the same —
 * so a crash mid-write, or two sessions finishing the same screen at once, leaves one whole
 * entry rather than half of one.
 */
const writeEntry = async <T>(file: string, key: string, value: T): Promise<void> => {
  const body = JSON.stringify({ version: ENTRY_VERSION, key, value } satisfies CacheEntry<T>);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}${ENTRY_EXTENSION}.tmp`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, file);
};

/**
 * Runs `fn` unless this key has already been answered in this run directory, in which case
 * it returns what it answered then.
 *
 * The value has to be JSON data, because the cache outlives the process that filled it: a
 * hit returns a value equal to the first one, not the same object. Captures are JSON data —
 * that is what `run.json` is made of.
 */
export const withCache = async <T>(
  key: string,
  fn: () => Promise<T>,
  options: CaptureCacheOptions = {},
): Promise<T> => {
  const runDir = options.runDir ?? '';
  if (runDir === '') return fn();

  const file = entryFile(runDir, key);
  const hit = await readEntry<T>(file, key);
  if (hit !== null) return hit.value;

  const value = await fn();
  try {
    await writeEntry(file, key, value);
  } catch {
    // An unwritable run directory, a full disk, a value JSON cannot serialise: the next
    // capture of this screen is slow, and this one still has its answer.
  }
  return value;
};
