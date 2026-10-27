import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMITTED_CORPUS_ID,
  REGRESSION_TOLERANCE,
  REPORT_METRIC_IDS,
  REPORT_SEED,
  ReportError,
  SCANPATH_METRICS,
  SCOPES,
  SCORING_BUDGET,
  breachesOf,
  committedCorpus,
  describeBreach,
  enginePredictor,
  floorsOf,
  loadCorpus,
  loadHistory,
  score,
  type Floor,
  type History,
  type RecordedFigures,
  type ScoreResult,
  type ScoredCorpus,
} from '../src/index.js';

/**
 * The regression gate (#89): the engine cannot get less human-like without saying so.
 *
 * Every figure of the committed report is held to the floor the last recorded measurement
 * put it at (`docs/calibration/history.json`). A fall past that floor by more than the
 * metric's tolerance fails this file — and the one command that runs it is
 * `pnpm --filter @personavision/calibration run gate`, which CI runs as its own step.
 *
 * **Fixed seed, fixed corpus.** The committed synthetic corpus (#82) and the seed the
 * figures were measured at, so this test is about the engine and nothing else: no download,
 * no network and no API key.
 *
 * **The tolerance.** `REGRESSION_TOLERANCE` states it per metric with the argument for its
 * size beside it. The short version: the figures are deterministic on one machine, so the
 * tolerance exists only for the drift between the machine the floors were measured on and
 * the one the gate runs on, and each is at most a hundredth of the range its metric covers
 * over this corpus. A worker who needs one wider has to replace that argument.
 */

const SEED = REPORT_SEED;

const run = async (weights?: Parameters<typeof enginePredictor>[0]): Promise<ScoreResult> =>
  score({
    predictor: enginePredictor(weights),
    corpus: committedCorpus(),
    /** The gate is about the engine; the baselines are the report's business, not its. */
    baselines: [],
    seed: SEED,
  });

/**
 * The engine with the fit handed back: the three values #90 moved, returned to the engine's
 * own defaults as `packages/engine/config/calibrated.json` records them.
 *
 * This is the regression the gate exists for — a change that loses the fit without anyone
 * noticing — rather than an invented bad configuration, so what it asserts is the gate
 * catching the thing it was built to catch.
 */
const DE_FITTED = {
  weights: { fixationDuration: { medianMs: 250, logSigma: 0.45, minMs: 80 } },
} as const;

const floors = (): readonly Floor[] => floorsOf(loadHistory());

/** The committed history with one figure moved, so a direction can be asserted on its own. */
const historyWith = (
  scope: (typeof SCOPES)[number],
  edit: (figures: RecordedFigures) => RecordedFigures,
): History => {
  const history = loadHistory();
  const last = history.rows.at(-1);
  if (last === undefined) throw new Error('the committed history has no row');
  const figures = last.figures[scope];
  if (figures === null || figures === undefined) throw new Error(`no ${scope} figures to move`);
  return {
    ...history,
    rows: [
      ...history.rows.slice(0, -1),
      { ...last, figures: { ...last.figures, [scope]: edit(figures) } },
    ],
  };
};

describe('the gate on the committed configuration', () => {
  it('passes: every figure is at or above the floor the last measurement recorded', async () => {
    const breaches = breachesOf(await run(), floors());

    expect(breaches.map(describeBreach)).toEqual([]);
  }, 60_000);

  it('holds every scope and every metric the last recorded measurement holds', () => {
    const held = floors();

    for (const scope of SCOPES) {
      for (const metric of REPORT_METRIC_IDS) {
        expect(
          held.some((floor) => floor.scope === scope && floor.metric === metric),
          `${scope} ${metric}`,
        ).toBe(true);
      }
    }
    expect(held).toHaveLength(SCOPES.length * REPORT_METRIC_IDS.length);
  });

  it('reads its floors from the committed file, at the corpus and seed the report names', async () => {
    const result = await run();
    const last = loadHistory().rows.at(-1);

    expect(last?.corpus.id).toBe(COMMITTED_CORPUS_ID);
    expect(last?.seed).toBe(result.provenance.seed);
    expect(result.provenance.corpus.id).toBe(COMMITTED_CORPUS_ID);
  }, 60_000);
});

describe('the gate on a knowingly worsened configuration', () => {
  it('fails when the fit is handed back to the engine’s defaults', async () => {
    const breaches = breachesOf(await run(DE_FITTED), floors());

    expect(breaches).not.toEqual([]);
    /** The fit was made on the web category's ScanMatch, so that is where it has to show. */
    const web = breaches.find(
      (breach) => breach.scope === 'webpage' && breach.metric === 'scanMatch',
    );
    expect(web).toBeDefined();
    expect(web?.measured).toBeLessThan(web?.floor ?? 0);
    expect(web?.beyond).toBeGreaterThan(REGRESSION_TOLERANCE.scanMatch);
  }, 60_000);

  it('and says which metric, which floor, which tolerance and how far past it fell', async () => {
    const breaches = breachesOf(await run(DE_FITTED), floors());
    const web = breaches.find(
      (breach) => breach.scope === 'webpage' && breach.metric === 'scanMatch',
    );
    if (web === undefined) throw new Error('the de-fitted engine did not breach the web floor');

    const said = describeBreach(web);

    expect(said).toContain('webpage');
    expect(said).toContain(SCANPATH_METRICS.scanMatch.label);
    expect(said).toContain(web.floor.toFixed(4));
    expect(said).toContain(web.measured.toFixed(4));
    expect(said).toContain(String(web.tolerance));
    expect(said).toContain(web.recordedOn);
  }, 60_000);

  it('and the fall is far larger than the tolerance, which is why the tolerance is where it is', async () => {
    const breaches = breachesOf(await run(DE_FITTED), floors());
    const web = breaches.find(
      (breach) => breach.scope === 'webpage' && breach.metric === 'scanMatch',
    );

    // Eighteen tolerances. A regression this gate would miss has to be smaller than a
    // hundredth of the metric's range, and this one is nowhere near that.
    expect((web?.beyond ?? 0) / REGRESSION_TOLERANCE.scanMatch).toBeGreaterThan(10);
  }, 60_000);
});

describe('a metric is read in its own direction', () => {
  it('a higher-is-better figure fails by falling, and passes inside the tolerance', async () => {
    const result = await run();
    const measured = result.predictor.categories.webpage?.saliency.cc ?? 0;

    const inside = breachesOf(
      result,
      floorsOf(historyWith('webpage', (figures) => ({ ...figures, cc: measured + 0.009 }))),
    );
    const past = breachesOf(
      result,
      floorsOf(historyWith('webpage', (figures) => ({ ...figures, cc: measured + 0.02 }))),
    );

    expect(inside.map(describeBreach)).toEqual([]);
    expect(past.map(({ scope, metric }) => `${scope} ${metric}`)).toEqual(['webpage cc']);
  }, 60_000);

  it('and KLD, which is lower-is-better, fails by rising rather than by falling', async () => {
    const result = await run();
    const measured = result.predictor.categories.webpage?.saliency.kld ?? 0;

    /** A floor far *below* the measurement: for a lower-is-better metric that is a breach. */
    const risen = breachesOf(
      result,
      floorsOf(historyWith('webpage', (figures) => ({ ...figures, kld: measured - 1 }))),
    );
    /** And a floor above it is not, however far above: KLD improving is KLD falling. */
    const fallen = breachesOf(
      result,
      floorsOf(historyWith('webpage', (figures) => ({ ...figures, kld: measured + 1 }))),
    );

    expect(risen.map(({ scope, metric }) => `${scope} ${metric}`)).toEqual(['webpage kld']);
    expect(risen[0]?.direction).toBe('lower-is-better');
    expect(fallen.map(describeBreach)).toEqual([]);
  }, 60_000);

  it('and every metric carries a tolerance, none of them zero', () => {
    for (const metric of REPORT_METRIC_IDS) {
      expect(REGRESSION_TOLERANCE[metric], metric).toBeGreaterThan(0);
    }
    expect(Object.keys(REGRESSION_TOLERANCE).sort()).toEqual([...REPORT_METRIC_IDS].sort());
  });
});

describe('a gate that stopped measuring', () => {
  it('is a failure of its own: a scope the floors hold and the run does not', async () => {
    const withoutTheWeb: ScoredCorpus = {
      ...committedCorpus(),
      id: `${COMMITTED_CORPUS_ID}-no-web`,
      records: loadCorpus().filter((record) => record.category !== 'webpage'),
    };

    const result = await score({
      predictor: enginePredictor(),
      corpus: withoutTheWeb,
      baselines: [],
      seed: SEED,
    });

    expect(() => breachesOf(result, floors())).toThrowError(ReportError);
    expect(() => breachesOf(result, floors())).toThrowError(/stops measuring/);
  }, 60_000);

  it('and a history with no row at all cannot hold the engine to anything', () => {
    expect(() => floorsOf({ schemaVersion: 1, rows: [] })).toThrowError(/no measurement/);
  });
});

describe('the gate runs with no network and no API key', () => {
  const fetchAsItWas = globalThis.fetch;
  const keysAsTheyWere = { ...process.env };

  afterEach(() => {
    globalThis.fetch = fetchAsItWas;
    process.env = { ...keysAsTheyWere };
  });

  it('with the socket taken away and every key deleted', async () => {
    globalThis.fetch = (() => {
      throw new Error('the gate opened a socket');
    }) as typeof globalThis.fetch;
    for (const key of Object.keys(process.env)) {
      if (key.includes('API_KEY') || key.includes('TOKEN')) delete process.env[key];
    }

    const breaches = breachesOf(await run(), floors());

    expect(breaches.map(describeBreach)).toEqual([]);
  }, 60_000);

  it('and the report module reaches for no socket at all', () => {
    const sources = ['../src/report/render.ts', '../src/report/index.ts'].map((entry) => ({
      entry,
      text: readFileSync(new URL(entry, import.meta.url), 'utf8'),
    }));

    /**
     * `node:fs` is not on this list and cannot be: the report and the history are files in
     * this repository, and reading them is the whole job. What is asserted is that nothing
     * here opens a socket or draws an unseeded number.
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

describe('inside a documented time budget', () => {
  it('one gated run costs about what #88 measured a scoring run at', async () => {
    const started = performance.now();

    await run();

    // The gate is one engine pass over the four committed records, which `SCORING_BUDGET`
    // measured at 34 ms and bounds at four seconds — loose on purpose, because the suite
    // runs beside several others and a tight figure would be a test about the machine. The
    // CI step's own budget is five minutes, which covers the install-free command around it.
    expect(performance.now() - started).toBeLessThan(SCORING_BUDGET.limitMs);
  }, 60_000);
});
