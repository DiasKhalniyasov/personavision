import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CACHE_ENV_VAR,
  CachePathError,
  cacheRoot,
  datasetCachePaths,
  isContainedRelativePath,
  isDatasetId,
} from '../src/dataset/cache.js';
import { loadManifest } from '../src/dataset/manifest.js';

/** The repository root, three directories above `packages/calibration/test`. */
const repositoryRoot = (): string => fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Whether a path the helpers returned lands outside the repository.
 *
 * Judged with the separators of the platform asked about, so a Windows path checked from a
 * macOS test runner is not resolved against the working directory and read as in-repo.
 */
const landsOutsideRepository = (path: string, platform: string): boolean => {
  const platformPath = platform === 'win32' ? win32 : posix;
  if (!platformPath.isAbsolute(path)) return false;
  const root = repositoryRoot().replace(/\/$/, '');
  return path !== root && !path.startsWith(root + platformPath.sep);
};

describe('the cache root', () => {
  it('is the OS cache directory on macOS', () => {
    expect(cacheRoot({ platform: 'darwin', homeDir: '/Users/dev', env: {} })).toBe(
      '/Users/dev/Library/Caches/personavision/calibration',
    );
  });

  it('honours XDG_CACHE_HOME on Linux, and falls back to ~/.cache without it', () => {
    expect(
      cacheRoot({
        platform: 'linux',
        homeDir: '/home/dev',
        env: { XDG_CACHE_HOME: '/var/cache/x' },
      }),
    ).toBe('/var/cache/x/personavision/calibration');

    expect(cacheRoot({ platform: 'linux', homeDir: '/home/dev', env: {} })).toBe(
      '/home/dev/.cache/personavision/calibration',
    );
  });

  it('ignores a relative XDG_CACHE_HOME, as the specification says to', () => {
    expect(
      cacheRoot({ platform: 'linux', homeDir: '/home/dev', env: { XDG_CACHE_HOME: 'cache' } }),
    ).toBe('/home/dev/.cache/personavision/calibration');
  });

  it('is LOCALAPPDATA on Windows, and the conventional path below the home without it', () => {
    expect(
      cacheRoot({
        platform: 'win32',
        homeDir: 'C:\\Users\\dev',
        env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\dev\\AppData\\Local\\personavision\\calibration');

    expect(cacheRoot({ platform: 'win32', homeDir: 'C:\\Users\\dev', env: {} })).toBe(
      'C:\\Users\\dev\\AppData\\Local\\personavision\\calibration',
    );
  });

  it('is the one documented environment variable when that is set, verbatim', () => {
    const root = cacheRoot({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: { [CACHE_ENV_VAR]: '/mnt/datasets/personavision' },
    });

    expect(CACHE_ENV_VAR).toBe('PERSONAVISION_CALIBRATION_CACHE');
    expect(root).toBe('/mnt/datasets/personavision');
  });

  it('prefers that variable over XDG_CACHE_HOME', () => {
    expect(
      cacheRoot({
        platform: 'linux',
        homeDir: '/home/dev',
        env: { XDG_CACHE_HOME: '/var/cache/x', [CACHE_ENV_VAR]: '/mnt/datasets' },
      }),
    ).toBe('/mnt/datasets');
  });

  it('refuses a relative override, naming the variable, rather than resolving it silently', () => {
    const resolveRelative = (): string =>
      cacheRoot({
        platform: 'linux',
        homeDir: '/home/dev',
        env: { [CACHE_ENV_VAR]: 'ueyes-cache' },
      });

    expect(resolveRelative).toThrow(CachePathError);
    expect(resolveRelative).toThrow(CACHE_ENV_VAR);
  });

  it('refuses a climbing override rather than normalising the typo away', () => {
    // `/mnt/data/../..` normalises to `/`, which would retarget 12.9 GB at a system
    // directory without a word. The variable is documented as used exactly as given.
    const climb = (): string =>
      cacheRoot({
        platform: 'linux',
        homeDir: '/home/dev',
        env: { [CACHE_ENV_VAR]: '/mnt/data/../..' },
      });

    expect(climb).toThrow(CachePathError);
    expect(climb).toThrow('..');
  });

  it('treats an explicitly undefined field as not overridden, rather than crashing on it', () => {
    // `cacheRoot({ homeDir: process.env.HOME })` type-checks — the base configuration sets
    // no `exactOptionalPropertyTypes` — and `HOME` can be undefined.
    expect(cacheRoot({ platform: 'linux', env: {}, homeDir: undefined })).toBe(
      cacheRoot({ platform: 'linux', env: {} }),
    );
    expect(() =>
      cacheRoot({ platform: 'linux', homeDir: '/home/dev', env: undefined }),
    ).not.toThrow(TypeError);
  });

  it('falls back to the temporary directory when there is no home to put a cache under', () => {
    const root = cacheRoot({ platform: 'linux', homeDir: '', env: {}, tmpDir: '/tmp' });

    // Never a path inside the repository: the last resort is still outside it.
    expect(root).toBe('/tmp/personavision/calibration');
  });
});

describe("one dataset's cache", () => {
  const paths = datasetCachePaths('ueyes', {
    platform: 'darwin',
    homeDir: '/Users/dev',
    env: {},
  });

  it('puts the dataset under its own directory, by the id the manifest gives it', () => {
    expect(loadManifest().dataset.id).toBe('ueyes');
    expect(paths.root).toBe('/Users/dev/Library/Caches/personavision/calibration/ueyes');
  });

  it('keeps the download, the unpacked tree and a quarantined file apart', () => {
    expect(paths.downloads).toBe(`${paths.root}/downloads`);
    expect(paths.extracted).toBe(`${paths.root}/dataset`);
    expect(paths.quarantine).toBe(`${paths.root}/quarantine`);
    expect(new Set([paths.downloads, paths.extracted, paths.quarantine]).size).toBe(3);
  });

  it('places a manifest file where the manifest says, inside the downloads directory', () => {
    const file = loadManifest().files[0]!;

    expect(paths.download(file.path)).toBe(`${paths.downloads}/UEyes_dataset.zip`);
    expect(paths.extractedFile('images/webpage_001.png')).toBe(
      `${paths.extracted}/images/webpage_001.png`,
    );
  });

  it.each([
    ['../../../etc/passwd', 'climbs out of the cache'],
    ['/etc/passwd', 'is absolute'],
    ['images/../../escape.png', 'climbs out halfway through'],
    ['', 'is empty'],
    // `win32.isAbsolute('C:secret.txt')` is false, but the path is drive-relative: resolved
    // against drive C:'s working directory it leaves the cache, and on NTFS `a:b` names an
    // alternate data stream on a file called `a`.
    ['C:secret.txt', 'is drive-relative'],
    ['images/a:b.png', 'names an alternate data stream'],
    ['a\u0000b.zip', 'carries a NUL that fs would reject far from here'],
    ['images/ /a.png', 'has a blank segment'],
    ['images /a.png', 'has a segment Windows would silently strip a space from'],
  ])('refuses a path that %s, rather than joining it', (path) => {
    expect(() => paths.download(path)).toThrow(CachePathError);
    expect(() => paths.extractedFile(path)).toThrow(CachePathError);
  });

  it('refuses a dataset id that is not a single directory name', () => {
    expect(() =>
      datasetCachePaths('../other', { platform: 'linux', homeDir: '/home/dev', env: {} }),
    ).toThrow(CachePathError);
    expect(() =>
      datasetCachePaths('', { platform: 'linux', homeDir: '/home/dev', env: {} }),
    ).toThrow(CachePathError);
  });
});

describe('the resolved default lands outside the repository', () => {
  /** Every path the helpers hand out for one dataset. */
  const allPaths = (environment: Parameters<typeof datasetCachePaths>[1]): readonly string[] => {
    const paths = datasetCachePaths('ueyes', environment);
    return [
      paths.root,
      paths.downloads,
      paths.extracted,
      paths.quarantine,
      paths.download('UEyes_dataset.zip'),
      paths.extractedFile('info.csv'),
    ];
  };

  it('on this machine, with the override unset', () => {
    // The real platform and home, so the assertion is about where the dataset would
    // actually land when someone runs the download here.
    const environment = {
      platform: process.platform,
      homeDir: homedir(),
      tmpDir: tmpdir(),
      env: {},
    };

    for (const path of allPaths(environment)) {
      expect(
        landsOutsideRepository(path, process.platform),
        `${path} is inside the repository`,
      ).toBe(true);
    }
  });

  it('on every platform, and with no home at all', () => {
    const environments = [
      { platform: 'darwin', homeDir: '/Users/dev', env: {} },
      { platform: 'linux', homeDir: '/home/dev', env: {} },
      { platform: 'linux', homeDir: '/home/dev', env: { XDG_CACHE_HOME: '/var/cache/x' } },
      { platform: 'win32', homeDir: 'C:\\Users\\dev', env: {} },
      { platform: 'linux', homeDir: '', env: {}, tmpDir: tmpdir() },
    ] as const;

    for (const environment of environments) {
      for (const path of allPaths(environment)) {
        expect(
          landsOutsideRepository(path, environment.platform),
          `${path} is inside the repository`,
        ).toBe(true);
      }
    }
  });

  it('and .gitignore covers the in-repo cache a mistake realistically creates', () => {
    const ignored = readFileSync(join(repositoryRoot(), '.gitignore'), 'utf8');

    expect(ignored).toContain('.cache/');
  });
});

describe('a contained relative path', () => {
  it.each([
    'UEyes_dataset.zip',
    'images/webpage_001.png',
    'scanpaths/paths_7s/a.json',
    '.hidden/a.png',
  ])('accepts %s', (path) => {
    expect(isContainedRelativePath(path)).toBe(true);
  });

  it.each([
    '',
    '/images',
    '../images',
    'images/../../escape',
    'images/./a.png',
    'C:\\images',
    'images\\a.png',
    'images//a.png',
    'C:images',
    'images/a:b',
    'a\u0000b',
    'a\u001fb',
    ' ',
    'images ',
    'images.',
  ])('rejects %s', (path) => {
    expect(isContainedRelativePath(path)).toBe(false);
  });
});

describe('a dataset id', () => {
  it('is one directory name, by the rule the manifest validates `dataset.id` with', () => {
    // One rule in one place: the manifest cannot accept an id the cache would refuse.
    expect(isDatasetId(loadManifest().dataset.id)).toBe(true);
    expect(isDatasetId('ueyes-v2')).toBe(true);
    for (const rejected of ['', '../other', 'UEyes', 'ueyes/v2', 'ueyes_v2', '-ueyes']) {
      expect(isDatasetId(rejected), rejected).toBe(false);
    }
  });
});
