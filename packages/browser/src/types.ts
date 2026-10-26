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
  act(page: PageHandle, action: Action, ctx: CaptureContext): Promise<ActResult>;
  close(page: PageHandle): Promise<void>;
}
