import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HISTORY_SCHEMA_VERSION,
  OBJECTIVE,
  REGRESSION_TOLERANCE,
  REPORT_COMMAND,
  REPORT_METRIC_IDS,
  REPORT_SEED,
  ReportError,
  SCOPES,
  appendHistory,
  committedCorpus,
  defaultBaselines,
  enginePredictor,
  historyRowOf,
  loadHistory,
  objectiveOf,
  parseHistory,
  renderHistory,
  renderReport,
  reportPaths,
  score,
  type History,
  type HistoryRow,
  type RecordedFigures,
  type ScoreResult,
} from '../src/index.js';

/**
 * The committed report is the engine's figures written down where a change to them shows up
 * in a diff (#89). What is asserted here is that **none of it was typed**: the file in
 * `docs/calibration/` is compared, character for character, with what a fresh scoring run
 * renders — which is the same comparison CI makes, as a test a developer can run.
 */

const freshRun = async (): Promise<ScoreResult> =>
  score({
    predictor: enginePredictor(),
    corpus: committedCorpus(),
    baselines: defaultBaselines(),
    seed: REPORT_SEED,
  });

const paths = reportPaths();

const committedReport = (): string => readFileSync(paths.report, 'utf8');

/** The run as it would be if the corpus were the benchmark itself rather than the stand-in. */
const overTheRealBenchmark = (result: ScoreResult): ScoreResult => ({
  ...result,
  provenance: {
    ...result.provenance,
    corpus: { ...result.provenance.corpus, id: 'ueyes', label: 'UEyes', synthetic: false },
  },
});

const ROW: Parameters<typeof historyRowOf>[1] = {
  date: '2026-10-28',
  note: 'a measurement recorded by a test',
};

describe('the committed report', () => {
  it('is exactly what a fresh scoring run renders, so no figure in it was typed', async () => {
    const result = await freshRun();

    expect(renderReport({ result, history: loadHistory() })).toBe(committedReport());
  }, 60_000);

  it('renders identically from a second run, so regenerating leaves the working tree clean', async () => {
    const history = loadHistory();

    const once = renderReport({ result: await freshRun(), history });
    const again = renderReport({ result: await freshRun(), history });

    expect(again).toBe(once);
  }, 60_000);

  it('carries no clock at all: a date in it is a recorded measurement and nothing else', async () => {
    const text = renderReport({ result: await freshRun(), history: loadHistory() });

    // Wall-clock timings are properties of the machine, not figures (#88), and a generation
    // date would make the file differ on every run — which is the whole reason the report is
    // regenerated in CI and compared.
    expect(text).not.toContain('elapsedMs');
    expect(text).not.toContain(' ms');
    const dates = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    const recorded = new Set(loadHistory().rows.map(({ date }) => date));
    for (const date of dates) expect(recorded, date).toContain(date);
  }, 60_000);

  it('says in its first lines that it was generated, and by which command', async () => {
    const text = renderReport({ result: await freshRun(), history: loadHistory() });

    expect(text.split('\n')[0]).toContain(REPORT_COMMAND);
  }, 60_000);
});

describe('honest about scope', () => {
  it('labels a synthetic corpus in the heading itself, not in a footnote', async () => {
    const text = renderReport({ result: await freshRun(), history: loadHistory() });
    const heading = text.split('\n').find((line) => line.startsWith('# '));

    expect(heading).toContain('synthetic');
    expect(heading).toContain('not the UEyes benchmark');
  }, 60_000);

  it('refuses to report a real corpus that does not name the dataset version', async () => {
    const result = overTheRealBenchmark(await freshRun());

    expect(() => renderReport({ result, history: loadHistory() })).toThrowError(ReportError);
    expect(() => renderReport({ result, history: loadHistory() })).toThrowError(/dataset version/);
  }, 60_000);

  it('and names that version in the heading when it is given one', async () => {
    const result = overTheRealBenchmark(await freshRun());

    const text = renderReport({ result, history: loadHistory(), dataset: 'UEyes 1.0' });
    const heading = text.split('\n').find((line) => line.startsWith('# '));

    expect(heading).toContain('UEyes 1.0');
    expect(heading).not.toContain('synthetic');
  }, 60_000);

  it('refuses to record a real corpus that does not name the dataset version either', async () => {
    const result = overTheRealBenchmark(await freshRun());

    expect(() => historyRowOf(result, ROW)).toThrowError(/dataset version/);
    expect(historyRowOf(result, { ...ROW, dataset: 'UEyes 1.0' }).dataset).toBe('UEyes 1.0');
  }, 60_000);
});

describe('what the report carries', () => {
  it('states which figure the product’s badge quotes, and prints that figure', async () => {
    const result = await freshRun();
    const text = renderReport({ result, history: loadHistory() });
    const web = result.predictor.categories.webpage;

    expect(text).toContain('## What the product’s badge quotes');
    expect(text).toContain('**The web category’s CC.**');
    /** The number the badge itself would print, and the one the table below it carries. */
    expect(text).toContain(`gaze similarity ${String(Number((web?.saliency.cc ?? 0).toFixed(2)))}`);
    expect(text).toContain(`**${(web?.saliency.cc ?? 0).toFixed(4)}**`);
  }, 60_000);

  it('carries the objective, its scope and the weight of every term', async () => {
    const result = await freshRun();
    const value = objectiveOf(result);

    const text = renderReport({ result, history: loadHistory() });

    expect(text).toContain(`\`${OBJECTIVE.id}\``);
    expect(text).toContain(OBJECTIVE.label);
    expect(text).toContain(`**${OBJECTIVE.scope}**`);
    for (const term of OBJECTIVE.terms) expect(text).toContain(`| ${String(term.weight)} |`);
    expect(text).toContain(`**${value.value.toFixed(4)}**`);
  }, 60_000);

  it('carries every metric for every scope, with the records behind it', async () => {
    const result = await freshRun();

    const text = renderReport({ result, history: loadHistory() });

    for (const scope of SCOPES) {
      const aggregate =
        scope === 'overall' ? result.predictor.overall : result.predictor.categories[scope];
      expect(aggregate, scope).not.toBeNull();
      const figures = { ...aggregate?.saliency, ...aggregate?.scanpath } as Record<string, number>;
      for (const metric of REPORT_METRIC_IDS) {
        expect(text, `${scope} ${metric}`).toContain(figures[metric]?.toFixed(4));
      }
      expect(text, scope).toContain(
        `${String(aggregate?.records)} ${aggregate?.records === 1 ? 'record' : 'records'}`,
      );
    }
  }, 60_000);

  it('carries both baselines and the margin over each, a negative margin included', async () => {
    const result = await freshRun();

    const text = renderReport({ result, history: loadHistory() });

    for (const baseline of result.baselines) expect(text).toContain(baseline.label);
    for (const margin of result.margins) {
      expect(text).toContain(margin.overall?.saliency.cc.toFixed(4));
    }
    /** The engine loses to the prior on the poster's CC, and the report prints the loss. */
    const poster = result.margins[0]?.categories.poster;
    expect(poster?.saliency.cc).toBeLessThan(0);
    expect(text).toContain(poster?.saliency.cc.toFixed(4));
  }, 60_000);

  it('carries the human-to-human ceiling where a record had more than one participant', async () => {
    const result = await freshRun();

    const text = renderReport({ result, history: loadHistory() });

    const ceiling = result.predictor.overall?.ceiling;
    expect(ceiling).not.toBeNull();
    expect(text).toContain(ceiling?.scanMatch.toFixed(4));
    expect(text).toContain('Human ceiling');
  }, 60_000);

  it('carries the floors in force and the tolerance beside every metric', async () => {
    const result = await freshRun();

    const text = renderReport({ result, history: loadHistory() });

    expect(text).toContain('### The floors in force');
    for (const metric of REPORT_METRIC_IDS) {
      expect(text, metric).toContain(`| ${String(REGRESSION_TOLERANCE[metric])} |`);
    }
  }, 60_000);

  it('prints one history table row per recorded measurement', async () => {
    const history = loadHistory();

    const text = renderReport({ result: await freshRun(), history });

    for (const row of history.rows) {
      expect(text).toContain(`| ${row.date} | \`${row.engineVersion}\``);
      expect(text).toContain(row.note);
    }
  }, 60_000);
});

describe('the committed history', () => {
  it('is the file the gate reads its floors from, and its last row is this run’s figures', async () => {
    const result = await freshRun();
    const last = loadHistory().rows.at(-1);

    expect(last?.engineVersion).toBe(result.predictor.provenance.version);
    expect(last?.corpus).toEqual(result.provenance.corpus);
    expect(last?.seed).toBe(result.provenance.seed);
    expect(last?.figures).toEqual(historyRowOf(result, ROW).figures);
  }, 60_000);

  it('carries the date, the engine version, the corpus identity and every figure in a row', async () => {
    const row = historyRowOf(await freshRun(), ROW);

    expect(row.date).toBe(ROW.date);
    expect(row.engineVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(row.calibrated).toBe(true);
    expect(row.corpus.id).toBe('committed-synthetic');
    expect(row.objective.id).toBe(OBJECTIVE.id);
    for (const scope of SCOPES) {
      const figures = row.figures[scope] as RecordedFigures;
      expect(figures, scope).not.toBeNull();
      for (const metric of REPORT_METRIC_IDS) {
        expect(Number.isFinite(figures[metric]), `${scope} ${metric}`).toBe(true);
      }
    }
  }, 60_000);

  it('appends a row and leaves every earlier one exactly as it was', async () => {
    const history = loadHistory();
    const row = historyRowOf(await freshRun(), ROW);

    const appended = appendHistory(history, row);

    expect(appended.rows).toHaveLength(history.rows.length + 1);
    expect(appended.rows.slice(0, history.rows.length)).toEqual(history.rows);
    expect(appended.rows.at(-1)).toEqual(row);
    /** And the committed file is unchanged by reading it: appending returns a new history. */
    expect(renderHistory(history)).toBe(readFileSync(paths.history, 'utf8'));
  }, 60_000);

  it('refuses a row dated before the last recorded one, because history is not inserted into', async () => {
    const history = loadHistory();
    const row = historyRowOf(await freshRun(), { ...ROW, date: '2000-01-01' });

    expect(() => appendHistory(history, row)).toThrowError(ReportError);
    expect(() => appendHistory(history, row)).toThrowError(/appended, never inserted into/);
  }, 60_000);

  it('refuses a measurement recorded with no reason', async () => {
    const result = await freshRun();

    expect(() => historyRowOf(result, { ...ROW, note: '   ' })).toThrowError(/why it was recorded/);
    expect(() => historyRowOf(result, { ...ROW, date: '27-10-2026' })).toThrowError(/YYYY-MM-DD/);
  }, 60_000);
});

describe('a history file that cannot be trusted', () => {
  const sound = (): History => loadHistory();

  const refused = (edit: (history: History) => unknown, message: RegExp): void => {
    const text = JSON.stringify(edit(sound()));

    expect(() => parseHistory(text, 'the history under test')).toThrowError(ReportError);
    expect(() => parseHistory(text, 'the history under test')).toThrowError(message);
  };

  it('is refused by name rather than read as a floor', () => {
    expect(() => parseHistory('{', 'a file')).toThrowError(/not JSON/);
    refused((history) => ({ ...history, schemaVersion: 99 }), /schema version/);
    refused((history) => ({ ...history, rows: 'later' }), /no rows array/);
  });

  it('and so is a row that cannot say when, what or how much', () => {
    const first = (history: History, edit: Partial<HistoryRow>): unknown => ({
      ...history,
      rows: [{ ...history.rows[0], ...edit }],
    });

    refused((history) => first(history, { date: 'yesterday' }), /YYYY-MM-DD date/);
    refused((history) => first(history, { engineVersion: '' }), /names no engine version/);
    refused(
      (history) => first(history, { corpus: undefined as unknown as HistoryRow['corpus'] }),
      /names no corpus/,
    );
    refused(
      (history) => first(history, { figures: undefined as unknown as HistoryRow['figures'] }),
      /carries no figures/,
    );
    refused(
      (history) =>
        first(history, {
          figures: {
            ...history.rows[0]?.figures,
            overall: { ...history.rows[0]?.figures.overall, cc: 'high' },
          } as unknown as HistoryRow['figures'],
        }),
      /no finite cc/,
    );
  });

  it('and the committed one parses at the version this build writes', () => {
    expect(loadHistory().schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
  });
});
