import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0);

/** The library packages this step fixes, so that no later ticket invents a name. */
const LIBRARY_PACKAGES = ['contract', 'cli', 'engine', 'browser', 'scoring', 'personas'] as const;

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
    expect(engines['node']).toBe('>=22.0.0 <23.0.0');
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

  for (const check of ['typecheck', 'lint', 'test', 'build']) {
    it(`runs pnpm ${check}`, () => {
      expect(workflow).toMatch(new RegExp(`^\\s*-\\s*run:\\s*pnpm ${check}\\s*$`, 'm'));
    });
  }
});

describe('nothing in the repository reads a credential', () => {
  // The patterns are assembled from fragments so that this test cannot match itself
  // and quietly pass while a real credential read sits a line away.
  const SECRETISH = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'];
  const ENV_READ = new RegExp(`process\\.env\\.[A-Z0-9_]*(?:${SECRETISH.join('|')})\\b`);
  const ACTIONS_SECRET = new RegExp(['\\$\\{\\{\\s*', 'sec', 'rets\\.'].join(''));
  const SCANNED = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh', '.yml', '.yaml']);

  const offenders = trackedFiles()
    .filter((path) => SCANNED.has(extname(path)))
    .filter((path) => {
      const source = read(path);
      return ENV_READ.test(source) || ACTIONS_SECRET.test(source);
    });

  it('reads no API key from the environment and no CI secret', () => {
    expect(offenders).toEqual([]);
  });
});
