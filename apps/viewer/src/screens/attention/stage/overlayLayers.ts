import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AttentionArea } from '../useAttentionAreas';
import type { HeatmapOverlay } from '../useAttentionSelection';
import type { Fixation, Saccade } from '../useAttentionStepSessions';
import { AOI_OUTLINE_LAYER } from './AoiOutlineLayer';
import { CLICKS_LAYER } from './ClicksLayer';
import { HEATMAP_LAYER } from './HeatmapLayer';
import { SCROLL_LAYER } from './ScrollDepthLayer';
import type { ScreenFiguresView } from '../useScreenFigures';
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
   * The figures of this screen in the slice the two filters picked, with the six states the
   * composition can be in (`useScreenFigures`).
   *
   * **This is where the clicks and the scroll depth come from**, and the reason they are
   * handed to a layer rather than fetched by one: `aggregate.json` is stored pre-sliced, so
   * *where did the people who failed click* is a different stored row and not this row
   * filtered in a browser. A layer that recounted it could disagree with the summary about
   * the same audience, which `docs/adr/0001` forbids.
   *
   * The attention layer never reads it: dwell is drawn from the sessions' own fixations, as
   * it always was, and there are no per-pixel attention bins in the aggregate to slice.
   */
  readonly screen: ScreenFiguresView;
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
  /**
   * Which of the contract's three overlays this layer is, when it is one of them.
   *
   * It is what makes a layer **URL state**: a layer with an overlay name is read from and
   * written to `?overlay=`, so a citation can open the screen on it and a reload reproduces
   * it (decision 134). A layer without one — the areas-of-interest outlines — is a reading
   * aid the reader turns on for themselves and the address says nothing about.
   *
   * It is a field rather than the id because the two are not the same word: the attention
   * layer has been `heat` since #71 and is `attention` in `HEATMAP_OVERLAYS`, and renaming
   * either would silently change a stored citation or a `data-overlay-layer` attribute.
   */
  readonly overlay?: HeatmapOverlay;
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
 * Every overlay, in the order `#screen-heatmaps` lists them — which is also back to front:
 * the clicks and the attention are the ground, the scroll bands wash over both, and the
 * outlines are the frame around all of it.
 *
 * **The scanpath is not here, and that is decision 132.** `#screen-heatmaps` offers clicks,
 * attention, scroll depth and the areas of interest, and its own lede says *three overlays*;
 * the Attention screen's numbered-fixation layer belonged to the screen this one replaces,
 * and its *Reading this* panel went with it. `ScanpathLayer.tsx` and `medianScanpath.ts`
 * keep their code and their tests, so re-offering it is this one line — which is the point
 * of leaving them in place rather than deleting them.
 */
export const OVERLAY_LAYERS: readonly OverlayLayer[] = [
  CLICKS_LAYER,
  HEATMAP_LAYER,
  SCROLL_LAYER,
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

/** Where the three named overlays' on/off state lives: the URL (`useAttentionSelection`). */
export interface OverlaySelection {
  /** The overlays `?overlay=` names, resolved against the contract's list. */
  readonly overlays: readonly string[];
  /** Draw exactly these. Replaces the history entry rather than pushing one. */
  setOverlays(overlays: readonly HeatmapOverlay[]): void;
}

/**
 * The layers, with the switch each one is at.
 *
 * **Which overlays are drawn is the URL** (decision 134), for every layer that carries an
 * `overlay` name: the strip above the stage and the switches in this panel are two
 * renderings of one state and so can never disagree about what is on the page, a reload
 * reproduces exactly what the reader was looking at, and a recommendation citing *heatmap ·
 * waiting · progress area* lands on that overlay. Writing it replaces the history entry, so
 * flicking between overlays does not have to be walked back through.
 *
 * The areas-of-interest outlines carry no overlay name and stay this hook's own state: they
 * are a reading aid rather than a thing anybody cites.
 *
 * `selection` is optional so that the Verdict screen can build this stage without a URL to
 * read — it mounts the attention layer alone (#125) and has no filters — and there every
 * layer falls back to its `defaultOn`.
 *
 * A layer that cannot be drawn keeps whatever the reader set, rather than being switched
 * off behind their back: moving to a step that does have areas of interest then shows the
 * outlines they had asked for.
 */
export function useOverlayLayers(
  props: OverlayLayerProps,
  selection?: OverlaySelection,
): OverlayLayerState {
  const [shown, setShownState] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(OVERLAY_LAYERS.map((layer) => [layer.id, layer.defaultOn])),
  );
  // Destructured, because a caller writing the object inline would otherwise hand this hook
  // a new identity on every render; both pieces come from `useMemo`/`useCallback` upstream.
  const urlOverlays = selection?.overlays;
  const setUrlOverlays = selection?.setOverlays;

  const setShown = useCallback(
    (id: string, on: boolean) => {
      const layer = OVERLAY_LAYERS.find((candidate) => candidate.id === id);
      if (
        layer?.overlay !== undefined &&
        urlOverlays !== undefined &&
        setUrlOverlays !== undefined
      ) {
        // The whole set is rewritten, in the registry's order, so that two readers who
        // turned the same overlays on are at the same URL however they got there.
        const next = OVERLAY_LAYERS.flatMap((candidate) => {
          if (candidate.overlay === undefined) return [];
          const wanted = candidate.id === id ? on : urlOverlays.includes(candidate.overlay);
          return wanted ? [candidate.overlay] : [];
        });
        setUrlOverlays(next);
        return;
      }
      setShownState((current) => ({ ...current, [id]: on }));
    },
    [urlOverlays, setUrlOverlays],
  );

  const layers = useMemo(
    () =>
      OVERLAY_LAYERS.map((layer) => {
        const on =
          layer.overlay !== undefined && urlOverlays !== undefined
            ? urlOverlays.includes(layer.overlay)
            : (shown[layer.id] ?? layer.defaultOn);
        const unavailable = layer.unavailable?.(props) ?? null;
        return { layer, on, unavailable, drawn: on && unavailable === null, props };
      }),
    [shown, props, urlOverlays],
  );

  return { layers, setShown };
}
