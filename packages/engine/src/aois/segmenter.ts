import type { Aoi } from '../aggregate.js';
import type { BoundingBox, Capture } from '../types.js';

/**
 * The `Segmenter` seam: the areas of interest the capture's elements do **not** explain.
 *
 * A screen is rarely all controls. A hero image, a card grid or a banner arrives from the
 * browser step as nothing at all, and attention still lands on it. `buildAois` therefore
 * asks an injected segmenter for the areas the elements left over, and does not care which
 * implementation it got: an offline heuristic partition over the image (#66, the default,
 * which the demo and CI run on) or SAM 3.1 through the Meta Model API (#69).
 *
 * Three rules hold both implementations and anything later:
 *
 * - **Additive, never required.** A segmenter that returns nothing, that returns something
 *   malformed, or that throws leaves `buildAois` returning the element-derived areas. A
 *   missing credential, a timeout or a broken image is never allowed to break the build or
 *   the demo, so `buildAois` swallows the failure by design rather than propagating it.
 * - **The engine stays pure.** A segmenter is handed the screenshot's run-directory-relative
 *   path and the page geometry, and whether it opens the image or calls a service is its own
 *   business, outside the engine's purity rule. `buildAois` itself touches no file and no
 *   socket either way.
 * - **Deterministic.** The same screenshot and the same explained areas give the same
 *   regions, with the same ids, in the same order. `buildAois` re-orders the result anyway,
 *   so a segmenter owes determinism of *content*, not of order.
 */

/** A value or a promise of one: the seam takes a synchronous segmenter and an asynchronous one. */
export type Awaitable<T> = T | Promise<T>;

/** What a segmenter is given: the captured screen, and the areas already accounted for. */
export interface SegmenterInput {
  /**
   * The capture, for its `screenshot` path, `viewport`, `pageHeight` and `foldY`. The
   * screenshot path is run-directory-relative, as the browser step records it, so a
   * segmenter that opens the image resolves it against the run directory itself.
   */
  readonly capture: Capture;
  /**
   * The areas the capture's elements explain, in the order `buildAois` emits them. A
   * segmenter returns regions for what is *left*: #66 keeps its regions from overlapping
   * these, and #69 states its own rule for a mask that does.
   */
  readonly explained: readonly Aoi[];
}

/**
 * One region a segmenter found. It is not an `Aoi` yet: `buildAois` owns `variant`, `step`,
 * `source` and `belowFold`, so a segmenter cannot disagree with the capture about the fold
 * or claim an area is the step's primary action.
 */
export interface SegmentedArea {
  /**
   * Stable for the same region on the same screen across sessions, since per-area metrics
   * are joined on it. `aoiId` derives one in the same family as the element-derived ids;
   * an id that collides with an area already built is dropped rather than overwriting it.
   */
  readonly id: string;
  /** What a designer would call the region — "product card grid", not "region-7". */
  readonly label: string;
  /** A role when the region has a recognisable one, `null` when it is just image. */
  readonly role: string | null;
  /** Page space, the same space the capture's elements use. */
  readonly bbox: BoundingBox;
}

export interface Segmenter {
  segment(input: SegmenterInput): Awaitable<readonly SegmentedArea[]>;
}

/**
 * The honest empty segmentation: no region, ever. Element-derived areas only.
 *
 * It is a real implementation rather than a stand-in — a run that wants no segmentation
 * passes this — and tests use it to say "no segmenter" without depending on which
 * implementation is currently the default.
 */
export const noSegmenter: Segmenter = { segment: () => [] };

/**
 * The segmenter `buildAois` uses when the caller names none.
 *
 * This is the seam #66 fills: that ticket replaces the value below with its offline
 * heuristic segmenter, in one line, and `buildAois` needs no change. Until then the
 * default segments nothing — an engine with no segmenter attributes attention to the
 * elements it can actually name, which is a smaller answer and never a fabricated one.
 */
export const defaultSegmenter: Segmenter = noSegmenter;
