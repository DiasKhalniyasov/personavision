import { clicksNowhere, clicksOnArea, totalClicks } from '../screenSlices';
import type { ScreenFigures } from '../screenSlices';
import type { OverlayLayer, OverlayLayerProps } from './overlayLayers';
import { OVERLAY_SPAN, boxToOverlay, overlaySpanY } from './overlayTransform';
import stage from './attentionStage.module.css';
import styles from './clicksLayer.module.css';

/**
 * The clicks overlay of `#screen-heatmaps`: where the people the filters name pressed.
 *
 * **It is drawn per area of interest, not per pixel**, and that is the aggregate's own
 * shape rather than this layer's choice: a session's `actions[]` carries `aoiId` and
 * `target` and no coordinates, so `aggregate.json` counts clicks per area and says so in
 * `aggregateSchema`'s own words. Each area that was pressed is therefore filled over its
 * `bbox`, in one of the heat ramp's steps according to how its count weighs against the
 * most-clicked area on this screen — the same reading the attention heatmap uses for dwell,
 * so the page's two heat layers are read against one key.
 *
 * Every figure comes from the slice the two filters picked (`clicksOnArea`). Nothing is
 * counted here and nothing is counted from the sessions: *where did the people who failed
 * click* is a different stored row, not the same row filtered in a browser, which is what
 * makes this layer able to disagree with nothing (`docs/adr/0001`).
 *
 * A pure renderer, like the attention layer beside it: the same figures draw the same
 * pixels, with no timer and no state, so it is complete and still the moment it mounts and
 * needs nothing special under `prefers-reduced-motion`.
 */

/** How many steps of the ramp a click count can be drawn in — `--heat-2` … `--heat-5`. */
const RAMP_STEPS = 4;

/** The ramp's classes, coolest first, so a step reads its colour from the tokens. */
const STEP_CLASS = [styles.step1, styles.step2, styles.step3, styles.step4];

/**
 * Which step of the ramp a count is drawn in: its share of the busiest area on this screen,
 * cut into as many steps as the key has.
 *
 * The scale is this screen's own, as the attention layer's is (decision 61): what a reader
 * is asking is which control took the clicks on *this* page, and a scale fixed across a
 * whole run would put every area of a quiet screen in the coolest step and say nothing.
 */
export const clickStep = (clicks: number, busiest: number): number => {
  if (clicks <= 0 || busiest <= 0) return 0;
  return Math.max(1, Math.ceil((clicks / busiest) * RAMP_STEPS));
};

/** One area with clicks on it, as this layer draws it. */
export interface ClickedArea {
  readonly aoiId: string;
  readonly label: string;
  readonly clicks: number;
  readonly step: number;
}

/**
 * The areas of this screen that were pressed, busiest first, each with its ramp step.
 *
 * An area with no clicks is left out: the page under it is the answer, and an outline over
 * every measured area is the *Areas of interest* overlay's job rather than this one's.
 */
export function clickedAreas(
  areas: OverlayLayerProps['areas'],
  figures: ScreenFigures | null,
): readonly ClickedArea[] {
  const counted = areas.flatMap(({ aoi }) => {
    const clicks = clicksOnArea(figures, aoi.id);
    return clicks === null || clicks === 0 ? [] : [{ aoiId: aoi.id, label: aoi.label, clicks }];
  });
  const busiest = counted.reduce((most, one) => Math.max(most, one.clicks), 0);
  return counted
    .map((one) => ({ ...one, step: clickStep(one.clicks, busiest) }))
    .sort((a, b) => b.clicks - a.clicks);
}

/** Why there is nothing to draw here, in the panel's own words, or `null`. */
const nothingToShow = (props: OverlayLayerProps): string | null => {
  const { screen } = props;
  switch (screen.status) {
    case 'loading':
      return 'Still reading this test’s figures. The clicks appear when they are in, rather than drawing half of them.';
    case 'none':
      // Decision 74: the overlay is offered and says what is missing, rather than being
      // hidden — a reader who cannot find the clicks layer cannot tell it apart from a
      // product that does not have one.
      return 'This test recorded no clicks and no scroll depth: it was run before either was measured, so there is nothing to draw. The attention overlay still works.';
    case 'unreadable':
      return `This test’s figures could not be read: ${screen.problem ?? 'the aggregate is unreadable'}.`;
    case 'no-people':
      return 'No session matches both filters, so there are no clicks to show for them.';
    case 'no-screen':
      return 'Nobody among these people reached this screen on this version, so no click was recorded on it.';
    case 'ready':
      break;
  }
  if (totalClicks(screen.figures) === 0) {
    return 'Not one of these people pressed anything on this screen. That is the reading, not a gap: there is no click to draw.';
  }
  if (clickedAreas(props.areas, screen.figures).length === 0) {
    const total = totalClicks(screen.figures);
    const nowhere = clicksNowhere(screen.figures);
    if (nowhere === total) {
      return `Every click on this screen — ${nowhere} of them — landed on empty space the page does not explain, so there is no area to draw them over.`;
    }
    // The rest landed on areas this version's step does not declare, which the aggregate
    // records faithfully and `io.ts` reports as a dangling area of interest. Saying they
    // landed on empty space would be a claim about the page; saying nothing would hide a
    // fault in the artifact behind a switch that simply looks off.
    return `${total - nowhere} of the ${total} clicks on this screen landed on areas this test does not list for this version of this step, so there is nothing here to draw them over.`;
  }
  return null;
};

/** The isolated area, when one is isolated: the layer honours it like every other layer. */
const isolate = (
  drawn: readonly ClickedArea[],
  isolatedAoiId: string | null,
): readonly ClickedArea[] =>
  isolatedAoiId === null ? drawn : drawn.filter((one) => one.aoiId === isolatedAoiId);

export function ClicksLayer(props: OverlayLayerProps) {
  const { areas, isolatedAoiId, transform, screen } = props;
  const drawn = isolate(clickedAreas(areas, screen.figures), isolatedAoiId);
  const boxes = new Map(areas.map(({ aoi }) => [aoi.id, aoi.bbox]));

  if (drawn.length === 0) return null;

  return (
    <div className={`${stage.layer} ${styles.clicks}`} data-overlay-layer={CLICKS_LAYER.id}>
      <svg
        viewBox={`0 0 ${OVERLAY_SPAN} ${overlaySpanY(transform)}`}
        aria-hidden="true"
        focusable="false"
      >
        {drawn.map((one) => {
          const bbox = boxes.get(one.aoiId);
          if (bbox === undefined) return null;
          const box = boxToOverlay(bbox, transform);
          return (
            <rect
              key={one.aoiId}
              className={`${styles.patch} ${STEP_CLASS[one.step - 1] ?? ''}`}
              // The figures behind the mark, on the element drawn from them: a test reads
              // what the layer was given without asserting a pixel of what it painted.
              data-clicks-area={one.aoiId}
              data-clicks={one.clicks}
              data-click-step={one.step}
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
            />
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The key, and the clicks said in words.
 *
 * The ramp is the legend for the colours on the page, as the attention layer's is. Under it
 * is the list this layer is the picture of — *26 on Generate, 9 on empty space* — because a
 * filled rectangle is not readable by anybody who cannot see it, and the overlay's text
 * alternative has to name what it shows rather than that it exists.
 */
export function ClicksKey(props: OverlayLayerProps) {
  const { screen } = props;
  // Isolated to the same area the layer is. A legend naming marks that are not on the page
  // is a text alternative for a drawing of nothing — and with an area isolated the layer
  // draws one rectangle or none, so the list has to say the same.
  const drawn = isolate(clickedAreas(props.areas, screen.figures), props.isolatedAoiId);
  // The clicks that landed on nothing belong to no area, so isolating one leaves them out.
  const nowhere = props.isolatedAoiId === null ? clicksNowhere(screen.figures) : 0;

  return (
    <div data-clicks-key="ramp">
      <div className={styles.ramp} />
      <div className={styles.scale}>
        <span>one click</span>
        <span>many</span>
      </div>
      <ul className={styles.counts}>
        {drawn.map((one) => (
          <li key={one.aoiId} data-clicks-count={one.aoiId}>
            <b>{one.clicks}</b> on {one.label}
          </li>
        ))}
        {nowhere === 0 ? null : (
          <li data-clicks-count="nowhere">
            <b>{nowhere}</b> on empty space the page does not explain
          </li>
        )}
      </ul>
    </div>
  );
}

/** The registry entry, in the prototype's words (`Clicks`, "where they pressed"). */
export const CLICKS_LAYER: OverlayLayer = {
  id: 'clicks',
  overlay: 'clicks',
  label: 'Clicks',
  hint: 'where they pressed',
  // The overlay `#screen-heatmaps` draws pressed, and the one the screen's question is
  // about. `?overlay=` is what actually decides it; this is what the registry falls back to.
  defaultOn: true,
  unavailable: nothingToShow,
  Component: ClicksLayer,
  Legend: ClicksKey,
};
