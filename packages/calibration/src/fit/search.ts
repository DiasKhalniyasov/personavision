/**
 * Fitting the engine's configuration to the benchmark: a seeded, bounded coarse search
 * (#90).
 *
 * This is what makes the engine's weights **fitted rather than chosen**. The search varies
 * the engine's own configuration object (#56) — nothing else — scores every candidate
 * through `score` (#88), and returns the candidate with the best objective (`objective.ts`)
 * beside every candidate's value and the engine's own defaults scored the same way. The
 * result is committed as data at `packages/engine/config/calibrated.json`, which the engine
 * imports at build time; `scripts/fit.ts` is the one command that writes it.
 *
 * **Random, not a grid, and not gradient-based.** #11 settled that the parameter count does
 * not justify a gradient method — there is no gradient to take: the objective runs through a
 * sampled scanpath and a segmenter, and a finite-difference estimate of it would cost more
 * engine passes than this whole search. Between the two coarse searches #90 allows, the
 * space below is twelve bounded parameters whose documented steps give `gridCandidates()`
 * 15,378,171,494,400 points — about 1.5 × 10^13: a full grid is not a long search but an
 * impossible one, and a
 * one-parameter-at-a-time sweep would be a grid that cannot see an interaction between the
 * softmax weights and the inhibition terms — which is exactly where one is expected, since
 * both decide where the next fixation goes. A seeded uniform draw over the same bounds, each
 * value snapped to the parameter's own step, covers every dimension jointly at a cost that
 * is linear in the candidate count: `SEARCH_COST` states it in engine passes.
 *
 * **One seed.** It seeds the candidate draw *and* is the prediction seed every candidate is
 * scored at — one number, so "the same seed and search space" is one statement. The
 * prediction seed is constant across candidates on purpose: two candidates scored at
 * different seeds would differ by the draw as much as by the configuration.
 *
 * **The search space is the engine's configuration object and nothing else.** Every
 * parameter below is a dotted path into `EngineConfig`, and its default is *read* from
 * `defaultEngineConfig` rather than restated here. No metric parameter and no corpus
 * parameter is reachable: fitting the ruler is not fitting the engine (#11, #83, #84), and
 * `test/fit.test.ts` asserts both directions of that.
 */

import { createSeededRandom } from '@personavision/contract';
import { defaultEngineConfig } from '@personavision/engine';
import type { CalibratedRecord, EngineConfigOverrides } from '@personavision/engine';
import { SCORING_BUDGET, committedCorpus, enginePredictor, score } from '../score/index.js';
import type { Aggregate, ScoreResult, ScoredCorpus } from '../score/index.js';
import { FitError, OBJECTIVE, objectiveOf } from './objective.js';
import type { Objective, ObjectiveValue } from './objective.js';

/** Which coarse search this is. Recorded in the committed file, so it is data, not prose. */
export const SEARCH_KIND = 'random' as const;

/** One searched parameter: where it lives in the engine's configuration, and its bounds. */
export interface SearchParameter {
  /** A dotted path into `EngineConfig`: `alpha`, `fixationDuration.medianMs`, … */
  readonly path: string;
  /** The lowest value a candidate may take, inclusive. */
  readonly min: number;
  /** The highest value a candidate may take, inclusive. */
  readonly max: number;
  /** The grid a drawn value is snapped to, so a recorded candidate is exactly replayable. */
  readonly step: number;
  /** Why these bounds, in one line a reviewer can disagree with. */
  readonly reason: string;
}

/**
 * The documented search space: the softmax weights, the fixation-duration parameters and the
 * inhibition parameters, which is what #90 names.
 *
 * Deliberately **not** every leaf of `EngineConfig`. The salience term weights, the
 * segmenter thresholds and the persona table are fittable in principle and are left for a
 * later fit with a reason: `predict` scores a bare screenshot with no persona and no goal
 * (#68), so the persona table cannot move this objective at all, and widening a twelve-
 * parameter draw to forty would spend the budget thinning its own coverage.
 */
export const SEARCH_SPACE: readonly SearchParameter[] = Object.freeze(
  [
    {
      path: 'alpha',
      min: 0.2,
      max: 3,
      step: 0.2,
      reason:
        'the softmax weight on salience: below 0.2 the engine stops preferring salient areas at all, above 3 it fixates the single most salient one and the scanpath stops moving',
    },
    {
      path: 'beta',
      min: 0,
      max: 3,
      step: 0.2,
      reason:
        'the softmax weight on relevance. `predict` has no goal, so relevance is neutral there and this term is expected to be inert on this objective — it is searched because #90 names it and because an inert parameter is a measured fact rather than an assumption',
    },
    {
      path: 'gamma',
      min: 0,
      max: 3,
      step: 0.2,
      reason:
        'the softmax weight on viewing history, which is what inhibition of return acts through: at 0 the engine may fixate one area forever, and the upper bound is the same as the other two weights so no term is privileged by its range',
    },
    {
      path: 'fixationDuration.medianMs',
      min: 150,
      max: 400,
      step: 10,
      reason:
        'the published free-viewing region is 200-300 ms. The upper bound reaches well past it; the lower one is a floor and binds, because the objective is degenerate downward — ScanMatch is dwell-weighted, so shorter fixations keep raising it (0.80 at a 80 ms median, against 0.66 at 150) all the way to dwells no eye performs. 150 ms is the lowest median any free-viewing study reports, and it is honoured over the objective',
    },
    {
      path: 'fixationDuration.logSigma',
      min: 0.2,
      max: 0.8,
      step: 0.05,
      reason:
        'the spread of the log-normal: 0.2 is near-constant dwells and 0.8 is a heavy tail of second-long looks. Dwell is what the map is weighted by, so this moves CC as well as ScanMatch',
    },
    {
      path: 'fixationDuration.minMs',
      min: 60,
      max: 140,
      step: 10,
      reason:
        'the floor a dwell is clamped to, kept below the median’s own lower bound so no draw can cross it. A fixation under 60 ms is not a fixation in any published definition, so this bound binds for the same reason the median’s does',
    },
    {
      path: 'fixationDuration.maxMs',
      min: 600,
      max: 1600,
      step: 100,
      reason:
        'the ceiling a dwell is clamped to, kept above the median’s upper bound so no draw can cross it. Past 1.6 s a single look would dominate a map the humans spread over a screen',
    },
    {
      path: 'inhibitionOfReturn.penalty',
      min: 0,
      max: 4,
      step: 0.25,
      reason:
        'what is subtracted from the history term of an area just fixated: 0 is no inhibition at all and 4 all but forbids a return, which brackets the published effect rather than assuming it',
    },
    {
      path: 'inhibitionOfReturn.decayPerFixation',
      min: 0,
      max: 0.95,
      step: 0.05,
      reason:
        'the share of the penalty surviving each further fixation: 0 forgets at once, and the top of the range stops short of 1, which would never forget and make the penalty permanent',
    },
    {
      path: 'inhibitionOfReturn.immediateRepeatAllowance',
      min: 0,
      max: 3,
      step: 1,
      reason:
        'consecutive fixations one area may hold before the penalty applies. Integral by nature, so the step is 1 and the range covers none to a long dwell split across three fixations',
    },
    {
      path: 'inhibitionOfReturn.deliberateReturnAfterFixations',
      min: 1,
      max: 8,
      step: 1,
      reason:
        'how long before a return counts as deliberate rather than an accident. Integral, and eight is past the fixation count a small screen gets at all',
    },
    {
      path: 'inhibitionOfReturn.deliberateReturnRelevance',
      min: 0,
      max: 1,
      step: 0.1,
      reason:
        'the relevance a deliberate return needs. The whole unit interval, because relevance is a unit interval and `predict` holds it at the neutral trait',
    },
  ].map((parameter) => Object.freeze(parameter)),
);

/** How many points a full grid over `SEARCH_SPACE` would hold, which is why this is random. */
export const gridCandidates = (space: readonly SearchParameter[] = SEARCH_SPACE): number =>
  // Rounded, not floored: `(3 - 0.2) / 0.2` is 13.999999999999998 in binary floating point,
  // and flooring it would drop a grid point from `alpha` and another from the decay.
  space.reduce((product, { min, max, step }) => product * (Math.round((max - min) / step) + 1), 1);

/** The drawn candidates a committed fit uses, and the file it writes. */
export const FIT_DEFAULTS = Object.freeze({
  /**
   * Candidates drawn, beside the defaults, which are always scored as candidate 0.
   *
   * A hundred and twenty-eight is about four and a half seconds of scoring over the
   * committed corpus by #88's own arithmetic (`SCORING_BUDGET.enginePassMs`), and it is the
   * point past which the committed seed stops finding anything: the best candidate of this
   * search was found inside the first half of it, and a run at 256 reaches the same value.
   */
  candidates: 128,
  /** The seed of the committed fit: the candidate draw and the prediction seed in one. */
  seed: 1,
  /** The one command that repeats it. */
  command: 'pnpm --filter @personavision/calibration run fit',
  /** Where the result is committed, relative to the engine package's own root. */
  recordPath: 'config/calibrated.json',
});

/**
 * What a search of `n` candidates costs, from #88's measured engine pass rather than a
 * guess: one pass over the corpus per candidate, plus the defaults.
 */
export const SEARCH_COST = Object.freeze({
  enginePassMs: SCORING_BUDGET.enginePassMs,
  corpusId: SCORING_BUDGET.corpusId,
  /** The defaults and every drawn candidate: 129 passes over the four committed records. */
  searchPasses: FIT_DEFAULTS.candidates + 1,
  /**
   * …and the pin phase after it, which re-scores once per parameter that differs from the
   * engine's default and once more to confirm the configuration it commits. At most one
   * pass per searched parameter, so the upper bound is the space's own size plus one; the
   * committed fit spends all of them, for 142 passes in all. `FitResult.enginePasses` is
   * the count a run actually made, and the file records it.
   */
  pinPasses: SEARCH_SPACE.length + 1,
  committedPasses: FIT_DEFAULTS.candidates + 1 + SEARCH_SPACE.length + 1,
  estimatedMs:
    (FIT_DEFAULTS.candidates + 1 + SEARCH_SPACE.length + 1) * SCORING_BUDGET.enginePassMs,
  /**
   * The bound `test/fit.test.ts` asserts the committed fit inside: thirty seconds, where the
   * measured search is under a second on a quiet machine and about three on a loaded one.
   * Loose on purpose, as #88's own bound is — the suite runs beside several others, and a
   * tight figure would be a test about the machine. What it still catches is a change of a
   * different order: a candidate that re-reads the corpus, or a search that lost its bounds.
   */
  limitMs: 30_000,
});

/** One point of the search space: the values, and the engine overrides they become. */
export interface Candidate {
  /**
   * 0 is the engine's defaults; 1 … n are the drawn candidates, in the order drawn. The pin
   * phase re-scores configurations that are none of those, which is what `label` is for.
   */
  readonly index: number;
  /** How an error or a progress line names it: `candidate 19`, `the defaults`, a revert. */
  readonly label: string;
  /** Every searched parameter's value, by its path. */
  readonly values: Readonly<Record<string, number>>;
  /** The same values as the layer `predict` and `resolveEngineConfig` take. */
  readonly weights: EngineConfigOverrides;
}

/** A candidate and what it scored. */
export interface ScoredCandidate {
  readonly candidate: Candidate;
  readonly objective: ObjectiveValue;
  /** The whole corpus, not only the objective's scope: a climb that cost the rest shows here. */
  readonly overall: Aggregate | null;
  readonly elapsedMs: number;
}

/** One candidate scored, for a reader watching a search (#90: progress a person can read). */
export interface FitProgress {
  readonly candidateIndex: number;
  /** Candidates still to score after this one, so a reader can see the end coming. */
  readonly candidatesTotal: number;
  readonly objective: number;
  readonly bestObjective: number;
  readonly bestCandidateIndex: number;
  /** Ready to print: `candidate 12 of 129 — objective 0.561 (best 0.587 at candidate 7)`. */
  readonly message: string;
}

export interface FitOptions {
  /** The candidate draw and the prediction seed in one number. */
  readonly seed?: number;
  /** Candidates drawn beside the defaults. */
  readonly candidates?: number;
  readonly space?: readonly SearchParameter[];
  readonly objective?: Objective;
  /** Defaults to the committed synthetic corpus (#82). */
  readonly corpus?: ScoredCorpus;
  readonly onProgress?: (progress: FitProgress) => void;
}

/** What one fit produced: the best configuration, the defaults it beat, and every candidate. */
export interface FitResult {
  readonly kind: typeof SEARCH_KIND;
  readonly seed: number;
  readonly space: readonly SearchParameter[];
  readonly objective: Objective;
  readonly engineVersion: string;
  readonly corpus: ScoreResult['provenance']['corpus'];
  /** The engine's own defaults, scored the same way: what the fit has to beat. */
  readonly defaults: ScoredCandidate;
  /** The best candidate the search drew, before any parameter was handed back. */
  readonly best: ScoredCandidate;
  /**
   * What the fit commits: `best` with every parameter the objective could not see returned
   * to the engine's default, which scores exactly what `best` scored (see `pinned`).
   */
  readonly fitted: ScoredCandidate;
  /**
   * The searched parameters whose drawn value the objective could not tell from the
   * engine's default, measured one at a time and handed back rather than committed.
   */
  readonly pinned: readonly string[];
  /**
   * Searched parameters whose committed value sits on the edge of its own range.
   *
   * A bound that binds chose that value, not the data, so it is recorded rather than read
   * off a table: `docs/fitting.md` has to say why the bound is honoured over the objective.
   */
  readonly atBound: readonly BoundReached[];
  /** Engine passes the whole fit made: every candidate, plus the pin phase. */
  readonly enginePasses: number;
  /** Every candidate scored, in the order scored, the defaults first. */
  readonly candidates: readonly ScoredCandidate[];
  readonly elapsedMs: number;
}

/** A committed value sitting on the edge of its searched range. */
export interface BoundReached {
  readonly path: string;
  readonly bound: 'min' | 'max';
  readonly value: number;
}

/**
 * Which committed values sit on a bound.
 *
 * The objective was still improving when the box stopped it, so the number committed is the
 * bound's and not the data's. Silence here would let a search space's edge pass for a fit.
 */
const boundsReached = (
  fitted: ScoredCandidate,
  space: readonly SearchParameter[],
): readonly BoundReached[] =>
  space.flatMap<BoundReached>(({ path, min, max }) => {
    const value = fitted.candidate.values[path];
    if (value === undefined || value === defaultAt(path)) return [];
    if (value === min) return [{ path, bound: 'min', value }];
    if (value === max) return [{ path, bound: 'max', value }];
    return [];
  });

/**
 * A fit as text two runs must agree on, character for character: everything but the
 * wall-clock timings, which are properties of the machine and not of the search.
 *
 * Shaped after #88's `comparableFigures`, and used the same way: `test/fit.test.ts` compares
 * two runs and two processes through it.
 */
export const comparableFit = (result: FitResult): string =>
  JSON.stringify(result, (key, value: unknown) => (key === 'elapsedMs' ? undefined : value));

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The value `defaultEngineConfig` holds at a path — read from the engine, never restated.
 *
 * A path the configuration object does not hold, or holds something other than a number at,
 * is a search space that has drifted from the object it claims to search, which is the
 * failure #56's leaf-key contract exists to make loud. It is refused by name here too,
 * because a `FitError` naming the path is a better answer than a candidate that silently
 * overrode nothing.
 */
export const defaultAt = (path: string): number => {
  const value = path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      defaultEngineConfig,
    );
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FitError(
      `the search space names ${path}, which the engine's configuration object does not hold as a number; every searched parameter is read from that object (#56)`,
    );
  }
  return value;
};

/** The step grid, so a recorded value is the value that was scored, to the last digit. */
const snap = ({ min, max, step }: SearchParameter, drawn: number): number => {
  const steps = Math.round((drawn - min) / step);
  const value = Math.min(max, Math.max(min, min + steps * step));
  // Float dust: 0.2 · 3 is 0.6000000000000001, and a recorded candidate has to read back as
  // the number it was. Six decimals is finer than any step in the space.
  return Number(value.toFixed(6));
};

/** The values as the nested override layer the engine takes. */
const weightsOf = (values: Readonly<Record<string, number>>): EngineConfigOverrides => {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.');
    if (keys.some((key) => UNSAFE_KEYS.has(key))) {
      throw new FitError(
        `the search space names ${path}, which would write through a prototype rather than into the configuration`,
      );
    }
    let node = root;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      if (typeof next !== 'object' || next === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1] as string] = value;
  }
  /** The engine’s own override type: a partial of `EngineConfig` to any depth. */
  return root as EngineConfigOverrides;
};

const candidateOf = (
  index: number,
  values: Readonly<Record<string, number>>,
  label = index === 0 ? 'the defaults' : `candidate ${String(index)}`,
): Candidate => ({
  index,
  label,
  values,
  weights: weightsOf(values),
});

/** Candidate 0: every searched parameter at the value the engine itself declares. */
const defaultValues = (space: readonly SearchParameter[]): Readonly<Record<string, number>> =>
  Object.fromEntries(space.map(({ path }) => [path, defaultAt(path)]));

/**
 * One drawn candidate: one draw per parameter, in the space’s own order, each snapped to
 * that parameter’s step. The order is what makes the draw replayable from the seed alone.
 */
const drawValues = (
  space: readonly SearchParameter[],
  random: () => number,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    space.map((parameter) => [
      parameter.path,
      snap(parameter, parameter.min + random() * (parameter.max - parameter.min)),
    ]),
  );

/**
 * Refuses a search space that has drifted from the object it claims to search.
 *
 * Checked before the first engine pass rather than discovered at candidate 90: a bound that
 * no longer contains the engine’s own default would make the defaults a point outside the
 * space, and a report that the fit beat them would be a comparison with something the search
 * could never have found.
 */
const assertSpace = (space: readonly SearchParameter[]): void => {
  if (!Array.isArray(space) || space.length === 0) {
    throw new FitError('a fit needs a search space: the engine’s parameters, with their bounds');
  }
  const paths = space.map(({ path }) => path);
  const repeated = paths.filter((path, position) => paths.indexOf(path) !== position);
  if (repeated.length > 0) {
    throw new FitError(
      `the search space names ${String(repeated[0])} twice; a parameter has one range and one step`,
    );
  }
  for (const parameter of space) {
    const { path, min, max, step } = parameter;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      throw new FitError(`${path} has no range to search: min ${String(min)}, max ${String(max)}`);
    }
    if (!Number.isFinite(step) || step <= 0 || step > max - min) {
      throw new FitError(
        `${path} has a step of ${String(step)}, which is not a grid over its range`,
      );
    }
    const value = defaultAt(path);
    if (value < min || value > max) {
      throw new FitError(
        `the engine’s default for ${path} is ${String(value)}, outside the searched range ${String(min)} … ${String(max)}; the defaults have to be a point of the space the fit beat`,
      );
    }
  }
};

/**
 * One candidate scored over the corpus at the run’s seed, through the engine’s own
 * `predict` and #88’s `score`.
 *
 * No baselines: a candidate is compared with the other candidates and with the defaults, and
 * the floor and the reference are the report’s business (#89), not the search’s. That is
 * also what keeps the search to one engine pass per candidate.
 *
 * A record the candidate could not be scored on stops the fit by name. A configuration
 * inside the documented bounds that the engine cannot predict with is a finding about the
 * bounds, and a mean over three records compared with a mean over four would make every
 * figure after it incomparable.
 */
const scoreCandidate = async (
  candidate: Candidate,
  corpus: ScoredCorpus,
  seed: number,
  objective: Objective,
): Promise<ScoredCandidate> => {
  const startedAt = performance.now();
  const result = await score({
    predictor: enginePredictor({ weights: candidate.weights }),
    corpus,
    seed,
    baselines: [],
  });
  const failed = result.predictor.failures;
  if (failed.length > 0) {
    throw new FitError(
      `${candidate.label} scored no figure for ${failed.length === 1 ? 'record' : 'records'} ${failed.map(({ recordId }) => recordId).join(', ')}: ${failed[0]?.reason ?? 'no reason given'}`,
    );
  }
  return {
    candidate,
    objective: objectiveOf(result, objective),
    overall: result.predictor.overall,
    elapsedMs: performance.now() - startedAt,
  };
};

/**
 * Hands back every parameter the objective could not see, measured rather than assumed.
 *
 * Some of the space is provably invisible to this objective: `predict` scores a bare
 * screenshot, so relevance is held at the neutral trait and `beta` - the softmax weight on
 * it - cannot move a figure, and a clamp the draws never reach is the same story. Committing
 * a drawn value for one of those would change the product on the strength of a figure that
 * never measured it: `beta` is live in a goal-driven session even though it is inert here, so
 * an arbitrary 2.0 would quietly change every run with a task in it.
 *
 * So each parameter whose drawn value differs from the default is returned to that default,
 * one at a time, and the candidate re-scored: if the objective is **exactly** what the best
 * candidate scored, the parameter made no difference and the default stays. Exact equality is
 * the right test because the whole pipeline is deterministic at a fixed seed (#88) - a
 * difference of one part in 10^15 is a difference.
 *
 * Greedy and sequential, against the configuration as it stands: each kept revert is part of
 * the next measurement, so a pair that only matters together is never handed back.
 */
const pinInertParameters = async (
  best: ScoredCandidate,
  space: readonly SearchParameter[],
  corpus: ScoredCorpus,
  seed: number,
  objective: Objective,
): Promise<{
  readonly fitted: ScoredCandidate;
  readonly pinned: readonly string[];
  readonly passes: number;
}> => {
  const pinned: string[] = [];
  let passes = 0;
  let values: Record<string, number> = { ...best.candidate.values };

  for (const { path } of space) {
    if (values[path] === defaultAt(path)) continue;
    const reverted = { ...values, [path]: defaultAt(path) };
    const candidate = await scoreCandidate(
      candidateOf(
        best.candidate.index,
        reverted,
        `${best.candidate.label} with ${path} handed back`,
      ),
      corpus,
      seed,
      objective,
    );
    passes += 1;
    if (candidate.objective.value === best.objective.value) {
      values = reverted;
      pinned.push(path);
    }
  }

  /**
   * One final pass, so the committed figures are the figures of the committed configuration
   * rather than figures inferred from another candidate's run.
   */
  const fitted = await scoreCandidate(
    candidateOf(best.candidate.index, values, 'the committed configuration'),
    corpus,
    seed,
    objective,
  );
  if (fitted.objective.value !== best.objective.value) {
    throw new FitError(
      `handing back ${pinned.join(', ')} moved the objective from ${String(best.objective.value)} to ${String(fitted.objective.value)}; a parameter measured as inert one at a time is not inert together`,
    );
  }
  return { fitted, pinned, passes: passes + 1 };
};

/**
 * Fit the engine’s configuration to the benchmark: a seeded, bounded random search over
 * the documented space, maximising the stated objective.
 *
 * The engine’s defaults are scored first, as candidate 0, so the result carries the figure
 * the fit had to beat, measured the same way in the same run rather than quoted from a doc.
 * The best candidate is the highest objective, and a tie keeps the earlier candidate — so a
 * search that finds nothing better returns the defaults rather than a configuration that
 * merely matched them.
 */
export const fit = async (options: FitOptions = {}): Promise<FitResult> => {
  if (typeof options !== 'object' || options === null) {
    throw new FitError(
      'a fit needs a seed and a candidate count, or neither for the committed ones',
    );
  }
  const seed = options.seed ?? FIT_DEFAULTS.seed;
  const candidates = options.candidates ?? FIT_DEFAULTS.candidates;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    /**
     * A whole 32-bit seed, because that is what the generator takes: `createSeededRandom`
     * does `seed >>> 0`, so 1.5 and 4294967297 both draw seed 1's sequence while the file
     * would record the number it was given — a fit that does not name the seed it drew at.
     */
    throw new FitError(
      `the seed is ${String(options.seed)}; a fit is only replayable if it names the seed its candidates were drawn at, which is a whole number from 0 to 4294967295`,
    );
  }
  if (!Number.isInteger(candidates) || candidates < 0) {
    throw new FitError(`${String(options.candidates)} is not a number of candidates to draw`);
  }
  const space = options.space ?? SEARCH_SPACE;
  assertSpace(space);
  const objective = options.objective ?? OBJECTIVE;
  const corpus = options.corpus ?? committedCorpus();
  const engineVersion = enginePredictor().provenance.version;

  const startedAt = performance.now();
  const random = createSeededRandom(seed);
  const scored: ScoredCandidate[] = [];
  let best: ScoredCandidate | null = null;

  const report = (candidate: ScoredCandidate): void => {
    if (options.onProgress === undefined || best === null) return;
    const index = candidate.candidate.index;
    try {
      options.onProgress({
        candidateIndex: index,
        candidatesTotal: candidates + 1,
        objective: candidate.objective.value,
        bestObjective: best.objective.value,
        bestCandidateIndex: best.candidate.index,
        message: `candidate ${String(index)} of ${String(candidates + 1)} — objective ${candidate.objective.value.toFixed(4)} (best ${best.objective.value.toFixed(4)} at candidate ${String(best.candidate.index)})`,
      });
    } catch {
      /**
       * Progress is a side channel for a reader, as it is in #88: a printer on a closed pipe
       * must not throw away a search that has already cost its engine passes.
       */
    }
  };

  for (let index = 0; index <= candidates; index += 1) {
    const candidate =
      index === 0
        ? candidateOf(0, defaultValues(space))
        : candidateOf(index, drawValues(space, random));
    const result = await scoreCandidate(candidate, corpus, seed, objective);
    scored.push(result);
    if (best === null || result.objective.value > best.objective.value) best = result;
    report(result);
  }

  const defaults = scored[0];
  if (defaults === undefined || best === null) {
    throw new FitError('a fit scored no candidate at all, not even the defaults');
  }
  const pin = await pinInertParameters(best, space, corpus, seed, objective);

  return {
    kind: SEARCH_KIND,
    seed,
    space,
    objective,
    engineVersion,
    corpus: {
      id: corpus.id,
      label: corpus.label,
      synthetic: corpus.synthetic,
      records: corpus.records.length,
    },
    defaults,
    best,
    fitted: pin.fitted,
    pinned: pin.pinned,
    atBound: boundsReached(pin.fitted, space),
    enginePasses: scored.length + pin.passes,
    candidates: scored,
    elapsedMs: performance.now() - startedAt,
  };
};

/**
 * The committed record of a fit: what `packages/engine/config/calibrated.json` holds.
 *
 * It extends the engine's own `CalibratedRecord`, so the file this builds is the file the
 * engine reads — the compiler is what keeps the writer and the reader in step, rather than a
 * convention. Beyond the two fields the engine needs, it carries the account of the fit a
 * reviewer repeats it from: the search space with every bound and step, the seed, the
 * objective with its weights, the figure the defaults scored, and the one command.
 *
 * **No timings.** A wall-clock figure in a committed file would make every re-fit a diff and
 * would be a fact about a machine; the cost of the search is in `docs/fitting.md`, measured.
 * What is here is exactly what the same seed and search space produce again.
 */
export interface CalibratedFileRecord extends CalibratedRecord {
  readonly schemaVersion: number;
  readonly engine: { readonly version: string };
  readonly fit: {
    readonly kind: typeof SEARCH_KIND;
    readonly seed: number;
    /** Candidates drawn beside the defaults, which were scored as candidate 0. */
    readonly candidates: number;
    readonly bestCandidateIndex: number;
    /** The one command that repeats the fit. */
    readonly command: string;
    readonly objective: Objective;
    readonly space: readonly (SearchParameter & { readonly default: number })[];
    /** The committed value for every searched parameter, by path. */
    readonly values: Readonly<Record<string, number>>;
    /**
     * Committed values sitting on the edge of their searched range: the bound chose them,
     * not the data. Empty is the ordinary case; `docs/fitting.md` answers for any entry.
     */
    readonly atBound: readonly BoundReached[];
    /** Engine passes the fit made in all: every candidate, plus the pin phase. */
    readonly enginePasses: number;
    /**
     * Parameters whose drawn value the objective could not tell from the engine's default,
     * measured one at a time and left at that default rather than committed.
     */
    readonly pinnedToDefault: readonly string[];
    /** What the engine's own defaults scored on the same objective, in the same run. */
    readonly defaults: {
      readonly objective: number;
      readonly values: Readonly<Record<string, number>>;
      /** …and over the whole corpus, so `overall` below has a baseline to be read against. */
      readonly overall: CorpusFigures | null;
    };
    /** Best minus defaults on the objective: the improvement the fit is committed for. */
    readonly improvement: number;
    /**
     * The same six metrics over the whole corpus, not only the objective's scope. A fit that
     * raised the web figures at the cost of everything else says so here rather than nowhere.
     */
    readonly overall: CorpusFigures | null;
  };
}

/** The six metrics over a whole corpus, with the records behind them. */
export interface CorpusFigures {
  readonly records: number;
  readonly cc: number;
  readonly nss: number;
  readonly kld: number;
  readonly aucJudd: number;
  readonly scanMatch: number;
  readonly sequenceScore: number;
}

const corpusFiguresOf = (aggregate: Aggregate | null): CorpusFigures | null =>
  aggregate === null
    ? null
    : {
        records: aggregate.records,
        cc: aggregate.saliency.cc,
        nss: aggregate.saliency.nss,
        kld: aggregate.saliency.kld,
        aucJudd: aggregate.saliency.aucJudd,
        scanMatch: aggregate.scanpath.scanMatch,
        sequenceScore: aggregate.scanpath.sequenceScore,
      };

/** The file's schema version, so a later shape can be told from this one. */
export const CALIBRATED_SCHEMA_VERSION = 1;

/**
 * The fit's result as the committed record, ready to be written as JSON.
 *
 * Every number here was measured in the run that produced `result`: nothing is quoted from a
 * doc, and the figures and the configuration that earned them leave this function in one
 * object, so the badge's number and the weights behind it cannot disagree.
 */
export const calibratedRecordOf = (result: FitResult): CalibratedFileRecord => {
  const { defaults, fitted, objective } = result;
  const best = fitted;
  const overall = fitted.overall;
  return {
    schemaVersion: CALIBRATED_SCHEMA_VERSION,
    engine: { version: result.engineVersion },
    weights: best.candidate.weights,
    metrics: {
      scope: best.objective.scope,
      corpus: {
        id: result.corpus.id,
        label: result.corpus.label,
        synthetic: result.corpus.synthetic,
        records: best.objective.records,
      },
      seed: result.seed,
      cc: best.objective.saliency.cc,
      nss: best.objective.saliency.nss,
      kld: best.objective.saliency.kld,
      aucJudd: best.objective.saliency.aucJudd,
      scanMatch: best.objective.scanpath.scanMatch,
      sequenceScore: best.objective.scanpath.sequenceScore,
      objective: { id: best.objective.id, value: best.objective.value },
    },
    fit: {
      kind: result.kind,
      seed: result.seed,
      candidates: result.candidates.length - 1,
      bestCandidateIndex: best.candidate.index,
      command: FIT_DEFAULTS.command,
      objective,
      space: result.space.map((parameter) => ({
        ...parameter,
        default: defaultAt(parameter.path),
      })),
      values: best.candidate.values,
      atBound: result.atBound,
      enginePasses: result.enginePasses,
      pinnedToDefault: result.pinned,
      defaults: {
        objective: defaults.objective.value,
        values: defaults.candidate.values,
        overall: corpusFiguresOf(defaults.overall),
      },
      improvement: best.objective.value - defaults.objective.value,
      overall: corpusFiguresOf(overall),
    },
  };
};
