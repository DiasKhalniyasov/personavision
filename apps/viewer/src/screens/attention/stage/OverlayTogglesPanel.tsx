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
 * draw on this version's step is disabled with its reason printed under it, rather than
 * offering a switch whose "on" looks exactly like its "off".
 */
export function OverlayTogglesPanel({ layers, setShown }: OverlayLayerState) {
  const panelId = useId();
  const reasonId = (layerId: string) => `${panelId}-${layerId}-reason`;

  return (
    <div className={styles.toggles}>
      {layers.map(({ layer, on, unavailable }) => (
        <div key={layer.id}>
          <Toggle
            className={styles.toggle}
            data-overlay-toggle={layer.id}
            pressed={on}
            disabled={unavailable !== null}
            aria-describedby={unavailable === null ? undefined : reasonId(layer.id)}
            onPressedChange={(next) => {
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
  );
}
