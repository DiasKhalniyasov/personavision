import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const entryPoint = pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href;

const take = (next: () => number, count: number): number[] =>
  Array.from({ length: count }, () => next());

/** The same helper, the same seed, in a process of its own. */
const sequenceFromAnotherProcess = (seed: number, count: number): number[] => {
  const program = [
    `const { createSeededRandom } = await import(${JSON.stringify(entryPoint)});`,
    `const next = createSeededRandom(${seed});`,
    `const drawn = Array.from({ length: ${count} }, () => next());`,
    'process.stdout.write(JSON.stringify(drawn));',
  ].join('\n');
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(output) as number[];
};

describe('the seeded random helper', () => {
  it('draws the identical sequence for the identical seed in a separate process', () => {
    const here = take(createSeededRandom(7), 8);

    expect(sequenceFromAnotherProcess(7, 8)).toEqual(here);
  });

  it('is mulberry32, so a reimplementation elsewhere draws the same numbers', () => {
    // Pinned against the reference algorithm, not against this implementation: a test that
    // only compares the helper with itself cannot notice the recurrence drifting.
    expect(take(createSeededRandom(7), 4)).toEqual([
      0.011704753153026104, 0.06195825757458806, 0.97690763277933, 0.6990287057124078,
    ]);
  });

  it('draws a different sequence for a different seed', () => {
    expect(take(createSeededRandom(8), 8)).not.toEqual(take(createSeededRandom(7), 8));
  });

  it('draws within 0..1', () => {
    for (const drawn of take(createSeededRandom(42), 200)) {
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(1);
    }
  });
});
