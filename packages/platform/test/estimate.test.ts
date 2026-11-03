import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDirName, writeRun } from '@personavision/contract';
import type { RunUsage } from '@personavision/contract';
import { estimateCostUsd, MODEL_ID_BY_MODE, MODEL_SPEC_BY_ID } from '@personavision/provider';
import type { BilledTokens } from '@personavision/provider';
import { onTheModel, validArtifact } from '../../contract/tests/fixtures.js';
import {
  acceptedEstimateRequest,
  EstimateNotAcceptedError,
  estimateRun,
  measuredHistoryOfRuns,
  providerPrices,
} from '../src/run/estimate.js';
import type {
  CostEstimate,
  EstimateRequest,
  MeasuredHistory,
  MeasuredRun,
  PriceTable,
  RunEstimate,
  StorageEstimate,
  TimeEstimate,
} from '../src/run/estimate.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { hashPassword } from '../src/store/password.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';
import { temporaryDirectories } from './workspace.js';

/**
 * The estimate: how long a hundred agents take and what they cost, as a range with the
 * figures the range was computed from (#283).
 *
 * Every bound asserted here is **recomputed from the returned inputs** rather than compared
 * with a number written down twice: that is what the ticket asks of this suite, because the
 * figures the screen prints under a range have to be the figures the range came from. The
 * price row is the provider's own and `estimateCostUsd` is the provider's own arithmetic —
 * neither is restated here, for the same reason the package under test does not restate them.
 *
 * No network and no key: the history is handed in, and the one suite that reads it off disk
 * writes its own run directories through `@personavision/contract`'s writer.
 */

/** The site every estimate here is for — the origin the committed fixture runs are on. */
const THE_SITE = 'https://example.test/a/cart';

/** Another origin, so a run of this workspace is history for somebody else's site. */
const ANOTHER_ORIGIN = 'https://app.clipforge.example';

const tokens = (
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): BilledTokens => ({ inputTokens, cachedInputTokens, outputTokens });

const measured = (
  runId: string,
  durationMs: number,
  billed: BilledTokens,
  videoBytesPerSession: number,
  engineMode: MeasuredRun['engineMode'] = 'model',
): MeasuredRun => ({
  runId,
  engineMode,
  sessionDurationsMs: [durationMs],
  tokensPerSession: billed,
  videoBytesPerSession,
  browserStartupMs: null,
});

/** The same five runs, on the offline deterministic engine and billing nothing. */
const offline = (runs: readonly MeasuredRun[]): MeasuredRun[] =>
  runs.map((run) => ({ ...run, engineMode: 'offline', tokensPerSession: null }));

/**
 * Five finished runs, one session each, spread the way sessions really are: a session that
 * gives up early is faster and spends less than one that finishes.
 *
 * Nearest-rank over five samples puts the quartiles on real sessions — 90s, 110s and 150s —
 * and the extremes on 60s and 240s, which is what makes the two bound rules assertable.
 */
const FIVE_RUNS: readonly MeasuredRun[] = [
  measured('r1', 60_000, tokens(4_000, 0, 300), 10_000_000),
  measured('r2', 90_000, tokens(6_000, 1_000, 400), 12_000_000),
  measured('r3', 110_000, tokens(6_800, 1_000, 500), 14_000_000),
  measured('r4', 150_000, tokens(9_000, 2_000, 700), 16_000_000),
  measured('r5', 240_000, tokens(14_000, 3_000, 1_200), 20_000_000),
];

const onThisSite = (runs: readonly MeasuredRun[] = FIVE_RUNS): MeasuredHistory => ({
  onSite: runs,
  elsewhere: [],
});

const onOtherSitesOnly = (runs: readonly MeasuredRun[] = FIVE_RUNS): MeasuredHistory => ({
  onSite: [],
  elsewhere: runs,
});

const NOTHING_MEASURED: MeasuredHistory = { onSite: [], elsewhere: [] };

/** A hundred agents, ten at a time — the concurrency is the caller's, never this package's. */
const request = (overrides: Partial<EstimateRequest> = {}): EstimateRequest => ({
  participants: 100,
  siteUrl: THE_SITE,
  engineMode: 'model',
  modelMode: 'standard',
  concurrency: 10,
  ...overrides,
});

/** The reason a figure carries, or `''` for one that was computed. */
const reasonOf = (figure: TimeEstimate | CostEstimate | StorageEstimate): string =>
  figure.state === 'known' ? '' : figure.reason;

const timeOf = (estimate: RunEstimate): Extract<TimeEstimate, { state: 'known' }> => {
  if (estimate.time.state !== 'known') throw new Error(`the time is ${estimate.time.state}`);
  return estimate.time;
};

const costOf = (estimate: RunEstimate): Extract<CostEstimate, { state: 'known' }> => {
  if (estimate.cost.state !== 'known') throw new Error(`the cost is ${estimate.cost.state}`);
  return estimate.cost;
};

const storageOf = (estimate: RunEstimate): Extract<StorageEstimate, { state: 'known' }> => {
  if (estimate.storage.state !== 'known') {
    throw new Error(`the storage is ${estimate.storage.state}`);
  }
  return estimate.storage;
};

describe('the estimate for a run that has not started', () => {
  describe('on a site with a history of its own', () => {
    it('quotes a time range whose arithmetic is the figures it reports', () => {
      const time = timeOf(estimateRun(request(), onThisSite()));

      expect(time.measuredFrom).toBe('this-site');
      expect(time.sessions).toBe(100);
      expect(time.concurrency).toBe(10);
      expect(time.batches).toBe(10);
      expect(time.sessionsMeasured).toBe(5);
      // The middle half of what has been measured here, around a 1:50 median session.
      expect(time.medianSessionMs).toBe(110_000);
      expect(time.sessionMs).toEqual({ low: 90_000, high: 150_000 });

      // Recomputed from what came back, rather than compared with a number written twice.
      const startup = time.browserStartupMs ?? 0;
      expect(time.ms.low).toBe(time.batches * (time.sessionMs.low + startup));
      expect(time.ms.high).toBe(time.batches * (time.sessionMs.high + startup));
      expect(time.ms.low).toBeLessThan(time.ms.high);
    });

    it('quotes a cost range at the provider’s own prices, and restates none of them', () => {
      const cost = costOf(estimateRun(request(), onThisSite()));

      expect(cost.modelId).toBe(MODEL_ID_BY_MODE.standard);
      expect(cost.prices).toEqual(MODEL_SPEC_BY_ID[MODEL_ID_BY_MODE.standard]);
      expect(cost.measuredFrom).toBe('this-site');
      expect(cost.runsMeasured).toBe(5);
      // The quartile runs of the five, ordered by what one session of each cost.
      expect(cost.tokensPerSession.median).toEqual(tokens(6_800, 1_000, 500));
      expect(cost.tokensPerSession.low).toEqual(tokens(6_000, 1_000, 400));
      expect(cost.tokensPerSession.high).toEqual(tokens(9_000, 2_000, 700));

      for (const bound of ['low', 'high'] as const) {
        expect(cost.usdPerSession[bound]).toBe(
          estimateCostUsd(cost.modelId, cost.tokensPerSession[bound]),
        );
        expect(cost.usd[bound]).toBeCloseTo(cost.usdPerSession[bound] * cost.sessions, 8);
      }
      expect(cost.usd.low).toBeLessThan(cost.usd.high);
    });

    it('quotes the storage as the median video a session took, times the sessions', () => {
      const storage = storageOf(estimateRun(request(), onThisSite()));

      expect(storage.measuredFrom).toBe('this-site');
      expect(storage.medianBytesPerSession).toBe(14_000_000);
      expect(storage.runsMeasured).toBe(5);
      expect(storage.bytes).toBe(storage.sessions * storage.medianBytesPerSession);
      expect(storage.bytes).toBe(1_400_000_000);
    });

    it('reports the agents and the concurrency it was handed, and no number of its own', () => {
      const estimate = estimateRun(request({ participants: 37, concurrency: 4 }), onThisSite());

      expect(estimate.agents).toEqual({ participants: 37, sessions: 37, concurrency: 4 });
      // Thirty-seven sessions four at a time is ten batches, the last of them short. It
      // belongs to the time, which is the figure it multiplies.
      expect(timeOf(estimate).batches).toBe(10);
    });

    it('composes no display text: every string it returns is a figure or a name', () => {
      const estimate = estimateRun(request(), onThisSite());

      const strings: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(estimate);

      expect([...new Set(strings)].sort()).toEqual(
        [
          ...new Set([
            THE_SITE,
            'model',
            MODEL_ID_BY_MODE.standard,
            'this-site',
            'known',
            MODEL_SPEC_BY_ID[MODEL_ID_BY_MODE.standard].ratesReadOn,
          ]),
        ].sort(),
      );
    });
  });

  describe('on a site that has never been tested', () => {
    it('says where the median came from, and is wider than its own history would be', () => {
      const borrowed = estimateRun(request(), onOtherSitesOnly());
      const measuredHere = estimateRun(request(), onThisSite());

      const time = timeOf(borrowed);
      expect(time.measuredFrom).toBe('other-sites');
      expect(costOf(borrowed).measuredFrom).toBe('other-sites');
      expect(storageOf(borrowed).measuredFrom).toBe('other-sites');

      // The same five runs, read as somebody else's: every session we have seen, rather
      // than the middle half of the ones we have seen here.
      expect(time.sessionMs).toEqual({ low: 60_000, high: 240_000 });
      const own = timeOf(measuredHere);
      expect(time.ms.high - time.ms.low).toBeGreaterThan(own.ms.high - own.ms.low);
      expect(time.ms.low).toBe(time.batches * time.sessionMs.low);
      expect(costOf(borrowed).usd.high).toBeGreaterThan(costOf(measuredHere).usd.high);
    });

    it('still quotes the median it has, measured over the same sessions', () => {
      const time = timeOf(estimateRun(request(), onOtherSitesOnly()));

      expect(time.medianSessionMs).toBe(110_000);
      expect(time.sessionsMeasured).toBe(5);
    });
  });

  describe('a figure it cannot compute', () => {
    it('names the figure rather than quoting nothing, when nothing has been measured', () => {
      const estimate = estimateRun(request(), NOTHING_MEASURED);

      expect(estimate.time.state).toBe('unknown');
      expect(estimate.cost.state).toBe('unknown');
      expect(estimate.storage.state).toBe('unknown');
      for (const figure of [estimate.time, estimate.cost, estimate.storage]) {
        expect(reasonOf(figure)).not.toBe('');
      }
      // The agents are the request's own numbers, and are known whatever history says.
      expect(estimate.agents).toEqual({ participants: 100, sessions: 100, concurrency: 10 });
    });

    it('names the price row it could not read, and leaves the other two figures standing', () => {
      const unreadable: PriceTable = { rowFor: () => null, usdFor: providerPrices.usdFor };

      const estimate = estimateRun(request(), onThisSite(), unreadable);

      expect(estimate.cost.state).toBe('unknown');
      expect(reasonOf(estimate.cost)).toMatch(/price/i);
      expect(estimate.time.state).toBe('known');
      expect(estimate.storage.state).toBe('known');
    });

    it('names every figure for a test of nobody, rather than quoting a total of zero', () => {
      const estimate = estimateRun(request({ participants: 0 }), onThisSite());

      expect(estimate.agents.participants).toBe(0);
      expect(estimate.time.state).toBe('unknown');
      expect(estimate.cost.state).toBe('unknown');
      expect(estimate.storage.state).toBe('unknown');
      const encoded = JSON.stringify(estimate);
      expect(encoded).not.toContain('"ms"');
      expect(encoded).not.toContain('"usd"');
      expect(encoded).not.toContain('"bytes"');
    });

    it('reports no cost at all for an offline run, and no zero that reads as a price', () => {
      const estimate = estimateRun(
        request({ engineMode: 'offline' }),
        onThisSite(offline(FIVE_RUNS)),
      );

      expect(estimate.cost.state).toBe('nothing-to-pay');
      expect(reasonOf(estimate.cost)).not.toBe('');
      expect(JSON.stringify(estimate.cost)).not.toContain('usd');
      expect(JSON.stringify(estimate.cost)).not.toContain('0.00');
      // The time and the storage of an offline run are measured the same way.
      expect(estimate.time.state).toBe('known');
      expect(estimate.storage.state).toBe('known');
    });

    it('reports no cost figure when no test has recorded what a session spends', () => {
      const unbilled = FIVE_RUNS.map((run) => ({ ...run, tokensPerSession: null }));

      const estimate = estimateRun(request(), onThisSite(unbilled));

      expect(estimate.cost.state).toBe('unknown');
      expect(estimate.time.state).toBe('known');
    });

    it('reports no storage figure when no test has recorded a session’s video', () => {
      const noVideo = FIVE_RUNS.map((run) => ({ ...run, videoBytesPerSession: null }));

      const estimate = estimateRun(request(), onThisSite(noVideo));

      expect(estimate.storage.state).toBe('unknown');
      expect(estimate.time.state).toBe('known');
    });
  });

  describe('each figure takes its own source', () => {
    it('reads the time from this site and the cost from elsewhere, and says so', () => {
      const estimate = estimateRun(request(), {
        onSite: FIVE_RUNS.map((run) => ({ ...run, tokensPerSession: null })),
        elsewhere: FIVE_RUNS,
      });

      expect(timeOf(estimate).measuredFrom).toBe('this-site');
      expect(costOf(estimate).measuredFrom).toBe('other-sites');
    });
  });

  describe('it is quoted from the engine the run would use', () => {
    it('quotes nothing from the offline sessions of a site, for a run on a model', () => {
      const estimate = estimateRun(request(), onThisSite(offline(FIVE_RUNS)));

      // Offline sessions never waited for a model call: they are not this run's history.
      expect(estimate.time.state).toBe('unknown');
      expect(reasonOf(estimate.time)).toContain('model');
      expect(estimate.storage.state).toBe('unknown');
    });

    it('quotes an offline run from the offline sessions, and ignores the model ones', () => {
      const slowerOnTheModel = FIVE_RUNS.map((run) => ({
        ...run,
        sessionDurationsMs: run.sessionDurationsMs.map((ms) => ms * 4),
      }));

      const estimate = estimateRun(request({ engineMode: 'offline' }), {
        onSite: [...offline(FIVE_RUNS), ...slowerOnTheModel],
        elsewhere: [],
      });

      expect(timeOf(estimate).medianSessionMs).toBe(110_000);
      expect(timeOf(estimate).sessionsMeasured).toBe(5);
    });
  });

  describe('one measured session is not a range', () => {
    it('keeps the typical bounds, and says they are, until this site has a spread of its own', () => {
      const oneHere = measured('r0', 111_000, tokens(6_800, 1_000, 500), 14_000_000);

      const estimate = estimateRun(request(), { onSite: [oneHere], elsewhere: FIVE_RUNS });

      const time = timeOf(estimate);
      expect(time.measuredFrom).toBe('other-sites');
      expect(time.sessionMs).toEqual({ low: 60_000, high: 240_000 });
      expect(time.ms.low).toBeLessThan(time.ms.high);
    });

    it('keeps the typical bounds when the middle half of this site’s sessions is flat', () => {
      // Five sessions here, and the middle three of them took exactly as long: the middle
      // half is a point, so it is no more a range than one session is.
      const flatMiddle = [60_000, 110_000, 110_000, 110_000, 240_000].map((ms, index) => ({
        ...measured(`f${String(index)}`, ms, tokens(6_800, 1_000, 500), 14_000_000),
        sessionDurationsMs: [ms],
      }));

      const time = timeOf(estimateRun(request(), { onSite: flatMiddle, elsewhere: FIVE_RUNS }));

      expect(time.measuredFrom).toBe('other-sites');
      expect(time.sessionMs).toEqual({ low: 60_000, high: 240_000 });
    });

    it('quotes the point it measured when nothing anywhere has a spread', () => {
      const oneHere = measured('r0', 111_000, tokens(6_800, 1_000, 500), 14_000_000);

      const time = timeOf(estimateRun(request(), { onSite: [oneHere], elsewhere: [] }));

      expect(time.measuredFrom).toBe('this-site');
      expect(time.sessionMs).toEqual({ low: 111_000, high: 111_000 });
      expect(time.sessionsMeasured).toBe(1);
    });
  });

  describe('a concurrency a typed caller built by hand', () => {
    it('names the figures rather than quoting infinite minutes for nobody at a time', () => {
      const estimate = estimateRun({ ...request(), concurrency: 0 }, onThisSite());

      expect(estimate.time.state).toBe('unknown');
      expect(estimate.cost.state).toBe('unknown');
      expect(estimate.storage.state).toBe('unknown');
      expect(JSON.stringify(estimate)).not.toContain('null');
    });
  });
});

describe('the request an estimate is quoted for', () => {
  const missingOf = (value: unknown): { path: string; message: string }[] => {
    try {
      acceptedEstimateRequest(value, 'standard');
    } catch (error) {
      if (error instanceof EstimateNotAcceptedError) return [...error.issues];
      throw error;
    }
    throw new Error('that request was accepted');
  };

  it('accepts the inputs it is quoted from, and nothing else of the run', () => {
    expect(acceptedEstimateRequest({ ...request(), audienceId: 'not-read' }, 'standard')).toEqual(
      request(),
    );
  });

  it('prices at the workspace’s model mode, whatever mode the body names', () => {
    const asked = { ...request(), modelMode: 'contributor' };

    // The body asked to be quoted at the cheap tier; the workspace pays the standard one.
    expect(acceptedEstimateRequest(asked, 'standard').modelMode).toBe('standard');
    expect(acceptedEstimateRequest(request(), 'contributor').modelMode).toBe('contributor');
  });

  it('refuses a participant count no arithmetic could survive', () => {
    expect(missingOf(request({ participants: 1e308 }))).toEqual([
      { path: 'participants', message: expect.any(String) },
    ]);
  });

  it('refuses a request with no concurrency, naming it rather than defaulting it', () => {
    const { participants, siteUrl, engineMode, modelMode } = request();

    expect(missingOf({ participants, siteUrl, engineMode, modelMode })).toEqual([
      { path: 'concurrency', message: expect.stringContaining('concurrency') },
    ]);
  });

  it('refuses a request with nothing in it, naming every input it is missing', () => {
    expect(
      missingOf({})
        .map((issue) => issue.path)
        .sort(),
    ).toEqual(['concurrency', 'engineMode', 'participants', 'siteUrl']);
  });

  it('refuses a site URL that is not one, at the field it is wrong at', () => {
    expect(missingOf(request({ siteUrl: 'app.clipforge.example' }))).toEqual([
      { path: 'siteUrl', message: expect.any(String) },
    ]);
  });

  it('refuses a concurrency of nobody, which no run could be divided into', () => {
    expect(missingOf(request({ concurrency: 0 }))).toEqual([
      { path: 'concurrency', message: expect.any(String) },
    ]);
  });
});

/** One finished run on `origin`, with these two session durations and this bill. */
const writeMeasuredRun = async (
  runsRoot: string,
  {
    stamp,
    origin,
    durationsMs,
    usage,
  }: { stamp: string; origin: string; durationsMs: readonly number[]; usage?: RunUsage },
): Promise<string> => {
  const runId = runDirName(new Date(stamp), 'a test');
  const artifact = validArtifact();
  const base = usage === undefined ? artifact.run : onTheModel(artifact.run);
  const progress = base.progress;
  if (progress === undefined) throw new Error('the fixture run records no progress');
  artifact.run = {
    ...base,
    runId,
    createdAt: stamp,
    variants: base.variants.map((variant) => ({
      ...variant,
      url: variant.url.replace('https://example.test', origin),
    })),
    progress: {
      ...progress,
      sessions: progress.sessions.map((session, index) => ({
        ...session,
        durationMs: durationsMs[index] ?? session.durationMs,
      })),
    },
    ...(usage === undefined ? {} : { usage }),
  };
  artifact.findings = { ...artifact.findings, runId };
  await writeRun(join(runsRoot, runId), artifact);
  return runId;
};

describe('the history the estimate is quoted from, read off the runs on disk', () => {
  it('pools the sessions of the runs on this site, and the rest as elsewhere', async () => {
    const directories = await temporaryDirectories();
    try {
      const here = await writeMeasuredRun(directories.runsRoot, {
        stamp: '2026-10-24T14:02:00.000Z',
        origin: 'https://example.test',
        durationsMs: [60_000, 120_000],
      });
      const there = await writeMeasuredRun(directories.runsRoot, {
        stamp: '2026-10-25T14:02:00.000Z',
        origin: ANOTHER_ORIGIN,
        durationsMs: [30_000, 40_000],
      });

      const history = await measuredHistoryOfRuns({
        runsRoot: directories.runsRoot,
        runIds: [here, there],
      })(THE_SITE);

      expect(history.onSite.map((run) => run.runId)).toEqual([here]);
      expect(history.onSite[0]?.sessionDurationsMs).toEqual([60_000, 120_000]);
      expect(history.elsewhere.map((run) => run.runId)).toEqual([there]);
      expect(history.elsewhere[0]?.sessionDurationsMs).toEqual([30_000, 40_000]);
    } finally {
      await directories.cleanup();
    }
  });

  it('reads what a session billed as the run’s bill over the sessions it ran', async () => {
    const directories = await temporaryDirectories();
    try {
      const runId = await writeMeasuredRun(directories.runsRoot, {
        stamp: '2026-10-24T14:02:00.000Z',
        origin: 'https://example.test',
        durationsMs: [60_000, 120_000],
        usage: {
          calls: 8,
          inputTokens: 13_600,
          cachedInputTokens: 2_000,
          outputTokens: 1_000,
          reasoningTokens: 800,
          estimatedCostUsd: 0.021,
        },
      });

      const history = await measuredHistoryOfRuns({
        runsRoot: directories.runsRoot,
        runIds: [runId],
      })(THE_SITE);

      // Two sessions on disk, so half of the run's bill each.
      expect(history.onSite[0]?.engineMode).toBe('model');
      expect(history.onSite[0]?.tokensPerSession).toEqual(tokens(6_800, 1_000, 500));
    } finally {
      await directories.cleanup();
    }
  });

  it('reads no bill and no video from an offline run, which recorded neither', async () => {
    const directories = await temporaryDirectories();
    try {
      const runId = await writeMeasuredRun(directories.runsRoot, {
        stamp: '2026-10-24T14:02:00.000Z',
        origin: 'https://example.test',
        durationsMs: [60_000, 120_000],
      });

      const history = await measuredHistoryOfRuns({
        runsRoot: directories.runsRoot,
        runIds: [runId],
      })(THE_SITE);

      expect(history.onSite[0]?.engineMode).toBe('offline');
      expect(history.onSite[0]?.tokensPerSession).toBeNull();
      expect(history.onSite[0]?.videoBytesPerSession).toBeNull();
      expect(history.onSite[0]?.browserStartupMs).toBeNull();
    } finally {
      await directories.cleanup();
    }
  });

  it('skips a run directory it cannot read rather than failing the estimate', async () => {
    const directories = await temporaryDirectories();
    try {
      const history = await measuredHistoryOfRuns({
        runsRoot: directories.runsRoot,
        runIds: ['2026-10-24-1402-no-such-run'],
      })(THE_SITE);

      expect(history).toEqual({ onSite: [], elsewhere: [] });
    } finally {
      await directories.cleanup();
    }
  });
});

describe('POST /runs/estimate', () => {
  let served: TestServer;
  let cookie: string;

  /** `null` sends no cookie at all — an explicit `undefined` would take the default. */
  const estimateFor = (body: unknown, as: string | null = cookie): Promise<Response> =>
    served.request('/runs/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(as === null ? {} : { cookie: as }) },
      body: JSON.stringify(body),
    });

  /** What the Launch step sends: the draft's own four inputs. */
  const draft = { participants: 100, siteUrl: THE_SITE, engineMode: 'offline', concurrency: 10 };

  beforeEach(async () => {
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
    });
    const signedIn = await served.signIn({
      email: DEMO_ACCOUNT_EMAIL,
      password: served.platform.seeded?.password ?? '',
    });
    expect(signedIn.status).toBe(200);
    cookie = cookieOf(signedIn);
  });

  afterEach(() => served.close());

  it('answers a signed-in caller with the figures and the inputs behind them', async () => {
    const response = await estimateFor(draft);

    expect(response.status).toBe(200);
    const estimate = (await response.json()) as RunEstimate;
    expect(estimate.agents).toEqual({ participants: 100, sessions: 100, concurrency: 10 });
    // The committed example run is this workspace's own, and it is on this origin.
    const time = timeOf(estimate);
    expect(time.measuredFrom).toBe('this-site');
    expect(time.medianSessionMs).toBe(38_000);
    expect(time.ms.low).toBe(time.batches * time.sessionMs.low);
    expect(estimate.cost.state).toBe('nothing-to-pay');
  });

  it('turns an incomplete request into the fields that are missing', async () => {
    const response = await estimateFor({ participants: 100 });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.issues.map((issue) => issue.path).sort()).toEqual([
      'concurrency',
      'engineMode',
      'siteUrl',
    ]);
  });

  it('is not answered for a caller with no session', async () => {
    const response = await estimateFor(draft, null);

    expect(response.status).toBe(401);
  });

  it('is quoted from the session’s own workspace and no other', async () => {
    const them = await served.platform.store.accounts.create({
      email: 'owner@another.example',
      displayName: 'Another shop owner',
      password: await hashPassword('another-shops-password'),
    });
    await served.platform.store.workspaces.create({
      name: 'Another shop',
      memberAccountIds: [them.id],
    });
    const signedIn = await served.signIn({
      email: 'owner@another.example',
      password: 'another-shops-password',
    });

    const response = await estimateFor(draft, cookieOf(signedIn));

    expect(response.status).toBe(200);
    // This workspace has run nothing, and another workspace's runs are not its history.
    expect(((await response.json()) as RunEstimate).time.state).toBe('unknown');
  });
});

describe('the concurrency this ticket defines', () => {
  it('is nowhere: no literal in the estimate names a number of browsers at a time', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = await Promise.all(
      ['../src/run/estimate.ts', '../src/server/routes/estimate.ts'].map((path) =>
        readFile(join(here, path), 'utf8'),
      ),
    );

    for (const source of sources) {
      // No default, no fallback and no cap of its own: the concurrency is an argument.
      expect(source).not.toMatch(/concurrency\s*(=|\?\?|\|\|)\s*\d/);
      expect(source).not.toMatch(/concurrency\s*:\s*\d/);
    }
  });
});
