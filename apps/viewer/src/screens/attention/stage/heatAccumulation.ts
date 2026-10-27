import type { Fixation } from '../useAttentionStepSessions';
import { pageToOverlay } from './overlayTransform';
import type { Transform } from './overlayTransform';

/**
 * The heat behind the heatmap: how long attention held at each place on the page.
 *
 * **Dwell, not footfall.** Every fixation the scored sessions made is placed where it
 * landed and added to that place by `durationMs`, so one 600 ms dwell burns hotter than
 * three glances at the same spot. That is the whole difference between this screen and a
 * click map: "where attention concentrated" is a measure of time, and a heatmap built from
 * fixation counts would say a page's busiest place was wherever the eye passed most often
 * on its way somewhere else.
 *
 * Pure, and the arithmetic is all here rather than in the layer: a test reads these numbers
 * instead of a canvas, which is why the layer's own test never has to assert a pixel. It is
 * also why the layer can be a pure renderer — the Verdict screen's warming-up heatmap
 * (#125) animates the same numbers and gets the same ones.
 */

/**
 * How many steps the ramp has: `--heat-1` … `--heat-5` in `docs/design/tokens.css`, cool
 * through lime and pink to red. A blob is drawn in the step its dwell falls in, so the heat
 * key beside the switch is the legend for what the page is showing, and the colours stay the
 * tokens' — this number is how many there are, not what any of them is.
 */
export const HEAT_STEPS = 5;

/**
 * The coolest step anything is *drawn* in.
 *
 * `--heat-1` is fully transparent — it is the edge every blob fades out to, not a colour a
 * place can be — so the steps a blob can land in are the four the heat key's own ramp is
 * made of, `--heat-2` through `--heat-5`. The page and the key are then on one scale: every
 * colour over the screenshot is a colour the legend beside it carries.
 */
export const HEAT_FIRST_STEP = 2;

/** The steps a place can be drawn in, coolest first: the heat key's four, left to right. */
export const HEAT_DRAWN_STEPS: readonly number[] = Array.from(
  { length: HEAT_STEPS - HEAT_FIRST_STEP + 1 },
  (_unused, index) => HEAT_FIRST_STEP + index,
);

/**
 * How far a place's heat spreads, in overlay units, at the coolest and at the hottest: the
 * prototype's own figures, from `heatHTML` in `docs/design/prototype.html`, where a blob is
 * `6` percent of the page's width plus `9` for every second of dwell. An overlay unit is a
 * hundredth of the page's width, which is exactly what those percentages are of, so these
 * are its numbers and not a restatement of them in another scale.
 *
 * The prototype draws one blob per fixation, where a second is a long look. Here a place is
 * every fixation that landed on it, and a busy control on a page eleven people walked
 * collects eight or nine seconds between them: carrying the formula over literally would
 * spread one button over the whole page. So what a second of dwell buys the prototype goes
 * to the hottest place on *this* page, and every other place is drawn against it — which is
 * the scale the colours are already on.
 *
 * They are not design tokens and are deliberately not in `docs/design/tokens.css`: how wide
 * a fixation's dwell spreads is a reading of the data — the foveal span a fixation stands
 * for — and a page would mean the same thing with every colour in it changed.
 */
const RADIUS_AT_NO_DWELL = 6;
const RADIUS_AT_FULL_DWELL = 15;

/**
 * How close two fixations have to be to count as the same place, in overlay units.
 *
 * Half a blob's base radius. Two people looking at one button do not look at one pixel of
 * it, and without a tolerance their dwell would never add up: the screen would draw two
 * cool blobs over one hot place and say the opposite of what happened. Wider than this and
 * two genuinely different controls on a dense page would melt into one reading.
 */
export const HEAT_CELL = RADIUS_AT_NO_DWELL / 2;

/** One place attention held, with how long it held there. */
export interface HeatBlob {
  /** Where it is drawn, in overlay units — `pageToOverlay` of the fixations in it. */
  readonly x: number;
  readonly y: number;
  /** Every `durationMs` that landed here, added up. */
  readonly dwellMs: number;
  /** How many fixations that was. Not what the heat is made of; what it is made *from*. */
  readonly fixationCount: number;
  /** This place's dwell against the hottest place's, `0`–`1`. */
  readonly intensity: number;
  /** Which ramp step it is drawn in, `HEAT_FIRST_STEP`–`HEAT_STEPS`. */
  readonly step: number;
  /** How far the heat spreads from it, in overlay units. */
  readonly radius: number;
}

/** An intensity is a share of the hottest place, so it is between none of it and all. */
const clamped = (intensity: number): number => Math.min(1, Math.max(0, intensity));

/** How far a place's heat spreads, from how it weighs against the hottest place. */
export const heatRadius = (intensity: number): number =>
  RADIUS_AT_NO_DWELL + (RADIUS_AT_FULL_DWELL - RADIUS_AT_NO_DWELL) * clamped(intensity);

/**
 * Which ramp step a dwell reads as, against the hottest dwell on the page.
 *
 * Relative, because the ramp has no numbers on it: the key says "brief" at one end and
 * "long dwell" at the other, and what it is the legend for is this page's own spread of
 * attention. An absolute scale would need a dwell in milliseconds written on the key, and a
 * step where nobody lingered anywhere would render as a page nobody looked at.
 */
export const heatStep = (intensity: number): number => {
  const bands = HEAT_DRAWN_STEPS.length;
  return (
    HEAT_FIRST_STEP + Math.min(bands - 1, Math.max(0, Math.ceil(clamped(intensity) * bands) - 1))
  );
};

/** One accumulation cell, before it is weighed against the rest of the page. */
interface Cell {
  xSum: number;
  ySum: number;
  dwellMs: number;
  fixationCount: number;
}

/**
 * Whether there is any dwell to draw at all — the cheap half of `accumulateHeat`, for a
 * caller that only needs to know whether there is a heatmap here.
 *
 * Three ways there is not, and each of them is a reading rather than a fault: nobody
 * fixated on this version of this step, nobody fixated inside the area the screen is
 * isolated to, or every fixation here holds for no time at all. That last one would
 * otherwise paint the whole page, because every place would weigh the same as the hottest
 * — a heatmap drawn from a total dwell of zero. The fourth way is a fault and not a
 * reading: a capture of no size is no page to place anything on, and the stage says so in
 * its own words rather than having this draw a page's worth of heat at the origin.
 */
export const hasHeat = (
  fixations: readonly Fixation[],
  transform: Transform,
  isolatedAoiId: string | null = null,
): boolean =>
  transform.pageWidth > 0 &&
  transform.pageHeight > 0 &&
  fixations.some(
    (fixation) =>
      (isolatedAoiId === null || fixation.aoiId === isolatedAoiId) && fixation.durationMs > 0,
  );

/**
 * Every place attention held on this version's step, coolest first — which is the order
 * they are drawn in, so that a hot core is painted over the cool spread around it.
 *
 * `isolatedAoiId` is this layer's own reading of the screen's isolation: the heatmap drops
 * to that area's fixations, because heat over the whole page while the address bar says one
 * area would tell the reader something the URL they are about to share does not. The
 * outlines beside it read the same field differently and deliberately — every area drawn,
 * the isolated one marked — so the registry hands both layers `isolatedAoiId` and holds
 * neither of them to a particular meaning (`overlayLayers.ts`).
 *
 * Only `pageX` / `pageY` are read. The viewport-relative `x` / `y` belong to the replay,
 * where one person's scroll offset is the subject; here the page is.
 */
export function accumulateHeat(
  fixations: readonly Fixation[],
  transform: Transform,
  isolatedAoiId: string | null = null,
): readonly HeatBlob[] {
  if (!hasHeat(fixations, transform, isolatedAoiId)) return [];

  const cells = new Map<string, Cell>();

  for (const fixation of fixations) {
    if (isolatedAoiId !== null && fixation.aoiId !== isolatedAoiId) continue;

    const { x, y } = pageToOverlay(fixation, transform);
    const key = `${Math.round(x / HEAT_CELL)},${Math.round(y / HEAT_CELL)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { xSum: 0, ySum: 0, dwellMs: 0, fixationCount: 0 };
      cells.set(key, cell);
    }
    // Where the blob sits is the mean of the fixations in the cell, not the cell's own
    // centre: one fixation is drawn exactly where it landed, whatever grid it fell on.
    cell.xSum += x;
    cell.ySum += y;
    cell.dwellMs += fixation.durationMs;
    cell.fixationCount += 1;
  }

  const hottest = Math.max(0, ...[...cells.values()].map((cell) => cell.dwellMs));

  return (
    [...cells.values()]
      .map((cell) => {
        const intensity = hottest > 0 ? cell.dwellMs / hottest : 0;
        return {
          x: cell.xSum / cell.fixationCount,
          y: cell.ySum / cell.fixationCount,
          dwellMs: cell.dwellMs,
          fixationCount: cell.fixationCount,
          intensity,
          step: heatStep(intensity),
          radius: heatRadius(intensity),
        };
      })
      // Coolest first: the order is the drawing order, so a hot core is painted over the
      // cool spread around it rather than under it.
      .sort((one, other) => one.dwellMs - other.dwellMs)
  );
}
