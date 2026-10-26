/**
 * Doing something to the page: a click, a scroll, a text entry or a back navigation.
 *
 * An action targets either an `elementId` from a capture — what the swarm uses — or a raw
 * `selector`, which this step's own tests use, and resolving whichever is given is this
 * module's job. Every failure of ours comes back as an `ActResult` with `ok: false` and a
 * typed reason, so a broken selector is never attributed to the product.
 *
 * **What this file decides, and what it leaves alone.** It knows three things about a
 * failure, and each is a position in the sequence below rather than a reading of an error
 * message:
 *
 * 1. A target that cannot be resolved — no element of the capture carries that id, no node
 *    matches that selector, more than one does, or there is no target at all — is
 *    `selector_not_found`. The page is untouched, so it is left usable for the next action.
 * 2. A navigation that never completes after a click, or a back with nothing behind it, is
 *    `navigation_error`.
 * 3. Anything thrown while the action itself runs is handed to `mapToAutomationFailure`,
 *    and rethrown when that seam cannot place it. Reading a timeout out of an error is that
 *    seam's job; retrying, capping and counting is the budget's. This file invents neither.
 *
 * It does not retry. One action is one attempt, and the policy above it is #50's.
 */

/// <reference lib="dom" />
// The callbacks below run inside the page, not in Node: this module needs the DOM
// types, and the reference travels with the file (see `geometry.ts`).
import { extractElements } from './extract/elements.js';
import { mapToAutomationFailure } from './failure-mapping.js';
import { readGeometry } from './geometry.js';
import { detectStep } from './steps.js';
import type {
  ActResult,
  Action,
  AutomationFailureReason,
  CaptureContext,
  CaptureElement,
  PageHandle,
} from './types.js';

/**
 * How long resolving a target, performing the action and settling a navigation may each
 * take. Long enough that a control still arriving on a real page is waited for, short
 * enough that a session's cap is reached by a page that is broken rather than slow.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ActOptions {
  /** How long each phase of the action may take. Defaults to 10 000. */
  readonly timeoutMs?: number;
  /**
   * The capture the action was decided against: where an `elementId` is looked up.
   *
   * The swarm has one in hand — it is the screen the agent chose from — and passing it
   * spares a second extraction and guarantees the action lands on the element that was
   * chosen rather than on whatever carries that id now. Without it, the page is extracted
   * again to resolve the id.
   */
  readonly screen?: { readonly elements: readonly CaptureElement[] };
}

export type Act = (
  page: PageHandle,
  action: Action,
  ctx: CaptureContext,
  options?: ActOptions,
) => Promise<ActResult>;

/** The page's own account of where it is, read out of the page rather than remembered. */
const readPosition = (handle: PageHandle): Promise<{ url: string; scrollY: number }> =>
  handle.page.evaluate(() => ({ url: window.location.href, scrollY: window.scrollY }));

/**
 * Scrolls the window by a delta.
 *
 * `behavior: 'instant'` overrides a page that asked for smooth scrolling, so the position
 * reported afterwards is the one the scroll reached and not a frame of an animation.
 */
const scrollByDelta = (handle: PageHandle, deltaY: number): Promise<void> =>
  handle.page.evaluate((delta) => {
    window.scrollBy({ top: delta, behavior: 'instant' });
  }, deltaY);

/**
 * Waits for the document a click landed on to be parsed.
 *
 * `domcontentloaded` rather than `load`: a page one of whose frames never arrives never
 * fires `load` — the fixture site has such a page on purpose — and a click that worked must
 * not be reported as a navigation error because an advert is still spinning. What the next
 * action needs is a parsed document, and Playwright waits for the element itself anyway.
 */
const settle = async (handle: PageHandle, timeoutMs: number): Promise<void> => {
  await handle.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
};

/** The page a browser is on before it has been sent anywhere: never a page of a product. */
const BLANK_PAGE = 'about:blank';

/**
 * Puts the page back where it was after a back navigation that went nowhere a session can
 * act on.
 *
 * Going back off the first page of a task lands on the blank page the session started from,
 * and leaving a swarm staring at `about:blank` would make its next action fail for a reason
 * that has nothing to do with the product. Going forward again is the exact inverse, so the
 * history the session still has is the history it had; re-opening the URL is the fallback
 * for when even that does not land.
 */
const restore = async (handle: PageHandle, url: string, timeoutMs: number): Promise<void> => {
  if (handle.page.url() === url) return;
  // Nothing forward to go to is not a second failure to report: the goto below is what
  // actually has to work.
  await handle.page
    .goForward({ timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    .catch(() => null);
  if (handle.page.url() === url) return;
  await handle.page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
};

/** Whether the action names an element at all. */
const isTargeted = (action: Action): boolean =>
  action.elementId !== undefined || action.selector !== undefined;

/**
 * The elements of the screen as it is now, for an action whose caller did not hand its
 * capture over. This is the extractor's own reading of the page, so an id minted by a
 * capture resolves here to the same element.
 */
const extractScreen = async (
  handle: PageHandle,
  ctx: CaptureContext,
): Promise<readonly CaptureElement[]> => {
  const geometry = await readGeometry(handle);
  const step = await detectStep(handle, ctx.task);
  return extractElements(handle, geometry, step);
};

/**
 * The selector the action aims at, or `null` when it aims at nothing we can find.
 *
 * An `elementId` wins over a `selector` when both are given: the capture-anchored target is
 * the one an agent chose, and the selector is the escape hatch underneath it.
 */
const resolveSelector = async (
  handle: PageHandle,
  action: Action,
  ctx: CaptureContext,
  screen: ActOptions['screen'],
): Promise<string | null> => {
  if (action.elementId !== undefined) {
    const elements = screen?.elements ?? (await extractScreen(handle, ctx));
    return elements.find((element) => element.id === action.elementId)?.selector ?? null;
  }
  return action.selector ?? null;
};

/**
 * Runs one action against the open page and reports what the page became.
 *
 * The result's `step` is the step-detection seam's answer for the page the action left the
 * session on, so a caller recording a session's screens gets the label with the position.
 */
export const act: Act = async (handle, action, ctx, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const report = async (failure?: AutomationFailureReason): Promise<ActResult> => {
    const { url, scrollY } = await readPosition(handle);
    const step = await detectStep(handle, ctx.task);
    return failure === undefined
      ? { ok: true, action, url, scrollY, step }
      : { ok: false, action, url, scrollY, step, failure };
  };

  // One step back in history, whatever else the action names.
  //
  // Whether it worked is judged by where the page ended up and not by what the navigation
  // answered: a back within one document answers with no response at all and still worked,
  // while a back off the first page of a task answers the same way and lands on the blank
  // page the session started from, which is our failure and not the product's.
  if (action.type === 'back') {
    const from = handle.page.url();
    try {
      await handle.page.goBack({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    } catch {
      return report('navigation_error');
    }
    const landed = handle.page.url();
    if (landed === from || landed === BLANK_PAGE) {
      await restore(handle, from, timeoutMs);
      return report('navigation_error');
    }
    return report();
  }

  // A scroll that names no element is a scroll by a delta. An absent delta scrolls
  // nothing and reports where the page already was, rather than failing over an action
  // that asked for nothing.
  if (action.type === 'scroll' && !isTargeted(action)) {
    await scrollByDelta(handle, action.deltaY ?? 0);
    return report();
  }

  const selector = await resolveSelector(handle, action, ctx, options.screen);
  if (selector === null) return report('selector_not_found');

  const target = handle.page.locator(selector);
  try {
    // Resolution is separated from the action so that the two failures stay apart: this
    // wait is what "the element cannot be resolved" means, and a selector that is
    // unparseable or matches two nodes fails here too.
    await target.waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    return report('selector_not_found');
  }

  try {
    switch (action.type) {
      case 'click':
        await target.click({ timeout: timeoutMs });
        break;
      case 'scroll':
        // The minimum scroll that puts the element on screen; an element already in view
        // moves the page not at all.
        await target.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        break;
      case 'type':
        // `fill` leaves the field holding exactly the value, which is what the agent
        // decided; a keystroke-by-keystroke entry would be at the mercy of a page's own
        // input handling and could leave something else behind.
        await target.fill(action.value ?? '', { timeout: timeoutMs });
        break;
    }
  } catch (error) {
    const reason = mapToAutomationFailure(error);
    if (reason === null) throw error;
    return report(reason);
  }

  // Only a click can navigate, and a click that navigates must report the page it arrived
  // at rather than the one it left.
  if (action.type === 'click') {
    try {
      await settle(handle, timeoutMs);
    } catch {
      return report('navigation_error');
    }
  }

  return report();
};
