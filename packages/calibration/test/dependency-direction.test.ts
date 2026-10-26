import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = (): string => {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('no pnpm-workspace.yaml above this test');
    directory = parent;
  }
  return directory;
};

const ROOT = repositoryRoot();

const packageJson = (workspacePath: string): Record<string, Record<string, string> | undefined> =>
  JSON.parse(readFileSync(join(ROOT, workspacePath, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;

/**
 * Whether a file imports a module, rather than merely mentioning its name: a test that
 * matched a mention would be failed by the sentence explaining it.
 */
const imports = (text: string, specifier: string): boolean =>
  new RegExp(String.raw`(?:from|import|require)\s*\(?\s*['"]${specifier}(?:/[^'"]*)?['"]`).test(
    text,
  );

/** Every TypeScript file under a workspace directory, with its text. */
const sources = (workspacePath: string): readonly { path: string; text: string }[] => {
  const directory = join(ROOT, workspacePath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(ts|tsx|mts|cts)$/.test(entry))
    .map((entry) => ({
      path: join(workspacePath, entry),
      text: readFileSync(join(directory, entry), 'utf8'),
    }));
};

describe('the calibration package reads the contract', () => {
  it('declares it as a workspace dependency', () => {
    const { dependencies } = packageJson('packages/calibration');

    expect(dependencies?.['@personavision/contract']).toBe('workspace:*');
  });

  it('and actually imports it, so the vocabulary is the contract’s and not a restatement', () => {
    const importers = sources('packages/calibration/src').filter(({ text }) =>
      imports(text, '@personavision/contract'),
    );

    expect(importers.map(({ path }) => path)).toContain('packages/calibration/src/types.ts');
  });
});

describe('nothing reads the calibration package back', () => {
  it.each(['packages/engine', 'apps/viewer'])('%s does not depend on it', (workspacePath) => {
    if (!existsSync(join(ROOT, workspacePath, 'package.json'))) return;
    const manifest = packageJson(workspacePath);

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('@personavision/calibration');
    }
  });

  it.each(['packages/engine', 'apps/viewer'])('no file in %s imports it', (workspacePath) => {
    // The engine is pure and the viewer only formats: a figure flows engine configuration →
    // run artifact → viewer, never by either of them calling calibration (#11).
    const importers = sources(workspacePath).filter(({ text }) =>
      imports(text, '@personavision/calibration'),
    );

    expect(importers.map(({ path }) => path)).toEqual([]);
  });
});

describe('the Predictor seam is structural', () => {
  it('so no module of this package imports the engine', () => {
    // #81 forbids it here, and the seam in `src/types.ts` is what makes it unnecessary: the
    // engine's `predict` satisfies `Predictor` field for field. A later ticket of step #11
    // that genuinely needs the engine may depend on it — the direction allows that — but it
    // says so on #11 and relaxes this test deliberately rather than drifting into it.
    const importers = [
      ...sources('packages/calibration/src'),
      ...sources('packages/calibration/test'),
    ].filter(({ text }) => imports(text, '@personavision/engine'));

    expect(importers.map(({ path }) => path)).toEqual([]);
  });
});
