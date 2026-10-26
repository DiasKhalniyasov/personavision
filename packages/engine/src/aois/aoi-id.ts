import type { BoundingBox } from '../types.js';

/**
 * The id of an area of interest: the one place that composition is written.
 *
 * It lives beside `build-aois.ts` rather than inside it because both sides of the
 * segmentation seam need it. `buildAois` names the areas the capture's elements explain,
 * and a `Segmenter` names the regions they do not (#66, #69) — and a segmenter that
 * imported the builder to reach this function would close a cycle around the module that
 * calls it. Both import this instead, so there is still exactly one id scheme.
 */

/** What an id is derived from. */
export interface AoiIdentity {
  readonly variant: string;
  readonly step: string;
  readonly role: string | null;
  readonly label: string;
  readonly bbox: BoundingBox;
}

const SLUG_LIMIT = 40;

/** Lower case, alphanumeric and single dashes, so an id reads like `a-cart-button-checkout`. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_LIMIT)
    .replace(/^-+|-+$/g, '');

const token = (value: string, fallback: string): string => slug(value) || fallback;

/**
 * A coordinate in an id. Negative becomes `n12` rather than `-12`: an element off the left
 * or top edge has a negative origin, and a minus sign inside a dash-joined id reads as an
 * empty segment.
 */
const coordinateToken = (value: number): string => {
  const rounded = Math.round(value);
  return rounded < 0 ? `n${Math.abs(rounded)}` : String(rounded);
};

/**
 * Derived from role, accessible name and position as #6 derives its element ids, with the
 * variant and the step in front because `run.json` holds every variant's areas in one
 * array and `aoiMetrics` joins on the id alone.
 *
 * Two areas with the same role and name at different positions get different ids; two
 * areas with the same box are the same area. A region with no role at all reads `region`,
 * which is what a segmented area of interest's id says where a control's says `button`.
 */
export const aoiId = (identity: AoiIdentity): string =>
  [
    token(identity.variant, 'variant'),
    token(identity.step, 'step'),
    token(identity.role ?? '', 'region'),
    token(identity.label, 'unnamed'),
    coordinateToken(identity.bbox.x),
    coordinateToken(identity.bbox.y),
    `${coordinateToken(identity.bbox.width)}x${coordinateToken(identity.bbox.height)}`,
  ].join('-');
