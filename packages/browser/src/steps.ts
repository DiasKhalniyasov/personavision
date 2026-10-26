/**
 * Which step of the task a page is on, and which element advances it.
 *
 * Both are the task's declarations, resolved against the live page — never guessed.
 *
 * **Detection is declarative.** A step matches on its URL pattern **and** its required
 * element, and a page is labelled with the first step both hold for. A URL alone never names
 * a step: `no-control.html` matches the payment pattern and carries no payment form, so it is
 * on no step. Nothing is read from the page's words either, so a page that *says* "payment"
 * is still labelled by what it is, and a session's screens are labelled `cart`, `payment`,
 * `review` or `confirmation` rather than guessed at.
 *
 * **The primary action is the task's.** A step names the selector of the control that
 * advances it; resolution finds that node's page-space box and marks the extracted element
 * occupying it. Matching by box rather than by selector is what keeps this independent of how
 * the extractor spells its own selectors — it mints them from the DOM and the accessibility
 * tree, and two candidates for one control may spell it two ways. Exactly one element is
 * marked, and any mark the candidates arrived with is cleared.
 *
 * **A control that cannot be resolved is our failure, not the product's.** Time to first
 * fixation on the primary action is a headline component, so a step whose declared control is
 * absent from the page, or present but matching none of the candidates, raises an
 * `AutomationFailure` with reason `selector_not_found` — which excludes the session — rather
 * than returning a silent `false` on every element, which would score it as zero.
 *
 * Two mechanics, stated once:
 *
 * - A step's selectors are **CSS**, resolved with `document.querySelector` inside the page.
 *   The box comes back from `getBoundingClientRect` plus the scroll offsets, which is the
 *   page space every box in a `Capture` is expressed in, so a scrolled page resolves the same
 *   control as an unscrolled one.
 * - A candidate matches when all four edges of its box are within a pixel of the resolved
 *   node's, and the closest such candidate is the one marked. The tolerance is there because
 *   an extractor may round what the page reported; the ties that remain are two candidates
 *   for one control, and list order decides between them, which `extractElements` fixes
 *   deterministically.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: this module needs the DOM types,
// and the reference travels with the file (see `geometry.ts`).
import { AutomationFailure } from './errors.js';
import type { Box, CaptureElement, PageHandle, TaskDefinition, TaskStep } from './types.js';

export type DetectStep = (page: PageHandle, task: TaskDefinition) => Promise<string | null>;

export type ResolvePrimaryAction = (
  page: PageHandle,
  elements: readonly CaptureElement[],
  step: TaskStep | null,
) => Promise<CaptureElement[]>;

/** How far a candidate's box may be from the resolved node's, per edge, in CSS pixels. */
const BOX_MATCH_TOLERANCE_PX = 1;

/** Whether a selector resolves to anything at all on the page. */
const isPresent = (handle: PageHandle, selector: string): Promise<boolean> =>
  handle.page.evaluate((chosen) => document.querySelector(chosen) !== null, selector);

/**
 * The page-space box of the first node a selector resolves to, or `null` when it resolves to
 * none. The scroll offsets are added here, so the box does not move when the session scrolls.
 */
const readPageSpaceBox = (handle: PageHandle, selector: string): Promise<Box | null> =>
  handle.page.evaluate((chosen) => {
    const node = document.querySelector(chosen);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }, selector);

/** Two boxes are the same control when no edge of either is more than the tolerance away. */
const isSameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) <= BOX_MATCH_TOLERANCE_PX &&
  Math.abs(a.y - b.y) <= BOX_MATCH_TOLERANCE_PX &&
  Math.abs(a.width - b.width) <= BOX_MATCH_TOLERANCE_PX &&
  Math.abs(a.height - b.height) <= BOX_MATCH_TOLERANCE_PX;

/** How far apart two boxes are: the four edges' distances summed, in CSS pixels. */
const boxDistance = (a: Box, b: Box): number =>
  Math.abs(a.x - b.x) +
  Math.abs(a.y - b.y) +
  Math.abs(a.width - b.width) +
  Math.abs(a.height - b.height);

/**
 * The index of the candidate whose box is the resolved node's, or `null` when none is. The
 * closest match wins; an exact tie is two candidates for one control, and the first of them
 * is taken.
 */
const closestMatch = (box: Box, elements: readonly CaptureElement[]): number | null => {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [index, element] of elements.entries()) {
    if (!isSameBox(box, element.bbox)) continue;
    const distance = boxDistance(box, element.bbox);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }

  return best;
};

const boxText = (box: Box): string => `${box.width}x${box.height} at (${box.x}, ${box.y})`;

/**
 * The step a detected id names, as the task declares it, or `null`.
 *
 * `detectStep` answers with an id, because that is what a `Capture` records and what a
 * screenshot is written under; resolving the primary action needs the declaration behind it.
 */
export const taskStep = (task: TaskDefinition, step: string | null): TaskStep | null =>
  step === null ? null : (task.steps.find((candidate) => candidate.id === step) ?? null);

/**
 * The id of the step the page is on, or `null` when it matches none of the task's.
 *
 * The steps are walked in the order the task declares them and the page is asked about one
 * required element at a time, so a page is labelled by the first step that holds and the
 * elements of later steps are never looked for.
 */
export const detectStep: DetectStep = async (page, task) => {
  const url = page.page.url();

  for (const step of task.steps) {
    if (!new RegExp(step.match.urlPattern).test(url)) continue;
    if (await isPresent(page, step.match.requiredSelector)) return step.id;
  }

  return null;
};

/**
 * The same elements, with `isPrimaryAction` set on the one the step declares and cleared on
 * every other — so exactly one element per step carries it, and a page on no step carries it
 * nowhere.
 *
 * A declared control that is absent from the page is an automation failure whether or not
 * anything was extracted. A candidate list that is **empty** is the one case that resolves to
 * nothing without failing: there is no element to mark, none left silently false, and no
 * screen attention could have been attributed on either way.
 */
export const resolvePrimaryAction: ResolvePrimaryAction = async (page, elements, step) => {
  const resolved = elements.map((element) => ({ ...element, isPrimaryAction: false }));
  if (step === null) return resolved;

  const { selector } = step.primaryAction;
  const box = await readPageSpaceBox(page, selector);
  if (box === null) {
    throw new AutomationFailure(
      'selector_not_found',
      `the ${step.id} step declares ${selector} as its primary action, and it is not on ${page.page.url()}`,
    );
  }

  if (resolved.length === 0) return resolved;

  const match = closestMatch(box, resolved);
  if (match === null) {
    throw new AutomationFailure(
      'selector_not_found',
      `the ${step.id} step's primary action ${selector} is ${boxText(box)}, which is none of the ${resolved.length} candidate elements of ${page.page.url()}`,
    );
  }

  resolved[match] = { ...resolved[match], isPrimaryAction: true };
  return resolved;
};
