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
import type { SessionRecording, VideoRequest } from './video.js';

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
 * Where the browser says it is, coarse: a region's largest city, never a person's own
 * address. The field names are `browser.newContext`'s own `geolocation`.
 */
export interface BrowsingLocation {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Where and how a session browses: the locale, the time zone and the location a context is
 * opened with, carried beside the device because they are the same kind of fact about the
 * same person.
 *
 * A site that geolocates its visitors serves whatever country the machine sits in unless the
 * browser is told otherwise, and every session of the IKEA test was redirected to the Arabic
 * store of the United Arab Emirates while the audience was UK and US shoppers (#421). A
 * session therefore browses in its persona's region, and this is what carries that down to
 * `browser.newContext`.
 *
 * The three names are **Playwright's**, not an artifact's: `locale`, `timezoneId` and
 * `geolocation` are what a context is opened with. What a *region* becomes — which region
 * subtag, which time zone, which city — is `@personavision/personas`' one table to say, and
 * nothing in this package reads a region name. The artifact's own `browser` block happens to
 * spell these three the same way, which is what lets one object be both what a context was
 * opened with and what the session records.
 *
 * Every field is optional **and** nullable, and the two mean the same thing here: a setting
 * nobody named is a setting the context is not opened with. A session opened with none of
 * them behaves exactly as it does today — the host's own locale and time zone, and no
 * geolocation permission.
 *
 * **No `Accept-Language` header is set by hand.** `locale` is what sets both
 * `navigator.language` and the `Accept-Language` request header, and two spellings of one
 * fact would drift: a context opened as `en-GB` asks the site for `en-GB` pages, which is
 * the header the real site read.
 */
export interface Browsing {
  /** A BCP-47 locale: `en-GB`. */
  readonly locale?: string | null;
  /** An IANA time zone: `Europe/London`. */
  readonly timezoneId?: string | null;
  /**
   * Where the browser reports being. A context given one is also granted the `geolocation`
   * permission, because a site that asks for the position has to be answered rather than
   * left waiting on a prompt nobody can click.
   */
  readonly geolocation?: BrowsingLocation | null;
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
  /**
   * The address the screen was captured at, read out of the page itself.
   *
   * A capture used to record a page's elements and not its location, and the walk above it
   * carried an address along from the last action instead — so a navigation nobody acted on
   * was never seen at all, and a `pushState` that committed after a click's promise settled
   * left every screen after it reading the address of the page the click left (#441). A
   * screen that knows where it was is what a URL success criterion is read against, and what
   * a session records so that a reader of a finished run can say which page a screen was on.
   *
   * It is **not** part of the cache key (`captureCacheKey`): an address is not what makes two
   * screens the same page to cache, so a cache hit is answered with this visit's address
   * rather than with the cached visit's.
   *
   * Optional, because a source may not know it: the shape is the one #41 published and every
   * capture built before this revision carries none, so a reader falls back rather than
   * claiming the variant's URL. Both sources that ship fill it — Chromium reads it through
   * `readSessionState`, and a replay resolves the recorded path against the variant the
   * session was opened on.
   */
  url?: string;
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
  /**
   * The control that advances the step, by selector.
   *
   * **A step that declares none is a step that is a whole page.** A test of one URL has no
   * designed primary action: the step stands for the site, nobody named a control on it,
   * and `resolvePrimaryAction` therefore probes nothing and marks nothing — every element
   * of such a screen comes back with `isPrimaryAction: false`, which is the honest
   * statement and the same thing a page on no step already gets (#418).
   *
   * `optional` is the other case and not this one: it is a **declared** control that some
   * pages of its step do not render, and such a page carries no primary action rather than
   * failing the session — for a step that spans pages the task does not control.
   */
  primaryAction?: { selector: string; optional?: boolean };
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
  /**
   * What has to be **observable in the page** for an attempt to count as a success, where
   * the run was given a goal: a visible element, a URL, a piece of text (`docs/FLOW.md`
   * section 12). It is the goal's own `successCriterion`, carried onto the task so that the
   * task a session is run with says where the task ends.
   *
   * Nothing in this package reads it — a step is recognised by its URL pattern and its
   * required element, and that is all this package does — but it travels with the task
   * through the swarm and across the runner seam, which is where a session's outcome is
   * decided from it (`@personavision/swarm`, #400).
   *
   * Optional: a run with no goal declares none, and its sessions are decided by reaching
   * the task's last declared step.
   */
  successCriterion?: string;
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
  /**
   * The session's recording, when it was opened with one (`OpenSessionOptions.video`).
   *
   * **Optional, and absent on every session nobody asked to record** — a capture source that
   * replays a run directory from disk opens no browser to record. A recording that could not
   * be *started* is present and reports why at `finish()`, because a stated absence with its
   * reason is what the artifact carries; there is nothing here to tell the two apart, and
   * nothing should: a consumer marks its screens and actions and finishes the recording, and
   * what comes back is either a file or the words for why there is none.
   */
  readonly video?: SessionRecording;
}

/** What one session is opened with, by the caller that knows which session it is. */
export interface SessionRequest {
  /**
   * Record this session into the run directory, as `videos/S-NN.webm`.
   *
   * A request names the session the file belongs to, so it is made per session rather than
   * per source: one source drives every session of a run, and one file cannot be two
   * sessions. A source that opens no browser — a run directory replayed from disk — has
   * nothing to record and ignores it, which is what leaves a fixture-mode session with no
   * video at all rather than with an absence it would have to explain.
   */
  readonly video?: VideoRequest;
  /**
   * Where and how **this** session browses (`Browsing`).
   *
   * Per session for the same reason the recording is: one source drives every session of a
   * run, and the people of one audience are drawn different regions — a swarm of UK and US
   * shoppers is half `en-GB` in `Europe/London` and half `en-US` in `America/New_York`. A
   * source that opens no browser ignores it, exactly as it ignores the recording.
   *
   * Omitted, the session is opened with the source's own settings where it has any, and
   * otherwise with none at all — which is a session that behaves exactly as it does today.
   */
  readonly browsing?: Browsing;
}

/**
 * Where captures come from: Chromium over a URL (`createLiveSource`) or a run directory on
 * disk (`createFixtureSource`). The engine, the swarm and the tests are written against
 * this interface and not against either implementation.
 */
export interface CaptureSource {
  /**
   * `session` is what this one session is opened with, and the recording it asks for is the
   * only thing in it. It is optional, so an implementation written against the two
   * parameters before it still satisfies this.
   */
  openSession(variant: Variant, device: Device, session?: SessionRequest): Promise<PageHandle>;
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
