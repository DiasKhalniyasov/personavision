/**
 * The one command that fits the engine and commits the result (#90).
 *
 * ```sh
 * pnpm --filter @personavision/calibration run fit
 * ```
 *
 * It runs the seeded, bounded search of `src/fit/search.ts` over the committed synthetic
 * corpus, prints each candidate as it is scored, and writes the best configuration — with
 * the figures, the search space, the seed and the objective behind it — to
 * `packages/engine/config/calibrated.json`, which the engine imports at build time.
 *
 * `--seed` and `--candidates` are for exploring; the committed file is the fit at
 * `FIT_DEFAULTS`, and running the command with no arguments reproduces it byte for byte.
 * `--check` writes nothing and reports whether the committed file is that fit, which is what
 * a reviewer runs.
 *
 * The engine package's root is resolved through the declared dependency rather than by a
 * path across the repository, so this writes the configuration of the engine that was
 * actually imported.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FIT_DEFAULTS, calibratedRecordOf, fit } from '../src/index.js';

const numberArg = (flag: string, fallback: number): number => {
  const position = process.argv.indexOf(flag);
  if (position < 0) return fallback;
  const value = Number(process.argv[position + 1]);
  if (!Number.isFinite(value)) throw new Error(`${flag} needs a number`);
  return value;
};

const seed = numberArg('--seed', FIT_DEFAULTS.seed);
const candidates = numberArg('--candidates', FIT_DEFAULTS.candidates);
const check = process.argv.includes('--check');

if (check && (process.argv.includes('--seed') || process.argv.includes('--candidates'))) {
  // `--check` asks whether the committed file is *the committed fit*. Answering it with
  // another seed's fit would print "re-run without --check to write it", and following that
  // would overwrite the committed fit with an exploratory one.
  throw new Error('--check reports on the committed fit, so it takes no --seed or --candidates');
}

const require = createRequire(import.meta.url);
const engineRoot = dirname(dirname(require.resolve('@personavision/engine')));
if (!existsSync(join(engineRoot, 'package.json'))) {
  // The entry point is two directories inside the package today — `src/index.ts` under the
  // development condition, `dist/index.js` otherwise. If that ever stops being true this
  // says so, rather than writing the fit into whatever directory the arithmetic lands on.
  throw new Error(`${engineRoot} is not the engine package: its manifest is not there`);
}
const recordPath = join(engineRoot, FIT_DEFAULTS.recordPath);

process.stdout.write(
  `fitting the engine over the committed corpus: ${String(candidates)} candidates beside the defaults, seed ${String(seed)}\n`,
);

const result = await fit({
  seed,
  candidates,
  onProgress: ({ message }) => process.stdout.write(`${message}\n`),
});

const record = calibratedRecordOf(result);
const text = `${JSON.stringify(record, null, 2)}\n`;

const { best, defaults } = result;
process.stdout.write(
  [
    '',
    `objective ${result.objective.id} (${result.objective.label})`,
    `  defaults   ${defaults.objective.value.toFixed(4)}  cc ${defaults.objective.saliency.cc.toFixed(4)}  scanMatch ${defaults.objective.scanpath.scanMatch.toFixed(4)}`,
    `  fitted     ${best.objective.value.toFixed(4)}  cc ${best.objective.saliency.cc.toFixed(4)}  scanMatch ${best.objective.scanpath.scanMatch.toFixed(4)}`,
    `  improvement ${(best.objective.value - defaults.objective.value).toFixed(4)} at candidate ${String(best.candidate.index)}`,
    `  search cost ${Math.round(result.elapsedMs)} ms for ${String(result.enginePasses)} engine passes`,
    ...result.atBound.map(
      ({ path, bound, value }) =>
        `  ON ITS BOUND: ${path} is ${String(value)}, the ${bound} of its range — the bound chose it, not the data`,
    ),
    '',
  ].join('\n'),
);

if (check) {
  const committed = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : null;
  const same = committed === text;
  process.stdout.write(
    same
      ? `${recordPath} is this fit\n`
      : `${recordPath} is NOT this fit: re-run without --check to write it\n`,
  );
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(recordPath, text);
  process.stdout.write(`wrote ${recordPath}\n`);
}
