import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPaths, runSchema } from '@personavision/contract';
import type { ModelMode, RunRequest } from '@personavision/contract';
import { estimateCostUsd, MODEL_ID_BY_MODE, MODEL_SPEC_BY_ID } from '@personavision/provider';
import type { BilledTokens, ModelSpec, PricedModelId } from '@personavision/provider';
import { parseSiteUrl, SiteUrlNotAcceptedError } from '../site/index.js';

/**
 * The estimate: how long a hundred agents will take, what they will cost and what they will
 * store — **as a range, labelled as a range**, with every figure the range was computed from
 * (`docs/FLOW.md` section 13).
 *
 * It returns **figures and the inputs they came from, and never a composed sentence**. The
 * launch step (#279) prints the words; `#screen-newtest-estimate` in
 * `docs/design/prototype.html` shows which words come from which figure, and the one thing
 * this module owes that screen is that each cell has a field behind it — including the cell
 * that says a figure could not be computed.
 *
 * Three rules this module holds to, each because its opposite is a lie a screen would print:
 *
 * - **An offline run reports no cost at all**, with the reason, rather than `$0.00` — a zero
 *   reads as a price somebody checked.
 * - **A figure that cannot be computed is named**, and no total is returned that silently
 *   leaves it out. A test of nobody is quoted no minutes, no dollars and no gigabytes.
 * - **No number of its own.** The concurrency is an argument (#239 owns the per-site cap and
 *   #241 hands it to a run), the prices are `@personavision/provider`'s table and its
 *   arithmetic, and everything else is measured. Nothing here is a default that could
 *   disagree with the module that owns it.
 *
 * Its input is a **plain estimate request, not a launch**: the participants, the site URL,
 * the engine mode and the concurrency. It deliberately waits on neither the one-URL request
 * schema nor a stored site — an estimate is quoted for a draft, and a draft is not a run —
 * and it writes nothing: no run directory, no record, no artifact field.
 *
 * **A site with no history of its own** is quoted from the sessions we have measured on
 * other sites, said so in `measuredFrom`, and quoted **wider**: the owner's decision 79 for
 * the New test area asks for "a typical session, labelled as not yours yet", and a range
 * that is deliberately wider than it will be next time. See `BOUNDS_AT`.
 */

/** Where a figure's numbers were measured. The screen says which, in its own words. */
export type MeasuredFrom = 'this-site' | 'other-sites';

/**
 * The quantiles a figure's two bounds are taken at, by where its numbers came from.
 *
 * **This site's own sessions**: the middle half of them. The extremes of a site we have
 * measured are one slow afternoon and one session that gave up on the first screen, and
 * quoting them as the range would make every estimate useless.
 *
 * **Somebody else's sessions**: all of them, end to end. We have measured nothing here, so
 * the honest bound is every session we have ever seen rather than the middle half of
 * sessions on other people's sites — which is what makes a borrowed range wider than an
 * own-history one over the same sessions, as decision 79 asks. It narrows to the middle half
 * the moment this site has finished one test.
 */
const BOUNDS_AT: Readonly<Record<MeasuredFrom, { readonly low: number; readonly high: number }>> = {
  'this-site': { low: 0.25, high: 0.75 },
  'other-sites': { low: 0, high: 1 },
};

/** The median is the median whatever the bounds are taken at: it is the figure, not a bound. */
const MEDIAN = 0.5;

/**
 * What an estimate is quoted from: a draft's own four inputs, and the mode its workspace
 * pays for. Nothing else of a run — no audience, no seed, no site record.
 */
export interface EstimateRequest {
  /**
   * The agents, and the sessions: **one session each**, which is what a hundred agents on
   * one URL means (`docs/FLOW.md` section 13, step #222).
   *
   * It is deliberately not an audience and a `repeats`: the two-variant A/B path runs
   * `people × repeats × variants` sessions, and an estimate for one of those is a different
   * question with two more inputs. Nothing asks it today — the launch step this feeds is
   * path 1 — and a caller that one day does must add the inputs rather than be quoted a
   * sixth of its run.
   */
  readonly participants: number;
  /** The site the feature starts on, as the user typed it. */
  readonly siteUrl: string;
  readonly engineMode: RunRequest['engineMode'];
  /**
   * Which model the sessions would decide on, for the price row. **Not the submitter's to
   * name**: it hangs off the workspace (#144), `startTest` puts the workspace's mode over
   * whatever a draft said, and an estimate quoted at another mode's rates would be a price
   * for a test that cannot run — twelve times out on input in the cheap direction. So it is
   * required here and `acceptedEstimateRequest` takes it from the caller rather than the
   * body. An offline estimate carries it and does not spend it, as `runRequestSchema` allows.
   */
  readonly modelMode: ModelMode;
  /**
   * How many sessions run at a time. **An argument, never a number of this module's.** The
   * per-site cap lives in `packages/platform`'s caps module (#239) and a run is handed one
   * by #241; until then the caller names it and this package has no opinion on it.
   */
  readonly concurrency: number;
}

/**
 * What a caller submits: the request without the model mode, which is the workspace's.
 * The shape `TestDraft` has for the same reason (`run/start.ts`).
 */
export type EstimateDraft = Omit<EstimateRequest, 'modelMode'>;

/** A range. Both bounds in the same unit as the figure that carries them. */
export interface Range {
  readonly low: number;
  readonly high: number;
}

/**
 * What one finished run measured, as an estimate reads it.
 *
 * Two grains, because that is how the artifact records them: a **session's** wall clock is
 * its own (`run.progress.sessions[].durationMs`), while what a session **spent** is the run's
 * bill over the sessions it ran (`run.usage`), so a run contributes many durations and one
 * token figure. Both are what they are rather than averages of averages, and `null` means
 * nothing recorded it rather than zero.
 */
export interface MeasuredRun {
  readonly runId: string;
  /**
   * The engine it ran on. A session that waits for a model call per screen is not the same
   * session as one the offline deterministic engine decided, so a figure is only ever
   * measured from runs on the engine being estimated.
   */
  readonly engineMode: RunRequest['engineMode'];
  /** The wall clock of each finished session, in milliseconds. */
  readonly sessionDurationsMs: readonly number[];
  /** What one session of this run billed, or `null` for a run that called no model. */
  readonly tokensPerSession: BilledTokens | null;
  /** The video one session of this run wrote, in bytes, or `null` where none was recorded. */
  readonly videoBytesPerSession: number | null;
  /** How long one session's browser took to be ready, or `null` where nothing timed it. */
  readonly browserStartupMs: number | null;
}

/** The runs behind an estimate, split by whether they were on the site being quoted for. */
export interface MeasuredHistory {
  /** Finished runs on this site. Empty for a site that has never been tested. */
  readonly onSite: readonly MeasuredRun[];
  /** Finished runs on every other site — decision 79's typical session. */
  readonly elsewhere: readonly MeasuredRun[];
}

/** How an estimate reads history. Handed in, so the arithmetic reaches no file system. */
export type MeasuredHistoryReader = (siteUrl: string) => Promise<MeasuredHistory>;

/**
 * The provider's price table, behind one seam — so that a table which cannot be read is a
 * figure this module names rather than a crash, and so that no rate and no arithmetic is
 * restated here.
 */
export interface PriceTable {
  /** The row for a model, or `null` for a table that cannot be read. */
  readonly rowFor: (modelId: PricedModelId) => ModelSpec | null;
  /** What those tokens cost at that model's rates, in US dollars. */
  readonly usdFor: (modelId: PricedModelId, tokens: BilledTokens) => number;
}

/** `@personavision/provider`'s own table and its own arithmetic, and nothing of ours. */
export const providerPrices: PriceTable = {
  rowFor: (modelId) => MODEL_SPEC_BY_ID[modelId] ?? null,
  usdFor: estimateCostUsd,
};

/** A figure that could not be computed, named rather than left out of a total. */
export interface UnknownFigure {
  readonly state: 'unknown';
  /** What was missing, in one plain clause. The screen words it; this is the fact. */
  readonly reason: string;
}

/** An offline run's cost: there is none, which is not the same as a price of zero. */
export interface NothingToPay {
  readonly state: 'nothing-to-pay';
  readonly reason: string;
}

/** How long the run will take, and the arithmetic the two bounds are. */
export interface TimeFigures {
  readonly state: 'known';
  readonly sessions: number;
  readonly concurrency: number;
  /** Sessions over concurrency, rounded up: the batches the run takes. */
  readonly batches: number;
  /** The median finished session the figure is built around, in milliseconds. */
  readonly medianSessionMs: number;
  /** The per-session bounds the range was computed from, in milliseconds. */
  readonly sessionMs: Range;
  readonly measuredFrom: MeasuredFrom;
  /** How many finished sessions those figures were taken over. */
  readonly sessionsMeasured: number;
  /**
   * Browser start-up, added once per batch, or `null` where nothing has timed it — which is
   * every run today: no artifact field records it, and #246 is the ticket that measures what
   * one browser process costs. A screen prints the start-up line only when this is a number.
   */
  readonly browserStartupMs: number | null;
  /** The answer: `batches × (sessionMs + browserStartupMs)`, in milliseconds. */
  readonly ms: Range;
}

export type TimeEstimate = TimeFigures | UnknownFigure;

/** What the model calls will cost, and the figures and the price row behind them. */
export interface CostFigures {
  readonly state: 'known';
  readonly sessions: number;
  /** The model the price row is for, as `@personavision/provider` maps the mode to an id. */
  readonly modelId: PricedModelId;
  /** The provider's own row, passed through — including the date its rates were read. */
  readonly prices: ModelSpec;
  /** What a session has historically billed: the quartile runs, by what a session cost. */
  readonly tokensPerSession: {
    readonly low: BilledTokens;
    readonly median: BilledTokens;
    readonly high: BilledTokens;
  };
  readonly measuredFrom: MeasuredFrom;
  /** How many finished runs those token figures were taken over. */
  readonly runsMeasured: number;
  /** What one session costs at those rates, in US dollars. */
  readonly usdPerSession: Range;
  /** The answer: `usdPerSession × sessions`, in US dollars. */
  readonly usd: Range;
}

export type CostEstimate = CostFigures | NothingToPay | UnknownFigure;

/** What the videos will take on disk, and the figure it was computed from. */
export interface StorageFigures {
  readonly state: 'known';
  readonly sessions: number;
  readonly medianBytesPerSession: number;
  readonly measuredFrom: MeasuredFrom;
  readonly runsMeasured: number;
  /** The answer: `medianBytesPerSession × sessions`, in bytes. */
  readonly bytes: number;
}

export type StorageEstimate = StorageFigures | UnknownFigure;

/**
 * The agents: the request's own numbers, so they are known whatever history says.
 *
 * The batches are **not** here. They are `sessions ÷ concurrency`, which is the first line
 * of the time arithmetic and belongs with it — and a concurrency of nobody would make them
 * `Infinity`, which `JSON.stringify` writes as `null`: a figure that could not be computed,
 * in the one block that promises it always can.
 */
export interface AgentsFigures {
  readonly participants: number;
  /** One session a participant, on the one-URL path this estimate is quoted for. */
  readonly sessions: number;
  readonly concurrency: number;
}

/** What the figures are multiplied up from: the agents, and the batches they run in. */
interface Scale extends AgentsFigures {
  readonly batches: number;
}

/** What the launch step is handed. Figures and their inputs; no sentence to print. */
export interface RunEstimate {
  /** The site quoted for, as the request gave it. */
  readonly siteUrl: string;
  readonly engineMode: RunRequest['engineMode'];
  readonly agents: AgentsFigures;
  readonly time: TimeEstimate;
  readonly cost: CostEstimate;
  readonly storage: StorageEstimate;
}

/** An input an estimate cannot be quoted without, at the field it is missing from. */
export interface EstimateIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A request an estimate cannot be quoted from, reported **at the path each problem is at**,
 * so the launch step renders every message against its own field.
 *
 * It is a refusal and not a figure that could not be computed: an estimate quoted from a
 * default nobody gave would be a number about a run nobody asked for.
 */
export class EstimateNotAcceptedError extends Error {
  readonly issues: readonly EstimateIssue[];

  constructor(issues: readonly EstimateIssue[]) {
    super('that estimate could not be quoted from what was submitted.');
    this.name = 'EstimateNotAcceptedError';
    this.issues = issues;
  }
}

const ENGINE_MODES: readonly RunRequest['engineMode'][] = ['offline', 'model'];

/**
 * A whole number of things, zero included. Safe-integer rather than merely integer, because
 * these are multiplied: `1e308` participants would carry a byte total to `Infinity`, which
 * `JSON.stringify` writes as `null` — a figure that could not be computed and was not named,
 * which is the one thing this module promises never to return. It is not a cap: how many
 * agents a run may have is #239's, and nothing here has an opinion above "a real number".
 */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The submitted body as an estimate request, or the refusal naming what is missing.
 *
 * It reads four fields and ignores everything else a draft may carry: a launch request is
 * not an estimate request, and nothing here resolves an audience, a site record or a seed.
 *
 * `modelMode` arrives as an **argument and not a field**, and a body naming one is dropped
 * on the way through — the mode is the workspace's (#144), exactly as `startTest` parses
 * `{ ...draft, modelMode: workspace.modelMode }` rather than honouring a submitted one.
 */
export const acceptedEstimateRequest = (value: unknown, modelMode: ModelMode): EstimateRequest => {
  const body: Record<string, unknown> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const issues: EstimateIssue[] = [];

  if (!isCount(body.participants)) {
    issues.push({
      path: 'participants',
      message: 'an estimate is quoted for a number of participants: how many agents would run',
    });
  }

  let siteUrl = '';
  try {
    siteUrl = parseSiteUrl(body.siteUrl);
  } catch (error) {
    if (!(error instanceof SiteUrlNotAcceptedError)) throw error;
    for (const issue of error.issues) issues.push({ path: 'siteUrl', message: issue.message });
  }

  const engineMode = body.engineMode as RunRequest['engineMode'];
  if (!ENGINE_MODES.includes(engineMode)) {
    issues.push({
      path: 'engineMode',
      message: `an estimate is quoted for one engine: ${ENGINE_MODES.join(' or ')}`,
    });
  }

  // A positive integer, because the batches are the sessions divided by it: nobody at a
  // time is not a run, and this module has no number to put in its place.
  if (!isCount(body.concurrency) || body.concurrency === 0) {
    issues.push({
      path: 'concurrency',
      message:
        'an estimate is quoted for a concurrency: how many sessions run at a time, from the per-site cap',
    });
  }

  if (issues.length > 0) throw new EstimateNotAcceptedError(issues);

  return {
    participants: body.participants as number,
    siteUrl,
    engineMode,
    modelMode,
    concurrency: body.concurrency as number,
  };
};

/** The sample at a quantile, by nearest rank — so the figure quoted is a session we saw. */
const atQuantile = <T>(sorted: readonly T[], quantile: number): T =>
  sorted[Math.round(quantile * (sorted.length - 1))];

const ascending = (first: number, second: number): number => first - second;

/** The group of runs a figure is measured from: this site's own if it has any. */
interface Measured<T> {
  readonly measuredFrom: MeasuredFrom;
  readonly runs: readonly MeasuredRun[];
  /** Sorted, so the quantiles are taken in order. */
  readonly samples: readonly T[];
}

/**
 * The group of runs a figure is measured from: this site's own, **if they are a range**.
 *
 * Per figure rather than once for the whole estimate: a site may have been tested without
 * ever recording a bill, so its sessions are its own and its token figures are somebody
 * else's, and each figure says where its own numbers came from.
 *
 * The spread is the second condition because of the first test. One measured session is not
 * a range: taking it would narrow "10–40 min, not yours yet" to "18–18 min, measured here"
 * on the strength of a single session, which is the one over-confident answer this module
 * must not give. Where this site's own figures have no spread and somebody else's do, the
 * bounds stay the typical ones and `measuredFrom` says so — the truth about where they came
 * from. When nothing anywhere has a spread, a figure is quoted as the point it was measured
 * as, because that is what was measured.
 */
/** The low bound, the median and the high bound of what a group measured. */
const bounds = <T>({
  measuredFrom,
  samples,
}: Measured<T>): {
  low: T;
  median: T;
  high: T;
} => ({
  low: atQuantile(samples, BOUNDS_AT[measuredFrom].low),
  median: atQuantile(samples, MEDIAN),
  high: atQuantile(samples, BOUNDS_AT[measuredFrom].high),
});

const measuredFor = <T>(
  history: MeasuredHistory,
  samplesOf: (runs: readonly MeasuredRun[]) => readonly T[],
  order: (first: T, second: T) => number,
): Measured<T> | null => {
  const groups = (
    [
      ['this-site', history.onSite],
      ['other-sites', history.elsewhere],
    ] as const
  )
    .map(([measuredFrom, runs]) => ({
      measuredFrom,
      runs,
      samples: [...samplesOf(runs)].sort(order),
    }))
    .filter((group) => group.samples.length > 0);

  // The bounds this group would actually be quoted as, not the ends of its samples: the
  // middle half of five sessions that all took the same time is as much of a point as one
  // session is, and the rule is about the range the screen prints.
  const isARange = (group: Measured<T>): boolean => {
    const quoted = bounds(group);
    return order(quoted.low, quoted.high) !== 0;
  };

  return groups.find(isARange) ?? groups[0] ?? null;
};

const unknown = (reason: string): UnknownFigure => ({ state: 'unknown', reason });

/** The median of what was timed, or `null` where nothing was. */
const medianOf = (values: readonly number[]): number | null =>
  values.length === 0 ? null : atQuantile([...values].sort(ascending), MEDIAN);

const timeFor = (
  { sessions, concurrency, batches }: Scale,
  engineMode: RunRequest['engineMode'],
  history: MeasuredHistory,
): TimeEstimate => {
  const measured = measuredFor(
    history,
    (runs) => runs.flatMap((run) => run.sessionDurationsMs),
    ascending,
  );
  if (measured === null) {
    return unknown(
      `no finished session on the ${engineMode} engine has been measured, on this site or on any other`,
    );
  }
  const session = bounds(measured);
  const browserStartupMs = medianOf(
    measured.runs
      .map((run) => run.browserStartupMs)
      .filter((startup): startup is number => startup !== null),
  );
  const perBatch = browserStartupMs ?? 0;
  return {
    state: 'known',
    sessions,
    concurrency,
    batches,
    medianSessionMs: session.median,
    sessionMs: { low: session.low, high: session.high },
    measuredFrom: measured.measuredFrom,
    sessionsMeasured: measured.samples.length,
    browserStartupMs,
    ms: {
      low: batches * (session.low + perBatch),
      high: batches * (session.high + perBatch),
    },
  };
};

/** Rounded the way the provider rounds a call, so a total is the sum and not the dust. */
const usd = (value: number): number => Number(value.toFixed(10));

const costFor = (
  { sessions }: Scale,
  request: EstimateRequest,
  history: MeasuredHistory,
  prices: PriceTable,
): CostEstimate => {
  if (request.engineMode !== 'model') {
    return {
      state: 'nothing-to-pay',
      reason: 'the offline deterministic engine calls no model, so this test is billed nothing',
    };
  }
  const modelId = MODEL_ID_BY_MODE[request.modelMode];
  const row = prices.rowFor(modelId);
  if (row === null) {
    return unknown(`the price row for ${modelId} could not be read from the provider's table`);
  }
  const measured = measuredFor(
    history,
    (runs) =>
      runs
        .map((run) => run.tokensPerSession)
        .filter((billed): billed is BilledTokens => billed !== null),
    (first, second) => prices.usdFor(modelId, first) - prices.usdFor(modelId, second),
  );
  if (measured === null) {
    return unknown('no finished test has recorded what one session spends on model calls');
  }

  const tokensPerSession = bounds(measured);
  const perSession = {
    low: usd(prices.usdFor(modelId, tokensPerSession.low)),
    high: usd(prices.usdFor(modelId, tokensPerSession.high)),
  };
  return {
    state: 'known',
    sessions,
    modelId,
    prices: row,
    tokensPerSession,
    measuredFrom: measured.measuredFrom,
    runsMeasured: measured.samples.length,
    usdPerSession: perSession,
    usd: { low: usd(perSession.low * sessions), high: usd(perSession.high * sessions) },
  };
};

const storageFor = (
  { sessions }: Scale,
  engineMode: RunRequest['engineMode'],
  history: MeasuredHistory,
): StorageEstimate => {
  const measured = measuredFor(
    history,
    (runs) =>
      runs
        .map((run) => run.videoBytesPerSession)
        .filter((bytes): bytes is number => bytes !== null),
    ascending,
  );
  if (measured === null) {
    return unknown(
      `no finished test on the ${engineMode} engine has recorded the video a session writes`,
    );
  }
  const medianBytesPerSession = bounds(measured).median;
  return {
    state: 'known',
    sessions,
    medianBytesPerSession,
    measuredFrom: measured.measuredFrom,
    runsMeasured: measured.samples.length,
    bytes: medianBytesPerSession * sessions,
  };
};

/**
 * The estimate for a run that has not started: the agents, the time, the cost and the
 * storage, each with the figures it was computed from.
 *
 * Pure and synchronous. The history is read before it is called, so the arithmetic reaches
 * no file system and a test hands it the sessions it wants to reason about.
 */
export const estimateRun = (
  request: EstimateRequest,
  history: MeasuredHistory,
  prices: PriceTable = providerPrices,
): RunEstimate => {
  const agents: AgentsFigures = {
    participants: request.participants,
    sessions: request.participants,
    concurrency: request.concurrency,
  };
  const common = { siteUrl: request.siteUrl, engineMode: request.engineMode, agents };

  // A test of nobody has no sessions to multiply, and a quoted nothing — no minutes, no
  // dollars, no gigabytes — would read as a priced answer rather than as the empty request
  // it is. The participant count is reported back so the screen can say whose test it is.
  if (agents.sessions === 0) {
    const nobody = unknown('this test has no participants, so there are no sessions to measure');
    return { ...common, time: nobody, cost: nobody, storage: nobody };
  }
  // `acceptedEstimateRequest` refuses this, and a typed caller can still build it: the
  // batches are the sessions divided by it, so a nought here is `Infinity` minutes rather
  // than a figure. Named, like every other figure that cannot be computed.
  if (agents.concurrency < 1) {
    const nobody = unknown(
      'nothing runs at a time, so there is no number of batches to multiply a session by',
    );
    return { ...common, time: nobody, cost: nobody, storage: nobody };
  }

  // Only the runs on the engine being estimated. A session that waits on a model call per
  // screen takes longer, bills tokens and records a longer video than one the offline
  // deterministic engine decided, so pooling the two would quote a model run from offline
  // sessions and call it measured. Where that leaves a figure with nothing behind it, the
  // figure says so, which is the honest answer rather than the convenient one.
  const onThisEngine = (runs: readonly MeasuredRun[]): readonly MeasuredRun[] =>
    runs.filter((run) => run.engineMode === request.engineMode);
  const measured: MeasuredHistory = {
    onSite: onThisEngine(history.onSite),
    elsewhere: onThisEngine(history.elsewhere),
  };

  const scale: Scale = { ...agents, batches: Math.ceil(agents.sessions / agents.concurrency) };
  return {
    ...common,
    time: timeFor(scale, request.engineMode, measured),
    cost: costFor(scale, request, measured, prices),
    storage: storageFor(scale, request.engineMode, measured),
  };
};

/** Where the runs an estimate is quoted from live, and which of them the caller may read. */
export interface RunHistorySource {
  readonly runsRoot: string;
  /** The workspace's own runs. An estimate is never quoted from another workspace's tests. */
  readonly runIds: readonly string[];
}

/** The origin of a URL, or `null` for a string that is not one. */
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** One run's measured figures and the origins it ran against, or `null` if it is unreadable. */
const measuredRunAt = async (
  runsRoot: string,
  runId: string,
): Promise<{ origins: readonly string[]; measured: MeasuredRun } | null> => {
  let text: string;
  try {
    text = await readFile(runPaths(join(runsRoot, runId)).run, 'utf8');
  } catch {
    return null;
  }
  let encoded: unknown;
  try {
    encoded = JSON.parse(text);
  } catch {
    return null;
  }
  // A run directory this build cannot read is a run this estimate is not quoted from. It is
  // skipped rather than thrown on: one unreadable directory is not a reason to answer the
  // launch screen with nothing.
  const parsed = runSchema.safeParse(encoded);
  if (!parsed.success) return null;
  const run = parsed.data;

  const ran = run.sessionIds.length;
  const usage = run.usage;
  // The run's bill over the sessions it ran. Whole tokens, so the figure the screen prints
  // ("~6.8k tokens a session") is the figure the cost was computed from. A run that called
  // no model measured nothing about what a call costs, which is not the same as zero.
  const tokensPerSession =
    usage === undefined || usage.calls === 0 || ran === 0
      ? null
      : {
          inputTokens: Math.round(usage.inputTokens / ran),
          cachedInputTokens: Math.round(usage.cachedInputTokens / ran),
          outputTokens: Math.round(usage.outputTokens / ran),
        };

  return {
    origins: run.variants
      .map((variant) => originOf(variant.url))
      .filter((origin): origin is string => origin !== null),
    measured: {
      runId,
      engineMode: run.engine.mode,
      // One file read a run: `run.progress` carries every finished session's wall clock, so
      // a hundred sessions cost one `run.json` rather than a hundred session files. When the
      // aggregate lands (#287) its timing distribution is the cheaper source still.
      sessionDurationsMs: run.progress?.sessions.map((session) => session.durationMs) ?? [],
      tokensPerSession,
      // Nothing records either yet, and `null` says so rather than quoting a zero: #242
      // declares a session's video and #246 measures what one browser costs. The figures
      // arrive here, and the two estimate figures behind them light up with them.
      videoBytesPerSession: null,
      browserStartupMs: null,
    },
  };
};

/**
 * The history an estimate is quoted from, read off the run directories a workspace owns.
 *
 * Scoped by `runIds`, which is the workspace's own list — the same scoping `visibleRuns`
 * applies to reading a run over HTTP, so an estimate is never quoted from a test another
 * workspace ran. A run is **on this site** when it drove this site's origin: the median
 * session on a site is about the site, not about one page of it.
 */
export const measuredHistoryOfRuns =
  ({ runsRoot, runIds }: RunHistorySource): MeasuredHistoryReader =>
  async (siteUrl: string): Promise<MeasuredHistory> => {
    const origin = originOf(siteUrl);
    const onSite: MeasuredRun[] = [];
    const elsewhere: MeasuredRun[] = [];
    // One run at a time rather than all of them at once: a workspace with hundreds of runs
    // would open hundreds of files in parallel, and a read that failed for want of a file
    // handle would be silently skipped — degrading the estimate to "nothing measured"
    // instead of answering. A hundred small reads in series cost milliseconds.
    for (const runId of runIds) {
      const run = await measuredRunAt(runsRoot, runId);
      if (run === null) continue;
      const here = origin !== null && run.origins.includes(origin);
      (here ? onSite : elsewhere).push(run.measured);
    }
    return { onSite, elsewhere };
  };
