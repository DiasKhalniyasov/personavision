import type { Aoi } from '../aggregate.js';
import type { BoundingBox, Capture, CaptureElement, ElementSource } from '../types.js';
import { aoiId } from './aoi-id.js';
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

/**
 * What every area of one screen shares. These four are this module's to set and no
 * segmenter's: a segmenter cannot disagree with the capture about the fold, and cannot put
 * its region on another variant or another step.
 */
interface Screen {
  readonly variant: string;
  readonly step: string;
  readonly foldY: number;
}

/** What differs between an element-derived area and a segmented one. */
interface AreaParts {
  readonly id: string;
  readonly label: string;
  readonly source: ElementSource;
  readonly role: string | null;
  readonly bbox: BoundingBox;
  readonly isPrimaryAction: boolean;
}

/**
 * `dom` before `a11y` before `sam`: which member of a merged group speaks for the area.
 *
 * A control reported by both trees is recorded as `source: 'dom'` — the DOM is what gives
 * the area a laid-out box and a selector, and the accessibility tree contributed its name.
 * It is also what `docs/design/prototype.html` draws in the areas-of-interest table, where
 * every control reads "DOM" and only a region reads "SAM 3.1 segment".
 */
const SOURCE_PRECEDENCE: readonly ElementSource[] = ['dom', 'a11y', 'sam'];

/**
 * The one place an area of interest is constructed.
 *
 * `belowFold` is computed here from the capture's own fold line rather than copied from an
 * element's flag, which is per element and would disagree with a merged area's box. The
 * fold line is in page space and content below it needed a scroll to be seen, so an area
 * whose top edge is at or past the fold is below it; one that straddles the fold is not,
 * because part of it was on screen without scrolling.
 */
const areaOn = (screen: Screen, parts: AreaParts): Aoi => ({
  id: parts.id,
  variant: screen.variant,
  step: screen.step,
  label: parts.label,
  source: parts.source,
  role: parts.role,
  bbox: parts.bbox,
  isPrimaryAction: parts.isPrimaryAction,
  belowFold: parts.bbox.y >= screen.foldY,
});

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
 * One area from the elements that share a box.
 *
 * The accessible name wins the label, as the acceptance criterion asks: it is the text a
 * screen reader would say, which is the closest thing in a capture to what a designer calls
 * the control. Visible text is the fallback for an element with no name at all, and the
 * role is the last resort, because `run.json` types a label as a non-empty string and a
 * blank label would read on screen as a missing area rather than an unnamed one.
 */
const mergedArea = (members: readonly CaptureElement[], screen: Screen): Aoi => {
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

  return areaOn(screen, {
    id: aoiId({ ...screen, role, label, bbox: speaker.bbox }),
    label,
    source: speaker.source,
    role,
    bbox: speaker.bbox,
    isPrimaryAction: members.some((element) => element.isPrimaryAction),
  });
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const hasExtent = (bbox: unknown): bbox is BoundingBox => {
  if (typeof bbox !== 'object' || bbox === null) return false;
  const box = bbox as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return (
    isFiniteNumber(box.x) &&
    isFiniteNumber(box.y) &&
    isFiniteNumber(box.width) &&
    box.width > 0 &&
    isFiniteNumber(box.height) &&
    box.height > 0
  );
};

/**
 * A region this module is willing to put its name to, checked rather than trusted.
 *
 * A segmenter is third-party code — one of them is a reply from a service (#69) — so a
 * blank id, a missing box or a box with no extent is answered by dropping the region. The
 * alternative is a run artifact the contract rejects when it is written, which is a broken
 * run rather than a screen with one area fewer.
 */
const isUsableRegion = (region: unknown): region is SegmentedArea => {
  if (typeof region !== 'object' || region === null) return false;
  const area = region as { id?: unknown; label?: unknown; bbox?: unknown };
  return isNonBlank(area.id) && isNonBlank(area.label) && hasExtent(area.bbox);
};

/**
 * Segmented regions as areas of interest, in whatever order they arrived.
 *
 * `isPrimaryAction` is always `false`: the primary action is the control the task declares,
 * and a region nobody could name is not it. A region whose id is already taken is dropped
 * rather than merged, because an id is a promise about one area across every session. The
 * geometry is copied field by field so that nothing a segmenter hung on its box reaches the
 * artifact, and a missing role is `null` rather than absent.
 */
const segmentedAreas = (returned: unknown, screen: Screen, taken: ReadonlySet<string>): Aoi[] => {
  if (!Array.isArray(returned)) return [];

  const used = new Set(taken);
  const kept: Aoi[] = [];

  for (const region of returned as readonly unknown[]) {
    if (!isUsableRegion(region) || used.has(region.id)) continue;
    used.add(region.id);
    kept.push(
      areaOn(screen, {
        id: region.id,
        label: region.label,
        source: 'sam',
        role: typeof region.role === 'string' ? region.role : null,
        bbox: {
          x: region.bbox.x,
          y: region.bbox.y,
          width: region.bbox.width,
          height: region.bbox.height,
        },
        isPrimaryAction: false,
      }),
    );
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
  const screen: Screen = { variant, step: capture.step, foldY: capture.foldY };

  const groups = new Map<string, CaptureElement[]>();
  for (const element of capture.elements) {
    const key = boxKey(element.bbox);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [element]);
    else group.push(element);
  }

  const elementAreas = [...groups.values()]
    .map((members) => mergedArea(members, screen))
    .sort(inReadingOrder);

  const taken = new Set(elementAreas.map((area) => area.id));
  let segmented: Aoi[] = [];
  try {
    const returned = await (input.segmenter ?? defaultSegmenter).segment({
      capture,
      variant,
      explained: elementAreas,
    });
    segmented = segmentedAreas(returned, screen, taken);
  } catch {
    // Additive and never required: a segmenter's failure is a screen with fewer areas on
    // it, never a failed run. #69 reports its own unavailability through its own result.
    segmented = [];
  }

  return [...elementAreas, ...segmented].sort(inReadingOrder);
};
