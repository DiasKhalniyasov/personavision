/**
 * The one command that writes the committed calibration report (#89).
 *
 * ```sh
 * pnpm --filter @personavision/calibration run report
 * ```
 *
 * It scores the engine over the committed corpus beside both baselines (#88), renders
 * `docs/calibration/report.md` from what that run produced, and writes it. Nothing in the
 * report is typed: the figures, their provenance, the objective and its weights and the
 * history table are all produced here, so a figure in this repository is always the figure
 * the code produces.
 *
 * - `--check` writes nothing and reports whether the committed report is this run. CI runs
 *   it, so a report that drifted from the code fails the build rather than misleading a
 *   reader.
 * - `--record --note "…"` appends one row to `docs/calibration/history.json` before
 *   rendering, which is how the regression gate's floors are moved. A row is appended and
 *   never rewritten, so a regression arrives as a diff. `--date` and `--dataset` are for a
 *   measurement that is not today's and not over the synthetic stand-in.
 *
 * Running it with no flags re-renders the report from a fresh run and must leave the working
 * tree clean: the report carries no clock, no elapsed time and no generation date.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  REPORT_SEED,
  appendHistory,
  committedCorpus,
  defaultBaselines,
  enginePredictor,
  historyRowOf,
  loadHistory,
  renderHistory,
  renderReport,
  reportPaths,
  score,
} from '../src/index.js';
import type { History } from '../src/index.js';

const stringArg = (flag: string): string | null => {
  const position = process.argv.indexOf(flag);
  if (position < 0) return null;
  const value = process.argv[position + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
};

const check = process.argv.includes('--check');
const record = process.argv.includes('--record');

if (check && record) {
  // `--check` asks whether the committed report is this run. Appending a row first would
  // make it ask whether the committed report is this run plus an edit it just made.
  throw new Error('--check reports on the committed report, so it records nothing');
}

const { report: reportPath, history: historyPath } = reportPaths();

process.stdout.write(
  `scoring the engine over the committed corpus at seed ${String(REPORT_SEED)}\n`,
);

const result = await score({
  predictor: enginePredictor(),
  corpus: committedCorpus(),
  baselines: defaultBaselines(),
  seed: REPORT_SEED,
  onProgress: ({ message }) => process.stdout.write(`${message}\n`),
});

const dataset = stringArg('--dataset');
const committedHistory: History = existsSync(historyPath)
  ? loadHistory(historyPath)
  : { schemaVersion: 1, rows: [] };

let history = committedHistory;
if (record) {
  const note = stringArg('--note');
  if (note === null) {
    throw new Error('--record needs --note "…": a recorded measurement says why it was recorded');
  }
  // The clock is read here and nowhere else: the report itself carries no date, so that
  // re-rendering it leaves the working tree clean.
  const date = stringArg('--date') ?? new Date().toISOString().slice(0, 10);
  history = appendHistory(committedHistory, historyRowOf(result, { date, note, dataset }));
  writeFileSync(historyPath, renderHistory(history));
  process.stdout.write(`appended the measurement of ${date} to ${historyPath}\n`);
}

const text = renderReport({ result, history, dataset });

const { overall, categories } = result.predictor;
process.stdout.write(
  [
    '',
    `engine ${result.predictor.provenance.version}${result.predictor.provenance.calibrated === true ? ' (calibrated)' : ' (NOT calibrated)'} over ${result.provenance.corpus.id}`,
    `  web      cc ${(categories.webpage?.saliency.cc ?? Number.NaN).toFixed(4)}  scanMatch ${(categories.webpage?.scanpath.scanMatch ?? Number.NaN).toFixed(4)}`,
    `  overall  cc ${(overall?.saliency.cc ?? Number.NaN).toFixed(4)}  scanMatch ${(overall?.scanpath.scanMatch ?? Number.NaN).toFixed(4)}  over ${String(overall?.records ?? 0)} records`,
    '',
  ].join('\n'),
);

if (check) {
  const committed = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const same = committed === text;
  process.stdout.write(
    same
      ? `${reportPath} is this run\n`
      : `${reportPath} is NOT this run: re-run without --check to write it\n`,
  );
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(reportPath, text);
  process.stdout.write(`wrote ${reportPath}\n`);
}
