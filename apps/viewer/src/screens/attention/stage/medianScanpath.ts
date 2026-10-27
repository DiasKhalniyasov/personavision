import type { AttentionArea } from '../useAttentionAreas';
import { OVERLAY_SPAN, boxToOverlay, overlaySpanY } from './overlayTransform';
import type { OverlayPoint, Transform } from './overlayTransform';

/**
 * The scanpath behind the layer: the order attention moved in on this version's step.
 *
 * **It is a median scanpath over areas, not one session's trace.** The screen aggregates
 * every scored session on the step; drawing each session's raw fixation sequence would be
 * unreadable, and picking one session would misrepresent the aggregate. So one mark per
 * area of interest that was fixated, ordered by the median time to first fixation the
 * pipeline wrote for it, sized by its median total dwell — which is exactly what the
 * prototype's side panel promises the numbers are ("Numbers are fixation order, median
 * across sessions. Fixation size is dwell time."). Per-session traces are the replay's
 * (#5). Recorded as an auto-decision on #4.
 *
 * That is why nothing here reads `fixations` or `saccades`. Those are the sessions' own
 * records, in the sessions' own coordinates, and the layer beside this one (#71) is what
 * aggregates them; the order and the dwell are already medians in `run.json`'s
 * `aoiMetrics`, and recomputing them from the raw fixations would be this viewer deciding
 * something the pipeline decided (`docs/FLOW.md` section 3, #4's "Reads only").
 *
 * Pure, and the arithmetic is all here rather than in the layer: a test reads these numbers
 * instead of a drawing, which is why the layer's own test never has to assert a pixel.
 */

/**
 * How far a mark reaches at the briefest dwell on the step and at the longest, in overlay
 * units — the prototype's own two figures, from `vectorHTML` in
 * `docs/design/prototype.html`, where a fixation is `1.6` percent of the page across plus
 * `1.9` for every second it held. An overlay unit is a hundredth of the page's width,
 * which is what those percentages are of, so these are its numbers rather than a
 * restatement of them in another scale.
 *
 * The prototype draws one fixation per look, where a second is a long one. Here a mark is
 * an area's **median total dwell across the audience**, which on a control people read
 * carefully runs to several seconds: carrying the formula over literally would draw one
 * area over half the page. So what a second of dwell buys the prototype goes to the
 * longest-dwelt area on *this* step, and every other mark is drawn against it — the same
 * relative scale the heat ramp beside it is on (`heatAccumulation.ts`), and the reason the
 * legend says "brief … long dwell" rather than carrying a figure in milliseconds.
 *
 * They are not design tokens and are deliberately not in `docs/design/tokens.css`: how
 * wide a dwell spreads is a reading of the data, and the page would mean the same thing
 * with every colour in it changed.
 */
export const MARK_RADIUS_BRIEF = 1.6;
export const MARK_RADIUS_LONG = 3.5;

/** One numbered fixation: an area that was looked at, and where it fell in the order. */
export interface ScanpathMark {
  readonly aoiId: string;
  /** What the areas table calls this area, so a sentence about a mark reads as the table. */
  readonly label: string;
  /** Its place in the order, `1`-based, over every fixated area of this version's step. */
  readonly number: number;
  /** The centre of the area's `bbox`, in overlay units. */
  readonly x: number;
  readonly y: number;
  /** How far the mark reaches, from its dwell against the longest dwell on the step. */
  readonly radius: number;
  /** The median the order is read from. Non-null by construction: a mark means fixated. */
  readonly timeToFirstFixationMs: number;
  /** The median the size is read from. */
  readonly totalDwellMs: number;
}

export interface Scanpath {
  /**
   * Every fixated area of this version's step, numbered `1..n` in fixation order —
   * whatever the screen is isolated to, and whether or not the capture can hold the mark.
   *
   * This is the ordering the numbers come from, and it is why an isolated mark keeps the
   * number it has here: a designer looking at one area still has to see where in the order
   * it fell. It is also what tells "nobody ever looked here" apart from "the capture
   * cannot hold this mark", which are a result and a fault and must never read alike.
   */
  readonly ordered: readonly ScanpathMark[];
  /** What this view draws: in fixation order, the isolated area alone when there is one. */
  readonly marks: readonly ScanpathMark[];
  /**
   * How many marks this view would have drawn and could not place on this capture.
   *
   * Not silence: the layer states the count. A fixated area whose box centre falls outside
   * the page the capture recorded cannot be anchored to anything, and a mark drawn beyond
   * the screenshot's edge would be a claim about page that is not there.
   */
  readonly unanchored: number;
}

const EMPTY: Scanpath = { ordered: [], marks: [], unanchored: 0 };

/** Whether a mark's centre falls on the page this capture recorded. */
const anchors = (point: OverlayPoint, transform: Transform): boolean =>
  transform.pageWidth > 0 &&
  transform.pageHeight > 0 &&
  point.x >= 0 &&
  point.x <= OVERLAY_SPAN &&
  point.y >= 0 &&
  point.y <= overlaySpanY(transform);

/**
 * How far a mark reaches, from its dwell against the longest dwell on the step.
 *
 * Relative, because the legend has no figure on it: it says "brief" at one end and "long
 * dwell" at the other, and what it is the key to is this step's own spread of attention.
 * The heat ramp beside it is on the same kind of scale and for the same reason
 * (`heatAccumulation.ts`): an absolute one would need a dwell in milliseconds written on
 * the key, and a step where nobody lingered anywhere would draw as a step nobody looked at.
 *
 * So a step where every area held the audience equally draws every mark alike, at the
 * size of the longest dwell — which is what each of them is. The one exception is a step
 * where nothing held at all: there is no longest dwell to read against, and every mark is
 * drawn at its briefest rather than at its largest.
 */
export const markRadius = (dwellMs: number, longestDwellMs: number): number =>
  longestDwellMs > 0
    ? MARK_RADIUS_BRIEF + (MARK_RADIUS_LONG - MARK_RADIUS_BRIEF) * (dwellMs / longestDwellMs)
    : MARK_RADIUS_BRIEF;

/**
 * The scanpath of one version's step, and the part of it this view draws.
 *
 * An area is on the path when its `aoiMetrics` row records a `timeToFirstFixationMs`: a
 * `null` there is the pipeline saying no fixation ever landed, which is a result and not a
 * gap (`attentionWording.ts`), and it gets no mark and no number at all — which is what
 * makes its absence visible against the outline the isolate view draws over it. An area the
 * run carries no metrics row for gets none either, for the same reason it reads as a gap in
 * the table: nothing is known about it, so nothing is drawn.
 *
 * `isolatedAoiId` narrows what is drawn and **not** what is numbered or how large a mark
 * is: both are read off the whole step, so isolating an area neither renumbers the path nor
 * resizes the one mark left on it into the longest dwell on the page.
 */
export function medianScanpath(
  areas: readonly AttentionArea[],
  transform: Transform,
  isolatedAoiId: string | null = null,
): Scanpath {
  const fixated = areas
    .map((area, index) => ({ area, index }))
    .filter(({ area }) => area.metric !== null && area.metric.timeToFirstFixationMs !== null)
    // Ascending time to first fixation, which is the order attention moved in. Two areas
    // the audience reached at the same median are left in the artifact's own order, so the
    // numbering is the run's and not this sort's.
    .sort(
      (one, other) =>
        (one.area.metric?.timeToFirstFixationMs ?? 0) -
          (other.area.metric?.timeToFirstFixationMs ?? 0) || one.index - other.index,
    );

  if (fixated.length === 0) return EMPTY;

  const longestDwellMs = Math.max(...fixated.map(({ area }) => area.metric?.totalDwellMs ?? 0));

  const ordered = fixated.map(({ area }, place) => {
    const box = boxToOverlay(area.aoi.bbox, transform);
    const metric = area.metric as NonNullable<AttentionArea['metric']>;
    return {
      aoiId: area.aoi.id,
      label: area.aoi.label,
      number: place + 1,
      // The centre of the area, through the stage's own transform: the mark stands for
      // every look that landed anywhere inside the box, so the middle of it is the one
      // place on the box that is not a claim about which part of it was read.
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
      radius: markRadius(metric.totalDwellMs, longestDwellMs),
      timeToFirstFixationMs: metric.timeToFirstFixationMs as number,
      totalDwellMs: metric.totalDwellMs,
    };
  });

  const inView =
    isolatedAoiId === null ? ordered : ordered.filter((mark) => mark.aoiId === isolatedAoiId);
  const marks = inView.filter((mark) => anchors(mark, transform));

  return { ordered, marks, unanchored: inView.length - marks.length };
}
