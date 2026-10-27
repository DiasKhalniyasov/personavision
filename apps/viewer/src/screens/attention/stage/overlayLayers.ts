import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AttentionArea } from '../useAttentionAreas';
import type { Fixation, Saccade } from '../useAttentionStepSessions';
import { AOI_OUTLINE_LAYER } from './AoiOutlineLayer';
import { HEATMAP_LAYER } from './HeatmapLayer';
import { SCANPATH_LAYER } from './ScanpathLayer';
import type { Transform } from './overlayTransform';

/**
 * The registry the Overlays panel renders, and the on/off state it owns.
 *
 * **This is the other half of the seam** (`overlayTransform.ts` is the first). The heatmap
 * (#71), the scanpath (#72) and the area outlines are one entry each in the list below:
 * each declares what it is called in the panel, whether it starts on, and one component
 * that draws it. None of them knows the others exist, none of them reads the URL, and none
 * of them is mounted at all while its toggle is off — so the three tickets can be written
 * without touching one another, and the order they land in is the order their entries are
 * added here.
 *
 * Every layer is handed the same data, including `isolatedAoiId`, and **every layer is
 * responsible for honouring it**: the panel's business is one on/off switch per entry and
 * nothing else. Isolation is the whole screen's state, in the URL (`useAttentionSelection`),
 * and a layer that quietly ignored it would show the reader a view the address bar says
 * they are not looking at.
 */

/** What every layer is given. The same object reaches all of them, from the stage. */
export interface OverlayLayerProps {
  /** Every fixation the scored sessions recorded on this version's step. */
  readonly fixations: readonly Fixation[];
  /** The moves between two of those fixations. */
  readonly saccades: readonly Saccade[];
  /** This version's step's areas of interest, each with the numbers the pipeline wrote. */
  readonly areas: readonly AttentionArea[];
  /** The one area the screen is isolated to, or `null` for all of them. */
  readonly isolatedAoiId: string | null;
  /** The screenshot's page box: what `pageToOverlay` and `boxToOverlay` draw against. */
  readonly transform: Transform;
  /**
   * Whether the sessions are still arriving, so what is above is part of the audience
   * rather than all of it (#71, threaded through by `AttentionStage`).
   *
   * Optional, and absent means settled: a layer that aggregates every session has to
   * withhold itself rather than draw half of them and fill in as the rest land, and a
   * layer drawing something the loading cannot change — the outlines, which come from the
   * run and not from the sessions — never reads it.
   */
  readonly loading?: boolean;
}

export interface OverlayLayer {
  /** Its own id, stable, and what the panel keys its switch on. */
  readonly id: string;
  /** What the panel calls it, in the prototype's words. */
  readonly label: string;
  /** The prototype's second half of the label, where it has one — "dwell-weighted". */
  readonly hint?: string;
  /** Whether it starts drawn. */
  readonly defaultOn: boolean;
  /**
   * Why this layer cannot be drawn over this version's step, in a sentence, or `null` when
   * it can. The panel disables the entry and prints the sentence instead of offering a
   * switch that would turn on an empty layer — a reader who toggles something and sees
   * nothing happen cannot tell "off" from "there is nothing here".
   */
  unavailable?(props: OverlayLayerProps): string | null;
  Component(props: OverlayLayerProps): ReactNode;
  /**
   * What the panel shows under this layer's switch while it is on, where a layer needs a
   * legend to be read at all — the heatmap's cool-to-hot key (#71), which also says when
   * there is nothing to show rather than presenting an empty ramp as data.
   *
   * It belongs to the layer and not to the panel because only the layer knows what it drew.
   * Switching the layer off unmounts it with the layer, and no other layer is touched.
   */
  Legend?(props: OverlayLayerProps): ReactNode;
}

/**
 * Every overlay, in the order the panel lists them — the prototype's order, which is also
 * back to front: the heatmap is the ground the scanpath is read over, and the outlines are
 * the frame around both.
 */
export const OVERLAY_LAYERS: readonly OverlayLayer[] = [
  HEATMAP_LAYER,
  SCANPATH_LAYER,
  AOI_OUTLINE_LAYER,
];

/** One registered layer, with what the panel shows about it and what the stage draws. */
export interface StageLayer {
  readonly layer: OverlayLayer;
  /** Whether the reader has it switched on. */
  readonly on: boolean;
  /** Why it cannot be drawn here, or `null`. */
  readonly unavailable: string | null;
  /** On, and drawable: the stage mounts exactly these. */
  readonly drawn: boolean;
  /**
   * What this layer would be handed, for the panel to render its `Legend` with (#71).
   *
   * Optional only so that a test of the panel can hand it layers of its own invention
   * without a run behind them; the hook below always sets it, and a layer with no legend
   * never reads it.
   */
  readonly props?: OverlayLayerProps;
}

export interface OverlayLayerState {
  readonly layers: readonly StageLayer[];
  setShown(id: string, on: boolean): void;
}

/**
 * The layers, with the switch each one is at.
 *
 * The state is this screen's only piece that is **not** in the URL, and that is deliberate:
 * which overlays a reader has on is how they are looking, not what they are looking at. The
 * three things a link has to reproduce — version, step, isolated area — are the selection
 * and live in the address (#30); putting the toggles there too would make every glance at a
 * different layer a new entry in the reader's history to go back through.
 *
 * A layer that cannot be drawn keeps whatever the reader set, rather than being switched
 * off behind their back: moving to a step that does have areas of interest then shows the
 * outlines they had asked for.
 */
export function useOverlayLayers(props: OverlayLayerProps): OverlayLayerState {
  const [shown, setShownState] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(OVERLAY_LAYERS.map((layer) => [layer.id, layer.defaultOn])),
  );

  const setShown = useCallback((id: string, on: boolean) => {
    setShownState((current) => ({ ...current, [id]: on }));
  }, []);

  const layers = useMemo(
    () =>
      OVERLAY_LAYERS.map((layer) => {
        const on = shown[layer.id] ?? layer.defaultOn;
        const unavailable = layer.unavailable?.(props) ?? null;
        return { layer, on, unavailable, drawn: on && unavailable === null, props };
      }),
    [shown, props],
  );

  return { layers, setShown };
}
