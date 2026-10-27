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
 * absent from the page, is not rendered, or matches none of the candidates raises an
 * `AutomationFailure` with reason `selector_not_found` — which excludes the session — rather
 * than returning a silent `false` on every element, which would score it as zero.
 *
 * **A declaration this module cannot parse is neither.** An unparseable URL pattern or
 * selector is a broken `TaskDefinition`: every session of every variant would fail it
 * identically, so it is raised as a plain error naming the step and the declaration rather
 * than excluded twenty-four times as a failure of our browsing.
 *
 * Three mechanics, stated once:
 *
 * - A step's selectors are **CSS**, resolved with `document.querySelector` in the page's main
 *   frame — the frame a task declares its steps against, and the one Playwright's own
 *   locators search by default. A control inside an `iframe` is therefore not resolvable
 *   here; the task walk is what would have to reach into a frame.
 * - A required element need only be **present** in the markup, which is what a task declares
 *   and what tells `no-control.html` from a payment page. A primary action must also be
 *   **rendered**: its box is what attention is attributed to, and a node that is not rendered
 *   reports a box of zeros, which is no box at all and would match whatever else is nowhere.
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

/**
 * What the page made of a selector. The four cases are told apart **inside** the page, so
 * that a selector its own engine cannot parse comes back as an answer rather than as a stray
 * `SyntaxError` thrown from the middle of a capture.
 */
type SelectorProbe =
  | { readonly found: 'box'; readonly box: Box }
  | { readonly found: 'absent' }
  | { readonly found: 'not-rendered' }
  | { readonly found: 'unparseable' };

/**
 * Whether a selector resolves to anything at all, and the box of the first node it does
 * resolve to. The scroll offsets are added here, so the box does not move when the session
 * scrolls, and a node that is not rendered is reported as such rather than as a box of zeros.
 */
const probeSelector = (handle: PageHandle, selector: string): Promise<SelectorProbe> =>
  handle.page.evaluate((chosen): SelectorProbe => {
    let node: Element | null;
    try {
      node = document.querySelector(chosen);
    } catch {
      return { found: 'unparseable' };
    }
    if (node === null) return { found: 'absent' };

    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { found: 'not-rendered' };

    return {
      found: 'box',
      box: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
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
 * The index of the candidate whose box is the resolved node's, or `null` when none is.
 *
 * The closest match wins, because two different controls can sit within the tolerance of one
 * another — a label overlapping its field by a pixel — and the exact box is then the right
 * one. An exact tie is two candidates for one control, and the first of them is taken.
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

/** A declaration of the task that this module cannot parse: the task is wrong, not the page. */
const unparseable = (step: TaskStep, what: string, declared: string, cause?: unknown): Error =>
  new Error(
    `the ${step.id} step declares ${declared} as its ${what}, which this module cannot parse`,
    { cause },
  );

/** The step's URL pattern, compiled — and named in the error when it is not a pattern. */
const stepPattern = (step: TaskStep): RegExp => {
  try {
    return new RegExp(step.match.urlPattern);
  } catch (cause) {
    throw unparseable(step, 'URL pattern', step.match.urlPattern, cause);
  }
};

/**
 * The step a detected id names, as the task declares it, or `null` when nothing was detected.
 *
 * `detectStep` answers with an id, because that is what a `Capture` records and what a
 * screenshot is written under; resolving the primary action needs the declaration behind it.
 * An id the task does not declare is a programming error rather than a page the task does not
 * cover, so it says so instead of resolving to no step and marking nothing.
 */
export const taskStep = (task: TaskDefinition, step: string | null): TaskStep | null => {
  if (step === null) return null;

  const declared = task.steps.find((candidate) => candidate.id === step);
  if (declared === undefined) {
    throw new Error(`the ${task.id} task declares no ${step} step`);
  }
  return declared;
};

/**
 * The id of the step the page is on, or `null` when it matches none of the task's.
 *
 * The steps are walked in the order the task declares them and the page is asked about one
 * required element at a time, so a page is labelled by the first step that holds and the
 * elements of later steps are never looked for. The URL is read per step rather than once, so
 * a page that navigates while it is being asked is matched against where it actually is.
 */
export const detectStep: DetectStep = async (page, task) => {
  for (const step of task.steps) {
    if (!stepPattern(step).test(page.page.url())) continue;

    const { requiredSelector } = step.match;
    const probe = await probeSelector(page, requiredSelector);
    if (probe.found === 'unparseable') {
      throw unparseable(step, 'required element', requiredSelector);
    }
    if (probe.found !== 'absent') return step.id;
  }

  return null;
};

/**
 * The same elements, with `isPrimaryAction` set on the one the step declares and cleared on
 * every other — so exactly one element per step carries it, and a page on no step carries it
 * nowhere. The candidates handed in are never touched: a resolution that fails leaves the
 * caller's list exactly as it was.
 *
 * A declared control that cannot be resolved on the page is an automation failure whether or
 * not anything was extracted. A candidate list that is **empty** is the one case that resolves
 * to nothing without failing: there is no element to mark, none left silently false, and no
 * screen attention could have been attributed on either way.
 */
export const resolvePrimaryAction: ResolvePrimaryAction = async (page, elements, step) => {
  const resolved = elements.map((element) => ({ ...element, isPrimaryAction: false }));
  if (step === null) return resolved;

  const { selector } = step.primaryAction;
  const probe = await probeSelector(page, selector);
  if (probe.found === 'unparseable') {
    throw unparseable(step, 'primary action', selector);
  }
  if (probe.found !== 'box') {
    throw new AutomationFailure(
      'selector_not_found',
      `the ${step.id} step's primary action ${selector} is ${probe.found} on ${page.page.url()}`,
    );
  }

  if (resolved.length === 0) return resolved;

  const match = closestMatch(probe.box, resolved);
  if (match === null) {
    throw new AutomationFailure(
      'selector_not_found',
      `the ${step.id} step's primary action ${selector} is ${boxText(probe.box)}, which is none of the ${resolved.length} candidate elements of ${page.page.url()}`,
    );
  }

  resolved[match] = { ...resolved[match], isPrimaryAction: true };
  return resolved;
};
