import { useId, useMemo } from 'react';
import { HEAT_DRAWN_STEPS, accumulateHeat, hasHeat } from './heatAccumulation';
import type { OverlayLayer, OverlayLayerProps } from './overlayLayers';
import { OVERLAY_SPAN, overlaySpanY } from './overlayTransform';
import stage from './attentionStage.module.css';
import styles from './heatmapLayer.module.css';

/**
 * `#att-heat`: where attention concentrated on this version's step, not merely where it
 * landed.
 *
 * On by default, because it is the answer the reader came for and the ground the other two
 * layers are read over. Every fixation of the scored sessions is placed by its page
 * coordinates and weighted by how long it held (`heatAccumulation.ts`), so one 600 ms dwell
 * burns hotter than three glances at the same spot, and the heat key beside the switch is
 * the legend for the colours on the page.
 *
 * **A pure renderer**: the same fixations draw the same pixels, with no timer, no state and
 * no animation of its own. That is what lets the Verdict screen reuse it — #125 animates
 * this layer warming up from outside it, and gets exactly what this screen shows.
 */

/**
 * Why there is no heatmap here, in the panel's own words.
 *
 * Both of these go through the registry's `unavailable` seam rather than being drawn by the
 * layer or printed by the key, so there is one voice and the rest of the screen can see it:
 * the switch says it is unavailable and names the reason to a screen reader, the stage
 * mounts nothing, and the page is not dimmed for a layer that drew nothing. The key is then
 * only ever the legend for colours that are actually on the page.
 */
const STILL_READING =
  'Still reading your audience’s sessions. The heatmap appears when they are all in, rather than warming up over half of them.';

/** What it says when there is no dwell to show — which is a result, not a gap. */
const nothingToShow = (area: string | null): string =>
  area === null
    ? 'No fixation landed anywhere on this version of this step, so there is no heat to show.'
    : `No fixation landed in “${area}” on this version of this step, so there is no heat to show.`;

/** What the areas table calls the isolated area, so the sentence reads as the table does. */
const isolatedLabel = ({ areas, isolatedAoiId }: OverlayLayerProps): string | null =>
  isolatedAoiId === null
    ? null
    : (areas.find((area) => area.aoi.id === isolatedAoiId)?.aoi.label ?? isolatedAoiId);

/** The ramp steps' classes, in order, so a step reads its colour from the tokens. */
const STEP_CLASS = [styles.step1, styles.step2, styles.step3, styles.step4, styles.step5];

/** Every step from the coolest up to this one: the stops of one blob's gradient. */
const stopsUpTo = (step: number): readonly number[] =>
  Array.from({ length: step }, (_unused, index) => step - index);

export function HeatmapLayer(props: OverlayLayerProps) {
  const { fixations, isolatedAoiId, transform, loading } = props;
  // React's own id, with the characters that are not an id's stripped: the gradients are
  // referenced by `url(#…)`, and the Verdict screen may hold a second heatmap on the page.
  const prefix = `heat-${useId().replace(/[^\w-]/g, '')}`;
  const gradientId = (step: number): string => `${prefix}-${step}`;
  const clipId = `${prefix}-page`;
  const spanY = overlaySpanY(transform);
  const blobs = useMemo(
    () => accumulateHeat(fixations, transform, isolatedAoiId),
    [fixations, transform, isolatedAoiId],
  );

  // On this screen the registry has already withheld the layer in both of these cases
  // (`HEATMAP_LAYER.unavailable`). They are here because the Verdict screen mounts this
  // component directly (#125), and a layer that drew half an audience — or a page of heat
  // over a capture of no size — would be wrong there for the same reasons.
  if (loading === true || blobs.length === 0) return null;

  return (
    <div className={`${stage.layer} ${styles.heat}`} data-overlay-layer={HEATMAP_LAYER.id}>
      <svg
        viewBox={`0 0 ${OVERLAY_SPAN} ${overlaySpanY(transform)}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {/* The capture's own box. A place's heat spreads up to 15 hundredths of the page
              either side of it, and the surface the layer draws on is `overflow: visible`
              for the outlines' labels: without this, a fixation near an edge would paint
              heat over the frame beside the screenshot, which is page the capture does not
              have. */}
          <clipPath id={clipId}>
            <rect x="0" y="0" width={OVERLAY_SPAN} height={spanY} />
          </clipPath>
          {HEAT_DRAWN_STEPS.map((step) => (
            <radialGradient key={step} id={gradientId(step)}>
              {stopsUpTo(step).map((stop, index, all) => (
                <stop
                  key={stop}
                  className={STEP_CLASS[stop - 1]}
                  offset={`${(index / (all.length - 1)) * 100}%`}
                />
              ))}
            </radialGradient>
          ))}
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {blobs.map((blob) => (
            <circle
              key={`${blob.x},${blob.y}`}
              // The numbers behind this place, on the element drawn from them: a test
              // reads what the layer was given without asserting a pixel of what it
              // painted.
              data-heat-step={blob.step}
              data-dwell-ms={blob.dwellMs}
              data-fixations={blob.fixationCount}
              cx={blob.x}
              cy={blob.y}
              r={blob.radius}
              fill={`url(#${gradientId(blob.step)})`}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/**
 * The heat key: the ramp the page's colours are read against, beside the switch.
 *
 * The prototype's `.heatkey` and `.scale-legend`. It belongs to the layer rather than to
 * the panel because only the layer knows what scale its colours are on, and the panel
 * mounts it only while the layer is actually being drawn — so it is never a ramp for a page
 * with no heat on it, which would present an absence as a reading. What is said instead is
 * `HEATMAP_LAYER.unavailable`, under the switch.
 */
export function HeatKey() {
  return (
    <div data-heat-key="ramp">
      <div className={styles.ramp} />
      <div className={styles.scale}>
        <span>brief</span>
        <span>long dwell</span>
      </div>
    </div>
  );
}

/** The registry entry, in the prototype's words (`#t-heat`, "dwell-weighted"). */
export const HEATMAP_LAYER: OverlayLayer = {
  id: 'heat',
  label: 'Attention heatmap',
  hint: 'dwell-weighted',
  defaultOn: true,
  unavailable: (props) =>
    props.loading === true
      ? STILL_READING
      : hasHeat(props.fixations, props.transform, props.isolatedAoiId)
        ? null
        : nothingToShow(isolatedLabel(props)),
  Component: HeatmapLayer,
  Legend: HeatKey,
};
