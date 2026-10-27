/**
 * The committed calibration report and the floors the regression gate holds the engine to
 * (#89).
 *
 * A human-likeness figure that lives only in a test run is a figure nobody remembers. This
 * module turns one scoring run (#88) into the markdown committed at `docs/calibration/`, and
 * reads the floors the gate asserts out of the history committed beside it — so a change
 * that makes the engine less human-like arrives as a diff a reviewer can see rather than as
 * a number that quietly moved.
 *
 * **Nothing here is typed by hand.** `scripts/report.ts` is the one command that writes the
 * report, `renderReport` is the only thing that writes its text, and `test/report.test.ts`
 * re-renders from a fresh scoring run and compares the committed bytes. A figure in this
 * repository is always the figure the code produces.
 *
 * **The report carries no clock.** No generation date, no elapsed milliseconds, nothing a
 * second run would change: regenerating it has to leave the working tree clean, so the only
 * dates in it are the ones a history row recorded when it was deliberately appended.
 *
 * **Honest about scope.** The heading says `synthetic` when the figures were measured over
 * the committed stand-in corpus, in the first line rather than in a footnote, and a run over
 * the real benchmark names the dataset version it came from or is refused. The report also
 * says which figure the product's badge quotes — the web category's CC — because a number on
 * every screen of the product should be traceable to the table it came from.
 *
 * **This module does not import `packages/engine`.** The engine reaches it as figures and
 * provenance inside a `ScoreResult`; `test/dependency-direction.test.ts` holds the package to
 * one importer of the engine, and a report is not it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OBJECTIVE, objectiveOf } from '../fit/objective.js';
import type { Objective, ObjectiveValue } from '../fit/objective.js';
import {
  SALIENCY_METRICS,
  SALIENCY_METRIC_IDS,
  SCANPATH_METRICS,
  SCANPATH_METRIC_IDS,
} from '../metrics/index.js';
import type {
  MetricDirection,
  SaliencyMetricId,
  SaliencyScores,
  ScanpathMetricId,
  ScanpathScores,
} from '../metrics/index.js';
import type { Aggregate, Margin, PredictorFigures, ScoreResult } from '../score/index.js';
import { RECORD_CATEGORIES } from '../types.js';
import type { RecordCategory } from '../types.js';

/** A report that cannot be written, or a history file that cannot be read, by name. */
export class ReportError extends Error {
  public override readonly name = 'ReportError';
}

/** The one command that writes the report, printed in the report itself. */
export const REPORT_COMMAND = 'pnpm --filter @personavision/calibration run report';

/** The one command that runs the gate, in CI and on a developer's machine alike. */
export const GATE_COMMAND = 'pnpm --filter @personavision/calibration run gate';

/**
 * The seed the committed figures are measured at.
 *
 * The same seed the fit was run at (#90) and the same one `test/score.test.ts` quotes, so
 * the report, the committed configuration and the gate are all talking about one run.
 */
export const REPORT_SEED = 1;

/** Where the report lives, relative to the repository root. */
export const REPORT_PATH = 'docs/calibration/report.md';

/** Where the history lives, relative to the repository root. The gate reads its last row. */
export const HISTORY_PATH = 'docs/calibration/history.json';

/**
 * The repository root, four directories above this module.
 *
 * `src/report/render.ts` and the built `dist/report/render.js` both sit two directories
 * inside the package, and the package two inside the repository. The marker file is checked
 * rather than assumed: a moved package would otherwise write a report into whichever
 * directory the arithmetic landed on.
 */
export const repositoryRoot = (): string => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  if (!existsSync(`${root}pnpm-workspace.yaml`)) {
    throw new ReportError(
      `${root} is not the repository root: pnpm-workspace.yaml is not there, so ${REPORT_PATH} cannot be placed`,
    );
  }
  return root;
};

/** The report and the history, as absolute paths. */
export const reportPaths = (): { readonly report: string; readonly history: string } => {
  const root = repositoryRoot();
  return { report: `${root}${REPORT_PATH}`, history: `${root}${HISTORY_PATH}` };
};

/** Every metric a figure is reported under, in the order the report lists them. */
export type ReportMetricId = SaliencyMetricId | ScanpathMetricId;

/** The six, saliency first: the order every table in the report uses. */
export const REPORT_METRIC_IDS: readonly ReportMetricId[] = [
  ...SALIENCY_METRIC_IDS,
  ...SCANPATH_METRIC_IDS,
];

/** A metric's label and the direction it reads in, from the metric module's own descriptor. */
const descriptorOf = (
  id: ReportMetricId,
): { readonly label: string; readonly direction: MetricDirection } =>
  id === 'scanMatch' || id === 'sequenceScore' ? SCANPATH_METRICS[id] : SALIENCY_METRICS[id];

/** The six metrics of one aggregate, by name, so a loop can read them. */
const metricsOf = (figures: {
  readonly saliency: SaliencyScores;
  readonly scanpath: ScanpathScores;
}): Readonly<Record<ReportMetricId, number>> => ({ ...figures.saliency, ...figures.scanpath });

/** The scopes the report and the gate read: the overall mean, then every category. */
export type Scope = 'overall' | RecordCategory;

/** Every scope, in the order the report lists them. */
export const SCOPES: readonly Scope[] = ['overall', ...RECORD_CATEGORIES];

/** One scope's figures as a history row records them: the six metrics and their count. */
export interface RecordedFigures {
  /** How many records the six figures below are the mean over. */
  readonly records: number;
  readonly cc: number;
  readonly nss: number;
  readonly kld: number;
  readonly aucJudd: number;
  readonly scanMatch: number;
  readonly sequenceScore: number;
}

/**
 * One recorded measurement: the date, what produced it, and every figure it produced.
 *
 * A row is appended, never rewritten — `appendHistory` refuses a history whose earlier rows
 * have moved — so the file reads as what the engine scored over time rather than as what it
 * scores now.
 */
export interface HistoryRow {
  /** The day the measurement was recorded, `YYYY-MM-DD`. */
  readonly date: string;
  readonly engineVersion: string;
  /** Whether the engine's resolved configuration was the fitted one. */
  readonly calibrated: boolean | null;
  readonly corpus: ScoreResult['provenance']['corpus'];
  /**
   * The dataset version a real corpus came from, and `null` for the synthetic stand-in.
   * A figure from the benchmark names the version it was measured on or is not recorded.
   */
  readonly dataset: string | null;
  readonly seed: number;
  /** What the fit maximised, and what this run reached on it. */
  readonly objective: {
    readonly id: string;
    readonly scope: RecordCategory;
    readonly value: number;
  };
  /** The engine's figures, per scope. A category the corpus holds no record of is `null`. */
  readonly figures: Readonly<Record<Scope, RecordedFigures | null>>;
  /** One line on why this row was recorded, which is what a reviewer reads first. */
  readonly note: string;
}

/** The committed history: the rows, oldest first. */
export interface History {
  readonly schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  readonly rows: readonly HistoryRow[];
}

/** The shape `docs/calibration/history.json` is written in. */
export const HISTORY_SCHEMA_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads a history file, refusing one it cannot trust rather than reporting a floor from it.
 *
 * The gate's floors come from the last row here, so a history that parses loosely would be a
 * gate that passes loosely. Every field a floor or a heading is read from is checked by name.
 */
export const parseHistory = (text: string, where: string): History => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ReportError(`${where} is not JSON: ${String(cause)}`);
  }
  if (!isRecord(parsed)) throw new ReportError(`${where} is not an object`);
  if (parsed['schemaVersion'] !== HISTORY_SCHEMA_VERSION) {
    throw new ReportError(
      `${where} is schema version ${String(parsed['schemaVersion'])}, and this build writes ${String(HISTORY_SCHEMA_VERSION)}`,
    );
  }
  const rows = parsed['rows'];
  if (!Array.isArray(rows)) throw new ReportError(`${where} carries no rows array`);
  rows.forEach((row, index) => {
    const at = `${where} row ${String(index)}`;
    if (!isRecord(row)) throw new ReportError(`${at} is not an object`);
    if (typeof row['date'] !== 'string' || !DATE.test(row['date'])) {
      throw new ReportError(`${at} carries no YYYY-MM-DD date, so it cannot be read as history`);
    }
    if (typeof row['engineVersion'] !== 'string' || row['engineVersion'].length === 0) {
      throw new ReportError(`${at} names no engine version, so its figures name no engine`);
    }
    if (!isRecord(row['corpus']) || typeof row['corpus']['id'] !== 'string') {
      throw new ReportError(`${at} names no corpus, so its figures could be about anything`);
    }
    if (!isRecord(row['figures'])) throw new ReportError(`${at} carries no figures`);
    for (const scope of SCOPES) {
      const figures = (row['figures'] as Record<string, unknown>)[scope];
      if (figures === null || figures === undefined) continue;
      if (!isRecord(figures)) throw new ReportError(`${at} figures for ${scope} are not an object`);
      for (const metric of [...REPORT_METRIC_IDS, 'records'] as const) {
        if (typeof figures[metric] !== 'number' || !Number.isFinite(figures[metric])) {
          throw new ReportError(`${at} figures for ${scope} carry no finite ${metric}`);
        }
      }
    }
  });
  return parsed as unknown as History;
};

/** The committed history, read from `docs/calibration/history.json`. */
export const loadHistory = (path: string = reportPaths().history): History => {
  if (!existsSync(path)) {
    throw new ReportError(
      `${path} is not there: the gate reads its floors from the last recorded measurement, and ${REPORT_COMMAND} --record writes one`,
    );
  }
  return parseHistory(readFileSync(path, 'utf8'), path);
};

const recordedFiguresOf = (aggregate: Aggregate | null): RecordedFigures | null =>
  aggregate === null ? null : { records: aggregate.records, ...metricsOf(aggregate) };

/** What a row records about a run: every scope's figures, and nothing about the machine. */
const figuresByScope = (
  figures: PredictorFigures,
): Readonly<Record<Scope, RecordedFigures | null>> => ({
  overall: recordedFiguresOf(figures.overall),
  ...(Object.fromEntries(
    RECORD_CATEGORIES.map((category) => [
      category,
      recordedFiguresOf(figures.categories[category]),
    ]),
  ) as Record<RecordCategory, RecordedFigures | null>),
});

/** What a caller has to say about a measurement before it is recorded as history. */
export interface RecordOptions {
  /** The day it was recorded, `YYYY-MM-DD`. The caller passes it; nothing here reads a clock. */
  readonly date: string;
  /** One line on why. A row with no reason is a row a reviewer cannot weigh. */
  readonly note: string;
  /** The dataset version, required when the corpus is not the synthetic stand-in. */
  readonly dataset?: string | null;
  readonly objective?: Objective;
}

/** One scoring run as a history row, with the account of itself a figure is quoted with. */
export const historyRowOf = (result: ScoreResult, options: RecordOptions): HistoryRow => {
  if (!DATE.test(options.date)) {
    throw new ReportError(`"${options.date}" is not a YYYY-MM-DD date`);
  }
  if (options.note.trim().length === 0) {
    throw new ReportError('a recorded measurement carries one line saying why it was recorded');
  }
  const dataset = options.dataset ?? null;
  if (!result.provenance.corpus.synthetic && dataset === null) {
    throw new ReportError(
      `the corpus ${result.provenance.corpus.id} is not the synthetic stand-in, so the row has to name the dataset version its figures came from`,
    );
  }
  const objective = objectiveOf(result, options.objective ?? OBJECTIVE);
  return {
    date: options.date,
    engineVersion: result.predictor.provenance.version,
    calibrated: result.predictor.provenance.calibrated,
    corpus: result.provenance.corpus,
    dataset,
    seed: result.provenance.seed,
    objective: { id: objective.id, scope: objective.scope, value: objective.value },
    figures: figuresByScope(result.predictor),
    note: options.note.trim(),
  };
};

/**
 * The history with one more row, refusing to move an earlier one.
 *
 * Appending is the only edit this code makes to the file: a regression is meant to be
 * visible as a diff, and a routine that could rewrite yesterday's figures would be a routine
 * that could erase the regression it exists to show. A row whose date precedes the last one
 * is refused for the same reason — the file reads oldest first.
 */
export const appendHistory = (history: History, row: HistoryRow): History => {
  const last = history.rows.at(-1);
  if (last !== undefined && row.date < last.date) {
    throw new ReportError(
      `the last recorded measurement is dated ${last.date} and this one ${row.date}: history is appended, never inserted into`,
    );
  }
  return { schemaVersion: HISTORY_SCHEMA_VERSION, rows: [...history.rows, row] };
};

/** The history as the bytes committed at `docs/calibration/history.json`. */
export const renderHistory = (history: History): string => `${JSON.stringify(history, null, 2)}\n`;

/**
 * How far a metric may fall below its recorded floor before the gate fails, per metric.
 *
 * **Why a tolerance exists at all.** The figures are deterministic: one corpus, one seed, one
 * configuration, and `test/score.test.ts` asserts two runs and two processes agree character
 * for character. So on one machine the honest tolerance is zero. It is not zero because the
 * gate runs on a different machine from the one the floors were measured on — CI is Linux on
 * x64 and the committed figures were measured on macOS on arm64 — and the image decode, the
 * resampling and the sums that follow are not bit-identical across them. The drift that
 * buys is in the last few digits; these numbers are several orders of magnitude above it.
 *
 * **Why these sizes.** Each is at most a hundredth of the range its metric covers over this
 * corpus, so the same argument reads the same for a metric on the unit interval and for one
 * that is not:
 *
 * - `cc`, `aucJudd`, `scanMatch`, `sequenceScore` run on the unit interval, so **0.01**.
 * - `nss` is unbounded and runs from -0.4 to 4.3 over this corpus, so **0.05**.
 * - `kld` is unbounded, lower-is-better, and runs from 0.9 to 14.5 over this corpus, so
 *   **0.1** — and it is read the other way round: the gate fails when KLD *rises* past its
 *   floor plus this.
 *
 * **Why not wider.** The smallest regression worth catching on this corpus is far larger:
 * the engine's own defaults score 0.18 on web ScanMatch against the fitted 0.41, so a fit
 * silently reverting is an eighteen-tolerance fall. A worker who needs these numbers wider
 * is being asked to say here why the drift they are absorbing is drift and not a regression.
 */
export const REGRESSION_TOLERANCE: Readonly<Record<ReportMetricId, number>> = Object.freeze({
  cc: 0.01,
  nss: 0.05,
  kld: 0.1,
  aucJudd: 0.01,
  scanMatch: 0.01,
  sequenceScore: 0.01,
});

/** One floor the gate holds a figure to: where it was recorded and how far it may move. */
export interface Floor {
  readonly scope: Scope;
  readonly metric: ReportMetricId;
  /** The figure the last recorded measurement produced. */
  readonly floor: number;
  readonly direction: MetricDirection;
  readonly tolerance: number;
  /** The worst figure that still passes, tolerance included. */
  readonly allowed: number;
  /** The date of the measurement this floor is read from. */
  readonly recordedOn: string;
}

/**
 * The floors the gate asserts: every metric of every scope the last recorded row holds.
 *
 * **The last row and not the best.** A floor is a measurement, not a high-water mark: when a
 * change costs KLD to buy CC, the honest act is to argue for it in review and record the new
 * measurement, which this file then shows as a diff beside the old one. A ratchet over the
 * best figure ever seen would instead have to be edited by hand to let that through, and a
 * gate that is routinely edited by hand is not a gate.
 */
export const floorsOf = (history: History): readonly Floor[] => {
  const last = history.rows.at(-1);
  if (last === undefined) {
    throw new ReportError(
      `no measurement has been recorded, so there is no floor to hold the engine to: ${REPORT_COMMAND} --record writes the first`,
    );
  }
  return SCOPES.flatMap((scope) => {
    const figures = last.figures[scope];
    if (figures === null || figures === undefined) return [];
    return REPORT_METRIC_IDS.map((metric) => {
      const { direction } = descriptorOf(metric);
      const floor = figures[metric];
      const tolerance = REGRESSION_TOLERANCE[metric];
      return {
        scope,
        metric,
        floor,
        direction,
        tolerance,
        allowed: direction === 'lower-is-better' ? floor + tolerance : floor - tolerance,
        recordedOn: last.date,
      };
    });
  });
};

/** A figure that fell past its floor by more than the tolerance. */
export interface FloorBreach extends Floor {
  /** What this run measured. */
  readonly measured: number;
  /** How far past `allowed` it fell, always positive. */
  readonly beyond: number;
}

/**
 * Every floor this run falls past, each with the arithmetic behind it.
 *
 * A scope the recorded row holds and this run does not is a breach of its own: a corpus that
 * stopped producing a web figure has not kept the engine honest, it has stopped measuring it.
 */
export const breachesOf = (result: ScoreResult, floors: readonly Floor[]): readonly FloorBreach[] =>
  floors.flatMap((floor) => {
    const aggregate =
      floor.scope === 'overall'
        ? result.predictor.overall
        : result.predictor.categories[floor.scope];
    if (aggregate === null) {
      throw new ReportError(
        `the last recorded measurement holds ${floor.scope} figures and this run produced none: a gate that stops measuring a scope cannot report on it`,
      );
    }
    const measured = metricsOf(aggregate)[floor.metric];
    const beyond =
      floor.direction === 'lower-is-better' ? measured - floor.allowed : floor.allowed - measured;
    return beyond > 0 ? [{ ...floor, measured, beyond }] : [];
  });

/** One breach as the line a failing gate prints. */
export const describeBreach = (breach: FloorBreach): string => {
  const { label, direction } = descriptorOf(breach.metric);
  const way = direction === 'lower-is-better' ? 'rose to' : 'fell to';
  return `${breach.scope} ${label} ${way} ${figure(breach.measured)}, past the ${figure(breach.allowed)} its floor of ${figure(breach.floor)} recorded on ${breach.recordedOn} allows at a tolerance of ${String(breach.tolerance)} — by ${figure(breach.beyond)}`;
};

/**
 * A figure as the report prints it: four decimals, and never a negative zero.
 *
 * Four decimals because the metrics differ in the third — the engine's web CC and the
 * prior's differ by 0.31, and two candidates of a fit by 0.0001 — and because a figure
 * printed to the last binary digit would make every diff unreadable. The full precision is
 * in `history.json`, which is what the gate reads.
 */
const figure = (value: number): string => {
  const printed = value.toFixed(4);
  return printed === '-0.0000' ? '0.0000' : printed;
};

/** A markdown table row. Cells are not padded: a changed figure is then a one-line diff. */
const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/** A markdown table: a header, its rule, and the body. */
const table = (header: readonly string[], body: readonly (readonly string[])[]): string =>
  [row(header), row(header.map(() => '---')), ...body.map(row)].join('\n');

/** How the report names a scope in a heading and in a table cell. */
const scopeLabel = (scope: Scope): string => (scope === 'overall' ? 'Overall' : scope);

/** `4 records` / `1 record`, so a figure never appears without the count behind it. */
const records = (count: number): string => `${String(count)} ${count === 1 ? 'record' : 'records'}`;

/** What the report needs beyond the run itself. */
export interface ReportInput {
  readonly result: ScoreResult;
  readonly history: History;
  /** The dataset version, required when the corpus is not the synthetic stand-in. */
  readonly dataset?: string | null;
  readonly objective?: Objective;
}

/** The corpus named as the heading names it: `synthetic`, in the heading and not a footnote. */
const corpusHeading = (input: ReportInput): string => {
  const { corpus } = input.result.provenance;
  if (corpus.synthetic)
    return 'the committed synthetic corpus (synthetic, not the UEyes benchmark)';
  const dataset = input.dataset ?? null;
  if (dataset === null) {
    throw new ReportError(
      `the corpus ${corpus.id} is not the synthetic stand-in, so the report has to name the dataset version its figures came from`,
    );
  }
  return `${dataset} (the real benchmark)`;
};

const provenanceSection = (input: ReportInput): string => {
  const { provenance, predictor } = input.result;
  const { corpus } = provenance;
  return [
    '## What produced these figures',
    '',
    table(
      ['', ''],
      [
        ['Engine version', `\`${predictor.provenance.version}\``],
        [
          'Engine configuration',
          predictor.provenance.calibrated === true
            ? 'the fitted one — `packages/engine/config/calibrated.json` is in the build'
            : 'the engine’s defaults: **not calibrated**',
        ],
        [
          'Corpus',
          `\`${corpus.id}\` — ${corpus.label}, ${corpus.synthetic ? '**synthetic**' : `**${input.dataset ?? ''}**`}, ${records(corpus.records)}`,
        ],
        ['Seed', `\`${String(provenance.seed)}\``],
        ['Predictors', provenance.predictorIds.map((id) => `\`${id}\``).join(', ')],
        ['Command', `\`${REPORT_COMMAND}\``],
      ],
    ),
    '',
    'Every figure below is the engine reached through its published `predict(image, seed)` (#68), scored by the',
    'metrics of this package (#83, #84) against the same records as both baselines (#87). The parameters of those',
    'metrics are the ruler and are never fitted (#90); they are listed here so that no figure is quoted without',
    'saying what produced it.',
    '',
    '### The saliency metrics’ parameters',
    '',
    table(
      ['Parameter', 'Value'],
      Object.entries(provenance.saliencyMetricParameters).map(([key, value]) => [
        `\`${key}\``,
        `\`${JSON.stringify(value)}\``,
      ]),
    ),
    '',
    '### The scanpath metrics’ parameters',
    '',
    table(
      ['Parameter', 'Value'],
      Object.entries(provenance.scanpathMetricParameters).map(([key, value]) => [
        `\`${key}\``,
        `\`${JSON.stringify(value)}\``,
      ]),
    ),
    '',
    '### The map each predictor drew',
    '',
    table(
      [
        'Predictor',
        'Drawn from',
        'Cell px',
        'σ share',
        'σ relative to',
        'Truncation',
        'Dwell weight',
        'Normalisation',
      ],
      Object.entries(provenance.mapKernels).map(([id, kernel]) => [
        `\`${id}\``,
        kernel.drawnFrom,
        String(kernel.cellPx),
        String(kernel.sigmaShare),
        kernel.sigmaRelativeTo,
        String(kernel.truncationSigmas),
        String(kernel.dwellWeightExponent),
        kernel.normalisation,
      ]),
    ),
    '',
    provenance.mapKernelDivergences.length === 0
      ? 'Every predictor drew its map the same way, so a margin below is a difference in where each one looked.'
      : provenance.mapKernelDivergences
          .map(
            ({ predictorId, otherId, fields }) =>
              `\`${predictorId}\` and \`${otherId}\` drew their maps differently — ${fields.map((field) => `\`${field}\``).join(', ')} — so a margin between them is placement **and** blur, and is read as both.`,
          )
          .join('\n'),
  ].join('\n');
};

/** The badge's own formatting, as `apps/viewer/src/shell/SimulatedBadge.tsx` applies it. */
const badgeFigure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const badgeSection = (input: ReportInput): string => {
  const web = input.result.predictor.categories.webpage;
  return [
    '## What the product’s badge quotes',
    '',
    '**The web category’s CC.** The header badge of every screen reads',
    web === null
      ? '`Simulated audience · gaze similarity …` from the run artifact’s `calibration.cc` — and this corpus holds no'
      : `\`Simulated audience · gaze similarity ${badgeFigure.format(web.saliency.cc)}\` from the run artifact’s \`calibration.cc\`, which the run`,
    web === null
      ? 'webpage record, so there is no figure here for it to quote.'
      : `loop writes from the engine’s own committed configuration. That is the **${figure(web.saliency.cc)}** in the \`webpage\` row`,
    web === null
      ? ''
      : `of the table below, over ${records(web.records)}. The badge’s longer form names CC, NSS and ScanMatch, all of that same`,
    web === null ? '' : 'category.',
    '',
    'The web category is what this product is for (#11, user story 8) and is never folded into the overall mean: the',
    'overall figures below cover four kinds of UI and are **not** what the badge is about. A run produced by an',
    'engine that was never calibrated shows no number at all — the badge says so in words rather than printing a',
    'zero.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
};

const objectiveSection = (input: ReportInput, value: ObjectiveValue): string => {
  const objective = input.objective ?? OBJECTIVE;
  return [
    '## The objective and its weights',
    '',
    `\`${objective.id}\` — ${objective.label}. Scope: **${objective.scope}**, never the overall mean.`,
    '',
    table(
      ['Term', 'Weight', 'Figure', 'Contribution'],
      [
        ...value.terms.map((term) => [
          descriptorOf(term.metric).label,
          String(term.weight),
          figure(term.figure),
          figure(term.contribution),
        ]),
        ['**Objective**', '', '', `**${figure(value.value)}**`],
      ],
    ),
    '',
    `Over ${records(value.records)} of the \`${objective.scope}\` category. The two figures are not commensurable, so`,
    'the objective is a direction to climb and never a score to quote — `packages/calibration/docs/fitting.md` says',
    'why, and the badge quotes CC itself rather than this sum.',
  ].join('\n');
};

/** One scope's figures for the engine and both baselines, with the human ceiling beside them. */
const scopeTable = (input: ReportInput, scope: Scope): string => {
  const { result } = input;
  const aggregateOf = (figures: PredictorFigures): Aggregate | null =>
    scope === 'overall' ? figures.overall : figures.categories[scope];
  const engine = aggregateOf(result.predictor);
  if (engine === null) {
    return [
      `### ${scopeLabel(scope)}`,
      '',
      `No record of this category is in the corpus, so there is **no figure** — not a zero: no figure and a figure`,
      'of zero are different claims.',
    ].join('\n');
  }
  const columns = [result.predictor, ...result.baselines];
  const ceiling = engine.ceiling;
  return [
    `### ${scopeLabel(scope)} — ${records(engine.records)}`,
    '',
    table(
      [
        'Metric',
        'Direction',
        ...columns.map((figures) => figures.label),
        `Human ceiling (${records(engine.ceilingRecords)})`,
      ],
      REPORT_METRIC_IDS.map((metric) => {
        const { label, direction } = descriptorOf(metric);
        const ceilingFigure =
          ceiling === null || (metric !== 'scanMatch' && metric !== 'sequenceScore')
            ? '—'
            : figure(ceiling[metric]);
        return [
          label,
          direction === 'lower-is-better' ? 'lower is better' : 'higher is better',
          ...columns.map((figures) => {
            const aggregate = aggregateOf(figures);
            return aggregate === null ? '—' : figure(metricsOf(aggregate)[metric]);
          }),
          ceilingFigure,
        ];
      }),
    ),
  ].join('\n');
};

const marginTable = (margin: Margin, label: string): string =>
  [
    `### Against ${label}`,
    '',
    table(
      ['Scope', 'Records', ...REPORT_METRIC_IDS.map((metric) => descriptorOf(metric).label)],
      SCOPES.flatMap((scope) => {
        const figures = scope === 'overall' ? margin.overall : margin.categories[scope];
        if (figures === null) return [];
        return [
          [
            scopeLabel(scope),
            String(figures.records),
            ...REPORT_METRIC_IDS.map((metric) => figure(metricsOf(figures)[metric])),
          ],
        ];
      }),
    ),
  ].join('\n');

const gateSection = (input: ReportInput): string => {
  const floors = floorsOf(input.history);
  const recordedOn = floors[0]?.recordedOn ?? '';
  return [
    '## The regression gate',
    '',
    `\`${GATE_COMMAND}\` holds every figure above to the floor the measurement of **${recordedOn}** recorded, which`,
    'is the last row of the history below. A figure that falls past its floor by more than its tolerance fails the',
    'gate; a figure that rises past it is a result, not a failure, and is recorded by appending a row rather than by',
    'moving an earlier one.',
    '',
    'The tolerances exist for one reason: the figures are deterministic on one machine — `test/score.test.ts`',
    'asserts two runs and two processes agree character for character — and the gate runs on another. CI is Linux on',
    'x64 and these floors were measured on macOS on arm64, and the image decode and the sums after it are not',
    'bit-identical across them. Each tolerance is at most a hundredth of the range its metric covers on this corpus,',
    'which is orders of magnitude above that drift and far below the smallest regression worth catching: the',
    'engine’s own defaults score 0.18 on web ScanMatch against the fitted 0.41, so a fit silently reverting would',
    'be an eighteen-tolerance fall.',
    '`packages/calibration/src/report/render.ts` carries the same argument beside the numbers, and a worker widening',
    'one has to replace it.',
    '',
    table(
      ['Metric', 'Tolerance', 'Read as'],
      REPORT_METRIC_IDS.map((metric) => {
        const { label, direction } = descriptorOf(metric);
        return [
          label,
          String(REGRESSION_TOLERANCE[metric]),
          direction === 'lower-is-better'
            ? 'fails when it rises past its floor plus the tolerance'
            : 'fails when it falls past its floor minus the tolerance',
        ];
      }),
    ),
    '',
    '### The floors in force',
    '',
    table(
      ['Scope', ...REPORT_METRIC_IDS.map((metric) => descriptorOf(metric).label)],
      SCOPES.flatMap((scope) => {
        const scoped = floors.filter((floor) => floor.scope === scope);
        if (scoped.length === 0) return [];
        return [
          [
            scopeLabel(scope),
            ...REPORT_METRIC_IDS.map((metric) =>
              figure(scoped.find((floor) => floor.metric === metric)?.floor ?? Number.NaN),
            ),
          ],
        ];
      }),
    ),
  ].join('\n');
};

const historySection = (input: ReportInput): string =>
  [
    '## History',
    '',
    'One row per recorded measurement, oldest first, appended by `' +
      REPORT_COMMAND +
      ' --record`. A row is never',
    'rewritten: a regression is meant to arrive as a diff rather than as a number that quietly moved. The full',
    `figures of every row — all six metrics, every scope — are in \`${HISTORY_PATH}\`; the columns below are the ones`,
    'a reader checks first.',
    '',
    table(
      [
        'Date',
        'Engine',
        'Corpus',
        'Seed',
        'web CC',
        'web ScanMatch',
        'Objective',
        'overall CC',
        'overall ScanMatch',
        'Why',
      ],
      input.history.rows.map((historyRow) => {
        const web = historyRow.figures.webpage;
        const overall = historyRow.figures.overall;
        return [
          historyRow.date,
          `\`${historyRow.engineVersion}\``,
          `\`${historyRow.corpus.id}\`${historyRow.corpus.synthetic ? ' (synthetic)' : ` (${historyRow.dataset ?? ''})`}`,
          String(historyRow.seed),
          web === null ? '—' : figure(web.cc),
          web === null ? '—' : figure(web.scanMatch),
          figure(historyRow.objective.value),
          overall === null ? '—' : figure(overall.cc),
          overall === null ? '—' : figure(overall.scanMatch),
          historyRow.note,
        ];
      }),
    ),
  ].join('\n');

/**
 * The committed report, rendered from one scoring run and the committed history.
 *
 * Deterministic by construction: the only inputs are the run's figures, its provenance and
 * the history file, and nothing read here is a clock or a wall-clock measurement. Running
 * the command twice over the same corpus leaves the working tree clean, which is what
 * `test/report.test.ts` and the CI step assert.
 */
export const renderReport = (input: ReportInput): string => {
  const { result } = input;
  const objective = objectiveOf(result, input.objective ?? OBJECTIVE);
  const baselineLabels = new Map(result.baselines.map((figures) => [figures.id, figures.label]));
  return (
    [
      `<!-- Generated by \`${REPORT_COMMAND}\`. Every figure here is produced, never typed: edit the code, not this file. -->`,
      '',
      `# Calibration — ${corpusHeading(input)}`,
      '',
      'How human-like the attention engine currently is, measured against human gaze with the standard saliency and',
      'scanpath metrics, against two baselines, per UI category and overall. An honest low number is better than a',
      'flattering one.',
      '',
      result.provenance.corpus.synthetic
        ? [
            '> **These figures are measured over a synthetic stand-in corpus, not over UEyes.** The records are',
            '> generated (#82) in the benchmark’s own shape so that this whole pipeline runs in CI with no download;',
            '> they are not the benchmark’s screenshots and not its participants’ gaze. **No number in this report is a',
            '> published UEyes score and none may be quoted as one.** Pointing the same code at the real dataset',
            '> changes the data and not a line of the code, and this report will then name the dataset version it was',
            '> measured on in its own heading.',
          ].join('\n')
        : `> These figures are measured over **${input.dataset ?? ''}**, the real benchmark.`,
      '',
      provenanceSection(input),
      '',
      badgeSection(input),
      '',
      objectiveSection(input, objective),
      '',
      '## The figures',
      '',
      'Every metric, for the engine and both baselines, with the number of records behind each figure and the',
      'human-to-human ceiling where a record had more than one participant. The ceiling is an agreement between two',
      'scanpaths, so it exists for the two scanpath metrics and not for the saliency ones. A category the corpus holds',
      'no record of reports no figure rather than a zero.',
      '',
      ...SCOPES.map((scope) => `${scopeTable(input, scope)}\n`),
      '## The margins',
      '',
      'The engine minus each baseline, metric by metric, over the records both sides scored. A positive margin is',
      'better on every metric but KLD, which is lower-is-better and so reads the other way. **A negative margin is a',
      'reported result and not a failure**: the centre-bias prior is hard to beat on a saliency metric, and a report',
      'that could only print a win would be decoration.',
      '',
      ...result.margins.map(
        (margin) =>
          `${marginTable(margin, baselineLabels.get(margin.baselineId) ?? margin.baselineId)}\n`,
      ),
      gateSection(input),
      '',
      historySection(input),
    ].join('\n') + '\n'
  );
};
