import { useId, useMemo, useState } from 'react';
import type { Run } from '@personavision/contract';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { runDataBase } from '@/shell/useRun';
import type { AttentionArea } from '../useAttentionAreas';
import type { AttentionStepSessions } from '../useAttentionStepSessions';
import { useOverlayLayers } from './overlayLayers';
import type { OverlayLayerProps, OverlayLayerState, StageLayer } from './overlayLayers';
import {
  DEFAULT_ZOOM,
  ZOOM_LEVELS,
  foldMark,
  isDrawable,
  pageBox,
  transformOf,
  zoomLabel,
} from './overlayTransform';
import type { Capture, Transform } from './overlayTransform';
import styles from './attentionStage.module.css';

/**
 * `#att-frame` and `#att-page`: the page as the audience saw it, with the overlays on it.
 *
 * It is the **whole captured page**, drawn at the size it was captured and scrolled inside
 * the frame — not one viewport of it. That is what separates this frame from the replay's
 * (#22), which is one viewport at one person's scroll offset and draws from the
 * viewport-relative `x`/`y`. Here the aggregate is drawn in page coordinates, over the
 * whole page, because the question is where attention went on the page and not where one
 * person's screen was. `docs/FLOW.md` and #4 keep the two coordinate bases apart on
 * purpose, so the two frames are two components and share only the tokens.
 *
 * Every overlay sits inside `#att-page` itself, the box the screenshot fills: the image and
 * the layers are one object that the zoom scales and the frame scrolls, which is what makes
 * "a fixation never drifts off the button it landed on" true by construction rather than by
 * arithmetic (`overlayTransform.ts`).
 */

/** How far the screenshot has got, which is what the frame says instead of showing a gap. */
type ScreenshotState =
  /** Not decoded yet. The box is open and nothing is drawn in it. */
  | 'loading'
  /** On screen, with whatever layers the reader has on. */
  | 'shown'
  /** The run records no capture of this version's step. */
  | 'missing'
  /** It records one, but of a page with no size: there is nothing to draw on. */
  | 'unusable'
  /** The file it names could not be read. The page's box is still known. */
  | 'unreadable';

/**
 * Whether the stage is what this screen shows at all.
 *
 * Two things are truer than a page and are shown instead of it — a session file that could
 * not be read, and a step nobody in the audience reached. Both the frame and the Overlays
 * panel read this, because they are in two cells of the screen's grid: a panel of live
 * switches beside a stage that is not there would offer the reader controls for nothing.
 */
export const stageIsShown = (sessions: AttentionStepSessions): boolean =>
  sessions.status !== 'error' && !(sessions.status === 'ready' && sessions.reachedCount === 0);

export interface AttentionStageView {
  /** Every registered layer, with the switch it is at. The panel renders these. */
  readonly layers: readonly StageLayer[];
  setShown(id: string, on: boolean): void;
  /** The capture of this version's step, or `null` when the run holds none. */
  readonly capture: Capture | null;
  /** Where its file is, resolved from the `path` the artifact itself records. */
  readonly screenshotUrl: string | null;
  /** What this step is called on screen — `Review`, not `review`. */
  readonly stepLabel: string;
  /** What this version is called — `Redesign candidate`, not `B`. */
  readonly variantName: string;
  /** What every layer is given. */
  readonly layerProps: OverlayLayerProps;
}

/**
 * The stage, assembled once for the two places it is read from: the frame below and the
 * Overlays panel, which the scaffold puts in the side column (#30). They are in different
 * cells of the screen's grid and share one piece of state — which layers are on — so it is
 * held here, above both, and neither of them holds any of the other's.
 */
export function useAttentionStage({
  run,
  variant,
  step,
  aoi,
  sessions,
  areas,
}: {
  run: Run;
  variant: string;
  step: string;
  /** The isolated area of interest, as the URL resolves it. */
  aoi: string | null;
  sessions: AttentionStepSessions;
  areas: readonly AttentionArea[];
}): AttentionStageView {
  const capture = useMemo(
    () => run.screenshots.find((shot) => shot.variant === variant && shot.step === step) ?? null,
    [run.screenshots, variant, step],
  );

  // The artifact's own `path`, not a path this screen spells: `run.json` records where each
  // capture is, and a viewer that re-derived it would disagree with the run the day the
  // pipeline writes them somewhere else.
  const screenshotUrl = useMemo(
    () =>
      capture === null
        ? null
        : new URL(capture.path, new URL(runDataBase(run.runId), window.location.href)).toString(),
    [capture, run.runId],
  );

  const transform: Transform = useMemo(
    () => (capture === null ? { pageWidth: 0, pageHeight: 0 } : transformOf(capture)),
    [capture],
  );

  const layerProps: OverlayLayerProps = useMemo(
    () => ({
      fixations: sessions.fixations,
      saccades: sessions.saccades,
      areas,
      isolatedAoiId: aoi,
      transform,
    }),
    [sessions.fixations, sessions.saccades, areas, aoi, transform],
  );

  const { layers, setShown }: OverlayLayerState = useOverlayLayers(layerProps);

  return {
    layers,
    setShown,
    capture,
    screenshotUrl,
    stepLabel: run.steps.find((candidate) => candidate.id === step)?.label ?? step,
    variantName: run.variants.find((candidate) => candidate.id === variant)?.name ?? variant,
    layerProps,
  };
}

export function AttentionStage({ stage }: { stage: AttentionStageView }) {
  const { capture, screenshotUrl, stepLabel, variantName, layers, layerProps } = stage;
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  // Which screenshot has arrived, and which one would not: the *url*, not a flag, because
  // moving step asks for a different file and that one deserves its own attempt.
  const [decoded, setDecoded] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  const state: ScreenshotState =
    capture === null || screenshotUrl === null
      ? 'missing'
      : !isDrawable(capture)
        ? 'unusable'
        : broken === screenshotUrl
          ? 'unreadable'
          : decoded === screenshotUrl
            ? 'shown'
            : 'loading';

  // A page there is something to draw on has a box of its own, in the pixels it was
  // captured in; without one the stage is a sentence, and the sentence fills the frame
  // rather than being laid out inside a box of nothing.
  const box =
    state === 'missing' || state === 'unusable' ? null : pageBox(layerProps.transform, zoom);
  const fold = capture === null || !isDrawable(capture) ? null : foldMark(capture);
  // Nothing is drawn until there is a page to draw it on. While the screenshot is still
  // decoding the frame is holding its box open; with no capture at all there are no page
  // coordinates to register to, and overlays over a sentence would be a drawing of
  // nowhere — the sentence in the frame is what says why they are not there.
  const drawn = state === 'loading' || state === 'missing' ? [] : layers.filter((one) => one.drawn);

  return (
    <div className={styles.stage}>
      <div className={styles.toolbar}>
        <ZoomControl zoom={zoom} onZoom={setZoom} />
      </div>

      <div
        className={styles.frame}
        id="att-frame"
        data-screenshot={state}
        // The frame scrolls, so it is focusable and named: a reader who does not use a
        // pointer has no other way to move down a page taller than the window onto it
        // (WCAG 2.1.1). What the page is, is the image's own alternative text; what this
        // says is what the box around it is for.
        role="group"
        aria-label={`The page your audience saw, scrollable: the ${stepLabel} step of ${variantName}`}
        tabIndex={0}
        // Dimmed only while something is drawn over it, as the prototype dims `#att-frame`
        // only when there is gaze to read on top: a page with every overlay off is the page
        // itself, and washing it out would be a treatment with nothing to serve.
        data-dim={drawn.length > 0 ? '' : undefined}
      >
        {/* The box is reserved from the artifact's own figures, before the image decodes,
            so the table and the footnotes under the stage never jump when it arrives. */}
        <div
          className={styles.page}
          id="att-page"
          style={box === null ? undefined : { width: `${box.width}px`, height: `${box.height}px` }}
        >
          {capture === null || screenshotUrl === null ? (
            <p className={styles.unreadable} role="status">
              This test holds no screenshot of the {stepLabel} step on {variantName}, so there is no
              page to show the overlays over.
            </p>
          ) : state === 'unusable' ? (
            <p className={styles.unreadable} role="status">
              The screenshot at {capture.path} records a page of no size &mdash;{' '}
              {capture.viewport.width} by {capture.pageHeight} pixels &mdash; so there is nothing to
              draw the overlays on.
            </p>
          ) : state === 'unreadable' ? (
            <p className={styles.unreadable} role="status">
              The screenshot at {capture.path} could not be read. Anything drawn over it is still
              placed on the page it recorded, {capture.viewport.width} by {capture.pageHeight}{' '}
              pixels.
            </p>
          ) : (
            <img
              src={screenshotUrl}
              alt={`The ${stepLabel} step of ${variantName}, the whole page as your audience saw it`}
              onLoad={() => {
                setDecoded(screenshotUrl);
              }}
              onError={() => {
                setBroken(screenshotUrl);
              }}
            />
          )}

          {drawn.map(({ layer }) => (
            <layer.Component key={layer.id} {...layerProps} />
          ))}

          {fold === null ? null : (
            <div className={styles.fold} style={{ top: `${fold.atPct}%` }} data-fold>
              <span>{fold.label}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The zoom: the page opens at the size it was captured, and the control says so.
 *
 * It is the registry's `toggle-group`, single-select, because the levels are three states
 * of one view. A continuous slider was not built: see `ZOOM_LEVELS`.
 */
function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  const labelId = useId();

  return (
    <div className={styles.zoom}>
      <span className="microlabel" id={labelId}>
        Zoom
      </span>
      <ToggleGroup
        type="single"
        value={String(zoom)}
        aria-labelledby={labelId}
        className={styles.zoomGroup}
        onValueChange={(next) => {
          // Radix sends '' when the pressed item is pressed again. The page is always at
          // some size, so that is not a state this control has.
          if (next !== '') onZoom(Number(next));
        }}
      >
        {ZOOM_LEVELS.map((level) => (
          <ToggleGroupItem key={level} value={String(level)} data-zoom={level}>
            {zoomLabel(level)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
