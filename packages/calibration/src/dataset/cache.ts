/**
 * Where the downloaded dataset lives: outside the repository, under the OS cache directory,
 * overridable by one environment variable.
 *
 * The raw download is 12.9 GB and licensed to the authors' terms, so it is never committed
 * (`packages/calibration/README.md` says why). These helpers are the only place its location
 * is decided, and they are **pure path arithmetic**: nothing here creates a directory, reads
 * a file or opens a socket. The platform, the environment and the home directory are read
 * once per call from the process and can be passed in instead, which is how the tests check
 * macOS, Linux and Windows from one machine.
 */

import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

/** The one documented override. Its value is the cache root, used exactly as given. */
export const CACHE_ENV_VAR = 'PERSONAVISION_CALIBRATION_CACHE';

const VENDOR_DIRECTORY = 'personavision';
const PACKAGE_DIRECTORY = 'calibration';
/** Archives as fetched from the publisher. */
const DOWNLOADS_DIRECTORY = 'downloads';
/** The unpacked dataset tree, in the layout the manifest describes. */
const EXTRACTED_DIRECTORY = 'dataset';
/** Where a file that failed its checksum is moved, so it is never silently reused (#85). */
const QUARANTINE_DIRECTORY = 'quarantine';

/** A dataset's directory name: lower-case letters, digits and hyphens, one segment. */
const DATASET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The ambient values the cache location is derived from. */
export interface CacheEnvironment {
  /** As `process.platform` spells it: `darwin`, `linux`, `win32` … */
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory, or `''` when there is none to be had. */
  readonly homeDir: string;
  /** The last resort when there is no home directory — still outside the repository. */
  readonly tmpDir: string;
}

/** A path that would land outside the cache, or a name that cannot be a directory. */
export class CachePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CachePathError';
  }
}

/**
 * Whether a path can be joined onto a cache directory without leaving it.
 *
 * Forward slashes only, no empty, `.` or `..` segment, and not absolute on any platform —
 * so a manifest entry or an archive member cannot write outside the cache, whichever
 * machine unpacks it.
 */
export const isContainedRelativePath = (value: string): boolean => {
  if (value === '' || value.includes('\\')) return false;
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

const platformPath = (platform: string): typeof posix => (platform === 'win32' ? win32 : posix);

const processEnvironment = (): CacheEnvironment => {
  let home = '';
  try {
    home = homedir();
  } catch {
    // No home directory to be had: the temporary directory is the documented fallback.
  }
  return { platform: process.platform, env: process.env, homeDir: home, tmpDir: tmpdir() };
};

const absoluteFrom = (value: string | undefined, platform: string): string | null => {
  const path = platformPath(platform);
  if (value === undefined || value.trim() === '' || !path.isAbsolute(value)) return null;
  return path.normalize(value);
};

/** The OS's own cache directory, by each platform's convention. */
const osCacheDirectory = ({ platform, env, homeDir, tmpDir }: CacheEnvironment): string => {
  const path = platformPath(platform);

  if (platform === 'win32') {
    return (
      absoluteFrom(env.LOCALAPPDATA, platform) ??
      (homeDir === '' ? tmpDir : path.join(homeDir, 'AppData', 'Local'))
    );
  }
  if (platform === 'darwin') {
    return homeDir === '' ? tmpDir : path.join(homeDir, 'Library', 'Caches');
  }
  // The XDG base directory specification: a relative XDG_CACHE_HOME is to be ignored.
  return (
    absoluteFrom(env.XDG_CACHE_HOME, platform) ??
    (homeDir === '' ? tmpDir : path.join(homeDir, '.cache'))
  );
};

/**
 * The directory every dataset of this package is cached under.
 *
 * `PERSONAVISION_CALIBRATION_CACHE` replaces it when set, and must be absolute: resolving a
 * relative value against the working directory would put 12.9 GB wherever a command happened
 * to be run from, and inside the repository if that was the repository.
 */
export const cacheRoot = (environment: Partial<CacheEnvironment> = {}): string => {
  const resolved: CacheEnvironment = { ...processEnvironment(), ...environment };
  const path = platformPath(resolved.platform);
  const override = resolved.env[CACHE_ENV_VAR];

  if (override !== undefined && override.trim() !== '') {
    const absolute = absoluteFrom(override, resolved.platform);
    if (absolute === null) {
      throw new CachePathError(
        `${CACHE_ENV_VAR} must be an absolute path, found ${JSON.stringify(override)}: a relative cache root would put the dataset wherever the command was run from`,
      );
    }
    return absolute;
  }

  return path.join(osCacheDirectory(resolved), VENDOR_DIRECTORY, PACKAGE_DIRECTORY);
};

/** Every path one dataset's cache is made of. */
export interface DatasetCachePaths {
  /** The dataset's own directory. */
  readonly root: string;
  /** Archives as fetched. */
  readonly downloads: string;
  /** The unpacked tree. */
  readonly extracted: string;
  /** Where a file that failed its checksum is moved. */
  readonly quarantine: string;
  /** A manifest file's place in `downloads`, by the path the manifest gives it. */
  download(filePath: string): string;
  /** A file's place in the unpacked tree, by its path in the archive's layout. */
  extractedFile(filePath: string): string;
}

/**
 * Where one dataset is cached. `datasetId` is the manifest's `dataset.id` — one directory
 * name, so a manifest cannot send the cache somewhere else.
 */
export const datasetCachePaths = (
  datasetId: string,
  environment: Partial<CacheEnvironment> = {},
): DatasetCachePaths => {
  if (!DATASET_ID.test(datasetId)) {
    throw new CachePathError(
      `a dataset id is one directory name of lower-case letters, digits and hyphens, found ${JSON.stringify(datasetId)}`,
    );
  }

  const resolved: CacheEnvironment = { ...processEnvironment(), ...environment };
  const path = platformPath(resolved.platform);
  const root = path.join(cacheRoot(resolved), datasetId);
  const downloads = path.join(root, DOWNLOADS_DIRECTORY);
  const extracted = path.join(root, EXTRACTED_DIRECTORY);

  const within = (base: string, filePath: string, what: string): string => {
    if (!isContainedRelativePath(filePath)) {
      throw new CachePathError(
        `${JSON.stringify(filePath)} cannot be a ${what} path: it must be relative, use forward slashes and stay inside the cache`,
      );
    }
    return path.join(base, ...filePath.split('/'));
  };

  return {
    root,
    downloads,
    extracted,
    quarantine: path.join(root, QUARANTINE_DIRECTORY),
    download: (filePath) => within(downloads, filePath, 'download'),
    extractedFile: (filePath) => within(extracted, filePath, 'dataset'),
  };
};
