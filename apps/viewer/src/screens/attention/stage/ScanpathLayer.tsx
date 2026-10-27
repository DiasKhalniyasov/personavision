import { useMemo } from 'react';
import { medianScanpath } from './medianScanpath';
import type { OverlayLayer, OverlayLayerProps } from './overlayLayers';
import { OVERLAY_SPAN, overlaySpanY } from './overlayTransform';
import stage from './attentionStage.module.css';
import styles from './scanpathLayer.module.css';

/**
 * `#att-vec`'s scanpath: the order attention moved in, numbered, with the saccades between.
 *
 * One mark per area of interest that was fixated on this version's step, numbered in
 * ascending median time to first fixation, sized by median total dwell, joined in that
 * order — the reading the prototype's side panel promises ("Numbers are fixation order,
 * median across sessions. Fixation size is dwell time."). On by default, because the order
 * is half of what this screen is for, and toggled on its own so that the heatmap can be
 * read without it.
 *
 * **An area nobody fixated has no mark at all**, which is what makes its absence visible
 * against the outline the isolate view draws over it: the whole demo turns on a button that
 * was never looked at, and a mark numbering it would say the opposite.
 *
 * The arithmetic — the order, the numbers, the sizes, what can be anchored — is
 * `medianScanpath.ts`; what is here is the drawing. Nothing reads `fixations` or
 * `saccades`: this is a median scanpath over areas rather than one session's trace, and the
 * per-session trace is the replay's (#5).
 *
 * Nothing reads `loading` either, and that is not an oversight. The marks come from
 * `run.json`'s own `aoiMetrics`, which this screen has read in full before it renders at
 * all (`AttentionPage`), so there is no half-read aggregate for this layer to withhold the
 * way the heatmap withholds itself while the sessions are still arriving.
 *
 * No animation and no state of its own: the direction's three animated moments are #125,
 * #123 and #124, and none of them is here.
 */

/** The sentence the panel prints in place of a switch, when there is no area to order. */
const NOTHING_MARKED =
  'This test marked no area of interest on this version of this step, so there is no scanpath to draw.';

/**
 * What it says when nobody looked — which is a result, not a gap.
 *
 * Deliberately not the never-fixated finding's own sentence: those exact words are written
 * once, in `attentionWording.ts`, and said by the areas table and the isolate caption
 * (#73), which know the version and how many of the audience reached the step. This is the
 * panel saying why one switch has nothing to draw, in the same voice as the heatmap's.
 */
const nothingFixated = (area: string | null): string =>
  area === null
    ? 'No fixation landed anywhere on this version of this step, so there is no order to read.'
    : `No fixation landed in “${area}” on this version of this step, so it has no place in the order.`;

/**
 * What it says when the areas were fixated but the capture cannot hold their marks.
 *
 * A fault in the artifact rather than a reading of the audience, and said as one: a box
 * whose centre falls off the page the screenshot recorded has nothing on this stage to be
 * anchored to, and a mark drawn past the screenshot's edge would be a claim about page that
 * is not there. The areas table is where a row that names no area at all is reported
 * (`useAttentionAreas`); this is the part of that story the stage can see.
 */
const offTheCapture = (count: number): string =>
  count === 1
    ? 'The one area the audience fixated here sits outside the page this screenshot recorded, so there is no mark that could be placed on it.'
    : `All ${count} areas the audience fixated here sit outside the page this screenshot recorded, so there is no mark that could be placed on them.`;

/** The same fault, when only some of the marks are lost: the count, under the legend. */
const withheld = (count: number): string =>
  count === 1
    ? 'One more area was fixated and is not drawn: its box falls outside the page this screenshot recorded.'
    : `${count} more areas were fixated and are not drawn: their boxes fall outside the page this screenshot recorded.`;

/** What the areas table calls the isolated area, so the sentence reads as the table does. */
const isolatedLabel = ({ areas, isolatedAoiId }: OverlayLayerProps): string | null =>
  isolatedAoiId === null
    ? null
    : (areas.find((area) => area.aoi.id === isolatedAoiId)?.aoi.label ?? isolatedAoiId);

export function ScanpathLayer(props: OverlayLayerProps) {
  const { areas, isolatedAoiId, transform } = props;
  const { marks } = useMemo(
    () => medianScanpath(areas, transform, isolatedAoiId),
    [areas, transform, isolatedAoiId],
  );
  const spanY = overlaySpanY(transform);

  if (marks.length === 0) return null;

  return (
    <div
      className={`${stage.layer} ${styles.scan}`}
      data-overlay-layer={SCANPATH_LAYER.id}
      // The drawing is not readable, and the areas table under the stage is this screen's
      // accessible representation of it (#4, user story 17). The numbers are text, so it
      // is the whole layer that is hidden and not only the vector surface inside it.
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${OVERLAY_SPAN} ${spanY}`} aria-hidden="true" focusable="false">
        {/* The saccades first, so a mark is drawn over the line into it rather than under
            it. They join consecutive marks of what is actually drawn: a step whose middle
            mark cannot be placed on this capture is one path with a longer leg, not a path
            broken in two — and the numbers either side of it say where the leg goes. */}
        {marks.slice(1).map((mark, index) => {
          const from = marks[index] as (typeof marks)[number];
          return (
            <line
              key={`${from.aoiId}-${mark.aoiId}`}
              className={styles.saccade}
              data-saccade={`${from.number}-${mark.number}`}
              x1={from.x}
              y1={from.y}
              x2={mark.x}
              y2={mark.y}
              // The token's width is a length in CSS pixels, so the line is that at every
              // zoom rather than growing with the page under it.
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {marks.map((mark) => (
          <circle
            key={mark.aoiId}
            className={styles.fixation}
            // The numbers behind this mark, on the element drawn from them: a test reads
            // what the layer was given without asserting a pixel of what it drew.
            data-fixation={mark.aoiId}
            data-fixation-number={mark.number}
            data-time-to-first-fixation-ms={mark.timeToFirstFixationMs}
            data-dwell-ms={mark.totalDwellMs}
            cx={mark.x}
            cy={mark.y}
            r={mark.radius}
          />
        ))}
      </svg>

      {/* The numbers are HTML over the surface rather than `text` inside it, and that is
          what keeps them legible at every zoom. A length inside the `viewBox` is in overlay
          units, which the zoom scales with the page; a span's `font-size` is in CSS pixels,
          which it does not. Its place is still the artifact's — a percentage of the same
          box the marks are drawn in, so the number cannot drift off the mark it belongs
          to. */}
      {marks.map((mark) => (
        <span
          key={mark.aoiId}
          className={styles.number}
          data-fixation-label={mark.aoiId}
          style={{
            left: `${(mark.x / OVERLAY_SPAN) * 100}%`,
            top: `${spanY > 0 ? (mark.y / spanY) * 100 : 0}%`,
          }}
        >
          {mark.number}
        </span>
      ))}
    </div>
  );
}

/**
 * The scanpath's scale: what the size of a mark means, beside the switch it belongs to.
 *
 * The prototype's `.scale-legend` — "brief … long dwell" — over a ramp of marks rather than
 * of colours, because on this layer dwell is read as size. The prototype carries one legend
 * because it draws both scales at once; here each layer brings its own, since either can be
 * switched off on its own and a legend for something not on the page would be a reading of
 * nothing.
 *
 * It belongs to the layer because only the layer knows what scale its marks are on, and
 * the panel mounts it only while they are actually being drawn (`overlayLayers.ts`).
 */
export function ScanpathKey(props: OverlayLayerProps) {
  const { unanchored } = medianScanpath(props.areas, props.transform, props.isolatedAoiId);

  return (
    <div data-scan-key="sizes">
      <div className={styles.sizes}>
        <span className={`${styles.dot} ${styles.brief}`} />
        <span className={`${styles.dot} ${styles.middling}`} />
        <span className={`${styles.dot} ${styles.long}`} />
      </div>
      <div className={styles.scale}>
        <span>brief</span>
        <span>long dwell</span>
      </div>
      {unanchored === 0 ? null : (
        <p className="footnote" data-scan-withheld={unanchored}>
          {withheld(unanchored)}
        </p>
      )}
    </div>
  );
}

/** The registry entry, in the prototype's words (`#t-scan`, "numbered fixations"). */
export const SCANPATH_LAYER: OverlayLayer = {
  id: 'scan',
  label: 'Scanpath',
  hint: 'numbered fixations',
  defaultOn: true,
  unavailable: (props) => {
    const { ordered, marks, unanchored } = medianScanpath(
      props.areas,
      props.transform,
      props.isolatedAoiId,
    );
    if (marks.length > 0) return null;
    if (props.areas.length === 0) return NOTHING_MARKED;
    if (unanchored > 0) return offTheCapture(unanchored);
    // Nothing drawn, and nothing withheld: either nobody looked anywhere on this step, or
    // the one area the screen is isolated to was never looked at. The second is the moment
    // this product exists for, and it is said about that area by name.
    return nothingFixated(ordered.length === 0 ? null : isolatedLabel(props));
  },
  Component: ScanpathLayer,
  Legend: ScanpathKey,
};
