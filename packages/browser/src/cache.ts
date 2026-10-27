/**
 * Content-addressed capture caching, inside the run directory.
 *
 * Twelve sessions over the same variant see the same screen twelve times, and a screen is a
 * full-page screenshot: without a cache that is twelve identical PNGs and twelve
 * extractions. The key is built by the caller from the variant URL, the step, the device
 * and the page's content hash (`captureCacheKey` in `capture.ts`), so two pages that differ
 * by a single byte of markup are two captures and the same page at two devices is two more.
 *
 * **One entry per screen, holding the key it was captured under.** A capture writes one
 * image per screen of one variant — `screenshots/<variant>/<step>.png` — and not one per
 * device or per content hash, so a cache that kept an entry per key would answer a session
 * with a capture whose picture something else has since overwritten. The entry therefore
 * lives at the screen and is a hit only when the key in it is the key being looked up:
 * whatever rewrites the image rewrites the entry beside it. `CaptureCacheOptions.screen`
 * says what that is worth.
 *
 * **It lives in the run directory.** One entry under `.capture-cache/`, so the cache travels
 * with the run it belongs to, a fresh run starts cold, and nothing is written anywhere else.
 * The directory is dotted because it is not artifact data: `run.json` records no path into
 * it, nothing in the viewer asks for a path inside it, and `cache.ts` is its only reader. It
 * is for the same reason the one path inside a run directory the contract does not spell —
 * `runPaths` declares what a run publishes, and this is the module's own working state. The
 * static mount in `packages/cli` serves any file inside a run directory, so an entry is
 * fetchable by a client that knows to ask; what it holds is the capture the artifact's own
 * `aois` are projected from, so that exposes nothing `run.json` does not.
 *
 * **A hit is indistinguishable from a miss** except in speed and in the number of files on
 * disk. The stored value is the whole `Capture` the work produced — its geometry, its
 * element ids and the path of the screenshot the first capture wrote — so a hit returns
 * that same screenshot path rather than taking a second picture of the same screen. Sessions
 * that reach one screen at the same moment all miss and all capture it: this is a cache over
 * a directory, not a lock over a screen.
 *
 * **Nothing the cache does can fail a session.** An entry that is truncated, half-written,
 * from an older format or hashed onto another screen's file is a miss; a run directory that
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
  /** The key this entry answers. Compared on the way out, so a screen that changed misses. */
  key: string;
  value: T;
}

export interface CaptureCacheOptions {
  /**
   * The run directory the cache lives in. Without one there is nowhere for it to be, so
   * every lookup is a miss and the work simply runs — correct, and merely repeated.
   */
  readonly runDir?: string;
  /**
   * What the work writes, named however the caller names it: the cache keeps **one entry
   * per name**, so a hit can only ever be the last thing written there.
   *
   * A capture's name is its screen, because `screenshots/<variant>/<step>.png` is one image
   * per screen of one variant. A swarm sends mobile and desktop sessions over that one
   * screen, and the second device's picture overwrites the first's. An entry per key would
   * then answer the third session — desktop again — with the first session's geometry and
   * element boxes while the image at the path it names is the mobile render, which is the
   * one thing `run-projection.ts` says must not happen: the last capture of a screen is the
   * one `run.json` records, because it is the one on disk. An entry per screen cannot do
   * that, because the entry and the image are written by the same work. Captures of a screen
   * that has not changed still hit, which is what the cache is for.
   *
   * Defaults to the key, which is right for work that writes nothing it shares.
   */
  readonly screen?: string;
}

/**
 * The file one screen's entry is stored in: a digest of its name, because a name holds a
 * URL or a path and neither is a file name.
 */
const entryFile = (runDir: string, screen: string): string => {
  const digest = createHash('sha256').update(screen, 'utf8').digest('hex');
  return join(runDir, CACHE_DIR, `${digest}${ENTRY_EXTENSION}`);
};

/**
 * The value stored for `key`, wrapped so that a stored `null` is a hit and an unreadable
 * entry is not.
 *
 * The key is compared and not assumed. It is what makes this cache content-addressed —
 * a screen captured at different content is a different key and a miss — and it is also
 * what keeps a digest collision, or a file somebody else left there, from being served as
 * this screen's capture.
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
 * Stores `value` for `key`, as this screen's one entry.
 *
 * Written beside the entry and renamed over it — `platform`'s file store does the same —
 * so a crash mid-write, or two sessions finishing the same screen at once, leaves one whole
 * entry rather than half of one. A process killed between the two leaves its `.tmp` file
 * behind; nothing reads one, the next capture of the screen still renames over the entry,
 * and the run directory it sits in is the run's to throw away.
 */
const writeEntry = async <T>(file: string, key: string, value: T): Promise<void> => {
  const body = JSON.stringify({ version: ENTRY_VERSION, key, value } satisfies CacheEntry<T>);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, file);
};

/**
 * Runs `fn` unless this screen's entry already answers this key, in which case it returns
 * what it answered then.
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

  const file = entryFile(runDir, options.screen ?? key);
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
