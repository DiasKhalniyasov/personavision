/**
 * The browser module's published shapes.
 *
 * Nine tickets of the browser-driving step are written against the names below, so this
 * file is the step's contract: a seam fills a body, never a signature. The artifact types
 * these feed — `run.json`'s `screenshots` and `aois` — stay declared in
 * `@personavision/contract`; nothing here restates an artifact field name.
 */

import type { Browser, BrowserContext, Page } from 'playwright';

/** A device to emulate: `docs/FLOW.md` section 1's mobile/desktop split, made concrete. */
export interface Device {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly touch: boolean;
}

/**
 * A page's measurements in CSS pixels. `foldY` is the viewport's bottom edge in page space
 * at scroll 0 — the line every screenshot in this project is drawn with
 * (`docs/FLOW.md` section 8) — and an element is below the fold when `y >= foldY`.
 */
export interface Geometry {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pageHeight: number;
  readonly foldY: number;
}

/** A page-space box: the origin is the document's, not the viewport's. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One candidate element of a captured screen. `id` is stable across sessions on the same
 * variant and step (`stableElementId`), so area-of-interest metrics aggregate across seeds.
 */
export interface CaptureElement {
  readonly id: string;
  readonly source: 'dom' | 'a11y';
  readonly role: string | null;
  readonly name: string | null;
  readonly text: string | null;
  readonly bbox: Box;
  readonly isPrimaryAction: boolean;
  readonly belowFold: boolean;
  readonly selector: string;
}

/**
 * One captured screen: what the attention engine looks at and what `run.json` records.
 * `screenshot` is the run-directory-relative path the image was written to, or `null` when
 * none was written; `step` is `null` when the page matches no step of the task.
 */
export interface Capture {
  readonly variant: string;
  readonly step: string | null;
  readonly screenshot: string | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pageHeight: number;
  readonly foldY: number;
  readonly elements: readonly CaptureElement[];
  readonly contentHash: string;
}

/**
 * One thing to do to a page. It targets either an `elementId` from a capture — what the
 * swarm uses — or a raw `selector`, which this step's own tests use; `act` resolves
 * whichever is given.
 */
export interface Action {
  readonly type: 'click' | 'scroll' | 'type' | 'back';
  readonly elementId?: string;
  readonly selector?: string;
  readonly value?: string;
  readonly deltaY?: number;
}

/**
 * Every way our own browsing can break. A failure of ours is never attributed to the
 * product: it surfaces as `outcome.status: "automation_failure"` with
 * `attribution: "automation"` and `excludedFromScores: true` (`docs/FLOW.md` section 8).
 */
export type AutomationFailureReason =
  'selector_not_found' | 'timeout' | 'navigation_error' | 'frame_error';

/** What an action did, and what the page became. */
export interface ActResult {
  readonly ok: boolean;
  readonly action: Action;
  readonly url: string;
  readonly scrollY: number;
  readonly step: string | null;
  readonly failure?: AutomationFailureReason;
}

/**
 * A task declares its steps; nothing is inferred from page text. A step matches on a URL
 * pattern **and** a required element, and its primary action is the control that advances
 * it.
 */
export interface TaskDefinition {
  readonly id: string;
  readonly prompt: string;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly match: { readonly urlPattern: string; readonly requiredSelector: string };
    readonly primaryAction: { readonly selector: string };
  }[];
}

/** Everything a capture needs to know that the page cannot tell it. */
export interface CaptureContext {
  readonly variant: string;
  readonly device: Device;
  readonly task: TaskDefinition;
  readonly runDir: string;
}

/**
 * An open session: the Chromium objects it owns, plus the variant and device it was opened
 * with, so that what a page reports can be checked against what was asked for.
 *
 * The Playwright objects are on the handle rather than behind an adapter because six of
 * this step's seams — extraction, screenshots, step detection, actions — are page
 * operations and each needs the real page. A source that replays captures from disk
 * (`createFixtureSource`) satisfies the shape over a blank page; see
 * `docs/adr/0002-capture-source-and-the-segmentation-hand-off.md`.
 */
export interface PageHandle {
  readonly variant: { readonly id: string; readonly url: string };
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
  openSession(variant: { id: string; url: string }, device: Device): Promise<PageHandle>;
  capture(page: PageHandle, ctx: CaptureContext): Promise<Capture>;
  act(page: PageHandle, action: Action, ctx: CaptureContext): Promise<ActResult>;
  close(page: PageHandle): Promise<void>;
}
