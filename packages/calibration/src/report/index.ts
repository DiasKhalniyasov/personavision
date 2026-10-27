/**
 * The committed calibration report and the floors the regression gate asserts (#89).
 *
 * One scoring run (#88) becomes the markdown committed at `docs/calibration/report.md` and a
 * row appended to `docs/calibration/history.json`; the gate reads the last row of that file
 * as the floor every figure is held to. `scripts/report.ts` is the one command that writes
 * either file, and `docs/calibration/report.md` says in its first line that it was generated.
 */

export {
  GATE_COMMAND,
  HISTORY_PATH,
  HISTORY_SCHEMA_VERSION,
  REGRESSION_TOLERANCE,
  REPORT_COMMAND,
  REPORT_METRIC_IDS,
  REPORT_PATH,
  REPORT_SEED,
  ReportError,
  SCOPES,
  appendHistory,
  breachesOf,
  describeBreach,
  floorsOf,
  historyRowOf,
  loadHistory,
  parseHistory,
  renderHistory,
  renderReport,
  reportPaths,
  repositoryRoot,
} from './render.js';
export type {
  Floor,
  FloorBreach,
  History,
  HistoryRow,
  RecordOptions,
  RecordedFigures,
  ReportInput,
  ReportMetricId,
  Scope,
} from './render.js';
