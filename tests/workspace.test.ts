import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

/** Every file git knows about, plus any new file not yet ignored. */
const sourceFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0);

/**
 * The library packages, so that no later ticket invents a name.
 *
 * The first six exist as placeholders from the first commit. `calibration` is the one
 * package a step creates rather than fills — step #11 needs a home for the human-likeness
 * figure — and it is listed here so it is held to the same five invariants as the rest.
 */
const LIBRARY_PACKAGES = [
  'contract',
  'cli',
  'engine',
  'browser',
  'scoring',
  'personas',
  'calibration',
] as const;

/** The root scripts this step fixes. */
const ROOT_SCRIPTS = [
  'typecheck',
  'lint',
  'format',
  'test',
  'build',
  'dev',
  'seed:example-run',
  'open',
] as const;

describe('the toolchain is pinned', () => {
  it('pins Node 22 in .nvmrc', () => {
    expect(read('.nvmrc').trim()).toBe('22');
  });

  it('pins the same major in engines.node', () => {
    const engines = readJson('package.json')['engines'] as Record<string, string>;
    expect(engines['node']).toBe('>=22.13.0 <23.0.0');
  });

  it('names pnpm as the package manager', () => {
    expect(readJson('package.json')['packageManager']).toMatch(/^pnpm@\d+\./);
  });

  it('commits a pnpm lockfile and no other', () => {
    expect(existsSync(join(repoRoot, 'pnpm-lock.yaml'))).toBe(true);
    for (const foreign of ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
      expect(existsSync(join(repoRoot, foreign))).toBe(false);
    }
  });
});

describe('the root scripts a developer runs', () => {
  const scripts = readJson('package.json')['scripts'] as Record<string, string>;

  for (const name of ROOT_SCRIPTS) {
    it(`declares ${name}`, () => {
      expect(scripts[name]).toBeTruthy();
    });
  }
});

describe('the workspace', () => {
  const workspace = read('pnpm-workspace.yaml');

  it('declares packages/* so a library ticket adds no manifest entry', () => {
    expect(workspace).toMatch(/^\s*-\s*packages\/\*\s*$/m);
  });

  it('declares apps/* so the viewer ticket adds no manifest entry', () => {
    expect(workspace).toMatch(/^\s*-\s*apps\/\*\s*$/m);
  });

  for (const name of LIBRARY_PACKAGES) {
    describe(`@personavision/${name}`, () => {
      const manifest = readJson(`packages/${name}/package.json`);

      it('carries the fixed package name', () => {
        expect(manifest['name']).toBe(`@personavision/${name}`);
      });

      it('is an ES module', () => {
        expect(manifest['type']).toBe('module');
      });

      it('exposes exactly one public entry point', () => {
        const exports = manifest['exports'] as Record<string, unknown>;
        expect(Object.keys(exports)).toEqual(['.']);
        expect(exports['.']).toEqual({
          // Vite and Vitest read the source through this condition, so a sibling package
          // is never type-checked or tested against a stale build. tsc does not match it.
          development: './src/index.ts',
          types: './dist/index.d.ts',
          default: './dist/index.js',
        });
      });

      it('has a placeholder entry point on disk', () => {
        expect(existsSync(join(repoRoot, 'packages', name, 'src/index.ts'))).toBe(true);
      });

      it('builds and type-checks itself', () => {
        const scripts = manifest['scripts'] as Record<string, string>;
        expect(scripts['build']).toBeTruthy();
        expect(scripts['typecheck']).toBeTruthy();
      });
    });
  }

  it("names the CLI's binary personavision", () => {
    const bin = readJson('packages/cli/package.json')['bin'] as Record<string, string>;
    expect(Object.keys(bin)).toEqual(['personavision']);
  });
});

describe('CI gates every root check', () => {
  const workflow = read('.github/workflows/ci.yml');

  it('installs with a frozen lockfile', () => {
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('reads the pinned Node version from .nvmrc', () => {
    expect(workflow).toContain('node-version-file: .nvmrc');
  });

  for (const check of ['typecheck', 'lint', 'format:check', 'test', 'build']) {
    it(`runs pnpm ${check}`, () => {
      expect(workflow).toMatch(new RegExp(`^\\s*-\\s*run:\\s*pnpm ${check}\\s*$`, 'm'));
    });
  }
});

describe('nothing in the repository reads a credential', () => {
  // Every pattern is assembled from fragments, and the comments below describe each shape
  // rather than spelling one out, so that this test cannot match itself and quietly pass
  // while a real credential read sits a line away.
  const SECRETISH = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'];
  const NAME = `[A-Z0-9_]*(?:${SECRETISH.join('|')})`;

  const PATTERNS = [
    // A dot read of an environment variable whose name ends in one of those words.
    new RegExp(`process\\.env\\.${NAME}\\b`),
    // The same read through a bracket with a quoted literal name.
    new RegExp(`process\\.env\\[\\s*['"\`]${NAME}`),
    // The same name destructured straight out of the environment.
    new RegExp(`\\{[^}]*\\b${NAME}\\b[^}]*\\}\\s*=\\s*process\\.env`),
    // a registry auth line in an .npmrc
    new RegExp(['_auth', '(?:Token)?\\s*='].join('')),
    // a CI secret reference in a workflow
    new RegExp(['\\$\\{\\{\\s*', 'sec', 'rets\\.'].join('')),
  ];

  const SCANNED_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.json',
    '.sh',
    '.yml',
    '.yaml',
  ]);

  // Files whose whole name carries no extension, and which are exactly where a
  // credential tends to land: an .npmrc auth token above all.
  const SCANNED_NAMES = new Set(['.npmrc', '.yarnrc', '.env.example', 'Dockerfile', 'Makefile']);

  it('reads no API key from the environment and holds no CI secret', () => {
    const offenders = sourceFiles()
      .filter((path) => SCANNED_EXTENSIONS.has(extname(path)) || SCANNED_NAMES.has(basename(path)))
      // `git ls-files --cached` still lists a file deleted from the working tree without
      // `git rm`, and reading it would throw.
      .filter((path) => existsSync(join(repoRoot, path)))
      .filter((path) => {
        const source = read(path);
        return PATTERNS.some((pattern) => pattern.test(source));
      });

    expect(offenders).toEqual([]);
  });
});
