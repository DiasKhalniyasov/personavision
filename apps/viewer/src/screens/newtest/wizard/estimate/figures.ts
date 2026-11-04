import type {
  CostEstimate,
  EstimateRange,
  StorageEstimate,
  TimeEstimate,
} from '@/screens/newtest/start';

/**
 * The launch step's words, from the platform's figures.
 *
 * **Nothing here computes a figure.** Every number arrives from `POST /runs/estimate`
 * already multiplied up (#283) and what these functions do is choose a unit and a sentence:
 * milliseconds into minutes, dollars into `$2.10`, bytes into `1.4 GB`, and the line of
 * arithmetic `#screen-newtest-estimate` prints under each figure. The one arithmetic in this
 * file is unit conversion, which is why it is testable on its own and why a test can read the
 * figures back out of the sentences.
 *
 * Three rules the owner settled, which these sentences carry:
 *
 * - **A range is labelled as a range** (#279). The bounds are printed with an en dash and the
 *   line under them says so, so a reader cannot take `18–26 min` for a measurement.
 * - **`low === high` is one figure**, never a range of a number to itself: that is the shape
 *   the first test on a site produces (decision 102, as #283 refined it).
 * - **Where the bounds came from is said per figure** — decision 79's *"not yet measured
 *   here"* for a figure quoted from other sites, and decision 101's *"Not measured yet"* for
 *   one nothing has measured at all.
 */

const MINUTE_MS = 60_000;

/** An en dash between the bounds, as `#screen-newtest-estimate` draws them. */
const EN_DASH = '–';

/** The host a launch is about, as `#screen-sites` and the prototype's heading name a site. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    // A draft that holds something that is not a URL is still a draft about a site: the
    // address is printed as it was typed rather than replaced by a sentence about parsing.
    return url;
  }
};

/** A figure, and whether what is printed is a range — which decides the words under it. */
export interface Figure {
  readonly text: string;
  readonly range: boolean;
}

/** `18` minutes from milliseconds; at least one for anything that takes any time at all. */
const inMinutes = (ms: number): number => (ms <= 0 ? 0 : Math.max(1, Math.round(ms / MINUTE_MS)));

const minutesText = (minutes: number): string =>
  minutes === 0 ? 'under a minute' : `${String(minutes)} min`;

/**
 * `18–26 min`, or one figure where both bounds round to the same minute.
 *
 * Rounded first and compared after: two bounds eleven seconds apart are the same number of
 * minutes, and `18–18 min` is a range of a number to itself.
 */
export const minutesFigure = (ms: EstimateRange): Figure => {
  const low = inMinutes(ms.low);
  const high = inMinutes(ms.high);
  return low === high
    ? { text: minutesText(low), range: false }
    : { text: `${String(low)}${EN_DASH}${minutesText(high)}`, range: true };
};

/** `1:50` — the median session, as the prototype writes a session's wall clock. */
export const sessionClock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
};

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * `$2.10`, and **never a price of zero**: a bill that rounds to nothing is stated as being
 * under a cent, because `$0.00` reads as a price somebody checked.
 */
const usdText = (usd: number): string => (usd < 0.005 ? 'under $0.01' : money.format(usd));

/** `$2.10–$3.40`, or one figure where both bounds round to the same cent. */
export const usdFigure = (usd: EstimateRange): Figure => {
  const low = usdText(usd.low);
  const high = usdText(usd.high);
  return low === high
    ? { text: low, range: false }
    : { text: `${low}${EN_DASH}${high}`, range: true };
};

/** `1.4 GB`, `14 MB` — decimal units, which is how a disk is sold and how a run is quoted. */
export const bytesFigure = (bytes: number): string => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`;
  if (bytes >= 1e3) return `${String(Math.round(bytes / 1e3))} kB`;
  return `${String(Math.round(bytes))} bytes`;
};

/** `6.8k`, `500` — tokens as the estimate card writes them. */
export const tokensFigure = (tokens: number): string => {
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens / 1000;
  const rounded = thousands.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded}k`;
};

const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * `10:12` — **in the reader's own time zone**, drawn from the instant a refusal carries.
 *
 * The platform writes its sentence in UTC and sends `retryAt` beside it for exactly this
 * (decision 111), so the time a reader is told to come back at is the time on their clock.
 */
export const clockTime = (instant: string): string | null => {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? null : clock.format(at);
};

/**
 * `27 Oct` — the day a price row's rates were read, as the product prints a date.
 *
 * Day then month, as every date in the prototype is printed, which is why the two are
 * formatted apart: `en-US` writes the pair the other way round in one format
 * (`screens/analysis/provenance.ts` does the same, for the same reason).
 */
const dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short' });

export const dayOf = (date: string): string | null => {
  const at = new Date(date);
  return Number.isNaN(at.getTime()) ? null : `${dayOfMonth.format(at)} ${monthShort.format(at)}`;
};

/** The prefix that labels a range as one, so a bound is never read as a measurement. */
const labelled = (figure: Figure, line: string): string =>
  figure.range ? `A range · ${line}` : line;

/** What a figure nothing has measured says, in the words of owner decision 101. */
export const NOT_MEASURED = 'Not measured yet';

/** What an offline run's cost says: there is none, which is not a price of zero. */
export const NOTHING_TO_PAY = 'Nothing to pay';

/* ---- the three figures, and the line under each ------------------------- */

/**
 * *"10 at a time, the per-site cap"* — the prototype's own line, when the run really will
 * run at the cap.
 *
 * A deployment that holds itself below the cap is quoted at what it will really run at
 * (decision 118), and then the line says that instead: a figure that called itself the
 * per-site cap while being half of it would be the one number on this card a reader plans
 * their afternoon around, quietly wrong.
 */
export const agentsLine = (concurrency: number, siteCap: number): string =>
  concurrency >= siteCap
    ? `${String(concurrency)} at a time, the per-site cap`
    : `${String(concurrency)} at a time, under the per-site cap of ${String(siteCap)}`;

/** Where a figure's bounds were measured, said per figure (decision 79). */
const measuredHere = (measuredFrom: 'this-site' | 'other-sites'): boolean =>
  measuredFrom === 'this-site';

/** *"10 batches × a 1:50 median session"*, or decision 79's typical session. */
export const timeLine = (time: TimeEstimate): string => {
  if (time.state === 'unknown') return time.reason;
  const session = sessionClock(time.medianSessionMs);
  const line = measuredHere(time.measuredFrom)
    ? `${String(time.batches)} batches × a ${session} median session`
    : `${String(time.batches)} batches × a ${session} typical session, not yet measured here`;
  return labelled(minutesFigure(time.ms), line);
};

/** *"~6.8k tokens a session at the standard price"*, with the model the row is for. */
export const costLine = (cost: CostEstimate): string => {
  if (cost.state !== 'known') return cost.reason;
  const tokens = tokensFigure(cost.tokensPerSession.median.inputTokens);
  const line = `~${tokens} tokens a session at the ${cost.modelId} price${
    measuredHere(cost.measuredFrom) ? '' : ', not yet measured here'
  }`;
  return labelled(usdFigure(cost.usd), line);
};

/** The time figure itself: `18–26 min`, or why there is none. */
export const timeFigure = (time: TimeEstimate): string =>
  time.state === 'known' ? minutesFigure(time.ms).text : NOT_MEASURED;

/** The cost figure itself: `$2.10–$3.40`, nothing to pay, or why there is none. */
export const costFigure = (cost: CostEstimate): string =>
  cost.state === 'known'
    ? usdFigure(cost.usd).text
    : cost.state === 'nothing-to-pay'
      ? NOTHING_TO_PAY
      : NOT_MEASURED;

/* ---- what the estimate is made of -------------------------------------- */

/**
 * The Time row of the card: the arithmetic, the sessions behind it, and why it is a range.
 *
 * The prototype's *"plus a minute to start the browsers"* is printed **only when something
 * has timed one**. `browserStartupMs` is `null` on every estimate today (#246 measures it),
 * and a minute nobody measured added to two figures that were measured is the one thing this
 * card must not do.
 */
export const timeArithmetic = (time: TimeEstimate): string => {
  if (time.state === 'unknown') return `${NOT_MEASURED}: ${time.reason}.`;

  const sessions = `${String(time.sessions)} sessions ÷ ${String(time.concurrency)} concurrent`;
  const median = `the ${sessionClock(time.medianSessionMs)} median session`;
  const from = measuredHere(time.measuredFrom)
    ? `${median} on this site`
    : `${median} across the tests we have run on other sites, not yet measured here`;
  const over = `over ${String(time.sessionsMeasured)} finished ${
    time.sessionsMeasured === 1 ? 'session' : 'sessions'
  }`;
  const startup =
    time.browserStartupMs === null
      ? ''
      : `, plus ${sessionClock(time.browserStartupMs)} a batch to start the browsers`;
  const range = minutesFigure(time.ms).range
    ? ' A range, because a session that gives up early is faster than one that finishes.'
    : ' One figure, because that is all the spread there is behind it.';

  return `${sessions} × ${from}, ${over}${startup}.${range}`;
};

/** The one document the Cost row cites, set in the mono family as the prototype draws it. */
export const MODEL_API_DOC = 'docs/meta-model-api.md';

/** The Cost row: the tokens, the rates they are priced at, and the model the row is for. */
export const costArithmetic = (cost: CostEstimate): string => {
  if (cost.state === 'nothing-to-pay') {
    // Deliberately not the prototype's own `$0.00`: this screen never prints that string,
    // not even inside a sentence explaining why it does not.
    return `${cost.reason}. Nothing is not a price of zero, so no price is shown.`;
  }
  if (cost.state === 'unknown') return `${NOT_MEASURED}: ${cost.reason}.`;

  const median = cost.tokensPerSession.median;
  const read = dayOf(cost.prices.ratesReadOn);
  return (
    `One model call per screen, around ${tokensFigure(median.inputTokens)} input and ` +
    `${tokensFigure(median.outputTokens)} output tokens a session, over ${String(cost.runsMeasured)} ` +
    `finished ${cost.runsMeasured === 1 ? 'test' : 'tests'}, at the ${cost.modelId} prices in ` +
    `${MODEL_API_DOC}${read === null ? '' : ` as they were read on ${read}`}.`
  );
};

/* ---- a refused launch -------------------------------------------------- */

/**
 * The cap that refused a launch, in words — by the name `POST /runs` answers it under.
 *
 * The **sentence** a refusal carries is the platform's and is printed as it was written
 * (`packages/platform/src/caps.ts` writes it once so that the screen, the API and the CLI
 * say the same thing). What this names is the cap itself, for the figures printed under that
 * sentence; a cap this build has not met is printed as the platform spelt it rather than
 * guessed at.
 */
export const capLabel = (cap: string): string =>
  cap === 'agentsPerRun'
    ? 'agents in one run'
    : cap === 'runsPerSitePerHour'
      ? 'runs an hour on this site'
      : cap === 'concurrentSessionsPerSite'
        ? 'browsers at a time on this site'
        : cap;

/** The Storage row: the video a hundred sessions write, or that nobody has measured it. */
export const storageArithmetic = (storage: StorageEstimate): string => {
  if (storage.state === 'unknown') {
    return `${NOT_MEASURED}: ${storage.reason}. The videos are kept inside the run directory.`;
  }
  return (
    `About ${bytesFigure(storage.bytes)} of video: ${String(storage.sessions)} sessions × ` +
    `~${bytesFigure(storage.medianBytesPerSession)} each, kept inside the run directory.`
  );
};
