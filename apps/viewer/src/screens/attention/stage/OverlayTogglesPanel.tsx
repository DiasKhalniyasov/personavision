import { useId } from 'react';
import { Toggle } from '@/components/ui/toggle';
import type { OverlayLayerState } from './overlayLayers';
import styles from './attentionStage.module.css';

/**
 * The Overlays panel — the prototype's first `.panel`, with `#t-heat`, `#t-scan` and
 * `#t-aoi` in it.
 *
 * It renders the registry (`overlayLayers.ts`), one entry per layer, and its whole job is
 * that one switch each: it knows nothing about what a layer draws, and a layer added by
 * #71 or #72 appears here without this file changing. Toggling one mounts or unmounts only
 * that layer, which is why a reader can read the heatmap without the scanpath over it.
 *
 * Each switch is the registry's `toggle` primitive, a button carrying `aria-pressed` — the
 * prototype draws a checkbox, and `aria-pressed` is what this product's on/off controls
 * say (the version switch beside it is the same primitive). A layer that has nothing to
 * draw on this version's step says so and does nothing when pressed, rather than offering
 * a switch whose "on" looks exactly like its "off".
 */
export function OverlayTogglesPanel({ layers, setShown }: OverlayLayerState) {
  const panelId = useId();
  const reasonId = (layerId: string) => `${panelId}-${layerId}-reason`;

  return (
    <>
      <div className={styles.toggles}>
        {layers.map(({ layer, on, unavailable }) => (
          <div key={layer.id}>
            <Toggle
              className={styles.toggle}
              data-overlay-toggle={layer.id}
              pressed={on}
              // `aria-disabled`, not `disabled`: a native disabled button is skipped by
              // keyboard and by a screen reader's focus mode, so the sentence saying why the
              // layer is unavailable would never reach the reader it was written for. The
              // control stays reachable and announces itself unavailable, and presses on it
              // do nothing.
              aria-disabled={unavailable === null ? undefined : true}
              aria-describedby={unavailable === null ? undefined : reasonId(layer.id)}
              onPressedChange={(next) => {
                if (unavailable !== null) return;
                setShown(layer.id, next);
              }}
            >
              {layer.label}
              {layer.hint === undefined ? null : <span className="faint">{layer.hint}</span>}
            </Toggle>
            {unavailable === null ? null : (
              <p className="footnote" id={reasonId(layer.id)} data-overlay-unavailable={layer.id}>
                {unavailable}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* A layer that needs a legend to be read has one, under the switches, where the
          prototype puts the heat key. It is the layer's own (`Legend`), it is mounted only
          while that layer is actually being drawn — a legend for something not on the page
          would be a reading of nothing — and a layer without one adds nothing here. */}
      {layers.map(({ layer, drawn, props }) =>
        !drawn || layer.Legend === undefined || props === undefined ? null : (
          <div key={layer.id} data-overlay-legend={layer.id}>
            <layer.Legend {...props} />
          </div>
        ),
      )}
    </>
  );
}
