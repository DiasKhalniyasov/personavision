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
 *    matches that selector, more than one does, or nothing on the page can be seen under it
 *    — is `selector_not_found`. The page is untouched, so it is left usable for the next
 *    action. Resolution is **not** passed through `mapToAutomationFailure`, even though that
 *    reads a driver's errors well: a control that is in the DOM and invisible leaves a call
 *    log saying the locator resolved, which that reading calls a `timeout` — and a control
 *    nobody could have acted on is a target this step cannot resolve, not an operation that
 *    ran out of time. `frame_error` therefore has no producer here.
 * 2. A navigation that never completes after a click, or a back that leaves the page where
 *    it was or off the product entirely, is `navigation_error`.
 * 3. Anything thrown while the action itself runs is handed to `mapToAutomationFailure`,
 *    and rethrown when it cannot be placed. Reading a timeout out of an error is that
 *    module's job; retrying, capping and counting is the budget's. This file invents neither.
 *    One error is read before it gets there: a **click's target going with the navigation the
 *    click caused**, which is an action that worked and not a failure at all. The words stay
 *    `failure-mapping.ts`'s to recognise; what this file adds is the half only it can answer
 *    — where the page ended up, against the address the click started from (#442).
 *
 * It does not retry. One action is one attempt, and the policy above it is #50's.
 *
 * **Timeouts.** `ActOptions.timeoutMs` bounds the waits this module owns — resolving a
 * target, performing the action, hearing back from the page. The navigations it starts are
 * left on the session's own navigation timeout, the one `openSession` was asked for: an
 * action must not quietly shorten what a caller allowed a slow product.
 */

/// <reference lib="dom" />
// The callback below runs inside the page, not in Node: this module needs the DOM types,
// and the reference travels with the file (see `geometry.ts`).
import { AutomationFailure } from './errors.js';
import { extractElements } from './extract/elements.js';
import { isLostTarget, mapToAutomationFailure } from './failure-mapping.js';
import { readGeometry } from './geometry.js';
import { readSessionState } from './session.js';
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
 * How long each wait this module owns may take. Long enough that a control still arriving
 * on a real page is waited for, short enough that a page which will not answer is reached
 * by a session's cap rather than by nothing at all.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ActOptions {
  /**
   * How long resolving the target, performing the action and hearing back from the page may
   * each take. Defaults to 10 000. Navigations keep the session's own navigation timeout.
   */
  readonly timeoutMs?: number;
  /**
   * The capture the action was decided against: where an `elementId` is looked up.
   *
   * Passing it spares a second reading of the page and guarantees the action lands on the
   * element that was chosen rather than on whatever carries that id now. Without it, the
   * page is read again to resolve the id.
   *
   * `CaptureSource.act` is declared with three parameters in `types.ts`, so a caller that
   * reaches this module through that interface — the walk, and the swarm above it — cannot
   * pass one yet, and pays the second reading. Widening that interface is a change to the
   * shapes #41 published and nine tickets are written against, so it belongs to the ticket
   * that fills the walk, not here.
   */
  readonly screen?: { readonly elements: readonly CaptureElement[] };
}

export type Act = (
  page: PageHandle,
  action: Action,
  ctx: CaptureContext,
  options?: ActOptions,
) => Promise<ActResult>;

/** The page a browser is on before it has been sent anywhere: never a page of a product. */
const BLANK_PAGE = 'about:blank';

/**
 * Where the page is: the URL it reports and where it is scrolled to.
 *
 * Read through the session's own reader, so that nothing in this package holds a second
 * opinion about what a position is. Bounded, because `page.evaluate` is not: a page whose
 * main thread never yields again would otherwise hold an action — and a swarm slot — open
 * for ever. A page that will not say where it is has no position to report, and inventing
 * one would put a quiet lie in the artifact, so that is an `AutomationFailure` carrying the
 * reason the session records rather than an `ActResult`.
 */
const readPosition = async (
  handle: PageHandle,
  timeoutMs: number,
): Promise<{ url: string; scrollY: number }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const state = await Promise.race([
      readSessionState(handle),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AutomationFailure('timeout', 'the page did not report where it is')),
          timeoutMs,
        );
      }),
    ]);
    return { url: state.url, scrollY: state.scrollY };
  } finally {
    clearTimeout(timer);
  }
};

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
const settle = async (handle: PageHandle): Promise<void> => {
  await handle.page.waitForLoadState('domcontentloaded');
};

/** How long a click is given to ask for a new document or to move the address, if it does. */
const NAVIGATION_START_MS = 1000;

/**
 * Runs a click and, when it moved the page, waits until the move has committed — so the
 * position the result reports is the one the click reached.
 *
 * **Two ways a page moves, and both are waited for.** A click that asks the main frame for a
 * new document returns once the request is out, and on a slow site the answer takes seconds:
 * a page read in between is read while it unloads, and the reading goes down with it. A click
 * that moves the page **within** one document asks for nothing at all — a framework's link
 * pushes its history entry once the route has resolved, which can be after the click's own
 * promise has settled — so waiting for a request would not see it, and the address read
 * afterwards is the page the click left (#441). `waitForURL(…, { waitUntil: 'commit' })`
 * resolves on a `pushState` as well, which is what makes the second wait the same kind of
 * thing as the first.
 *
 * Both are armed **before** the click and under the one cap, so they are one wait rather than
 * two in a row: a click that goes nowhere costs what it cost when only the request was
 * waited for, and a click that moved the page returns as soon as the move has committed. A
 * document that was asked for and has not arrived within that cap keeps the session's own
 * navigation timeout, as every navigation this module starts does.
 */
const following = async (handle: PageHandle, click: () => Promise<void>): Promise<void> => {
  const { page } = handle;
  const before = page.url();
  const elsewhere = (url: URL): boolean => url.href !== before;
  const asked = page
    .waitForRequest(
      (request) => request.isNavigationRequest() && request.frame() === page.mainFrame(),
      { timeout: NAVIGATION_START_MS },
    )
    .then(
      () => true,
      () => false,
    );
  const moved = page
    .waitForURL(elsewhere, { waitUntil: 'commit', timeout: NAVIGATION_START_MS })
    .then(
      () => true,
      () => false,
    );
  await click();
  // The address having moved is enough on its own, whichever way it moved: the page is
  // already where the click sent it, and there is no document left to wait for.
  if (await moved) return;
  // It has not moved within the cap. If a document was asked for, it is still on its way:
  // that wait is the session's own navigation timeout, as it has always been — a click that
  // worked must not be read while the page it answered with is still unloading.
  if (await asked) {
    await page.waitForURL(elsewhere, { waitUntil: 'commit' }).catch(() => undefined);
  }
};

/**
 * Whether the page's address or document is still the one it was on when this was armed.
 *
 * **Two signals, because either alone misses a case.** The address moves for a `pushState`
 * and for an ordinary link alike, and on a single-page application it is the only thing that
 * moves at all. A **new document** is what a move that does not change the address looks
 * like — the post-redirect-get that lands back where it started — and no reading of the
 * address can see that one.
 *
 * `domcontentloaded` is the second signal rather than `framenavigated`, which fires for a
 * same-document navigation too: an application that calls `replaceState` on mount, on scroll
 * or for its analytics would otherwise set it with the address unchanged, and swallow the
 * discriminator this rule rests on. A parsed document is what "not the document it started
 * on" means.
 *
 * Armed before the action and asked after it, **including after one that threw**: a click
 * that worked can raise its target going with the navigation it caused, and where the page
 * ended up is part of what tells that from a click that broke and went nowhere. It is armed
 * beside `following`'s own waits and reads the same address they do.
 *
 * **Asking waits**, under the cap a click's move is already given. At the instant a destroyed
 * context is raised the move is not visible yet — the error *is* the context going away, and
 * the navigation that destroyed it reaches the driver a moment later — so a reading taken at
 * once reports the page the click left. A move already seen is answered without waiting, and
 * a page that is going nowhere spends the cap once, on an action that has failed anyway.
 */
interface PageMovement {
  /** Whether the page's address or document is not the one it was, waited for. */
  moved(): Promise<boolean>;
  /** Stops listening. Stopping twice is not an error. */
  stop(): void;
}

const watchMovement = (handle: PageHandle): PageMovement => {
  const { page } = handle;
  const from = page.url();
  let parsedAnother = false;
  const onLoaded = (): void => {
    parsedAnother = true;
  };
  page.on('domcontentloaded', onLoaded);
  const seen = (): boolean => parsedAnother || page.url() !== from;

  return {
    moved: async () => {
      if (seen()) return true;
      // Both settled, so neither rejection is left for the process to complain about, and
      // both on the one cap, so the pair is one wait rather than two in a row.
      const changed = page
        .waitForURL((url) => url.href !== from, {
          waitUntil: 'commit',
          timeout: NAVIGATION_START_MS,
        })
        .then(
          () => true,
          () => false,
        );
      const loaded = page.waitForEvent('domcontentloaded', { timeout: NAVIGATION_START_MS }).then(
        () => true,
        () => false,
      );
      await Promise.race([changed, loaded]);
      return seen();
    },
    stop: () => page.off('domcontentloaded', onLoaded),
  };
};

/** A tap at a position, landing as a person's does: on whatever is on top there. */
const tapAt = (handle: PageHandle, x: number, y: number): Promise<void> =>
  following(handle, () => handle.page.mouse.click(x, y));

/**
 * Puts the page back where it was after a back navigation that went nowhere a session can
 * act on.
 *
 * Going back off the first page of a task lands on the blank page the session started from,
 * and leaving a swarm staring at `about:blank` would make its next action fail for a reason
 * that has nothing to do with the product. Going forward again is the exact inverse, so the
 * history the session still has is the history it had; re-opening the URL is the fallback.
 *
 * Neither is allowed to throw. The caller is already on its way to reporting a
 * `navigation_error`, and a restore that cannot land must not replace that typed answer
 * with an exception — the position the result carries is read after this, so it says where
 * the page actually ended up.
 */
const restore = async (handle: PageHandle, url: string): Promise<void> => {
  if (handle.page.url() === url) return;
  await handle.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => null);
  if (handle.page.url() === url) return;
  await handle.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
};

/** Whether the action names an element at all. */
const isTargeted = (action: Action): boolean =>
  action.elementId !== undefined || action.selector !== undefined;

/**
 * The elements of the screen as it is now, for an action whose caller did not hand its
 * capture over. This is the extractor's own reading of the page, so an id minted by a
 * capture resolves here to the same element.
 *
 * Not `capture()`: that composition writes a screenshot and is cached and budgeted as one
 * unit, and resolving a target must not put an image in the run directory. It is also why
 * this reading is neither cached nor budgeted — the budget belongs to the caller, which
 * holds it for the whole session, and a caller that hands its capture over never gets here.
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
    // Independent readings of the same page: one round trip, not two in a row.
    const [{ url, scrollY }, step] = await Promise.all([
      readPosition(handle, timeoutMs),
      detectStep(handle, ctx.task),
    ]);
    return failure === undefined
      ? { ok: true, action, url, scrollY, step }
      : { ok: false, action, url, scrollY, step, failure };
  };

  /**
   * The page a click landed on, waited for and then read.
   *
   * Only a click can navigate, and a click that navigates must report the page it arrived at
   * rather than the one it left. A document that was asked for and never parsed is the
   * navigation error it has always been.
   */
  const landed = async (): Promise<ActResult> => {
    try {
      await settle(handle);
    } catch {
      return report('navigation_error');
    }
    return report();
  };

  /**
   * A tap where a person would put it, for a control that will not take Playwright's click:
   * where the control is now, or, when it is not there any more, where the screenshot showed
   * it. False when the action is no click or there is nowhere to tap.
   */
  const tapWhereSeen = async (
    now: { x: number; y: number; width: number; height: number } | null,
  ): Promise<boolean> => {
    if (action.type !== 'click') return false;
    try {
      if (now !== null) {
        await tapAt(handle, now.x + now.width / 2, now.y + now.height / 2);
        return true;
      }
      const seen = options.screen?.elements.find(
        (element) => element.id === action.elementId,
      )?.bbox;
      if (seen === undefined) return false;
      const { scrollY } = await readPosition(handle, timeoutMs);
      await tapAt(handle, seen.x + seen.width / 2, seen.y + seen.height / 2 - scrollY);
      return true;
    } catch {
      return false;
    }
  };

  // One step back in history, whatever else the action names.
  //
  // Whether it worked is judged by where the page ended up **and** whether the navigation
  // answered, because neither alone is enough. A back off the first page of a task lands on
  // the blank page the session started from — our failure, whatever it answered. A back
  // within one document answers nothing and still worked, so a changed URL is enough. And
  // two adjacent history entries for one URL, which is what a post-redirect-get checkout
  // leaves behind, move the page without changing what it reports — but that back crosses
  // documents and so comes back with a response, which is the signal that separates it from
  // a back that did nothing at all.
  //
  // One case stays ambiguous: two entries for one URL *within* one document, which a
  // `pushState` to the current URL creates. It answers nothing and changes nothing, so it is
  // reported as a failure. Telling it apart needs a `popstate` listener armed before the
  // navigation, and no page of this project's shop or fixture site can produce it.
  if (action.type === 'back') {
    const from = handle.page.url();
    let response;
    try {
      response = await handle.page.goBack({ waitUntil: 'domcontentloaded' });
    } catch {
      return report('navigation_error');
    }
    const landedOn = handle.page.url();
    if (landedOn === BLANK_PAGE || (response === null && landedOn === from)) {
      await restore(handle, from);
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

  /**
   * Whether the element the action was aimed at is no longer on the page.
   *
   * The piece of evidence that is **about the target** rather than about the page, and the
   * one that keeps the rule below from being circular. A destroyed execution context is
   * raised *by* a navigation commit — a `pushState` does not destroy one — so "the page
   * moved" is true of every such error by construction, and pairing the two would turn every
   * destroyed context under a click into a success. What is particular to a click whose
   * target went with the navigation it caused is that the target has gone: an application
   * that redraws the same control, or a redirect that lands on a page carrying it, leaves it
   * there and is the failure it has always been.
   *
   * A count that cannot be taken answers `false`: not being able to look is not evidence
   * that something is absent, and the reading below is the conservative one.
   */
  const targetIsGone = (): Promise<boolean> =>
    target.count().then(
      (found) => found === 0,
      () => false,
    );

  try {
    // Resolution is separated from the action so that the two failures stay apart, and it
    // waits for what all three actions need: an element in the DOM that can be seen. A
    // selector that is unparseable or matches two nodes fails here too, and a control that
    // is present but invisible is not a target a person could have acted on — which is why
    // what this catch answers is decided by where it sits, not by reading the error.
    await target.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    // A page that rebuilt its DOM after the capture, or a carousel that turned the control
    // away, leaves the recorded path pointing at nothing, while the control was where the
    // screenshot shows it: a person taps there, so the tap goes there.
    if (!(await tapWhereSeen(null))) return report('selector_not_found');
    try {
      await settle(handle);
    } catch {
      return report('selector_not_found');
    }
    return report();
  }

  // Where the page was when the action started, for the one failure a click that worked can
  // raise. Only a click can navigate, so only a click arms it.
  const movement = action.type === 'click' ? watchMovement(handle) : null;
  try {
    switch (action.type) {
      case 'click':
        await following(handle, () => target.click({ timeout: timeoutMs }));
        break;
      case 'scroll':
        // The minimum scroll that puts the element on screen; an element already in view
        // moves the page not at all.
        await target.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        break;
      case 'type':
        // `fill` leaves the field holding exactly the value, which is what the agent
        // decided; a keystroke-by-keystroke entry would be at the mercy of a page's own
        // input handling and could leave something else behind. An action carrying no
        // value clears the field — typing nothing into a field is what that means — so a
        // decision layer that drops a value is asking for an empty field, not for this
        // module to guess at one.
        await target.fill(action.value ?? '', { timeout: timeoutMs });
        break;
      default: {
        // A new member of `Action['type']` lands here as a compile error rather than as a
        // reported success for an action that was never performed.
        const unsupported: never = action.type;
        throw new Error(`act: unsupported action ${String(unsupported)}`);
      }
    }
  } catch (error) {
    // A click whose target went with the navigation it caused did what the agent asked. The
    // driver lost the node, or the context its checks were running in, to the very move the
    // click made — and the artifact used to say that the one action of the session which
    // worked had failed, while `ok: false` spent a give-up budget on it (#442). So it is
    // reported as the success it is, with the position it reached.
    //
    // **Three things have to hold**, and each is evidence of its own. The driver has to say
    // the target is gone; the page has to be somewhere else than the click started; and the
    // target has to be absent now. The third is what makes the second mean anything — see
    // `targetIsGone` — and without it a page that moved itself under a click which asked for
    // nothing would be recorded as an action that worked.
    //
    // One case stays ambiguous, as the `back` above has one: a page that navigates itself to
    // a document which does not carry the control, under a click that did nothing. All three
    // hold and no signal here separates it from the real thing. Anything short of all three
    // falls through to the reading below, which is the failure it is today.
    if (
      movement !== null &&
      isLostTarget(error) &&
      (await movement.moved()) &&
      (await targetIsGone())
    ) {
      return await landed();
    }
    const reason = mapToAutomationFailure(error);
    if (reason === null) throw error;
    // A control that never holds still (a playing video, a carousel) or sits under another
    // layer times out Playwright's checks, while a person taps where it is anyway: so the tap
    // goes there, and lands on whatever is on top, as theirs would.
    if (reason !== 'timeout') return report(reason);
    const now = await target.boundingBox({ timeout: timeoutMs }).catch(() => null);
    if (!(await tapWhereSeen(now))) return report(reason);
  } finally {
    movement?.stop();
  }

  return action.type === 'click' ? landed() : report();
};
