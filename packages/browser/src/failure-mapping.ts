/**
 * A thrown error, read as one of our four automation failures.
 *
 * `selector_not_found`, `timeout`, `navigation_error` and `frame_error` are the whole
 * vocabulary — the four #6 fixes for this step. An error this cannot place is **not** ours to
 * classify: it returns `null` and the caller rethrows, because a mystery recorded as a
 * timeout is worse than a mystery that reaches a stack trace.
 *
 * Reading is done off the error's own text because that is all a driver gets: Chromium's
 * driver raises a `TimeoutError` for a selector that never resolved and for a navigation
 * that never completed alike, and what tells them apart is the call that raised it and the
 * call log underneath. The shapes matched below are the ones `test/failures.test.ts` reads
 * out of a real browser against the fixture site, so a Playwright release that rewords them
 * fails that suite rather than silently turning our breakage into the product's.
 *
 * Two failures of ours are never thrown at all, and have an entry point each:
 *
 * - a navigation that **completed on a status a session cannot be driven on** —
 *   `/boom`'s 500 (`navigationFailure`);
 * - a **subframe whose own document never arrived**, which the page reports as a failed
 *   request and no call raises (`frameFailure`, `watchFrameFailures`).
 *
 * Whatever the reason, `toAutomationFailureOutcome` is the only outcome this file can
 * produce: `attribution: "automation"`, `excludedFromScores: true`. There is no path here to
 * an outcome the product is blamed for — `docs/FLOW.md` section 8 keeps *abandoned*,
 * *failed* and *automation failure* apart, and this is the third one's end of that promise.
 */

import type { Request } from 'playwright';
import { AutomationFailure } from './errors.js';
import type { AutomationFailureReason, PageHandle } from './types.js';

export type MapToAutomationFailure = (error: unknown) => AutomationFailureReason | null;

/** A classified error, wrapped with a reason naming what was being attempted. */
export type ToAutomationFailure = (error: unknown, attempting: string) => AutomationFailure | null;

/**
 * What a navigation answered with — `page.goto`'s response, read structurally so that
 * judging a navigation needs no browser.
 */
export interface NavigationResponse {
  url(): string;
  status(): number;
}

/** A request that failed inside one of the page's frames. */
export interface FailedFrameRequest {
  readonly url: string;
  /** Chromium's own text, e.g. `net::ERR_NAME_NOT_RESOLVED`. Empty when it reported none. */
  readonly errorText: string;
}

/** Frame failures as they arrive, for as long as the watch is open. */
export interface FrameFailureWatch {
  /** Every frame failure seen so far, in the order the page reported them. */
  seen(): readonly AutomationFailure[];
  /** Stops listening. Stopping twice is not an error. */
  stop(): void;
}

/**
 * The session outcome a failure of ours produces: the five fields
 * `@personavision/contract`'s session schema declares for `outcome`, with the three that are
 * not negotiable fixed as literals so that no caller can widen them.
 */
export interface AutomationFailureOutcome {
  readonly status: 'automation_failure';
  readonly step: string;
  readonly reason: string;
  readonly attribution: 'automation';
  readonly excludedFromScores: true;
}

/**
 * The step recorded when a session broke before it reached one. The contract requires a step
 * on every outcome, and a session that never arrived anywhere still has to say so.
 */
export const UNKNOWN_STEP = 'unknown';

/** Colour codes travel in a driver's call log, and would break every match below. */
const ANSI = /\u001b\[\d+m/g;

/** `locator.waitFor`, `page.goto`, `frame.waitForLoadState`: the call that raised the error. */
const CALL = /^([a-z][A-Za-z]*)\.([A-Za-z]+):/;

/** A driver timeout, whether or not the error is named `TimeoutError`. */
const TIMEOUT = /Timeout (\d+)ms exceeded/;

/** What the call log says it was waiting for: a locator expression, or an older selector. */
const WAITING = /waiting for ((?:locator\(|selector ).+?)(?: to be [a-z ]+)?$/m;

/** A lone locator, which reads better as the selector it holds than as the call. */
const LONE_LOCATOR = /^locator\((['"`])([^'"`]*)\1\)$/;

/**
 * The call log line a locator writes **once it has found its element**. An operation that
 * timed out after this is the operation timing out — a click on a covered button, a wait for
 * a state the element never reached — and recording it as a selector that never existed
 * would both read falsely and inflate the artifact's `selectorFailures`.
 */
const LOCATOR_RESOLVED = /locator resolved to/;

/** Chromium's network error codes, which are what a navigation failure really says. */
const NET_ERROR = /net::[A-Z_]+/;

/**
 * A request Chromium gave up on rather than failed: a frame taken out of the DOM, or one
 * still in flight when the page navigated away or closed. It happens on healthy pages, so a
 * frame watch that counted it would exclude sessions where nothing of ours broke.
 */
const ABORTED = /net::ERR_ABORTED/;

/** A frame that went away under an operation, which Chromium reports in words. */
const DETACHED_FRAME = /frames? (?:was|got) detached/i;

/** A navigation replaced before it finished — including by Chromium's own error page. */
const INTERRUPTED = /is interrupted by another navigation/i;

/** The lowest HTTP status a session cannot be driven on: a page that is an error, not a page. */
const FIRST_ERROR_STATUS = 400;

/** The error, if it is one. Anything else is not ours to read, let alone to classify. */
const asError = (error: unknown): Error | null => (error instanceof Error ? error : null);

/** An error's message, with the driver's colour codes taken out. */
const readMessage = (error: Error): string => error.message.replace(ANSI, '');

/** The object the failing call was made on: `page`, `locator`, `frame`. */
const readCallObject = (message: string): string | null => CALL.exec(message)?.[1] ?? null;

/** The selector, or the locator expression, the call log names. */
const readSelector = (message: string): string | null => {
  const waiting = WAITING.exec(message);
  if (waiting === null) return null;
  const expression = waiting[1].trim();
  return LONE_LOCATOR.exec(expression)?.[2] ?? expression;
};

export const mapToAutomationFailure: MapToAutomationFailure = (error) => {
  // A failure of ours handed back to us keeps the reason it already carries, so that a
  // caller may re-read anything it caught without a reason changing under it.
  if (error instanceof AutomationFailure) return error.reason;

  const raised = asError(error);
  if (raised === null) return null;
  const message = readMessage(raised);

  // A frame's own call is a frame failure whatever broke it: a page whose frame never
  // arrives is not a page that timed out, and the swarm's integrity counters say so.
  if (readCallObject(message) === 'frame' || DETACHED_FRAME.test(message)) return 'frame_error';

  if (raised.name === 'TimeoutError' || TIMEOUT.test(message)) {
    // A locator that found its element and then ran out of time is the operation timing
    // out, not a selector that never resolved.
    if (LOCATOR_RESOLVED.test(message)) return 'timeout';
    const waitedOnSelector =
      readSelector(message) !== null || readCallObject(message) === 'locator';
    return waitedOnSelector ? 'selector_not_found' : 'timeout';
  }

  if (NET_ERROR.test(message) || INTERRUPTED.test(message)) return 'navigation_error';

  return null;
};

/** ` after 300ms`, when the driver said how long it waited. */
const readWaited = (message: string): string => {
  const timeout = TIMEOUT.exec(message);
  return timeout === null ? '' : ` after ${timeout[1]}ms`;
};

/** ` (net::ERR_CONNECTION_REFUSED)`, when Chromium named a network error. */
const readNetError = (message: string): string => {
  const net = NET_ERROR.exec(message);
  return net === null ? '' : ` (${net[0]})`;
};

/** What broke, in words, for the one field a person reads. */
const describeFailure = (reason: AutomationFailureReason, message: string): string => {
  switch (reason) {
    case 'selector_not_found': {
      const selector = readSelector(message);
      const named = selector === null ? 'the selector' : `the selector ${selector}`;
      return `${named} never resolved${readWaited(message)}`;
    }
    case 'timeout':
      return `the operation timed out${readWaited(message)}`;
    case 'navigation_error':
      return `the navigation failed${readNetError(message)}`;
    case 'frame_error':
      return `a frame of the page never loaded${readNetError(message)}`;
  }
};

/**
 * The classified error, with a reason naming **what was being attempted** and what the
 * driver said about it: `waiting for the cart checkout link: the selector #cart-checkout
 * never resolved after 500ms`. The original error travels as the `cause`, so a stack trace
 * is never lost to a tidy sentence.
 */
export const toAutomationFailure: ToAutomationFailure = (error, attempting) => {
  const reason = mapToAutomationFailure(error);
  if (reason === null) return null;
  if (error instanceof AutomationFailure) return error;

  const raised = asError(error);
  const message = raised === null ? '' : readMessage(raised);
  return new AutomationFailure(reason, `${attempting}: ${describeFailure(reason, message)}`, {
    cause: error,
  });
};

/**
 * A navigation that completed on a status a session cannot be driven on. Nothing is thrown
 * for one of these — the fixture site's `/boom` answers 500 and the page loads — so the
 * response is what has to be read.
 *
 * A navigation that produced no response at all (`null`, which `page.goto` returns for a
 * same-document navigation) is not judged here: there is nothing to read, and a navigation
 * that truly failed threw and is `mapToAutomationFailure`'s.
 */
export const navigationFailure = (
  response: NavigationResponse | null,
  attempting: string,
): AutomationFailure | null => {
  if (response === null) return null;
  const status = response.status();
  if (status < FIRST_ERROR_STATUS) return null;

  return new AutomationFailure(
    'navigation_error',
    `${attempting}: ${response.url()} answered ${status}, which is not a page a session can be driven on`,
  );
};

/** A frame whose own document never arrived. Always ours, and always a frame failure. */
export const frameFailure = (
  request: FailedFrameRequest,
  attempting: string,
): AutomationFailure => {
  const said = request.errorText === '' ? '' : ` (${request.errorText})`;
  return new AutomationFailure(
    'frame_error',
    `${attempting}: the frame at ${request.url} never loaded${said}`,
  );
};

/**
 * Watches an open page for the frame failures nothing throws.
 *
 * Only a **subframe's own document** counts, and only when Chromium failed it rather than
 * aborted it. A failed subresource is not a frame failure, and a failed request in the main
 * frame is the page's navigation — which `page.goto` throws for, and which is a
 * `navigation_error` rather than ours to invent here. A frame that *answers* 4xx or 5xx
 * fails no request at all, so it is not seen here either: that is the status-reading case,
 * and a caller that needs it judged reads the frame's own response with `navigationFailure`.
 *
 * A watch reports what happens while it is open, so it is attached before the navigation
 * whose frames it is meant to judge. The one navigation it cannot have watched is the one
 * `openSession` makes as it launches: a caller that needs the opening page's frames judged
 * has to attach the watch inside the session source.
 */
export const watchFrameFailures = (handle: PageHandle, attempting: string): FrameFailureWatch => {
  const seen: AutomationFailure[] = [];

  const onRequestFailed = (request: Request): void => {
    if (!request.isNavigationRequest()) return;
    // A request whose frame has already gone is one we cannot place; `frame()` throws for it.
    try {
      if (request.frame() === handle.page.mainFrame()) return;
    } catch {
      return;
    }
    const errorText = request.failure()?.errorText ?? '';
    // An abort is not a failure: it is what a frame taken out of the DOM, or one in flight
    // when the page moved on, looks like. Counting it would exclude good sessions.
    if (ABORTED.test(errorText)) return;

    seen.push(frameFailure({ url: request.url(), errorText }, attempting));
  };

  handle.page.on('requestfailed', onRequestFailed);

  return {
    seen: () => [...seen],
    stop: () => handle.page.off('requestfailed', onRequestFailed),
  };
};

/**
 * The session outcome a failure of ours produces, as `@personavision/contract` declares it.
 *
 * There is **one** outcome shape here and it is always ours: the status is
 * `automation_failure`, the attribution is `automation`, and the session is excluded from
 * the scores. A step the session never reached is recorded as `UNKNOWN_STEP` rather than
 * left blank, because the contract requires a step and a blank one would not parse.
 */
export const toAutomationFailureOutcome = (
  failure: AutomationFailure,
  step: string | null,
): AutomationFailureOutcome => ({
  status: 'automation_failure',
  step: step === null || step.trim() === '' ? UNKNOWN_STEP : step,
  reason: failure.message,
  attribution: 'automation',
  excludedFromScores: true,
});
