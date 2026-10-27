import type { Run } from '@personavision/contract';

/**
 * The stage's geometry: where a page coordinate lands on the overlay, how large the
 * screenshot's box is at a zoom level, and where the fold goes.
 *
 * **This is the seam the overlay tickets are written against.** The heatmap (#71), the
 * scanpath (#72) and the outlines below all draw in page coordinates — `fixations[].pageX`
 * / `pageY` against the full-page capture, and `aois[].bbox` — and all of them ask these
 * two functions where that is. Neither function is given the zoom or the scroll offset,
 * and that is the whole point: **an overlay coordinate does not depend on either.** A
 * fixation cannot drift off the button it landed on, because nothing a layer computes
 * could make it.
 *
 * What makes that true is where the two live. The overlay surface is laid over the
 * screenshot's own box — sized to the capture's intrinsic pixels, scaled by the zoom, and
 * scrolled inside the frame with the image under it — so the image and every layer move as
 * one object. Within that box the unit is a hundredth of it in each axis, which is the
 * prototype's own convention (`viewBox="0 0 100 100"` with `preserveAspectRatio="none"`,
 * and `vector-effect="non-scaling-stroke"` so a stroke and a dash stay device-sized). A
 * layer therefore does no per-zoom arithmetic: there is none left to do.
 *
 * Pure, so a test reads the answers rather than measuring a rendered box. None of these
 * numbers is a visual value — a fixation's position and a page's height are data — so none
 * of them belongs in `docs/design/tokens.css`.
 */

/** One captured page, as `run.json`'s `screenshots[]` records it. */
export type Capture = Run['screenshots'][number];

/**
 * The screenshot an overlay is drawn over, in the page pixels it was captured in: the
 * viewport's width, because a full-page capture is exactly as wide as the viewport that
 * took it, and the whole page's height.
 */
export interface Transform {
  readonly pageWidth: number;
  readonly pageHeight: number;
}

/** A point on the overlay, in overlay units. */
export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

/** A box on the overlay, in overlay units. `w`/`h` as the prototype's SVG names them. */
export interface OverlayBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * How many overlay units span the screenshot's **width**. It is the prototype's 100, so an
 * overlay x reads as a percentage of the page, and it is exported so that a layer writes
 * its `viewBox` from it rather than from a literal of its own.
 *
 * The **same** unit measures down the page, which is why there is one span and not two:
 * the surface keeps the capture's aspect ratio, so a square area of the page is a square
 * on the overlay and nothing a layer draws — a dash, a label, a fixation's dot — is
 * stretched by the shape of the page it is drawn on. A full-page capture is four times
 * taller than it is wide often enough that the prototype's square `0 0 100 100` box, over
 * its drawn 16:10 page, cannot simply be carried over: it would squash every label to a
 * quarter of its width. `overlaySpanY` is how far down the page the overlay reaches
 * instead.
 */
export const OVERLAY_SPAN = 100;

/** How many overlay units reach from the top of the screenshot to the bottom. */
export const overlaySpanY = (t: Transform): number =>
  t.pageWidth > 0 ? (t.pageHeight / t.pageWidth) * OVERLAY_SPAN : 0;

/**
 * One overlay unit in CSS pixels at the size the page was captured.
 *
 * The stylesheet divides a type token by it, because a length inside an SVG `viewBox` is
 * in overlay units and `--text-2xs` is in CSS pixels: this is the conversion between them,
 * and it is why an area's label is the token's own size over a 390px capture and over a
 * 1280px one alike rather than a figure written out by hand.
 */
export const pxPerOverlayUnit = (t: Transform): number => t.pageWidth / OVERLAY_SPAN;

/** The screenshot's page box, from the capture the artifact recorded. */
export const transformOf = (capture: Capture): Transform => ({
  pageWidth: capture.viewport.width,
  pageHeight: capture.pageHeight,
});

/**
 * Whether this capture records a page with anything to draw on it.
 *
 * `pageHeight` is a `pixels` in the contract, which permits `0`, and a run that records a
 * page of no height is a fault in the artifact rather than a page nobody looked at. Without
 * this the frame would hold a box of nothing and draw an empty rectangle — and an empty
 * frame on this screen reads as "your audience saw nothing", which is the one thing it must
 * never say. The stage asks this before it draws, and states the figures when the answer is
 * no.
 */
export const isDrawable = (capture: Capture): boolean =>
  capture.viewport.width > 0 && capture.pageHeight > 0;

/**
 * A page measurement in overlay units: hundredths of the page's width, along either axis.
 *
 * `pageHeight` and the capture's width are `pixels` in the contract, which permits `0`: a
 * capture that records no size is a fault in the artifact, and answering `0` leaves the
 * frame saying so in words rather than drawing every layer at `NaN`, which renders as
 * nothing at all and reads as "nobody looked anywhere".
 */
const units = (value: number, pageWidth: number): number =>
  pageWidth > 0 ? (value / pageWidth) * OVERLAY_SPAN : 0;

/** Where one fixation — or anything else recorded in page coordinates — is drawn. */
export function pageToOverlay(
  pt: { readonly pageX: number; readonly pageY: number },
  t: Transform,
): OverlayPoint {
  return { x: units(pt.pageX, t.pageWidth), y: units(pt.pageY, t.pageWidth) };
}

/** Where one area of interest's box is drawn, from the `bbox` the run recorded for it. */
export function boxToOverlay(
  bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  t: Transform,
): OverlayBox {
  return {
    x: units(bbox.x, t.pageWidth),
    y: units(bbox.y, t.pageWidth),
    w: units(bbox.width, t.pageWidth),
    h: units(bbox.height, t.pageWidth),
  };
}

/** The screenshot's box in CSS pixels at one zoom level: what the frame scrolls over. */
export interface PageBox {
  readonly width: number;
  readonly height: number;
}

export const pageBox = (t: Transform, zoom: number): PageBox => ({
  width: t.pageWidth * zoom,
  height: t.pageHeight * zoom,
});

/**
 * The zoom levels the stage offers.
 *
 * `1` is first among equals: the page opens **at the size it was captured**, which is the
 * one scale at which what the reader sees is what the audience saw. The step either side
 * is for the two things a reader does from there — stand back from a tall page, or go in
 * close on one control — and a continuous zoom was not built, because a stage that can be
 * left at 73% is a stage whose reader can no longer say what size they are looking at.
 */
export const ZOOM_LEVELS = [0.5, 1, 2] as const;

/** The size a page opens at: its own. */
export const DEFAULT_ZOOM = 1;

/** What a zoom level reads as on its control. */
export const zoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/** The fold line: where the first viewport ended, and the viewport that is. */
export interface FoldMark {
  /** How far down the screenshot it sits, in overlay units. */
  readonly atPct: number;
  /** `fold · 1280 × 800`, as the prototype labels it. */
  readonly label: string;
}

/**
 * Where the fold goes on this capture, or `null` when it is not on the page at all.
 *
 * The tokens carry a figure for this (`--frame-fold-desktop: 62%`), and it is deliberately
 * not used: that figure places the fold over the prototype's *drawn* page, a sketch at no
 * particular scale, while here the fold is where the capture says the first viewport ended.
 * The tokens stay the source of the line's colour and its label's type — only the position
 * is the artifact's.
 *
 * A `foldY` of exactly the page's height is the page's own bottom edge, and is drawn:
 * "everything on this page was above the fold" is a reading a designer wants. A `foldY` of
 * `0`, or one past the end of the page it was taken of, is a capture contradicting itself,
 * and a line drawn outside the image would be a claim about a part of the page that is not
 * there.
 */
export function foldMark(capture: Capture): FoldMark | null {
  const { foldY, pageHeight, viewport } = capture;
  if (pageHeight <= 0 || foldY <= 0 || foldY > pageHeight) return null;
  return {
    // A percentage of the frame's own canvas, not an overlay unit: the fold is one HTML
    // element placed over the screenshot rather than something a layer draws into its
    // `viewBox`, and `top` on it is a percentage of the box it is placed in.
    atPct: (foldY / pageHeight) * 100,
    label: `fold · ${viewport.width} × ${viewport.height}`,
  };
}
