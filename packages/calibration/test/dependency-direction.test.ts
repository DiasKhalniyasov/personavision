import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The repository root, three directories above `packages/calibration/test`. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The workspace directories this file makes claims about.
 *
 * Asserted to exist before anything is asserted about their contents: a renamed or moved
 * workspace would otherwise turn "no file in apps/viewer imports it" into
 * `expect([]).toEqual([])` — green, and checking nothing.
 */
const CONSUMERS = ['packages/engine', 'apps/viewer'] as const;

const packageJson = (workspacePath: string): Record<string, Record<string, string> | undefined> =>
  JSON.parse(readFileSync(join(ROOT, workspacePath, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;

/**
 * Whether a file imports a module, rather than merely mentioning its name: a test that
 * matched a mention would be failed by the sentence explaining it.
 */
const imports = (text: string, specifier: string): boolean => {
  // The specifier is escaped: a name carrying a regex metacharacter would otherwise match
  // the wrong text, or throw.
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`(?:from|import|require)\s*\(?\s*['"]${escaped}(?:/[^'"]*)?['"]`,
  ).test(text);
};

/** Every TypeScript file under a workspace directory, with its text. */
const sources = (workspacePath: string): readonly { path: string; text: string }[] => {
  const directory = join(ROOT, workspacePath);
  if (!existsSync(directory)) throw new Error(`${workspacePath} is not in this repository`);
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

  it('and declares the engine too, which #88 scores through its published predict', () => {
    const { dependencies } = packageJson('packages/calibration');

    expect(dependencies?.['@personavision/engine']).toBe('workspace:*');
  });

  it('and actually imports it, so the vocabulary is the contract’s and not a restatement', () => {
    const importers = sources('packages/calibration/src').filter(({ text }) =>
      imports(text, '@personavision/contract'),
    );

    expect(importers.map(({ path }) => path)).toContain('packages/calibration/src/types.ts');
  });
});

describe('nothing reads the calibration package back', () => {
  it.each(CONSUMERS)('%s is where this test thinks it is', (workspacePath) => {
    expect(existsSync(join(ROOT, workspacePath, 'package.json')), workspacePath).toBe(true);
  });

  it.each(CONSUMERS)('%s does not depend on it', (workspacePath) => {
    const manifest = packageJson(workspacePath);

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('@personavision/calibration');
    }
  });

  it.each(CONSUMERS)('no file in %s imports it', (workspacePath) => {
    // The engine is pure and the viewer only formats: a figure flows engine configuration →
    // run artifact → viewer, never by either of them calling calibration (#11).
    const importers = sources(workspacePath).filter(({ text }) =>
      imports(text, '@personavision/calibration'),
    );

    expect(importers.map(({ path }) => path)).toEqual([]);
  });
});

describe('the engine is read from one module and no other', () => {
  it('so only the scoring imports it', () => {
    // #81 forbade this package the engine outright, and said that a later ticket of step #11
    // which genuinely needs it may depend on it — the direction has always allowed
    // calibration to read the engine — provided the ticket relaxes this test deliberately
    // rather than drifting into it. #88 is that ticket: it scores the engine through its
    // published `predict`, which is a dependency no seam can stand in for, and it is
    // recorded on #11 and #88. What stays asserted is the shape of the dependency: one
    // importer, named here, so a later ticket cannot spread the engine through the metrics
    // or the baselines — those are the ruler, and a ruler that imported the thing it
    // measures could be moved by it.
    const importers = [
      ...sources('packages/calibration/src'),
      ...sources('packages/calibration/test'),
    ].filter(({ text }) => imports(text, '@personavision/engine'));

    // #90 is the second such ticket: the fit searches `EngineConfig` and writes
    // `packages/engine/config/calibrated.json`, so it reads the engine's own configuration
    // object and its override type. Named here deliberately, as #88 was, and recorded on #90
    // and #11. The metrics and the baselines still import nothing from the engine.
    expect(importers.map(({ path }) => path).sort()).toEqual([
      'packages/calibration/src/fit/search.ts',
      'packages/calibration/src/score/score.ts',
      'packages/calibration/test/fit.test.ts',
      'packages/calibration/test/score.test.ts',
    ]);
  });

  it('and the Predictor seam still holds the two sides together field for field', () => {
    // The seam in `src/types.ts` is what the metrics, the baselines and the corpus are
    // written against, and `packages/engine/tests/predict.test.ts` assigns the real
    // `predict` to it (#68). The scoring's own assignment — `enginePredictor`'s `predictor`
    // field — is now a second check of the same thing, on this side.
    const scoring = sources('packages/calibration/src/score');

    expect(scoring.map(({ path }) => path).sort()).toEqual([
      'packages/calibration/src/score/index.ts',
      'packages/calibration/src/score/score.ts',
    ]);
  });
});
