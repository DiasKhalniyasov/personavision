import { useMemo } from 'react';
import type { Run } from '@personavision/contract';
import { useCurrentRunId, useOptionalRun } from '@/shell/useRun';

/**
 * The areas of interest of one version's step, each with the numbers the pipeline worked
 * out for it.
 *
 * `run.json` keeps the two apart: `aois` is where an area is and what it is called, and
 * `aoiMetrics` is what the audience did there. The join is by `aoiId`, it is made here
 * once, and the screen's table, outlines and isolate caption all read the result — so the
 * outline a reader sees and the row they click can never be about different areas.
 *
 * Nothing is recomputed: the viewer does not aggregate fixations into metrics, the pipeline
 * does (`docs/FLOW.md` section 3). What this adds is honesty about the gaps. An area the
 * run recorded no metrics for keeps its row with a `null` metric rather than vanishing, an
 * area that exists on the other version only is reported so the table can say "not present
 * in this version — nothing to compare", and a metrics row naming no area at all is
 * surfaced rather than dropped, because a figure attached to nothing is a fault in the
 * artifact and not something a screen should swallow.
 */

/** One area of interest, as `run.json`'s `aois` records it. */
export type Aoi = Run['aois'][number];
/** One area's numbers, as `run.json`'s `aoiMetrics` records them. */
export type AoiMetric = Run['aoiMetrics'][number];

/** One row of this step: the area, and what the audience did there. */
export interface AttentionArea {
  readonly aoi: Aoi;
  /** `null` when the run recorded no metrics for this area: a gap, stated as one. */
  readonly metric: AoiMetric | null;
}

export interface AttentionAreas {
  /** The areas of this version's step, in the artifact's order. */
  readonly areas: AttentionArea[];
  /**
   * Areas of this step that only the other version has, by the name both versions give the
   * same thing. The promo banner the redesign added is one of these on the current
   * checkout, and a row saying so is the comparison; a row missing is not.
   */
  readonly presentOnOtherVariantOnly: Aoi[];
  /** `aoiMetrics` rows whose `aoiId` names no area anywhere in this run. */
  readonly unknownMetricAoiIds: string[];
}

/** The areas of one version's step, joined to their metrics. Pure, so a test needs no DOM. */
export function attentionAreas(run: Run, variant: string, step: string): AttentionAreas {
  const metricsById = new Map(run.aoiMetrics.map((metric) => [metric.aoiId, metric]));
  const onThisStep = run.aois.filter((aoi) => aoi.step === step);
  const here = onThisStep.filter((aoi) => aoi.variant === variant);
  const named = new Set(here.map((aoi) => aoi.label));

  const elsewhere: Aoi[] = [];
  for (const aoi of onThisStep) {
    if (aoi.variant === variant || named.has(aoi.label)) continue;
    // One row per area, not one per version that has it: two other versions carrying the
    // same area is still one thing this version does not have.
    if (elsewhere.some((seen) => seen.label === aoi.label)) continue;
    elsewhere.push(aoi);
  }

  const known = new Set(run.aois.map((aoi) => aoi.id));

  return {
    areas: here.map((aoi) => ({ aoi, metric: metricsById.get(aoi.id) ?? null })),
    presentOnOtherVariantOnly: elsewhere,
    unknownMetricAoiIds: run.aoiMetrics
      .map((metric) => metric.aoiId)
      .filter((aoiId) => !known.has(aoiId)),
  };
}

const NONE: AttentionAreas = { areas: [], presentOnOtherVariantOnly: [], unknownMetricAoiIds: [] };

/** The areas of this version's step, read from the run the route is about. */
export function useAttentionAreas(variant: string, step: string): AttentionAreas {
  const state = useOptionalRun(useCurrentRunId());
  const run = state?.status === 'ready' ? state.run : null;

  return useMemo(
    () => (run === null ? NONE : attentionAreas(run, variant, step)),
    [run, variant, step],
  );
}
