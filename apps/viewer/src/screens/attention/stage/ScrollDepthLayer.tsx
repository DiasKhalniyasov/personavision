import { hasScrollDepth, scrollBands } from '../screenSlices';
import type { ScrollBand } from '../screenSlices';
import type { OverlayLayer, OverlayLayerProps } from './overlayLayers';
import stage from './attentionStage.module.css';
import styles from './scrollDepthLayer.module.css';

/**
 * The scroll-depth overlay of `#screen-heatmaps`: how far down the page these people got.
 *
 * **Decision 128** fixes what the stored bins mean — equal bands from the top of the page,
 * and a person falls in the band the furthest point they *saw* reached. So the people who
 * saw a band are the people whose deepest band was that one or any below it, which is what
 * `scrollBands` reads out of the histogram, and it is why every band of the page can be
 * shaded rather than only the one somebody's scroll position stopped at.
 *
 * The bands are drawn as horizontal strips in page coordinates, so they need no box of
 * their own and cannot come out of register with the page: a band is a percentage of the
 * same page box the screenshot fills, which is the one thing `overlayTransform.ts` exists to
 * make true by construction.
 *
 * A pure renderer with no state and no timer, so it is complete and still on mount.
 */

/** How many steps of the ramp a band can be drawn in — `--heat-2` … `--heat-5`. */
const RAMP_STEPS = 4;

/** The ramp's classes, coolest first. */
const STEP_CLASS = [styles.step1, styles.step2, styles.step3, styles.step4];

/**
 * Which step of the ramp a band is drawn in: the share of these people who saw it.
 *
 * The scale is the slice's own population rather than this page's busiest band, because
 * unlike dwell and clicks this figure already *has* a denominator everybody understands —
 * the people who reached the screen — and *half of them got this far* is the reading the
 * band is for. A band nobody saw is step 0 and is not drawn at all.
 */
export const bandStep = (sawIt: number, of: number): number => {
  if (sawIt <= 0 || of <= 0) return 0;
  return Math.max(1, Math.ceil((sawIt / of) * RAMP_STEPS));
};

/** One band as this layer draws it: where it sits, who saw it, how it is shaded. */
export interface DrawnBand extends ScrollBand {
  readonly step: number;
  /** The share of these people who saw it, for the words under the switch. */
  readonly share: number;
}

/** The bands of this screen, top first, each with its shade. */
export function drawnBands(props: OverlayLayerProps): readonly DrawnBand[] {
  const { figures } = props.screen;
  // The denominator is the people who **reached the screen**, which the slice states: a band
  // nobody saw out of nine is a different reading from a band nobody saw out of nobody.
  const reached = figures?.reached ?? 0;
  return scrollBands(figures).map((band) => ({
    ...band,
    step: bandStep(band.sawIt, reached),
    share: reached === 0 ? 0 : band.sawIt / reached,
  }));
}

/** Why there is nothing to draw here, in the panel's own words, or `null`. */
const nothingToShow = (props: OverlayLayerProps): string | null => {
  const { screen } = props;
  switch (screen.status) {
    case 'loading':
      return 'Still reading this test’s figures. The scroll depth appears when they are in, rather than drawing half of them.';
    case 'none':
      // Decision 74, as the clicks layer states it: offered, and honest about what is absent.
      return 'This test recorded no clicks and no scroll depth: it was run before either was measured, so there is nothing to draw. The attention overlay still works.';
    case 'unreadable':
      return `This test’s figures could not be read: ${screen.problem ?? 'the aggregate is unreadable'}.`;
    case 'no-people':
      return 'No session matches both filters, so there is no scroll depth to show for them.';
    case 'no-screen':
      return 'Nobody among these people reached this screen on this version, so no scroll depth was recorded on it.';
    case 'ready':
      break;
  }
  if (!hasScrollDepth(screen.figures)) {
    return 'This test recorded no scroll depth on this screen: there is nothing to draw, and that is not a page nobody scrolled.';
  }
  return null;
};

export function ScrollDepthLayer(props: OverlayLayerProps) {
  const bands = drawnBands(props).filter((band) => band.step > 0);
  if (bands.length === 0) return null;

  return (
    <div className={`${stage.layer} ${styles.depth}`} data-overlay-layer={SCROLL_LAYER.id}>
      {/* Strips of the page's own box rather than an SVG: a band is a percentage of the page
          in one axis and the whole of it in the other, which is what a block already is. */}
      {bands.map((band) => (
        <div
          key={band.index}
          className={`${styles.band} ${STEP_CLASS[band.step - 1] ?? ''}`}
          data-scroll-band={band.index}
          data-saw-it={band.sawIt}
          data-band-step={band.step}
          style={{ top: `${band.topPct}%`, height: `${band.heightPct}%` }}
        />
      ))}
    </div>
  );
}

const share = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

/**
 * The key, and the depths said in words.
 *
 * The deepest band anybody reached and the share who got past the fold are the two readings
 * the shading is a picture of, and they are the layer's text alternative: a strip of colour
 * says nothing to a reader who cannot see it.
 */
export function ScrollDepthKey(props: OverlayLayerProps) {
  const bands = drawnBands(props);
  const reached = props.screen.figures?.reached ?? 0;
  const pastFold = props.screen.figures?.scrollDepth.pastFoldSessions ?? 0;
  const deepest = [...bands].reverse().find((band) => band.sawIt > 0) ?? null;
  const halfway = bands[Math.floor(bands.length / 2)] ?? null;

  return (
    <div data-scroll-key="ramp">
      <div className={styles.ramp} />
      <div className={styles.scale}>
        <span>nobody got this far</span>
        <span>all of them</span>
      </div>
      <ul className={styles.counts}>
        <li data-scroll-count="past-fold">
          <b>
            {pastFold} of {reached}
          </b>{' '}
          scrolled past the fold
        </li>
        {halfway === null ? null : (
          <li data-scroll-count="halfway">
            <b>{share.format(halfway.share)}</b> of them saw the middle of the page
          </li>
        )}
        {deepest === null ? null : (
          <li data-scroll-count="deepest">
            The deepest anybody got is the{' '}
            <b>
              {deepest.index + 1} of {bands.length}
            </b>{' '}
            bands down the page
          </li>
        )}
      </ul>
    </div>
  );
}

/** The registry entry, in the prototype's words (`Scroll depth`, "how far down they got"). */
export const SCROLL_LAYER: OverlayLayer = {
  id: 'scroll',
  overlay: 'scroll',
  label: 'Scroll depth',
  hint: 'how far down they got',
  defaultOn: false,
  unavailable: nothingToShow,
  Component: ScrollDepthLayer,
  Legend: ScrollDepthKey,
};
