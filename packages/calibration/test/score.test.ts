import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultEngineConfig } from '@personavision/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CENTRE_BIAS_PREDICTOR_ID,
  COMMITTED_CORPUS_ID,
  ENGINE_PREDICTOR_ID,
  RANDOM_FIXATION_PREDICTOR_ID,
  SALIENCY_METRIC_PARAMETERS,
  SCANPATH_METRIC_PARAMETERS,
  SCORING_BUDGET,
  ScoreError,
  centreBiasPredictor,
  committedCorpus,
  comparableFigures,
  defaultBaselines,
  enginePredictor,
  loadCorpus,
  randomFixationPredictor,
  score,
  type Aggregate,
  type MarginFigures,
  type RecordCategory,
  type SaliencyScores,
  type ScanpathScores,
  type ScoreProgress,
  type ScoreResult,
  type ScoredCorpus,
  type ScoredPredictor,
} from '../src/index.js';

/**
 * The seed every figure in this file is measured at.
 *
 * One seed, stated here: the figures below are a property of the corpus, the predictors and
 * this number, and nothing else. #87's own table is a mean over the seeds 1–8, and a caller
 * who wants that averages several runs — `score` reports what one seed produced, so two runs
 * of it can be compared character for character.
 */
const SEED = 1;

const engineRun = async (): Promise<ScoreResult> =>
  score({ predictor: enginePredictor(), corpus: committedCorpus(), seed: SEED });

/** The corpus, narrowed to the categories a case is about. */
const corpusOf = (...categories: readonly RecordCategory[]): ScoredCorpus => ({
  ...committedCorpus(),
  id: `${COMMITTED_CORPUS_ID}-${categories.join('-')}`,
  records: loadCorpus().filter((record) => categories.includes(record.category)),
});

const EVERY_FIGURE = ['cc', 'nss', 'kld', 'aucJudd', 'scanMatch', 'sequenceScore'] as const;

/** Every one of the six metrics of a set of figures, so a loop can read them by name. */
const figuresOf = (figures: {
  readonly saliency: SaliencyScores;
  readonly scanpath: ScanpathScores;
}): Readonly<Record<string, number>> => ({ ...figures.saliency, ...figures.scanpath });

describe('scoring the engine over the committed corpus', () => {
  it('reports every metric per record, with the humans behind it', async () => {
    const result = await engineRun();
    const records = result.predictor.records;

    expect(records.map(({ recordId }) => recordId)).toEqual(loadCorpus().map(({ id }) => id));
    expect(result.predictor.failures).toEqual([]);
    for (const figure of records) {
      for (const metric of EVERY_FIGURE) {
        expect(Number.isFinite(figuresOf(figure)[metric]), `${figure.recordId} ${metric}`).toBe(
          true,
        );
      }
      expect(figure.seed).toBe(SEED);
      expect(figure.humans).toBeGreaterThan(0);
      /** The display the humans saw, reported back rather than assumed (#11, story 4). */
      expect(figure.display).toEqual(
        loadCorpus().find(({ id }) => id === figure.recordId)?.display,
      );
    }
  });

  it('reports every metric per category and overall, each with the records behind it', async () => {
    const result = await engineRun();

    /** Four records, one per category: the counts are the corpus's own, not a guess. */
    expect(result.predictor.overall?.records).toBe(4);
    for (const category of ['webpage', 'desktop', 'mobile', 'poster'] as const) {
      const aggregate = result.predictor.categories[category];
      expect(aggregate, category).not.toBeNull();
      expect(aggregate?.records, category).toBe(1);
      for (const metric of EVERY_FIGURE) {
        const figures = figuresOf(aggregate as Aggregate);
        expect(Number.isFinite(figures[metric]), `${category} ${metric}`).toBe(true);
      }
    }
  });

  it('keeps the web category its own figure, never folded into the overall mean', async () => {
    const result = await engineRun();
    const web = result.predictor.categories.webpage;
    const overall = result.predictor.overall;

    expect(web).not.toBeNull();
    expect(web?.records).toBe(1);
    expect(overall?.records).toBe(4);
    /** The two differ on this corpus, which is why one cannot stand in for the other. */
    expect(web?.saliency.cc).not.toBe(overall?.saliency.cc);
  });

  it('reports no figure for a category with no records, rather than a zero', async () => {
    const result = await score({
      predictor: enginePredictor(),
      corpus: corpusOf('webpage'),
      seed: SEED,
    });

    expect(result.predictor.categories.webpage?.records).toBe(1);
    expect(result.predictor.categories.desktop).toBeNull();
    expect(result.predictor.categories.mobile).toBeNull();
    expect(result.predictor.categories.poster).toBeNull();
    /** And the overall figure says how many records it covers (#88). */
    expect(result.predictor.overall?.records).toBe(1);
    expect(result.provenance.corpus.records).toBe(1);
    for (const baseline of result.baselines) {
      expect(baseline.categories.poster, baseline.id).toBeNull();
    }
  });

  it('reports the human-to-human ceiling for every record with more than one human', async () => {
    const result = await engineRun();

    for (const figure of result.predictor.records) {
      if (figure.humans > 1) {
        expect(figure.ceiling, figure.recordId).not.toBeNull();
        expect(figure.humanPairs, figure.recordId).toBeGreaterThan(0);
        expect(Number.isFinite(figure.ceiling?.scanMatch), figure.recordId).toBe(true);
      } else {
        /** One participant: no pair of humans to agree, so no ceiling is claimed. */
        expect(figure.ceiling, figure.recordId).toBeNull();
        expect(figure.humanPairs, figure.recordId).toBe(0);
      }
    }
    /** Three of the four committed records carry more than one scanpath (#82). */
    expect(result.predictor.overall?.ceilingRecords).toBe(3);
    expect(result.predictor.categories.mobile?.ceiling).toBeNull();
    expect(result.predictor.categories.webpage?.ceiling).not.toBeNull();
  });
});

describe('the same corpus, predictor and seed', () => {
  it('produce identical figures across two runs', async () => {
    const [first, again] = [await engineRun(), await engineRun()];

    expect(comparableFigures(again)).toBe(comparableFigures(first));
  });

  it('produce identical figures in a second process', async () => {
    const here = await engineRun();
    const child = fileURLToPath(new URL('score.child.ts', import.meta.url));

    const elsewhere = execFileSync(
      process.execPath,
      ['--conditions', 'development', '--import', 'tsx', child, String(SEED)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );

    /** The child scores the engine alone against its own default baselines, as `engineRun` does. */
    expect(elsewhere).toBe(comparableFigures(here));
  }, 60_000);

  it('and a different seed moves the figures a seed decides', async () => {
    const one = await score({
      predictor: randomFixationPredictor(),
      corpus: committedCorpus(),
      seed: SEED,
      baselines: [],
    });
    const other = await score({
      predictor: randomFixationPredictor(),
      corpus: committedCorpus(),
      seed: SEED + 1,
      baselines: [],
    });

    expect(other.predictor.overall?.saliency.cc).not.toBe(one.predictor.overall?.saliency.cc);
  });
});

describe('the figures against the baselines', () => {
  it('beat the random-fixation baseline on CC and on ScanMatch over the whole corpus', async () => {
    const result = await engineRun();
    const random = result.margins.find(
      ({ baselineId }) => baselineId === RANDOM_FIXATION_PREDICTOR_ID,
    );

    expect(random?.overall?.records).toBe(4);
    expect(random?.overall?.saliency.cc).toBeGreaterThan(0);
    expect(random?.overall?.scanpath.scanMatch).toBeGreaterThan(0);
    /** And in the web category on its own, which is what this product is for. */
    expect(random?.categories.webpage?.saliency.cc).toBeGreaterThan(0);
    expect(random?.categories.webpage?.scanpath.scanMatch).toBeGreaterThan(0);
  });

  it('report the margin over the centre-bias prior whichever way it falls', async () => {
    const result = await engineRun();
    const prior = result.margins.find(({ baselineId }) => baselineId === CENTRE_BIAS_PREDICTOR_ID);

    /**
     * No sign is asserted. A negative margin over the prior is a reported result and not a
     * test failure (#87, #88): human gaze is strongly centre-biased, and on the flattest
     * record of the corpus the prior wins on CC. What is asserted is that the number is
     * there, per category and overall, with the records behind it.
     */
    expect(prior?.overall?.records).toBe(4);
    const overall = figuresOf(prior?.overall as MarginFigures);
    for (const metric of EVERY_FIGURE) {
      expect(Number.isFinite(overall[metric]), metric).toBe(true);
    }
    for (const category of ['webpage', 'desktop', 'mobile', 'poster'] as const) {
      expect(prior?.categories[category]?.records, category).toBe(1);
    }
  });

  it('carry both baselines, scored on the same records through the same seam', async () => {
    const result = await engineRun();

    expect(result.baselines.map(({ id }) => id)).toEqual([
      CENTRE_BIAS_PREDICTOR_ID,
      RANDOM_FIXATION_PREDICTOR_ID,
    ]);
    for (const baseline of result.baselines) {
      expect(baseline.overall?.records, baseline.id).toBe(4);
      expect(
        baseline.records.map(({ recordId }) => recordId),
        baseline.id,
      ).toEqual(result.predictor.records.map(({ recordId }) => recordId));
      /** The ceiling is the record's, so it is the same number whoever predicted. */
      expect(baseline.overall?.ceiling, baseline.id).toEqual(result.predictor.overall?.ceiling);
    }
  });
});

describe('the provenance a figure is quoted with', () => {
  it('names the engine version, its calibrated flag and the kernel its map was drawn with', async () => {
    const result = await engineRun();
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../engine/package.json', import.meta.url), 'utf8'),
    );

    expect(result.predictor.provenance.version).toBe(
      (manifest as { readonly version: string }).version,
    );
    /** False until #90 commits `config/calibrated.json`: never a fabricated number (#11). */
    expect(result.predictor.provenance.calibrated).toBe(false);
    expect(result.predictor.provenance.mapKernel).toEqual({
      drawnFrom: 'fixations',
      cellPx: defaultEngineConfig.prediction.map.cellPx,
      sigmaShare: defaultEngineConfig.prediction.map.kernelSigmaShare,
      sigmaRelativeTo: 'map-longer-side',
      truncationSigmas: defaultEngineConfig.prediction.map.kernelRadiusSigmas,
      dwellWeightExponent: defaultEngineConfig.prediction.map.dwellWeightExponent,
      normalisation: 'sum-to-one',
    });
  });

  it('names the corpus, the seed and the metric parameters', async () => {
    const result = await engineRun();

    expect(result.provenance.corpus).toEqual({
      id: COMMITTED_CORPUS_ID,
      label: 'the committed synthetic corpus',
      /** Labelled synthetic at the source, so #89's heading cannot quietly drop it. */
      synthetic: true,
      records: 4,
    });
    expect(result.provenance.seed).toBe(SEED);
    expect(result.provenance.predictorIds).toEqual([
      ENGINE_PREDICTOR_ID,
      CENTRE_BIAS_PREDICTOR_ID,
      RANDOM_FIXATION_PREDICTOR_ID,
    ]);
    /** The rulers themselves, not a copy: #90 fits the engine and never these. */
    expect(result.provenance.saliencyMetricParameters).toBe(SALIENCY_METRIC_PARAMETERS);
    expect(result.provenance.scanpathMetricParameters).toBe(SCANPATH_METRIC_PARAMETERS);
  });

  it('says where the prior drew its map differently rather than hiding it in an average', async () => {
    const result = await engineRun();
    const divergences = result.provenance.mapKernelDivergences;

    /**
     * The random baseline is rendered at the engine's own kernel, so the engine's margin over
     * it is a difference in where each one looked. The prior is one broad kernel at a point,
     * and #87 measured how much of a CC margin that blur is worth — so the difference is
     * named here.
     */
    expect(divergences.map(({ otherId }) => otherId)).toEqual([CENTRE_BIAS_PREDICTOR_ID]);
    expect(divergences[0]?.predictorId).toBe(ENGINE_PREDICTOR_ID);
    expect(divergences[0]?.fields).toEqual([
      'drawnFrom',
      'sigmaShare',
      'sigmaRelativeTo',
      'truncationSigmas',
      'dwellWeightExponent',
    ]);
    expect(result.provenance.mapKernels[RANDOM_FIXATION_PREDICTOR_ID]).toEqual(
      result.provenance.mapKernels[ENGINE_PREDICTOR_ID],
    );
  });

  it('cannot be left out: a predictor with no provenance scores nothing', async () => {
    const withoutProvenance = {
      id: 'nameless',
      label: 'a predictor that will not say what it is',
      predictor: enginePredictor().predictor,
    } as unknown as ScoredPredictor;

    await expect(
      score({ predictor: withoutProvenance, corpus: committedCorpus(), seed: SEED }),
    ).rejects.toThrow(ScoreError);
    await expect(
      score({
        predictor: enginePredictor(),
        corpus: committedCorpus(),
        seed: SEED,
        baselines: [withoutProvenance],
      }),
    ).rejects.toThrow(/carries no provenance/);
  });

  it('cannot be half there either: a kernel or a version left out is refused by name', async () => {
    const engine = enginePredictor();
    const cases: readonly { readonly what: string; readonly predictor: ScoredPredictor }[] = [
      {
        what: 'no map kernel',
        predictor: {
          ...engine,
          provenance: { version: '1.2.3', calibrated: false },
        } as unknown as ScoredPredictor,
      },
      {
        what: 'no version',
        predictor: {
          ...engine,
          provenance: { ...engine.provenance, version: '' },
        },
      },
      {
        what: 'no calibrated flag',
        predictor: {
          ...engine,
          provenance: { ...engine.provenance, calibrated: undefined },
        } as unknown as ScoredPredictor,
      },
      {
        what: 'a kernel with no spread',
        predictor: {
          ...engine,
          provenance: {
            ...engine.provenance,
            mapKernel: { ...engine.provenance.mapKernel, sigmaShare: Number.NaN },
          },
        },
      },
    ];

    for (const { what, predictor } of cases) {
      await expect(
        score({ predictor, corpus: committedCorpus(), seed: SEED }),
        what,
      ).rejects.toThrow(ScoreError);
    }
  });

  it('and a corpus that cannot name itself scores nothing', async () => {
    const nameless = { ...committedCorpus(), id: '' } as ScoredCorpus;
    const unlabelled = { ...committedCorpus(), synthetic: undefined } as unknown as ScoredCorpus;
    const empty = { ...committedCorpus(), records: [] };

    await expect(
      score({ predictor: enginePredictor(), corpus: nameless, seed: SEED }),
    ).rejects.toThrow(/carries no identity/);
    await expect(
      score({ predictor: enginePredictor(), corpus: unlabelled, seed: SEED }),
    ).rejects.toThrow(/synthetic/);
    await expect(
      score({ predictor: enginePredictor(), corpus: empty, seed: SEED }),
    ).rejects.toThrow(/holds no record/);
    await expect(
      score({
        predictor: enginePredictor(),
        corpus: committedCorpus(),
        seed: Number.NaN,
      }),
    ).rejects.toThrow(/seed/);
  });
});

describe('a run a person can read, inside a budget', () => {
  it('reports progress per prediction, naming the predictor and the record', async () => {
    const seen: ScoreProgress[] = [];
    const result = await score({
      predictor: enginePredictor(),
      corpus: committedCorpus(),
      seed: SEED,
      onProgress: (progress) => seen.push(progress),
    });

    /** Four records for each of the three predictors, in the order they were scored. */
    expect(seen).toHaveLength(12);
    expect(seen.map(({ predictorId }) => predictorId).slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () => ENGINE_PREDICTOR_ID),
    );
    expect(seen.slice(0, 4).map(({ predictionsDone }) => predictionsDone)).toEqual([1, 2, 3, 4]);
    expect(seen[0]?.predictionsTotal).toBe(4);
    expect(seen[0]?.message).toBe('engine: 1 of 4 records — webpage-bright-hero');
    expect(result.predictor.records).toHaveLength(4);
  });

  it('finishes a full run inside the documented budget', async () => {
    const result = await engineRun();

    /**
     * The bound is far above the measurement `docs/scoring.md` records, because a tighter one
     * would be a test about the machine rather than about the code. What it catches is a
     * change of a different order — a sweep that decodes an image per metric, or a predictor
     * called once per human.
     */
    expect(SCORING_BUDGET.limitMs).toBeGreaterThan(SCORING_BUDGET.measuredMs * 4);
    expect(result.elapsedMs).toBeLessThan(SCORING_BUDGET.limitMs);
    expect(SCORING_BUDGET.machine.length).toBeGreaterThan(0);
    expect(SCORING_BUDGET.corpusId).toBe(COMMITTED_CORPUS_ID);
  });

  it('reports a failed record rather than losing the sweep', async () => {
    const breaks = loadCorpus()[1]?.id;
    const brittle: ScoredPredictor = {
      ...enginePredictor(),
      id: 'brittle',
      predictor: (image, seed) => {
        if (image.size.width === 320 && image.size.height === 240) {
          throw new Error('this predictor cannot read a landscape image');
        }
        return enginePredictor().predictor(image, seed);
      },
    };

    const result = await score({
      predictor: brittle,
      corpus: committedCorpus(),
      seed: SEED,
      baselines: [],
    });

    /** Three of the four records are 320 × 240, so one figure survives and three are named. */
    expect(result.predictor.failures.map(({ recordId }) => recordId)).toContain(breaks);
    expect(result.predictor.failures).toHaveLength(3);
    expect(result.predictor.failures[0]?.reason).toContain('landscape');
    expect(result.predictor.overall?.records).toBe(1);
    expect(result.predictor.categories.mobile?.records).toBe(1);
    expect(result.predictor.categories.webpage).toBeNull();
  });

  it('names a record whose image is not there, and scores the rest', async () => {
    const corpus = committedCorpus();
    const missing = {
      ...corpus,
      records: corpus.records.map((record, position) =>
        position === 0 ? { ...record, imagePath: `${record.imagePath}.gone` } : record,
      ),
    };

    const result = await score({
      predictor: enginePredictor(),
      corpus: missing,
      seed: SEED,
      baselines: [],
    });

    /**
     * The image is read at the moment the record is scored, not for the whole corpus up
     * front — the real dataset is 1,980 screenshots (#85) — so a record with no readable
     * image is one named failure rather than a run that never starts.
     */
    expect(result.predictor.failures.map(({ recordId }) => recordId)).toEqual([
      corpus.records[0]?.id,
    ]);
    expect(result.predictor.failures[0]?.reason).toContain('ENOENT');
    expect(result.predictor.overall?.records).toBe(3);
    expect(result.predictor.categories.webpage).toBeNull();
  });
});

describe('with no network and no API key', () => {
  const fetchAsItWas = globalThis.fetch;
  const keysAsTheyWere = { ...process.env };

  afterEach(() => {
    globalThis.fetch = fetchAsItWas;
    process.env = { ...keysAsTheyWere };
  });

  it('a full run over the committed corpus still produces every figure', async () => {
    globalThis.fetch = (() => {
      throw new Error('a scoring run opened a socket');
    }) as typeof globalThis.fetch;
    for (const key of Object.keys(process.env)) {
      if (key.includes('API_KEY') || key.includes('TOKEN')) delete process.env[key];
    }

    const result = await score({
      predictor: enginePredictor(),
      corpus: committedCorpus(),
      /** Both baselines as well, so nothing on the path is exercised only by the engine. */
      baselines: defaultBaselines(),
      seed: SEED,
    });

    expect(result.predictor.failures).toEqual([]);
    expect(result.predictor.overall?.records).toBe(4);
    for (const baseline of result.baselines) expect(baseline.failures, baseline.id).toEqual([]);
  });

  it('and the scoring reaches for no socket at all', () => {
    const sources = ['../src/score/score.ts', '../src/score/index.ts'].map((entry) => ({
      entry,
      text: readFileSync(new URL(entry, import.meta.url), 'utf8'),
    }));

    /**
     * `node:fs` is not on this list and cannot be: a record's image is bytes on disk, and
     * reading them is what the engine is handed. What is asserted is that nothing here opens
     * a socket or draws an unseeded number — the engine's own purity is asserted in
     * `packages/engine/tests/config.test.ts`.
     */
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

describe('the baselines as scored predictors', () => {
  it('each carry a version, no calibrated flag and their own kernel', () => {
    for (const baseline of [centreBiasPredictor(), randomFixationPredictor()]) {
      expect(baseline.provenance.version.length, baseline.id).toBeGreaterThan(0);
      /** `null`, not `false`: a baseline has no configuration to calibrate. */
      expect(baseline.provenance.calibrated, baseline.id).toBeNull();
      expect(baseline.provenance.mapKernel.normalisation, baseline.id).toBe('sum-to-one');
    }
  });

  it('and the prior is the one drawn as a position prior', () => {
    expect(centreBiasPredictor().provenance.mapKernel.drawnFrom).toBe('position-prior');
    expect(randomFixationPredictor().provenance.mapKernel.drawnFrom).toBe('fixations');
  });
});
