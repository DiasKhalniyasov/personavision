/**
 * Scoring a predictor over a corpus: per record, per category, overall, and against the two
 * baselines (#88).
 *
 * This is the only place in the project where a human-likeness figure is produced. The fit
 * (#90) maximises what this returns, the committed report (#89) prints it, and the badge the
 * product shows on every screen quotes it by way of the engine's configuration — so a figure
 * that leaves here without saying what was compared would be a number nobody can check.
 *
 * **What it does.** Every record of the corpus is predicted by every predictor at one seed,
 * each prediction is scored with the four saliency metrics (#83) and the two scanpath metrics
 * (#84), and the per-record figures are averaged per category and overall. The engine is
 * reached through its published `predict(image, seed)` (#68) and the baselines through the
 * same `Predictor` seam (#87), so a reported margin is a margin between comparable numbers.
 *
 * **Provenance travels with the figures.** `ScoreResult.provenance` carries the engine
 * version, whether the engine's resolved configuration was calibrated, the corpus identity,
 * the seed, the metric parameters and the map kernel each predictor drew with. Nothing here
 * can be constructed without them: `score` refuses a predictor or a corpus that does not
 * carry its own provenance rather than reporting a figure with a gap in its account of
 * itself.
 *
 * **Webpages are what this product is for.** The web category is a category of its own at
 * every level and is never folded into the overall mean; a category with no records reports
 * `null` rather than a zero, because no figure and a figure of zero are different claims.
 *
 * **This module imports `packages/engine`**, which every earlier ticket of step #11 was
 * forbidden to do. #88 is the ticket the dependency was declared for — the direction has
 * always run one way, calibration reading the engine and never the reverse — and
 * `test/dependency-direction.test.ts` now asserts that this file is the only importer.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predict, resolveEngineConfig, type EngineConfigOverrides } from '@personavision/engine';
import {
  CENTRE_BIAS_PRIOR,
  MAP_RENDERING,
  centreBiasBaseline,
  randomFixationBaseline,
} from '../baselines/index.js';
import { loadCorpus } from '../corpus.js';
import {
  SALIENCY_METRIC_PARAMETERS,
  SCANPATH_METRIC_PARAMETERS,
  scoreSaliency,
  scoreScanpathAgainstHumans,
  type SaliencyScores,
  type ScanpathScores,
} from '../metrics/index.js';
import { RECORD_CATEGORIES } from '../types.js';
import type {
  Display,
  GroundTruthRecord,
  Predictor,
  RecordCategory,
  SaliencyNormalisation,
} from '../types.js';

/** Raised when there is nothing to score, or when a figure would have to be quoted blind. */
export class ScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreError';
  }
}

/** The predictor under test: the engine, as `enginePredictor()` builds it. */
export const ENGINE_PREDICTOR_ID = 'engine';
/** The reference baseline: what a predictor that knows only where pictures get looked at scores. */
export const CENTRE_BIAS_PREDICTOR_ID = 'centre-bias-prior';
/** The floor: what a predictor that looks in the wrong places scores. */
export const RANDOM_FIXATION_PREDICTOR_ID = 'random-fixations';
/** The identity of the committed synthetic corpus (#82), as a figure's provenance names it. */
export const COMMITTED_CORPUS_ID = 'committed-synthetic';

/**
 * How a predictor's saliency map was drawn, as data beside the figures it produced.
 *
 * Every saliency metric is sensitive to the kernel: a broad field correlates better with a
 * human fixation map than a handful of tight blobs do wherever those blobs sit, so part of a
 * CC margin can be blur rather than placement (#87 measured it and said so). This is why the
 * kernel is reported per predictor and why `ScoreResult.provenance.mapKernelDivergences`
 * names a difference rather than letting it hide inside an average.
 */
export interface MapKernelProvenance {
  /** `fixations` spreads a kernel per fixation; `position-prior` is one kernel at a point. */
  readonly drawnFrom: 'fixations' | 'position-prior';
  /** Image pixels a map cell covers on a side. */
  readonly cellPx: number;
  /** The Gaussian's standard deviation, as a share of `sigmaRelativeTo`. */
  readonly sigmaShare: number;
  /** What `sigmaShare` is a share of — the two conventions in this step are not the same. */
  readonly sigmaRelativeTo: 'map-longer-side' | 'image-shorter-side';
  /** Standard deviations summed before the kernel is cut off, or the whole map. */
  readonly truncationSigmas: number | 'whole-map';
  /** The exponent on a fixation's dwell: 1 is dwell-weighted, 0 counts fixations. */
  readonly dwellWeightExponent: number;
  readonly normalisation: SaliencyNormalisation;
}

/** What produced a prediction, carried beside every figure measured from it. */
export interface PredictorProvenance {
  /** The version of the package the predictor's code lives in. */
  readonly version: string;
  /**
   * Whether the engine's resolved configuration was calibrated. `null` for a baseline, which
   * has no configuration to calibrate — and never `false`, which would be a claim that
   * something fittable was left at its defaults.
   */
  readonly calibrated: boolean | null;
  readonly mapKernel: MapKernelProvenance;
}

/** A predictor with the account of itself a figure has to be quoted with. */
export interface ScoredPredictor {
  /** Stable across runs: a report and a history row find a figure by it. */
  readonly id: string;
  /** How a report names it in a heading. */
  readonly label: string;
  readonly predictor: Predictor;
  readonly provenance: PredictorProvenance;
}

/**
 * The corpus, with the identity a figure measured on it is quoted with.
 *
 * `synthetic` is the committed corpus's own label and not a detail: a figure measured on four
 * generated pictures is not a published UEyes score, and #89 asserts the label is in a
 * report's heading rather than its footnote.
 */
export interface ScoredCorpus {
  readonly id: string;
  readonly label: string;
  readonly synthetic: boolean;
  readonly records: readonly GroundTruthRecord[];
}

/** The committed synthetic corpus (#82), ready to score. */
export const committedCorpus = (): ScoredCorpus => ({
  id: COMMITTED_CORPUS_ID,
  label: 'the committed synthetic corpus',
  synthetic: true,
  records: loadCorpus(),
});

/** Where the engine's version and its `calibrated` flag are read from. */
const require = createRequire(import.meta.url);

const versionOfPackageAt = (root: string, name: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (cause) {
    throw new ScoreError(`cannot read ${name}'s version at ${root}: ${String(cause)}`);
  }
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new ScoreError(`${name} declares no version, so a figure cannot name what produced it`);
  }
  return version;
};

/**
 * The engine's version, from the engine package's own manifest.
 *
 * Resolved through the declared dependency rather than by a path across the repository, so
 * this reads the engine that was actually imported. Both the published entry points —
 * `src/index.ts` under the `development` condition and `dist/index.js` otherwise — sit one
 * directory inside the package, which is why two `dirname` calls reach its root.
 */
const engineVersion = (): string =>
  versionOfPackageAt(
    dirname(dirname(require.resolve('@personavision/engine'))),
    '@personavision/engine',
  );

/** This package's version, which is the version of the baselines' definitions. */
const calibrationVersion = (): string =>
  versionOfPackageAt(
    fileURLToPath(new URL('../../', import.meta.url)),
    '@personavision/calibration',
  );

/** What `enginePredictor` varies: the configuration layer the fit (#90) searches. */
export interface EnginePredictorOptions {
  /**
   * Layered over the engine's defaults, exactly as `predict`'s own `weights` are. A fit
   * passes a candidate here; nothing else about the prediction moves, which is what makes
   * two candidates' figures comparable.
   */
  readonly weights?: EngineConfigOverrides;
}

/**
 * The engine as a scored predictor: its published `predict`, its version, whether its
 * resolved configuration was calibrated, and the kernel its map is drawn with.
 *
 * The seed reaches `predict` unchanged, so the same image and seed give the same prediction
 * and a reported figure is reproducible (#68).
 */
export const enginePredictor = (options: EnginePredictorOptions = {}): ScoredPredictor => {
  const { config, calibrated } = resolveEngineConfig(options.weights);
  const { map } = config.prediction;
  return {
    id: ENGINE_PREDICTOR_ID,
    label: 'the attention engine',
    predictor: (image, seed) => predict(image, seed, { weights: options.weights }),
    provenance: {
      version: engineVersion(),
      calibrated,
      mapKernel: {
        drawnFrom: 'fixations',
        cellPx: map.cellPx,
        sigmaShare: map.kernelSigmaShare,
        sigmaRelativeTo: 'map-longer-side',
        truncationSigmas: map.kernelRadiusSigmas,
        dwellWeightExponent: map.dwellWeightExponent,
        normalisation: 'sum-to-one',
      },
    },
  };
};

/**
 * The centre-bias prior as a scored predictor (#87).
 *
 * Its kernel is **not** the engine's: the spread is a quarter of the image's shorter side
 * rather than three per cent of the map's longer one, and it is one kernel at a point rather
 * than one per fixation. That is what the prior is, and `mapKernelDivergences` reports the
 * difference so a margin over it is read as placement *and* blur.
 */
export const centreBiasPredictor = (): ScoredPredictor => ({
  id: CENTRE_BIAS_PREDICTOR_ID,
  label: 'the centre-bias prior',
  predictor: centreBiasBaseline,
  provenance: {
    version: calibrationVersion(),
    calibrated: null,
    mapKernel: {
      drawnFrom: 'position-prior',
      cellPx: MAP_RENDERING.cellPx,
      sigmaShare: CENTRE_BIAS_PRIOR.spreadShare,
      sigmaRelativeTo: 'image-shorter-side',
      truncationSigmas: CENTRE_BIAS_PRIOR.truncation,
      dwellWeightExponent: CENTRE_BIAS_PRIOR.dwellWeightExponent,
      normalisation: MAP_RENDERING.normalisation,
    },
  },
});

/**
 * The random-fixation baseline as a scored predictor (#87): fixations drawn uniformly over
 * the image, rendered at the engine's own kernel — so the engine's margin over it is a
 * difference in where each one looked and not in how its map was blurred.
 */
export const randomFixationPredictor = (): ScoredPredictor => ({
  id: RANDOM_FIXATION_PREDICTOR_ID,
  label: 'random fixations',
  predictor: randomFixationBaseline,
  provenance: {
    version: calibrationVersion(),
    calibrated: null,
    mapKernel: {
      drawnFrom: 'fixations',
      cellPx: MAP_RENDERING.cellPx,
      sigmaShare: MAP_RENDERING.kernelSigmaShare,
      sigmaRelativeTo: 'map-longer-side',
      truncationSigmas: MAP_RENDERING.kernelRadiusSigmas,
      dwellWeightExponent: MAP_RENDERING.dwellWeightExponent,
      normalisation: MAP_RENDERING.normalisation,
    },
  },
});

/** Both baselines, in the order a report lists them: the reference, then the floor. */
export const defaultBaselines = (): readonly ScoredPredictor[] => [
  centreBiasPredictor(),
  randomFixationPredictor(),
];

/** One record's figures, before anything is averaged. */
export interface RecordFigures {
  readonly recordId: string;
  readonly category: RecordCategory;
  readonly seed: number;
  readonly saliency: SaliencyScores;
  /** The mean over the record's humans (#84), which is what a prediction is scored at. */
  readonly scanpath: ScanpathScores;
  /**
   * The human-to-human agreement: the ceiling the figures above are read against, and `null`
   * for a record with one participant, where no pair of humans can agree.
   */
  readonly ceiling: ScanpathScores | null;
  readonly humans: number;
  readonly humanPairs: number;
  /** What the predictor says it predicted at, when it records one. */
  readonly display: Display | null;
  readonly elapsedMs: number;
}

/** A record that produced no figure, named rather than quietly left out of a count. */
export interface RecordFailure {
  readonly recordId: string;
  readonly category: RecordCategory;
  /** The error's message: `predict` raises rather than degrading on a failure (#68). */
  readonly reason: string;
}

/**
 * Figures averaged over a set of records, with the number of records behind them.
 *
 * `records` is the count behind every metric in `saliency` and `scanpath`: the six metrics
 * either all answer for a record or that record is a failure, so one count covers them.
 * `ceilingRecords` is its own count because a ceiling exists only where a record has more
 * than one human scanpath.
 */
export interface Aggregate {
  readonly records: number;
  readonly saliency: SaliencyScores;
  readonly scanpath: ScanpathScores;
  readonly ceiling: ScanpathScores | null;
  readonly ceilingRecords: number;
}

/** Every category's aggregate; `null` where the corpus holds no scored record of it. */
export type CategoryAggregates = Readonly<Record<RecordCategory, Aggregate | null>>;

/** One predictor's figures over the whole corpus. */
export interface PredictorFigures {
  readonly id: string;
  readonly label: string;
  readonly provenance: PredictorProvenance;
  readonly records: readonly RecordFigures[];
  readonly failures: readonly RecordFailure[];
  readonly categories: CategoryAggregates;
  /** `null` when no record produced a figure at all. */
  readonly overall: Aggregate | null;
  readonly elapsedMs: number;
}

/** A difference of figures: the predictor under test minus a baseline. */
export interface MarginFigures {
  /**
   * How many records the difference rests on — the records **both** sides scored.
   *
   * Normally every record of the scope, because both sides see the same corpus. When one
   * side failed a record the other managed, the margin is taken over the records they share
   * rather than between two means over different material, and this count says how many
   * those were. `predictorRecords` and `baselineRecords` are what each side scored in the
   * same scope, so a shortfall is visible rather than implied.
   */
  readonly records: number;
  readonly predictorRecords: number;
  readonly baselineRecords: number;
  /**
   * Predictor minus baseline, metric by metric. The direction a metric reads in is its own:
   * a positive CC, NSS, AUC-Judd, ScanMatch or sequence-score margin is better, and a
   * **negative** KLD margin is better, because KLD is lower-is-better.
   */
  readonly saliency: SaliencyScores;
  readonly scanpath: ScanpathScores;
}

/**
 * The predictor's margin over one baseline, per category and overall.
 *
 * A negative margin is a reported result and not a failure (#88, #87): the centre-bias prior
 * is hard to beat on a saliency metric, and a report that could only print a win would be
 * decoration.
 */
export interface Margin {
  readonly baselineId: string;
  readonly overall: MarginFigures | null;
  readonly categories: Readonly<Record<RecordCategory, MarginFigures | null>>;
}

/** Two predictors whose maps were drawn differently, and which fields differ. */
export interface MapKernelDivergence {
  readonly predictorId: string;
  readonly otherId: string;
  readonly fields: readonly string[];
}

/** What a figure cannot be quoted without. */
export interface ScoreProvenance {
  readonly corpus: {
    readonly id: string;
    readonly label: string;
    readonly synthetic: boolean;
    /** How many records the corpus holds, scored or not. */
    readonly records: number;
  };
  /** The seed every predictor was called with. */
  readonly seed: number;
  /** Which predictor is under test, and which are its baselines. */
  readonly predictorIds: readonly string[];
  /** The rulers, as committed data: #90 fits the engine and never these. */
  readonly saliencyMetricParameters: typeof SALIENCY_METRIC_PARAMETERS;
  readonly scanpathMetricParameters: typeof SCANPATH_METRIC_PARAMETERS;
  /** The kernel each predictor drew with, by predictor id. */
  readonly mapKernels: Readonly<Record<string, MapKernelProvenance>>;
  /** Empty when every predictor drew its map the same way. */
  readonly mapKernelDivergences: readonly MapKernelDivergence[];
}

/**
 * One step of a scoring run, for a reader watching it (#88: progress a person can read).
 *
 * The counts are **per predictor**: a run over four records with two baselines reports three
 * sequences of 1 … 4, each naming the predictor it belongs to, because that is the unit a
 * reader follows — the engine's pass, then each baseline's.
 *
 * A consumer that throws does not stop the run. A printer on a closed pipe is the likely
 * one (#91's CLI passes a printer), and discarding figures already measured because the
 * thing watching them went away would be the failure the per-record `failures` design
 * exists to prevent.
 */
export interface ScoreProgress {
  readonly predictorId: string;
  readonly recordId: string;
  /** Records this predictor has been scored on, 1 … `recordsTotal`. */
  readonly recordsDone: number;
  /** Records in the corpus, which is this predictor's own total. */
  readonly recordsTotal: number;
  /** Ready to print: `engine: 2 of 4 records — desktop-two-panels`. */
  readonly message: string;
}

export interface ScoreOptions {
  /** The predictor under test. `enginePredictor()` is the one this step exists to score. */
  readonly predictor: ScoredPredictor;
  readonly corpus: ScoredCorpus;
  /** The seed every prediction is made at, so two runs produce identical figures. */
  readonly seed: number;
  /** Defaults to both baselines (#87). An empty array scores the predictor alone. */
  readonly baselines?: readonly ScoredPredictor[];
  readonly onProgress?: (progress: ScoreProgress) => void;
}

/** What one scoring run produced, with the account of itself it is quoted with. */
export interface ScoreResult {
  readonly provenance: ScoreProvenance;
  readonly predictor: PredictorFigures;
  readonly baselines: readonly PredictorFigures[];
  /** One per baseline, in the order they were scored. */
  readonly margins: readonly Margin[];
  /** Wall-clock milliseconds the whole run took, which is what `SCORING_BUDGET` bounds. */
  readonly elapsedMs: number;
}

/**
 * The measured cost of a full run over the committed corpus, as committed data.
 *
 * The budget exists so that the cost of #90's search can be estimated from it: a search of
 * `n` candidates is about `n` engine passes, and `enginePassMs` is one pass over the whole
 * corpus. `limitMs` is the bound a test asserts — deliberately far above the measurement,
 * because a figure that flakes on a loaded machine would be a test about the machine.
 */
export const SCORING_BUDGET = Object.freeze({
  corpusId: COMMITTED_CORPUS_ID,
  /** The records and predictors the measurement covers: four records, engine and two baselines. */
  records: 4,
  predictors: 3,
  /**
   * A full run — the engine and both baselines over the four records — as the median of
   * fifteen: **41 ms** on a loaded machine and 24 ms on a quiet one, with the *first* run of
   * a process at 282 ms, because it pays for `sharp`'s warm-up. The spread is machine load
   * (this was measured with several other agent sessions running), which is why the asserted
   * bound below is a hundred times the figure and not twice it. `docs/scoring.md` records
   * the one command that repeats the measurement.
   */
  measuredMs: 41,
  /**
   * One engine pass over the whole corpus, without the baselines: **34 ms** by the same
   * method, 18 ms at the fastest. This is the unit a fit's cost is counted in — #90's search
   * of `n` candidates is about `n` of these, so a two-hundred-candidate search over this
   * corpus is about seven seconds of scoring.
   */
  enginePassMs: 34,
  machine: 'Apple M4 Pro, 14 cores, Node 22.20.0, macOS (Darwin 27), under parallel load',
  /**
   * The bound asserted by `test/score.test.ts`: about a hundred and sixty times the
   * measurement. Loose on purpose — the suite runs beside several others on a contended
   * machine, and a figure that flaked there would be a test about the machine. What it still
   * catches is a change of a different order: an image decoded once per metric, a predictor
   * called once per human, or a sweep that lost its seed and started sampling.
   */
  limitMs: 4_000,
});

/**
 * The result as text two runs must agree on, character for character: everything but the
 * wall-clock timings, which are properties of the machine and not figures.
 *
 * `test/score.test.ts` compares two runs and two processes through this, and #89 writes a
 * committed report from a result — a report that carried a millisecond count would differ on
 * every run and make a diff meaningless.
 */
export const comparableFigures = (result: ScoreResult): string =>
  JSON.stringify(result, (key, value: unknown) => (key === 'elapsedMs' ? undefined : value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Refuses a predictor that does not carry its own provenance.
 *
 * The types say the same thing, so this is what holds for a caller that is not TypeScript — a
 * CLI flag, a JSON configuration, a JavaScript test. #88's criterion is that a result cannot
 * be constructed without provenance, and "the compiler would have caught it" is not that.
 */
const assertScoredPredictor = (candidate: ScoredPredictor, role: string): void => {
  const where = `the ${role}`;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new ScoreError(`${where} is not a predictor to score`);
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new ScoreError(`${where} carries no id, so its figures could not be named`);
  }
  if (typeof candidate.label !== 'string' || candidate.label.length === 0) {
    throw new ScoreError(`predictor ${candidate.id} carries no label`);
  }
  if (typeof candidate.predictor !== 'function') {
    throw new ScoreError(`predictor ${candidate.id} is not a function of an image and a seed`);
  }
  const provenance: PredictorProvenance | undefined = candidate.provenance;
  if (typeof provenance !== 'object' || provenance === null) {
    throw new ScoreError(
      `predictor ${candidate.id} carries no provenance; a figure cannot be quoted without the version, the calibrated flag and the map kernel behind it`,
    );
  }
  if (typeof provenance.version !== 'string' || provenance.version.length === 0) {
    throw new ScoreError(`predictor ${candidate.id} names no version`);
  }
  if (provenance.calibrated !== null && typeof provenance.calibrated !== 'boolean') {
    throw new ScoreError(
      `predictor ${candidate.id} says neither whether it was calibrated nor that it has no configuration to calibrate`,
    );
  }
  const kernel: MapKernelProvenance | undefined = provenance.mapKernel;
  if (typeof kernel !== 'object' || kernel === null) {
    throw new ScoreError(
      `predictor ${candidate.id} does not say what kernel its map was drawn with, and every saliency metric is sensitive to it`,
    );
  }
  for (const field of ['cellPx', 'sigmaShare', 'dwellWeightExponent'] as const) {
    if (!isFiniteNumber(kernel[field])) {
      throw new ScoreError(`predictor ${candidate.id}'s map kernel has no ${field}`);
    }
  }
  if (kernel.truncationSigmas !== 'whole-map' && !isFiniteNumber(kernel.truncationSigmas)) {
    throw new ScoreError(`predictor ${candidate.id}'s map kernel has no truncation`);
  }
  for (const field of ['normalisation', 'drawnFrom', 'sigmaRelativeTo'] as const) {
    if (typeof kernel[field] !== 'string' || kernel[field].length === 0) {
      throw new ScoreError(
        `predictor ${candidate.id}'s map kernel has no ${field}, and it is one of the fields a divergence is read from`,
      );
    }
  }
};

/** Refuses a corpus that cannot be named, or that holds nothing to score. */
const assertCorpus = (corpus: ScoredCorpus): void => {
  if (typeof corpus !== 'object' || corpus === null) {
    throw new ScoreError('there is no corpus to score');
  }
  if (typeof corpus.id !== 'string' || corpus.id.length === 0) {
    throw new ScoreError(
      'the corpus carries no identity; a figure measured on it could not say what it was measured on',
    );
  }
  if (typeof corpus.label !== 'string' || corpus.label.length === 0) {
    throw new ScoreError(`the corpus ${corpus.id} carries no label`);
  }
  if (typeof corpus.synthetic !== 'boolean') {
    throw new ScoreError(
      `the corpus ${corpus.id} does not say whether its records are synthetic, and a figure measured on synthetic records is not a published score`,
    );
  }
  if (!Array.isArray(corpus.records) || corpus.records.length === 0) {
    throw new ScoreError(`the corpus ${corpus.id} holds no record, so there is nothing to score`);
  }
};

const meanOf = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const meanSaliency = (figures: readonly RecordFigures[]): SaliencyScores => ({
  cc: meanOf(figures.map(({ saliency }) => saliency.cc)),
  nss: meanOf(figures.map(({ saliency }) => saliency.nss)),
  kld: meanOf(figures.map(({ saliency }) => saliency.kld)),
  aucJudd: meanOf(figures.map(({ saliency }) => saliency.aucJudd)),
});

const meanScanpath = (scores: readonly ScanpathScores[]): ScanpathScores => ({
  scanMatch: meanOf(scores.map(({ scanMatch }) => scanMatch)),
  sequenceScore: meanOf(scores.map(({ sequenceScore }) => sequenceScore)),
});

/**
 * The mean of a set of records' figures, or `null` when the set is empty.
 *
 * `null` rather than zero is the whole point of this function: a category UEyes has no record
 * of in the corpus at hand has no figure, and a zero would read as a measured one (#88).
 */
const aggregateOf = (figures: readonly RecordFigures[]): Aggregate | null => {
  if (figures.length === 0) return null;
  const ceilings = figures.flatMap(({ ceiling }) => (ceiling === null ? [] : [ceiling]));
  return {
    records: figures.length,
    saliency: meanSaliency(figures),
    scanpath: meanScanpath(figures.map(({ scanpath }) => scanpath)),
    ceiling: ceilings.length === 0 ? null : meanScanpath(ceilings),
    ceilingRecords: ceilings.length,
  };
};

const byCategory = (figures: readonly RecordFigures[]): CategoryAggregates =>
  Object.fromEntries(
    RECORD_CATEGORIES.map((category) => [category, aggregateOf(ofCategory(figures, category))]),
  ) as CategoryAggregates;

/**
 * The predictor's margin over a baseline, taken over the records the two of them share.
 *
 * A difference between a mean over one set of records and a mean over another is not a
 * margin, and the only reason the two sets can differ is that one side failed a record the
 * other managed. So each side is re-averaged over the records both scored, and the count
 * travels with the figure; with nothing in common there is no margin at all, which is
 * `null` rather than a number nobody can read. #89 prints these, so an incomparable margin
 * must not be able to reach a report as a plain figure.
 */
const marginOf = (
  predictorFigures: readonly RecordFigures[],
  baselineFigures: readonly RecordFigures[],
): MarginFigures | null => {
  const scoredByBaseline = new Set(baselineFigures.map(({ recordId }) => recordId));
  const scoredByPredictor = new Set(predictorFigures.map(({ recordId }) => recordId));
  const predictor = aggregateOf(
    predictorFigures.filter(({ recordId }) => scoredByBaseline.has(recordId)),
  );
  const baseline = aggregateOf(
    baselineFigures.filter(({ recordId }) => scoredByPredictor.has(recordId)),
  );
  if (predictor === null || baseline === null) return null;
  return {
    records: predictor.records,
    predictorRecords: predictorFigures.length,
    baselineRecords: baselineFigures.length,
    saliency: {
      cc: predictor.saliency.cc - baseline.saliency.cc,
      nss: predictor.saliency.nss - baseline.saliency.nss,
      kld: predictor.saliency.kld - baseline.saliency.kld,
      aucJudd: predictor.saliency.aucJudd - baseline.saliency.aucJudd,
    },
    scanpath: {
      scanMatch: predictor.scanpath.scanMatch - baseline.scanpath.scanMatch,
      sequenceScore: predictor.scanpath.sequenceScore - baseline.scanpath.sequenceScore,
    },
  };
};

const ofCategory = (
  figures: readonly RecordFigures[],
  category: RecordCategory,
): readonly RecordFigures[] => figures.filter((figure) => figure.category === category);

const marginsOver = (
  predictor: PredictorFigures,
  baselines: readonly PredictorFigures[],
): readonly Margin[] =>
  baselines.map((baseline) => ({
    baselineId: baseline.id,
    overall: marginOf(predictor.records, baseline.records),
    categories: Object.fromEntries(
      RECORD_CATEGORIES.map((category) => [
        category,
        marginOf(ofCategory(predictor.records, category), ofCategory(baseline.records, category)),
      ]),
    ) as Readonly<Record<RecordCategory, MarginFigures | null>>,
  }));

const KERNEL_FIELDS = [
  'drawnFrom',
  'cellPx',
  'sigmaShare',
  'sigmaRelativeTo',
  'truncationSigmas',
  'dwellWeightExponent',
  'normalisation',
] as const;

/**
 * Where two predictors' kernels differ, so the result says so rather than hiding it in an
 * average (#88).
 *
 * Each baseline is compared with the predictor under test, because that is the comparison a
 * margin is read from.
 */
const kernelDivergences = (
  predictor: ScoredPredictor,
  baselines: readonly ScoredPredictor[],
): readonly MapKernelDivergence[] =>
  baselines.flatMap((baseline) => {
    const fields = KERNEL_FIELDS.filter(
      (field) => predictor.provenance.mapKernel[field] !== baseline.provenance.mapKernel[field],
    );
    return fields.length === 0
      ? []
      : [{ predictorId: predictor.id, otherId: baseline.id, fields: [...fields] }];
  });

/** What a predictor is handed for one record: the pixels, the size and the display. */
interface PredictorImageOf {
  readonly bytes: Uint8Array;
  readonly size: GroundTruthRecord['imageSize'];
  readonly display: Display;
}

/**
 * One record's image, read at the moment it is scored and let go of afterwards.
 *
 * Deliberately **not** read once for the whole corpus up front: the committed corpus is four
 * small pictures, but the real dataset is 1,980 screenshots (#85), and holding all of their
 * bytes to save a few file reads would trade a gigabyte of memory for nothing measurable.
 * The bytes are the same on every read, so each predictor still sees the same image.
 *
 * `display` is the display the humans saw, never a default: a prediction is made at their
 * resolution (#11, user story 4).
 */
const imageOf = (record: GroundTruthRecord): PredictorImageOf => ({
  bytes: readFileSync(record.imagePath),
  size: record.imageSize,
  display: record.display,
});

const scoreOnePredictor = async (
  scored: ScoredPredictor,
  records: readonly GroundTruthRecord[],
  seed: number,
  report: (progress: Omit<ScoreProgress, 'message' | 'predictorId'>) => void,
): Promise<PredictorFigures> => {
  const figures: RecordFigures[] = [];
  const failures: RecordFailure[] = [];
  const startedAt = performance.now();

  for (const [position, record] of records.entries()) {
    const predictionStartedAt = performance.now();
    try {
      const prediction = await scored.predictor(imageOf(record), seed);
      /**
       * The provenance is checked against the prediction rather than taken on trust. A
       * predictor declares its normalisation up front — it is a property of its code, not
       * of one answer — and a declaration that disagrees with the map it returns would make
       * every figure quoted with a kernel that misstates it, and `mapKernelDivergences`
       * report no divergence where there is one. KLD reads a map as a distribution and is
       * not invariant to a rescaling, so this is a figure-changing difference.
       */
      if (prediction.saliencyMap.normalisation !== scored.provenance.mapKernel.normalisation) {
        throw new ScoreError(
          `predictor ${scored.id} says its maps are ${scored.provenance.mapKernel.normalisation} but returned a ${prediction.saliencyMap.normalisation} map for record ${record.id}; a figure cannot be quoted with a kernel that misstates it`,
        );
      }
      const saliency = scoreSaliency(prediction.saliencyMap, record);
      const agreement = scoreScanpathAgainstHumans(prediction.scanpath, record);
      figures.push({
        recordId: record.id,
        category: record.category,
        seed,
        saliency,
        scanpath: agreement.prediction,
        ceiling: agreement.humanToHuman,
        humans: agreement.humans,
        humanPairs: agreement.humanPairs,
        display: prediction.display ?? null,
        elapsedMs: performance.now() - predictionStartedAt,
      });
    } catch (cause) {
      /**
       * A `ScoreError` is the run being wrong — a predictor that misstates its own
       * provenance is wrong about every record — so it stops the run rather than being
       * logged four times as a failed record.
       */
      if (cause instanceof ScoreError) throw cause;
      // One record that cannot be read, predicted or scored is a record with no figure,
      // not a sweep that stops: `predict` raises rather than degrading (#68), and a category
      // total that silently lost a record would be worse than one that says it did.
      failures.push({
        recordId: record.id,
        category: record.category,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    report({
      recordId: record.id,
      recordsDone: position + 1,
      recordsTotal: records.length,
    });
  }

  return {
    id: scored.id,
    label: scored.label,
    provenance: scored.provenance,
    records: figures,
    failures,
    categories: byCategory(figures),
    overall: aggregateOf(figures),
    elapsedMs: performance.now() - startedAt,
  };
};

/**
 * Score a predictor over a corpus: per record, per category, overall, and against the
 * baselines, with the provenance every figure is quoted with.
 *
 * The predictors are called in order — the one under test, then each baseline — and within a
 * predictor the records are scored in corpus order, each at the run's one seed. Nothing here
 * reads a clock for a figure, draws a random number of its own or touches the network: the
 * same corpus, predictor and seed produce identical figures across two runs and two
 * processes, which is what lets #90 replay a fit and #89 gate on a number.
 */
export const score = async (options: ScoreOptions): Promise<ScoreResult> => {
  if (typeof options !== 'object' || options === null) {
    throw new ScoreError('score needs a predictor, a corpus and a seed');
  }
  assertScoredPredictor(options.predictor, 'predictor under test');
  assertCorpus(options.corpus);
  if (!isFiniteNumber(options.seed)) {
    throw new ScoreError(
      `the seed is ${String(options.seed)}; a figure is only reproducible if it names the seed it was measured at`,
    );
  }
  const baselines = options.baselines ?? defaultBaselines();
  if (!Array.isArray(baselines)) {
    throw new ScoreError('the baselines are not a list of predictors to score alongside');
  }
  for (const baseline of baselines) assertScoredPredictor(baseline, `baseline ${baseline?.id}`);
  /**
   * Ids are how a figure, a margin and a kernel are found in the result, so two predictors
   * sharing one would make a report ambiguous and silently drop a kernel from
   * `mapKernels`. The realistic way in is #90 scoring a candidate engine against the
   * current one: both are `enginePredictor()`, so one of them is given an id of its own.
   */
  const ids = [options.predictor.id, ...baselines.map(({ id }) => id)];
  const repeated = ids.filter((id, position) => ids.indexOf(id) !== position);
  if (repeated.length > 0) {
    throw new ScoreError(
      `two predictors of this run share the id ${JSON.stringify(repeated[0])}; a margin and a map kernel are found by id, so each one needs its own`,
    );
  }

  const records = options.corpus.records;
  const startedAt = performance.now();
  const onProgress = options.onProgress;
  const figuresFor = async (scored: ScoredPredictor): Promise<PredictorFigures> =>
    scoreOnePredictor(scored, records, options.seed, ({ recordId, recordsDone, recordsTotal }) => {
      if (onProgress === undefined) return;
      try {
        onProgress({
          predictorId: scored.id,
          recordId,
          recordsDone,
          recordsTotal,
          message: `${scored.id}: ${String(recordsDone)} of ${String(recordsTotal)} records — ${recordId}`,
        });
      } catch {
        /**
         * Progress is a side channel for a reader. A printer whose pipe has closed — #91's
         * CLI piped into `head` — must not discard figures that have already been measured,
         * and the caller's own exception is the caller's to see on its own side.
         */
      }
    });

  const predictor = await figuresFor(options.predictor);
  const baselineFigures: PredictorFigures[] = [];
  for (const baseline of baselines) baselineFigures.push(await figuresFor(baseline));

  return {
    provenance: {
      corpus: {
        id: options.corpus.id,
        label: options.corpus.label,
        synthetic: options.corpus.synthetic,
        records: options.corpus.records.length,
      },
      seed: options.seed,
      predictorIds: [options.predictor.id, ...baselines.map(({ id }) => id)],
      saliencyMetricParameters: SALIENCY_METRIC_PARAMETERS,
      scanpathMetricParameters: SCANPATH_METRIC_PARAMETERS,
      mapKernels: Object.fromEntries(
        [options.predictor, ...baselines].map((scored) => [scored.id, scored.provenance.mapKernel]),
      ),
      mapKernelDivergences: kernelDivergences(options.predictor, baselines),
    },
    predictor,
    baselines: baselineFigures,
    margins: marginsOver(predictor, baselineFigures),
    elapsedMs: performance.now() - startedAt,
  };
};
