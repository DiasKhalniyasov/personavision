import { useId } from 'react';
import { HEAT_DRAWN_STEPS, accumulateHeat } from './heatAccumulation';
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

/** What the key says instead of a ramp while the sessions are still being read. */
const STILL_READING =
  'Still reading your audience’s sessions. The heatmap appears when they are all in, rather than warming up over half of them.';

/** What it says when there is no dwell to show — which is a result, not a gap. */
const nothingToShow = (isolatedAoiId: string | null): string =>
  isolatedAoiId === null
    ? 'No fixation landed anywhere on this version of this step, so there is no heat to show.'
    : `No fixation landed in “${isolatedAoiId}” on this version of this step, so there is no heat to show.`;

/** The ramp steps' classes, in order, so a step reads its colour from the tokens. */
const STEP_CLASS = [styles.step1, styles.step2, styles.step3, styles.step4, styles.step5];

/** Every step from the coolest up to this one: the stops of one blob's gradient. */
const stopsUpTo = (step: number): readonly number[] =>
  Array.from({ length: step }, (_unused, index) => step - index);

export function HeatmapLayer({ fixations, isolatedAoiId, transform, loading }: OverlayLayerProps) {
  // React's own id, with the characters that are not an id's stripped: the gradients are
  // referenced by `url(#…)`, and the Verdict screen may hold a second heatmap on the page.
  const prefix = `heat-${useId().replace(/[^\w-]/g, '')}`;
  const gradientId = (step: number): string => `${prefix}-${step}`;

  // Withheld, not drawn half-populated: a heatmap of the three sessions that have arrived
  // is a different claim about the audience from the one this screen is making, and it
  // would warm up in front of the reader as the rest landed.
  if (loading === true) return null;

  const blobs = accumulateHeat(fixations, transform, isolatedAoiId);
  // Nothing to draw: no empty surface, so the frame is the page itself and the key says
  // why. An empty ramp over an undimmed screenshot would read as data.
  if (blobs.length === 0) return null;

  return (
    <div className={`${stage.layer} ${styles.heat}`} data-overlay-layer={HEATMAP_LAYER.id}>
      <svg
        viewBox={`0 0 ${OVERLAY_SPAN} ${overlaySpanY(transform)}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {HEAT_DRAWN_STEPS.map((step) => (
            <radialGradient key={step} id={gradientId(step)}>
              {stopsUpTo(step).map((stop, index, all) => (
                <stop
                  key={stop}
                  className={STEP_CLASS[stop - 1]}
                  offset={`${all.length === 1 ? 0 : (index / (all.length - 1)) * 100}%`}
                />
              ))}
            </radialGradient>
          ))}
        </defs>
        {blobs.map((blob) => (
          <circle
            key={`${blob.x},${blob.y}`}
            // The numbers behind this place, on the element drawn from them: a test reads
            // what the layer was given without asserting a pixel of what it painted.
            data-heat-step={blob.step}
            data-dwell-ms={blob.dwellMs}
            data-fixations={blob.fixationCount}
            cx={blob.x}
            cy={blob.y}
            r={blob.radius}
            fill={`url(#${gradientId(blob.step)})`}
          />
        ))}
      </svg>
    </div>
  );
}

/**
 * The heat key: the ramp the page's colours are read against, beside the switch.
 *
 * It is the prototype's `.heatkey` and `.scale-legend`, and it is part of this layer rather
 * than furniture in the panel for one reason: when there is no dwell to show it has to say
 * so. A ramp drawn over a page with nothing on it presents an absence as a reading, and
 * this screen's whole job is that the absences are results.
 */
export function HeatKey({ fixations, isolatedAoiId, transform, loading }: OverlayLayerProps) {
  const nothing =
    loading === true
      ? STILL_READING
      : accumulateHeat(fixations, transform, isolatedAoiId).length === 0
        ? nothingToShow(isolatedAoiId)
        : null;

  return (
    <div data-heat-key={nothing === null ? 'ramp' : 'nothing'}>
      {nothing === null ? (
        <>
          <div className={styles.ramp} />
          <div className={styles.scale}>
            <span>brief</span>
            <span>long dwell</span>
          </div>
        </>
      ) : (
        <p className="footnote">{nothing}</p>
      )}
    </div>
  );
}

/** The registry entry, in the prototype's words (`#t-heat`, "dwell-weighted"). */
export const HEATMAP_LAYER: OverlayLayer = {
  id: 'heat',
  label: 'Attention heatmap',
  hint: 'dwell-weighted',
  defaultOn: true,
  Component: HeatmapLayer,
  Legend: HeatKey,
};
