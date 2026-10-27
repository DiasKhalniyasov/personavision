import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultEngineConfig, resolveEngineConfig } from '@personavision/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORPUS_RECORD_NAMES,
  FIT_DEFAULTS,
  FitError,
  OBJECTIVE,
  RECORD_CATEGORIES,
  SALIENCY_METRIC_PARAMETERS,
  SCANPATH_METRIC_PARAMETERS,
  SEARCH_COST,
  SEARCH_KIND,
  SEARCH_SPACE,
  calibratedRecordOf,
  committedCorpus,
  comparableFit,
  defaultAt,
  enginePredictor,
  fit,
  gridCandidates,
  loadCorpusRecord,
  objectiveOf,
  score,
} from '../src/index.js';
import type { FitProgress, FitResult, SearchParameter } from '../src/index.js';

/** The seed and candidate count of the committed fit, which this suite reproduces. */
const { seed: SEED, candidates: CANDIDATES } = FIT_DEFAULTS;

/** Small enough to run several times in a suite, large enough to find something. */
const FEW = 8;

/** The file the fit commits, read as text so a test can compare it byte for byte. */
const committedRecordPath = fileURLToPath(
  new URL('../../engine/config/calibrated.json', import.meta.url),
);

const committedRecordText = (): string => readFileSync(committedRecordPath, 'utf8');

/** Every leaf name of a frozen parameter surface, which is the ruler's vocabulary. */
const leafNames = (value: unknown): readonly string[] =>
  typeof value !== 'object' || value === null
    ? []
    : Object.entries(value).flatMap(([key, child]) => [key, ...leafNames(child)]);

describe('the search space', () => {
  it('is the engine’s configuration object: every parameter is read from it', () => {
    for (const { path } of SEARCH_SPACE) {
      // `defaultAt` walks `defaultEngineConfig` and refuses a path it does not hold as a
      // number, so this is the assertion that nothing in the space is invented here.
      expect(typeof defaultAt(path), path).toBe('number');
      expect(Number.isFinite(defaultAt(path)), path).toBe(true);
    }
  });

  it('covers what this ticket documents: the softmax weights, the fixation durations and the inhibition terms', () => {
    expect(SEARCH_SPACE.map(({ path }) => path)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'fixationDuration.medianMs',
      'fixationDuration.logSigma',
      'fixationDuration.minMs',
      'fixationDuration.maxMs',
      'inhibitionOfReturn.penalty',
      'inhibitionOfReturn.decayPerFixation',
      'inhibitionOfReturn.immediateRepeatAllowance',
      'inhibitionOfReturn.deliberateReturnAfterFixations',
      'inhibitionOfReturn.deliberateReturnRelevance',
    ]);
  });

  it('bounds every parameter, with a step that is a grid over its range and a stated reason', () => {
    for (const parameter of SEARCH_SPACE) {
      const { path, min, max, step, reason } = parameter;
      expect(min, path).toBeLessThan(max);
      expect(step, path).toBeGreaterThan(0);
      expect(step, path).toBeLessThanOrEqual(max - min);
      expect(reason.length, path).toBeGreaterThan(40);
      // The engine's own default has to be a point of the space, or "the fit beat the
      // defaults" would be a comparison with something the search could never have found.
      expect(defaultAt(path), path).toBeGreaterThanOrEqual(min);
      expect(defaultAt(path), path).toBeLessThanOrEqual(max);
    }
  });

  it('is coarse and random because a full grid over it is not a long search but an impossible one', () => {
    expect(SEARCH_KIND).toBe('random');
    // Fourteen million million points at the documented steps: #90 asks which coarse search this
    // is and why, and this is the arithmetic behind the answer.
    expect(gridCandidates()).toBe(15_378_171_494_400);
    // The pin phase costs passes too, so the published cost counts them: the defaults, every
    // drawn candidate, one revert per searched parameter and one confirming pass.
    expect(SEARCH_COST.committedPasses).toBe(CANDIDATES + 1 + SEARCH_SPACE.length + 1);
  });

  it('reaches no metric parameter: the fit searches the engine, never the ruler', () => {
    const ruler = new Set([
      ...leafNames(SALIENCY_METRIC_PARAMETERS),
      ...leafNames(SCANPATH_METRIC_PARAMETERS),
    ]);
    expect(ruler.size).toBeGreaterThan(5);

    for (const { path } of SEARCH_SPACE) {
      for (const segment of path.split('.')) expect([...ruler], path).not.toContain(segment);
    }
    // …and the engine's configuration object does not hold one under any name, so no search
    // space written against it could reach the ruler even by accident.
    for (const name of ruler) expect(() => defaultAt(name), name).toThrow(FitError);
  });

  it('reaches no corpus parameter either: what was scored is not what was fitted', () => {
    const record = loadCorpusRecord('webpage-bright-hero');
    const corpusNames = new Set([
      ...Object.keys(record),
      ...CORPUS_RECORD_NAMES,
      ...RECORD_CATEGORIES,
      'corpus',
      'records',
      'seed',
      'synthetic',
    ]);

    for (const { path } of SEARCH_SPACE) {
      for (const segment of path.split('.')) expect([...corpusNames], path).not.toContain(segment);
    }
    for (const name of corpusNames) expect(() => defaultAt(name), name).toThrow(FitError);
  });
});

describe('the objective', () => {
  it('is the web category’s CC plus ScanMatch, equally weighted, recorded with its weights', () => {
    expect(OBJECTIVE.id).toBe('web-cc-scanmatch');
    expect(OBJECTIVE.scope).toBe('webpage');
    expect(OBJECTIVE.terms).toEqual([
      { metric: 'cc', weight: 0.5 },
      { metric: 'scanMatch', weight: 0.5 },
    ]);
  });

  it('is read from the web category and never from the overall mean', async () => {
    const result = await score({
      predictor: enginePredictor(),
      corpus: committedCorpus(),
      seed: SEED,
      baselines: [],
    });
    const web = result.predictor.categories.webpage;
    const value = objectiveOf(result);

    expect(web).not.toBeNull();
    expect(value.value).toBeCloseTo(
      0.5 * (web?.saliency.cc ?? 0) + 0.5 * (web?.scanpath.scanMatch ?? 0),
      12,
    );
    expect(value.records).toBe(web?.records);
    // All six metrics travel with the one number, so a climb that cost KLD is visible.
    expect(value.saliency).toEqual(web?.saliency);
    expect(value.scanpath).toEqual(web?.scanpath);
  }, 60_000);

  it('refuses a corpus with no record of its scope rather than reading a zero', async () => {
    const corpus = committedCorpus();
    const posters = {
      ...corpus,
      records: corpus.records.filter(({ category }) => category === 'poster'),
    };
    const result = await score({
      predictor: enginePredictor(),
      corpus: posters,
      seed: SEED,
      baselines: [],
    });

    expect(() => objectiveOf(result)).toThrow(FitError);
    expect(() => objectiveOf(result)).toThrow(/scored no webpage record/);
  }, 60_000);
});

describe('a fit', () => {
  it('scores the defaults as candidate 0, then every drawn candidate, and reports the best', async () => {
    const result = await fit({ seed: SEED, candidates: FEW });

    expect(result.candidates).toHaveLength(FEW + 1);
    expect(result.candidates[0]?.candidate.index).toBe(0);
    expect(result.candidates[0]?.candidate.values).toEqual(result.defaults.candidate.values);
    for (const scored of result.candidates) {
      expect(Number.isFinite(scored.objective.value), String(scored.candidate.index)).toBe(true);
      expect(Object.keys(scored.candidate.values).sort()).toEqual(
        SEARCH_SPACE.map(({ path }) => path).sort(),
      );
    }
    expect(result.best.objective.value).toBe(
      Math.max(...result.candidates.map(({ objective }) => objective.value)),
    );
  }, 60_000);

  it('draws every candidate inside the bounds and on the parameter’s own step', async () => {
    const result = await fit({ seed: SEED, candidates: FEW });
    const stepsFrom = ({ min, step }: SearchParameter, value: number): number =>
      (value - min) / step;

    for (const { candidate } of result.candidates.slice(1)) {
      for (const parameter of SEARCH_SPACE) {
        const value = candidate.values[parameter.path] ?? Number.NaN;
        expect(value, parameter.path).toBeGreaterThanOrEqual(parameter.min);
        expect(value, parameter.path).toBeLessThanOrEqual(parameter.max);
        expect(stepsFrom(parameter, value), parameter.path).toBeCloseTo(
          Math.round(stepsFrom(parameter, value)),
          6,
        );
      }
    }
  }, 60_000);

  it('reports progress a person can read, naming the candidate and the best so far', async () => {
    const progress: FitProgress[] = [];
    const result = await fit({
      seed: SEED,
      candidates: FEW,
      onProgress: (step) => progress.push(step),
    });

    expect(progress).toHaveLength(FEW + 1);
    expect(progress.map(({ candidateIndex }) => candidateIndex)).toEqual([
      ...Array.from({ length: FEW + 1 }, (_value, index) => index),
    ]);
    expect(progress.at(-1)?.message).toMatch(
      /^candidate 8 of 9 — objective -?\d\.\d{4} \(best -?\d\.\d{4} at candidate \d+\)$/,
    );
    expect(progress.at(-1)?.bestObjective).toBe(result.best.objective.value);
  }, 60_000);

  it('and a progress consumer that throws does not discard the search', async () => {
    const result = await fit({
      seed: SEED,
      candidates: FEW,
      onProgress: () => {
        throw new Error('a printer whose pipe has closed');
      },
    });

    expect(result.candidates).toHaveLength(FEW + 1);
  }, 60_000);

  it('never commits a configuration worse than the engine’s defaults', async () => {
    const result = await fit({ seed: SEED, candidates: FEW });

    expect(result.best.objective.value).toBeGreaterThanOrEqual(result.defaults.objective.value);
    // The committed configuration is the best candidate with the parameters the objective
    // could not see handed back, and it scores exactly what the best candidate scored.
    expect(result.fitted.objective.value).toBe(result.best.objective.value);
  }, 60_000);

  it('hands back a parameter the objective cannot see instead of committing a drawn value', async () => {
    const result = await fit({ seed: SEED, candidates: CANDIDATES });

    // `predict` holds relevance at the neutral trait (#68), so beta — the softmax weight on
    // relevance — cannot move this objective. Committing a drawn value for it would change
    // every goal-driven session on the strength of a figure that never measured it.
    expect(result.pinned).toContain('beta');
    for (const path of result.pinned) {
      expect(result.fitted.candidate.values[path], path).toBe(defaultAt(path));
    }
    // What is handed back is measured, not assumed: the committed configuration with beta
    // at the value the search drew for it scores the very same objective.
    const scored = await score({
      predictor: enginePredictor({
        weights: {
          ...result.fitted.candidate.weights,
          beta: result.best.candidate.values['beta'] ?? defaultAt('beta'),
        },
      }),
      corpus: committedCorpus(),
      seed: SEED,
      baselines: [],
    });

    expect(objectiveOf(scored).value).toBe(result.fitted.objective.value);
  }, 120_000);

  it('refuses a search space the engine’s configuration object does not hold', async () => {
    await expect(
      fit({
        seed: SEED,
        candidates: 1,
        space: [
          {
            path: 'gridWidth',
            min: 1,
            max: 12,
            step: 1,
            reason: 'the ruler, which a fit may not search',
          },
        ],
      }),
    ).rejects.toThrow(FitError);
  });

  it('refuses a seed that is not the seed it would draw at', async () => {
    // `createSeededRandom` takes a 32-bit word (`seed >>> 0`), so 1.5 and 2^32 + 1 both draw
    // seed 1's sequence while the file would record the number it was handed.
    for (const seed of [Number.NaN, 1.5, 4_294_967_296 + 1, -1]) {
      await expect(fit({ seed, candidates: 1 }), String(seed)).rejects.toThrow(/seed/);
    }
  });

  it('counts the engine passes it made, the pin phase included', async () => {
    const result = await fit({ seed: SEED, candidates: FEW });

    expect(result.enginePasses).toBeGreaterThan(FEW + 1);
    expect(result.enginePasses).toBeLessThanOrEqual(FEW + 1 + SEARCH_SPACE.length + 1);
  }, 60_000);

  it('names a committed value that sits on a bound, because the bound chose it', async () => {
    const result = await fit({ seed: SEED, candidates: CANDIDATES });

    // The objective is degenerate downward — ScanMatch is dwell-weighted — so the shortest
    // fixations win and the lower bound is what stops them. That is recorded rather than
    // read off a table: `docs/fitting.md` answers for every entry here.
    expect(result.atBound).toEqual([
      { path: 'fixationDuration.medianMs', bound: 'min', value: 150 },
      { path: 'fixationDuration.minMs', bound: 'min', value: 60 },
    ]);
    for (const { path, bound, value } of result.atBound) {
      const parameter = SEARCH_SPACE.find((searched) => searched.path === path);
      expect(value, path).toBe(bound === 'min' ? parameter?.min : parameter?.max);
    }
  }, 120_000);
});

describe('the same seed and search space', () => {
  it('produce an identical best configuration and objective value across two runs', async () => {
    const first = await fit({ seed: SEED, candidates: FEW });
    const second = await fit({ seed: SEED, candidates: FEW });

    expect(comparableFit(second)).toBe(comparableFit(first));
  }, 60_000);

  it('and in a second process', async () => {
    const first = await fit({ seed: SEED, candidates: FEW });
    const child = fileURLToPath(new URL('fit.child.ts', import.meta.url));
    const out = execFileSync(
      process.execPath,
      ['--conditions', 'development', '--import', 'tsx', child, String(SEED), String(FEW)],
      { encoding: 'utf8' },
    );

    expect(out).toBe(comparableFit(first));
  }, 120_000);

  it('and a different seed draws different candidates', async () => {
    const first = await fit({ seed: SEED, candidates: FEW });
    const other = await fit({ seed: SEED + 1, candidates: FEW });

    expect(other.candidates[1]?.candidate.values).not.toEqual(
      first.candidates[1]?.candidate.values,
    );
    // The defaults are the defaults at every seed: candidate 0 is not drawn.
    expect(other.candidates[0]?.candidate.values).toEqual(first.candidates[0]?.candidate.values);
  }, 60_000);
});

describe('the committed configuration', () => {
  let committed: FitResult | null = null;
  const committedFit = async (): Promise<FitResult> =>
    (committed ??= await fit({ seed: SEED, candidates: CANDIDATES }));

  it('is the fit at the committed seed and candidate count, byte for byte', async () => {
    const record = calibratedRecordOf(await committedFit());

    expect(committedRecordText()).toBe(`${JSON.stringify(record, null, 2)}\n`);
  }, 120_000);

  it('carries the fitted values with the engine version, the corpus, the search, the seed, the objective and its metrics', async () => {
    const result = await committedFit();
    const record = JSON.parse(committedRecordText()) as ReturnType<typeof calibratedRecordOf>;

    expect(record.engine.version).toBe(enginePredictor().provenance.version);
    expect(record.weights).toEqual(result.fitted.candidate.weights);
    expect(record.metrics.corpus.id).toBe('committed-synthetic');
    expect(record.metrics.corpus.synthetic).toBe(true);
    expect(record.metrics.scope).toBe(OBJECTIVE.scope);
    expect(record.metrics.seed).toBe(SEED);
    expect(record.metrics.objective).toEqual({
      id: OBJECTIVE.id,
      value: result.fitted.objective.value,
    });
    for (const metric of ['cc', 'nss', 'kld', 'aucJudd', 'scanMatch', 'sequenceScore'] as const) {
      expect(typeof record.metrics[metric], metric).toBe('number');
    }
    expect(record.fit.kind).toBe(SEARCH_KIND);
    expect(record.fit.seed).toBe(SEED);
    expect(record.fit.candidates).toBe(CANDIDATES);
    expect(record.fit.command).toBe(FIT_DEFAULTS.command);
    expect(record.fit.objective).toEqual(OBJECTIVE);
    expect(record.fit.space.map(({ path }) => path)).toEqual(SEARCH_SPACE.map(({ path }) => path));
    for (const parameter of record.fit.space) {
      expect(parameter.default, parameter.path).toBe(defaultAt(parameter.path));
    }
    // The figure the fit had to beat, measured in the same run rather than quoted.
    expect(record.fit.defaults.objective).toBe(result.defaults.objective.value);
    expect(record.fit.improvement).toBeGreaterThan(0);
    expect(record.fit.enginePasses).toBe(result.enginePasses);
    expect(record.fit.atBound).toEqual(result.atBound);
    // The whole corpus on both sides, so `overall` has a baseline to be read against.
    expect(record.fit.defaults.overall?.records).toBe(4);
    expect(record.fit.overall?.records).toBe(4);
    expect(record.fit.overall?.cc).toBeGreaterThan(record.fit.defaults.overall?.cc ?? 1);
  }, 120_000);

  it('scores better on the objective than the engine’s defaults do', async () => {
    const record = JSON.parse(committedRecordText()) as ReturnType<typeof calibratedRecordOf>;

    expect(record.metrics.objective.value).toBeGreaterThan(record.fit.defaults.objective);
    expect(record.metrics.objective.value - record.fit.defaults.objective).toBeCloseTo(
      record.fit.improvement,
      12,
    );
  });

  it('holds only numbers at the leaves of its weights, so it is an engine configuration and nothing else', () => {
    const record = JSON.parse(committedRecordText()) as ReturnType<typeof calibratedRecordOf>;
    const leaves = (value: unknown, prefix = ''): readonly [string, unknown][] =>
      typeof value !== 'object' || value === null
        ? [[prefix, value]]
        : Object.entries(value).flatMap(([key, child]) =>
            leaves(child, prefix === '' ? key : `${prefix}.${key}`),
          );

    for (const [path, value] of leaves(record.weights)) {
      expect(typeof value, path).toBe('number');
      expect(
        SEARCH_SPACE.map(({ path: searched }) => searched),
        path,
      ).toContain(path);
    }
  });
});

describe('the engine’s resolved configuration', () => {
  it('reports calibrated with the recorded metrics, so a run loop needs no file of its own', () => {
    const record = JSON.parse(committedRecordText()) as ReturnType<typeof calibratedRecordOf>;
    const resolved = resolveEngineConfig();

    expect(resolved.calibrated).toBe(true);
    expect(resolved.metrics).toEqual({ benchmark: 'UEyes', ...record.metrics });
    // The fitted values are the engine's defaults now, layered over the uncalibrated ones.
    expect(resolved.config.fixationDuration.medianMs).toBe(
      record.weights.fixationDuration?.medianMs,
    );
    expect(resolved.config.alpha).toBe(defaultEngineConfig.alpha);
  });

  it('and a run’s own weights still win over the fitted ones', () => {
    const resolved = resolveEngineConfig({ fixationDuration: { medianMs: 321 } });

    expect(resolved.config.fixationDuration.medianMs).toBe(321);
    expect(resolved.calibrated).toBe(true);
  });
});

describe('with no network and no API key', () => {
  const fetchAsItWas = globalThis.fetch;
  const keysAsTheyWere = { ...process.env };

  afterEach(() => {
    globalThis.fetch = fetchAsItWas;
    process.env = { ...keysAsTheyWere };
  });

  it('a fit over the committed corpus finishes inside its documented budget', async () => {
    globalThis.fetch = (() => {
      throw new Error('a fit opened a socket');
    }) as typeof globalThis.fetch;
    for (const key of Object.keys(process.env)) {
      if (key.includes('API_KEY') || key.includes('TOKEN')) delete process.env[key];
    }

    const result = await fit({ seed: SEED, candidates: CANDIDATES });

    expect(result.candidates).toHaveLength(CANDIDATES + 1);
    expect(result.elapsedMs).toBeLessThan(SEARCH_COST.limitMs);
  }, 120_000);

  it('and the fit reaches for no socket and draws no unseeded number', () => {
    const sources = ['../src/fit/search.ts', '../src/fit/objective.ts', '../src/fit/index.ts'].map(
      (entry) => ({ entry, text: readFileSync(new URL(entry, import.meta.url), 'utf8') }),
    );

    for (const forbidden of [
      'node:net',
      'node:http',
      'node:dns',
      'XMLHttpRequest',
      'Math.random',
    ]) {
      for (const { entry, text } of sources) {
        expect(`${entry}: ${text}`, forbidden).not.toContain(forbidden);
      }
    }
  });
});
