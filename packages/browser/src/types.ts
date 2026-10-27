/**
 * The browser module's published shapes.
 *
 * Nine tickets of the browser-driving step are written against the names below, so this
 * file is the step's contract: a seam fills a body, never a signature. The shapes are the
 * ones #41 publishes, spelt as it spells them — **mutable**, so that a ticket filling a
 * seam can build a `Capture` up, push to its `elements` and hand the array to anything
 * expecting a `CaptureElement[]`. Only the inputs this module declares itself are
 * `readonly`.
 *
 * The artifact types these feed — `run.json`'s `screenshots` and `aois` — stay declared in
 * `@personavision/contract`; nothing here restates an artifact field name.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import type { ActOptions } from './act.js';

/** A variant under test: its id in the run artifact, and the URL a session opens. */
export interface Variant {
  id: string;
  url: string;
}

/** A viewport in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** A device to emulate: `docs/FLOW.md` section 1's mobile/desktop split, made concrete. */
export interface Device {
  name: string;
  viewport: Viewport;
  deviceScaleFactor: number;
  touch: boolean;
}

/**
 * A page's measurements in CSS pixels. `foldY` is the viewport's bottom edge in page space
 * at scroll 0 — the line every screenshot in this project is drawn with
 * (`docs/FLOW.md` section 8) — and an element is below the fold when `y >= foldY`.
 */
export interface Geometry {
  viewport: Viewport;
  pageHeight: number;
  foldY: number;
}

/** A page-space box: the origin is the document's, not the viewport's. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One candidate element of a captured screen. `id` is stable across sessions on the same
 * variant and step (`stableElementId`), so area-of-interest metrics aggregate across seeds.
 */
export interface CaptureElement {
  id: string;
  source: 'dom' | 'a11y';
  role: string | null;
  name: string | null;
  text: string | null;
  bbox: Box;
  isPrimaryAction: boolean;
  belowFold: boolean;
  selector: string;
  /**
   * The name the page gives this region of itself — its `data-aoi` — or `null` on an
   * element that declares none.
   *
   * It is not part of `id`, which stays a function of the markup alone (`stable-id.ts`):
   * an element id has to exist for every candidate on every page, including the ones
   * nobody instrumented. This is the other thing — a site that has been prepared for
   * eye tracking naming its own areas of interest, the way a Tobii study names them
   * before it runs — and the attention engine prefers it when minting an area's id, so
   * that one control has one id at both viewports (`aoiId`). A page that declares nothing
   * is read exactly as before, which is why this is optional: a capture replayed from a
   * file written before #78 carries no region at all, and must still parse.
   */
  region?: string | null;
}

/**
 * One captured screen: what the attention engine looks at and what `run.json` records.
 * `screenshot` is the run-directory-relative path the image was written to, or `null` when
 * none was written; `step` is `null` when the page matches no step of the task.
 */
export interface Capture {
  variant: string;
  step: string | null;
  screenshot: string | null;
  viewport: Viewport;
  pageHeight: number;
  foldY: number;
  elements: CaptureElement[];
  contentHash: string;
}

/**
 * One thing to do to a page. It targets either an `elementId` from a capture — what the
 * swarm uses — or a raw `selector`, which this step's own tests use; `act` resolves
 * whichever is given.
 */
export interface Action {
  type: 'click' | 'scroll' | 'type' | 'back';
  elementId?: string;
  selector?: string;
  value?: string;
  deltaY?: number;
}

/**
 * Every way our own browsing can break. A failure of ours is never attributed to the
 * product: it surfaces as `outcome.status: "automation_failure"` with
 * `attribution: "automation"` and `excludedFromScores: true`, the three fields
 * `@personavision/contract`'s session schema declares. `docs/FLOW.md` section 8 is why
 * they are separate: *abandoned*, *failed* and *automation failure* are never merged.
 */
export type AutomationFailureReason =
  'selector_not_found' | 'timeout' | 'navigation_error' | 'frame_error';

/** What an action did, and what the page became. */
export interface ActResult {
  ok: boolean;
  action: Action;
  url: string;
  scrollY: number;
  step: string | null;
  failure?: AutomationFailureReason;
}

/** One step of a task: how it is recognised, and the control that advances it. */
export interface TaskStep {
  id: string;
  label: string;
  match: { urlPattern: string; requiredSelector: string };
  primaryAction: { selector: string };
  /**
   * What the person is trying to do *on this screen*, in their own words — "Go to
   * checkout", not the whole errand. Omitted, the screen inherits the task's `prompt`.
   *
   * A task prompt is what somebody was sent to do; it is not what they are thinking at
   * each screen of doing it. Handing the whole sentence to every screen is what the swarm
   * did before #78, and it makes the simulation unable to recognise a conventional
   * next-step control: "Buy the hiking boots and pay with the saved card" shares no word
   * with "Checkout", so the lexical attention and decision layers rank the page's copy
   * above the button beside it and no session ever reaches the review step. A step goal
   * is the smallest thing that fixes that, and it is a claim about the *errand* rather
   * than about the page: it names no selector and no element, so a control the gaze never
   * landed on is still invisible to the agent — which is how the planted below-the-fold
   * defect is still discovered rather than assumed.
   */
  goal?: string;
}

/**
 * A task declares its steps; nothing is inferred from page text. A step matches on a URL
 * pattern **and** a required element, and its primary action is the control that advances
 * it.
 */
export interface TaskDefinition {
  id: string;
  prompt: string;
  steps: TaskStep[];
}

/** Everything a capture needs to know that the page cannot tell it. */
export interface CaptureContext {
  variant: string;
  device: Device;
  task: TaskDefinition;
  runDir: string;
}

/**
 * An open session: the Chromium objects it owns, plus the variant and device it was opened
 * with, so that what a page reports can be checked against what was asked for.
 *
 * The Playwright objects are on the handle rather than behind an adapter because this
 * step's page-operating seams — extraction, screenshots, step detection, actions — each
 * need the real page. A source that replays captures from disk
 * (`createFixtureSource`) satisfies the shape over a blank page; see
 * `docs/adr/0002-capture-source-and-the-segmentation-hand-off.md`.
 */
export interface PageHandle {
  readonly variant: Variant;
  readonly device: Device;
  /** What `openSession` was asked for, which a page cannot be asked after the fact. */
  readonly headless: boolean;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
}

/**
 * Where captures come from: Chromium over a URL (`createLiveSource`) or a run directory on
 * disk (`createFixtureSource`). The engine, the swarm and the tests are written against
 * this interface and not against either implementation.
 */
export interface CaptureSource {
  openSession(variant: Variant, device: Device): Promise<PageHandle>;
  capture(page: PageHandle, ctx: CaptureContext): Promise<Capture>;
  /**
   * `options` is the fourth parameter `act.ts` left to the ticket that fills the walk: it
   * carries the capture an `elementId` was chosen against, so that an action lands on the
   * element a decision layer chose rather than on whatever carries that id once the page has
   * been read again. It is optional, so an implementation written against the three
   * parameters above still satisfies this.
   */
  act(
    page: PageHandle,
    action: Action,
    ctx: CaptureContext,
    options?: ActOptions,
  ): Promise<ActResult>;
  close(page: PageHandle): Promise<void>;
}
