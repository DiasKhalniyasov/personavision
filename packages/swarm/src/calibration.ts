/**
 * The run artifact's calibration block: the badge's number, or an honest nothing.
 *
 * The product chrome's badge reads `Simulated audience · gaze similarity 0.68` on every
 * screen, and its longer form names CC, NSS and ScanMatch. Both read `run.calibration`, and
 * this module is the data behind them.
 *
 * The whole of its job is to **carry** figures. It computes nothing, scores nothing, rounds
 * nothing, defaults nothing and reads no file of its own: the figures arrive through the
 * engine's resolved configuration (#56), which is where the fit (#90) already put them for
 * this purpose. An engine nobody calibrated writes `calibration: null` — not a zero, not a
 * default, not the last number anyone saw. The viewer renders that block as "not calibrated"
 * in words (#12, #14), and a fabricated similarity figure would be the worst defect this
 * product could ship.
 *
 * `run.engine.version` names the engine the figures were earned by, so a run can be matched
 * against the committed calibration report (`docs/calibration/report.md`, #89), whose every
 * row carries the same version. It is the engine's own `ENGINE_VERSION`, because a creator
 * can only guess at which engine is about to run and a stale figure beside a new engine is
 * the one thing this block must never carry.
 *
 * `docs/FLOW.md` section 8; step #11; ticket #92.
 */

import { ENGINE_VERSION, resolveEngineConfig } from '@personavision/engine';
import type { Run } from '@personavision/contract';
import type { CalibratedMetrics, ResolvedEngineConfig } from '@personavision/engine';

/** `run.calibration`, as `packages/contract` declares it (#2): the figures, or nothing. */
export type RunCalibration = Run['calibration'];

/** The two fields of a run artifact that say which engine ran and what it scored. */
export interface EngineOnTheRecord {
  /** `run.engine.version`. */
  readonly version: string;
  /** `run.calibration`. */
  readonly calibration: RunCalibration;
}

/**
 * The calibration block, from the figures the engine's configuration carries.
 *
 * Three of the six figures the fit recorded, because three are what the badge and the
 * comparison footnote state; the other three stay in `packages/engine/config/calibrated.json`
 * where a reviewer reads them. Nothing is derived on the way — every value is the
 * configuration's own, to the last digit — and `null` in is `null` out.
 */
export const calibrationOf = (metrics: CalibratedMetrics | null): RunCalibration =>
  metrics === null
    ? null
    : {
        benchmark: metrics.benchmark,
        cc: metrics.cc,
        nss: metrics.nss,
        scanMatch: metrics.scanMatch,
      };

/**
 * What a run records about the engine that produced it: which engine, and what it scored.
 *
 * The run loop writes this into `run.json` before its first session, so the badge does not
 * change value mid-run. Whatever **creates** a run writes the same two fields from here —
 * the command or the platform that opens one, and the one that records a run which failed to
 * start and never reached the loop (#54) — so a run carries its block from the moment it
 * exists and there is one answer rather than two.
 *
 * **The figures are a fact about the build, not about this run's configuration.** A run may
 * layer its own `engine.weights` over the fitted values, and the figures it carries are
 * still the ones the fit measured: that is the engine's own stance on `calibrated`
 * (`packages/engine/src/config.ts`), restated here because this is where it becomes a number
 * on a screen. What the figures were measured over travels with them in
 * `config/calibrated.json`'s `metrics.corpus` — a synthetic corpus says so — and the
 * committed report (#89) is where a reader goes for the scope.
 */
export const engineOnTheRecord = (
  resolved: Pick<ResolvedEngineConfig, 'metrics'> = resolveEngineConfig(),
): EngineOnTheRecord => ({
  version: ENGINE_VERSION,
  calibration: calibrationOf(resolved.metrics),
});

/**
 * Whether two blocks say the same thing, so a run that already carries the engine's own
 * figures is left exactly as its creator wrote it.
 *
 * Field by field rather than by a deep compare, because the fields are the contract's four
 * and a block that grew one would have to be read here before it could be written.
 */
export const sameCalibration = (left: RunCalibration, right: RunCalibration): boolean =>
  left === null || right === null
    ? left === right
    : left.benchmark === right.benchmark &&
      left.cc === right.cc &&
      left.nss === right.nss &&
      left.scanMatch === right.scanMatch;
