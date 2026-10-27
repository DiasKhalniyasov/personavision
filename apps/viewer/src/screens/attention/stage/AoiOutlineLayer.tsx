import type { CSSProperties } from 'react';
import type { OverlayLayer, OverlayLayerProps } from './overlayLayers';
import { OVERLAY_SPAN, boxToOverlay, overlaySpanY, pxPerOverlayUnit } from './overlayTransform';
import styles from './attentionStage.module.css';

/**
 * The first overlay: the boundary of every area of interest on this version's step, each
 * labelled with its area id.
 *
 * It is off by default, and that is the prototype's own `#t-aoi`: a page covered in dashed
 * boxes is a map of what the pipeline measured, not of what the audience did, and the
 * reader of this screen came to see the second. A designer turns it on to ask the one
 * question it answers — which box is this number about.
 *
 * It draws from `aois[].bbox`, which is in the page coordinates of the capture, through
 * `boxToOverlay`: the layer does no arithmetic of its own and therefore none that the zoom
 * or the scroll offset could put out of register.
 */

/** The sentence the panel prints in place of a switch, when there is nothing to outline. */
const NOTHING_TO_OUTLINE =
  'This test marked no area of interest on this version of this step, so there is nothing to outline.';

export function AoiOutlineLayer({ areas, isolatedAoiId, transform }: OverlayLayerProps) {
  return (
    <div
      className={styles.layer}
      data-overlay-layer={AOI_OUTLINE_LAYER.id}
      // The conversion between an overlay unit and a CSS pixel, so that the stylesheet can
      // set the label's size from `--text-2xs` rather than from a figure written by hand.
      style={{ '--overlay-unit': pxPerOverlayUnit(transform) } as CSSProperties}
    >
      <svg
        viewBox={`0 0 ${OVERLAY_SPAN} ${overlaySpanY(transform)}`}
        aria-hidden="true"
        focusable="false"
      >
        {areas.map(({ aoi }) => {
          const box = boxToOverlay(aoi.bbox, transform);
          const isolated = aoi.id === isolatedAoiId;
          return (
            <g key={aoi.id}>
              <rect
                className={`${styles.aoibox} ${isolated ? styles.isolated : ''}`}
                data-aoi={aoi.id}
                data-isolated={isolated ? '' : undefined}
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                // The dash and the hairline are the tokens' own lengths in CSS pixels, so
                // they stay that at every zoom rather than growing with the page.
                vectorEffect="non-scaling-stroke"
              />
              {/* Lifted and inset by its own type size, which is the one measurement here
                  that is not the artifact's: `em` keeps it right whatever the token says. */}
              <text
                className={styles.aoilabel}
                data-aoi-label={aoi.id}
                x={box.x}
                y={box.y}
                dx="0.25em"
                dy="-0.35em"
              >
                {aoi.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The registry entry, in the prototype's words (`#t-aoi` carries no second half). */
export const AOI_OUTLINE_LAYER: OverlayLayer = {
  id: 'aoi',
  label: 'Areas of interest',
  defaultOn: false,
  unavailable: ({ areas }) => (areas.length === 0 ? NOTHING_TO_OUTLINE : null),
  Component: AoiOutlineLayer,
};
