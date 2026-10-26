import type { Aoi } from '../aggregate.js';
import type { BoundingBox, Capture, CaptureElement, ElementSource } from '../types.js';
import { defaultSegmenter } from './segmenter.js';
import type { SegmentedArea, Segmenter } from './segmenter.js';

/**
 * The areas of interest of one captured screen: what attention is attributed to.
 *
 * A heatmap has to talk about elements a designer recognises rather than about pixels, so
 * this module turns a capture into the areas the rest of the engine scores, samples and
 * aggregates. Three things it owns, and nothing else in the package repeats them:
 *
 * **Merge, do not duplicate.** The browser step reports the same control twice — once from
 * the DOM and once from the accessibility tree — and two areas for one button would split
 * its dwell in half and double its row in the areas-of-interest table. Elements that occupy
 * the same box are one area, with the accessible name as its label.
 *
 * **Stable ids.** An area's id is derived from the variant, the step, the role, the
 * accessible name and the box, so the same control on the same screen has the same id in
 * every session and every seed. Aggregation across sessions (`aggregate`) joins on it
 * entirely, so an id that moved would quietly report two halves of one control.
 *
 * **Deterministic order.** Reading order — down the page, then across — with the id as the
 * final tie-break. Neither the order the capture listed its elements in nor any object's
 * key order reaches the output, because a run's `aois` are committed to the artifact and a
 * reordered array would read as a change nobody made.
 *
 * The regions the DOM does not explain come from the injected `Segmenter`; see
 * `segmenter.ts` for why a segmenter is additive and can never break this function.
 *
 * Pure: no file is read and no socket is opened here. The screenshot is passed on as the
 * path the capture carries, and only a segmenter may choose to go and look at it.
 */

/**
 * `buildAois` takes an input object rather than `(capture, segmenter)` as #7 sketched it,
 * because an area of interest carries the `variant` and a capture does not: the browser
 * step's `Capture` is per step, and `run.json` keys an area on variant *and* step. The
 * variant id is therefore passed beside the capture rather than guessed from the
 * screenshot path. See the auto-decision on #64.
 */
export interface BuildAoisInput {
  readonly capture: Capture;
  /** The variant id, exactly as `run.json`'s `variants[].id` spells it. */
  readonly variant: string;
  /** Omitted means `defaultSegmenter`; `noSegmenter` means element-derived areas only. */
  readonly segmenter?: Segmenter;
}

/** What an id is derived from. `aoiId` is the only place that composition is written. */
export interface AoiIdentity {
  readonly variant: string;
  readonly step: string;
  readonly role: string | null;
  readonly label: string;
  readonly bbox: BoundingBox;
}

/**
 * `dom` before `a11y` before `sam`: which member of a merged group speaks for the area.
 *
 * A control reported by both trees is recorded as `source: 'dom'` — the DOM is what gives
 * the area a laid-out box and a selector, and the accessibility tree contributed its name.
 * The distinction the screens lean on is between an element we can name and a region we
 * segmented, so `sam` last matters more than `dom` before `a11y`.
 */
const SOURCE_PRECEDENCE: readonly ElementSource[] = ['dom', 'a11y', 'sam'];

const LABEL_SLUG_LIMIT = 40;

/** Lower case, alphanumeric and single dashes, so an id reads like `a-cart-button-checkout`. */
const slug = (value: string, limit: number): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, limit)
    .replace(/^-+|-+$/g, '');

const token = (value: string, fallback: string, limit = LABEL_SLUG_LIMIT): string =>
  slug(value, limit) || fallback;

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
 * The id of an area of interest, derived from role, accessible name and position as #6
 * derives its element ids, with the variant and the step in front because `run.json` holds
 * every variant's areas in one array and `aoiMetrics` joins on the id alone.
 *
 * Exported so that a segmenter (#66, #69) names its regions in the same family instead of
 * inventing a second id scheme. Two areas with the same role and name at different
 * positions get different ids; two areas with the same box are the same area.
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

/**
 * Elements that occupy the same box are the same control, reported twice.
 *
 * The box is the merge key, not the role and name: the DOM entry for a button often has no
 * accessible name while the accessibility entry has one, and keying on the name would keep
 * exactly the pair this function exists to merge apart. Rounded to whole pixels, because a
 * box measured twice can differ in its last fraction and a half-pixel is not a second
 * control.
 */
const boxKey = (bbox: BoundingBox): string =>
  [bbox.x, bbox.y, bbox.width, bbox.height].map((value) => Math.round(value)).join(':');

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Source precedence first, then the element id, so a group's order never depends on input order. */
const bySourceThenId = (a: CaptureElement, b: CaptureElement): number =>
  SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source) ||
  compareIds(a.id, b.id);

/** Down the page, then across, then by id — a total order over the areas of one screen. */
const inReadingOrder = (a: Aoi, b: Aoi): number =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || compareIds(a.id, b.id);

const firstNonEmpty = (values: readonly string[]): string | null =>
  values.map((value) => value.trim()).find((value) => value !== '') ?? null;

/**
 * The fold line is in page space and content below it needed a scroll to be seen, so an
 * area whose top edge is at or past the fold is below it. One that straddles the fold is
 * not: part of it was on screen without scrolling.
 *
 * Recomputed from the capture's `foldY` rather than copied from the element's own flag,
 * which is per element and would disagree with the merged area's box.
 */
const isBelowFold = (bbox: BoundingBox, foldY: number): boolean => bbox.y >= foldY;

/**
 * One area from the elements that share a box.
 *
 * The accessible name wins the label, as the acceptance criterion asks: it is the text a
 * screen reader would say, which is the closest thing in a capture to what a designer calls
 * the control. Visible text is the fallback for an element with no name at all, and the
 * role is the last resort, because `run.json` types a label as a non-empty string and a
 * blank label would read on screen as a missing area rather than an unnamed one.
 */
const mergedArea = (members: readonly CaptureElement[], variant: string, capture: Capture): Aoi => {
  const inPrecedence = [...members].sort(bySourceThenId);
  const accessible = inPrecedence.filter((element) => element.source === 'a11y');
  const speaker = inPrecedence[0];

  const role =
    accessible.map((element) => element.role).find((value) => value !== null) ??
    inPrecedence.map((element) => element.role).find((value) => value !== null) ??
    null;

  const label =
    firstNonEmpty(accessible.map((element) => element.name)) ??
    firstNonEmpty(inPrecedence.map((element) => element.name)) ??
    firstNonEmpty(inPrecedence.map((element) => element.text)) ??
    role ??
    'Unnamed area';

  const identity = { variant, step: capture.step, role, label, bbox: speaker.bbox };

  return {
    id: aoiId(identity),
    variant,
    step: capture.step,
    label,
    source: speaker.source,
    role,
    bbox: speaker.bbox,
    isPrimaryAction: members.some((element) => element.isPrimaryAction),
    belowFold: isBelowFold(speaker.bbox, capture.foldY),
  };
};

const isFinitePoint = (value: number): boolean => Number.isFinite(value);

/**
 * A region a malformed segmenter cannot smuggle into the artifact: a box that is not finite
 * or has no extent, a blank id or a blank label would all fail the contract's own schema
 * when the run is written, which is a broken run rather than a missing region.
 */
const isUsable = (area: SegmentedArea): boolean =>
  typeof area.id === 'string' &&
  area.id.trim() !== '' &&
  typeof area.label === 'string' &&
  area.label.trim() !== '' &&
  isFinitePoint(area.bbox.x) &&
  isFinitePoint(area.bbox.y) &&
  isFinitePoint(area.bbox.width) &&
  isFinitePoint(area.bbox.height) &&
  area.bbox.width > 0 &&
  area.bbox.height > 0;

/**
 * Segmented regions as areas of interest.
 *
 * `variant`, `step`, `belowFold` and `source` are this module's to set, and
 * `isPrimaryAction` is always `false`: the primary action is the control the task declares,
 * and a region nobody could name is not it. A region whose id is already taken is dropped
 * rather than merged, because an id is a promise about one area across every session.
 */
const segmentedAreas = (
  areas: readonly SegmentedArea[],
  variant: string,
  capture: Capture,
  taken: ReadonlySet<string>,
): Aoi[] => {
  const used = new Set(taken);
  const kept: Aoi[] = [];

  for (const area of areas) {
    if (!isUsable(area) || used.has(area.id)) continue;
    used.add(area.id);
    kept.push({
      id: area.id,
      variant,
      step: capture.step,
      label: area.label,
      source: 'sam',
      role: area.role,
      bbox: area.bbox,
      isPrimaryAction: false,
      belowFold: isBelowFold(area.bbox, capture.foldY),
    });
  }

  return kept;
};

/**
 * The areas of interest of one captured screen, in reading order.
 *
 * The element-derived areas are built first and handed to the segmenter as the areas
 * already explained; whatever it returns is tagged `source: 'sam'` and sorted in among
 * them, so a segmented card grid reads in the same order as the controls around it.
 *
 * A segmenter that returns nothing, returns something it should not, or throws leaves the
 * element-derived areas exactly as they were. That is the whole point of the seam: the
 * SAM 3.1 path needs a credential and a network, and a cold clone with neither must build
 * the same areas it always did.
 */
export const buildAois = async (input: BuildAoisInput): Promise<Aoi[]> => {
  const { capture, variant } = input;

  const groups = new Map<string, CaptureElement[]>();
  for (const element of capture.elements) {
    const key = boxKey(element.bbox);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [element]);
    else group.push(element);
  }

  const elementAreas = [...groups.values()]
    .map((members) => mergedArea(members, variant, capture))
    .sort(inReadingOrder);

  const segmenter = input.segmenter ?? defaultSegmenter;
  let segmented: readonly SegmentedArea[] = [];
  try {
    const returned = await segmenter.segment({ capture, explained: elementAreas });
    if (Array.isArray(returned)) segmented = returned;
  } catch {
    // Additive and never required: a segmenter's failure is a screen with fewer areas on
    // it, never a failed run. #69 reports its own unavailability through its own result.
    segmented = [];
  }

  const taken = new Set(elementAreas.map((area) => area.id));
  return [...elementAreas, ...segmentedAreas(segmented, variant, capture, taken)].sort(
    inReadingOrder,
  );
};
