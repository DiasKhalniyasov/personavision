import type { Run, Session } from '@personavision/contract';
import type { SessionTimeline, TimelineMoment } from '@/session/index.js';
import type { Capture } from './runWords';

/**
 * The arithmetic behind the replay: where the scrubber is, what the clock reads, where the
 * screenshot sits in the frame, and which gaze marks are drawn over it.
 *
 * It is pure, so the screen is a rendering of these answers and a test can check the
 * answers themselves. The session's own clock — which screen covers a time, which fixation
 * is current, how a step moves — is `src/session/timeline.ts` (#20) and is not re-derived
 * here; what this module adds is the **geometry**, which is the screen's own business: a
 * fixation is recorded in the device pixels of its own screen's viewport, and has to be
 * drawn in a frame of a different size.
 *
 * Every number below comes out of the run artifact. None of them is a visual value, so
 * none of them belongs in `docs/design/tokens.css`: a fixation's position is data.
 */

/** The query parameter the scrubber's position is carried in, as `docs/FLOW.md` section 3 spells it. */
export const FIX_PARAM = 'fix';

/**
 * Which fixation `?fix=` asks for: 1-based, clamped to the fixations this session recorded,
 * and `1` when the parameter is absent or not a number a session could be at.
 *
 * `0` only for a session with no fixations at all, where there is no position to be at.
 * A value out of range is clamped rather than refused: a stale link from a session that has
 * since been re-simulated still opens, at the nearest moment that exists.
 */
export function fixationFromParam(raw: string | null, fixationCount: number): number {
  if (fixationCount <= 0) return 0;
  const asked = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(asked)) return 1;
  return Math.min(Math.max(Math.trunc(asked), 1), fixationCount);
}

/** `m:ss`, floored, as the prototype's clock reads it. A negative time is the start. */
export function timeLabel(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(Math.floor(ms / 1000), 0) : 0;
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}`;
}

/** What `#rp-clock` reads: elapsed against total. */
export function clockLabel(elapsedMs: number, totalMs: number): string {
  return `${timeLabel(elapsedMs)} / ${timeLabel(totalMs)}`;
}

/** What `#rp-fixlabel` reads: which fixation of how many. */
export function fixationLabel(fixationNumber: number, fixationCount: number): string {
  return `fixation ${fixationNumber} of ${fixationCount}`;
}

export interface FrameGeometry {
  /** The frame holds one viewport, so a portrait capture is drawn in the phone frame. */
  readonly portrait: boolean;
  /** The whole captured page's height, as a percentage of the frame's. */
  readonly pageHeightPct: number;
  /** Where the top of the page sits: `0` unscrolled, negative once this screen is scrolled. */
  readonly pageTopPct: number;
  /**
   * Where the first viewport ends, as a percentage down the frame — `null` when this
   * screen is scrolled past it and the marker would be drawn outside the frame.
   */
  readonly foldTopPct: number | null;
}

/**
 * The frame is **one viewport** of the device this was captured on, and the page slides
 * behind it: that is what makes "scrolled to that screen's `scrollY`" a position rather
 * than a picture of a whole page. Everything is expressed as a percentage of the frame, so
 * the image, the fold and the gaze layer stay in register at any rendered size.
 *
 * The fold is the one measurement here that the tokens also carry a figure for
 * (`--frame-fold-mobile: 46%`). That figure places the fold over the prototype's *drawn*
 * page, which is a sketch at no particular scale; over a real screenshot the fold is where
 * the capture says the first viewport ended, which is why it is computed. On a screen
 * nobody scrolled that lands on the frame's bottom edge — which is the truth: everything
 * in view is above the fold — and as the session scrolls, the marker rises through the
 * frame.
 */
export function frameGeometry(capture: Capture, scrollY: number): FrameGeometry {
  const { width, height } = capture.viewport;
  const foldTopPct = ((capture.foldY - scrollY) / height) * 100;
  return {
    portrait: height > width,
    pageHeightPct: (capture.pageHeight / height) * 100,
    pageTopPct: (-scrollY / height) * 100,
    foldTopPct: foldTopPct >= 0 && foldTopPct <= 100 ? foldTopPct : null,
  };
}

/** One fixation, placed in the frame and numbered as the session numbers it. */
export interface GazeMark {
  /** 1-based and continuous across the session: `fixations[].index` plus one. */
  readonly number: number;
  readonly xPct: number;
  readonly yPct: number;
  readonly durationMs: number;
  /** The fixation the scrubber is on, drawn apart from the rest. */
  readonly current: boolean;
}

/** One saccade: the hop between two fixations that are both on screen. */
export interface GazeHop {
  readonly fromNumber: number;
  readonly toNumber: number;
  readonly fromXPct: number;
  readonly fromYPct: number;
  readonly toXPct: number;
  readonly toYPct: number;
}

export interface GazeTrail {
  readonly marks: readonly GazeMark[];
  readonly hops: readonly GazeHop[];
}

/**
 * The gaze over the screen the scrubber is on: every fixation up to the scrubber's position
 * that happened on this screen, and the saccades between them.
 *
 * The numbering is the session's own and so runs continuously across screens — walking onto
 * a new screen does not restart it at 1, because the order of attention is the thing the
 * number tells.
 */
/**
 * The box a gaze mark is placed in: one viewport of the device this session ran on. A
 * screenshot `Capture` is one, and so is the recording's own frame — a video is the device's
 * viewport scaled into 720p, so the same percentage lands on the same element in both.
 */
export interface GazeBox {
  readonly viewport: { readonly width: number; readonly height: number };
}

export function gazeTrail(session: Session, moment: TimelineMoment, box: GazeBox): GazeTrail {
  const { width, height } = box.viewport;
  const drawn = session.fixations.filter(
    (fixation) =>
      fixation.screenIndex === moment.screenIndex &&
      moment.fixation !== null &&
      fixation.index <= moment.fixation.index,
  );
  const place = (fixation: Session['fixations'][number]) => ({
    xPct: (fixation.x / width) * 100,
    yPct: (fixation.y / height) * 100,
  });
  const onScreen = new Set(drawn.map((fixation) => fixation.index));

  return {
    marks: drawn.map((fixation) => ({
      number: fixation.index + 1,
      ...place(fixation),
      durationMs: fixation.durationMs,
      current: fixation.index === moment.fixation?.index,
    })),
    hops: session.saccades
      .filter((saccade) => onScreen.has(saccade.fromFixation) && onScreen.has(saccade.toFixation))
      .map((saccade) => {
        const from = session.fixations[saccade.fromFixation] as Session['fixations'][number];
        const to = session.fixations[saccade.toFixation] as Session['fixations'][number];
        const start = place(from);
        const end = place(to);
        return {
          fromNumber: from.index + 1,
          toNumber: to.index + 1,
          fromXPct: start.xPct,
          fromYPct: start.yPct,
          toXPct: end.xPct,
          toYPct: end.yPct,
        };
      }),
  };
}

/* ---- The recording's own clock ----------------------------------------- */

/** The query parameter a cited moment of the recording is carried in (`docs/FLOW.md` section 14). */
export const T_PARAM = 't';

/** A session whose recording was made: the only shape that has offsets to read. */
export type Recording = Extract<NonNullable<Session['video']>, { state: 'recorded' }>;

/** The recording a session carries, or `null` for a session with none. */
export function recordingOf(session: Session): Recording | null {
  const video = session.video;
  return video !== undefined && video.state === 'recorded' ? video : null;
}

/** What `?t=` asked for, placed inside the recording it names. */
export interface AskedTime {
  /** Where the replay opens: the asked moment, or the last frame when it is past the end. */
  readonly videoMs: number;
  /** `true` when the link asked for a moment the recording does not reach. */
  readonly pastEnd: boolean;
  /** What the link asked for, as it asked for it, so the line that says so can print it. */
  readonly askedMs: number;
}

/**
 * `?t=` read: **seconds** into the recording, as the contract means them and as a citation
 * prints them (*S-62 · 0:48*).
 *
 * `null` when the parameter is absent or is not a number, which is the difference between
 * *a link that asks for a moment* and *a link that asks for nothing* — the first opens
 * paused on that frame and the second opens at the start.
 *
 * A moment past the end is **not** refused and not silently clamped either: it opens on the
 * last frame and reports `pastEnd`, so the screen can say that the link asks for a second
 * this recording never reached. A recording truncated at a cap is exactly that case, and a
 * reader handed such a link has to be told, or they would read the last frame as the frame
 * the citation meant.
 */
export function videoTimeFromParam(raw: string | null, durationMs: number): AskedTime | null {
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return null;
  const askedMs = Math.round(seconds * 1000);
  if (askedMs > durationMs) return { videoMs: durationMs, pastEnd: true, askedMs };
  return { videoMs: Math.max(askedMs, 0), pastEnd: false, askedMs };
}

/** One moment of the session, as both clocks stamp it. */
interface Anchor {
  readonly sessionMs: number;
  readonly videoMs: number;
}

/**
 * The two clocks of one session, and the map between them.
 *
 * A session's own `tMs` runs on the clock the gaze model wrote; the recording's runs from
 * the frame the page opened on. They start together and they are **not** the same clock
 * afterwards, which is why the contract stores `actionOffsetsMs` at all: an action is the
 * one entry stamped on both, so each one is a pair of times the map can be built from.
 *
 * Between two pairs the map is linear, and outside them the clocks run together.
 *
 * **The first pair is the first screen.** The recorder's clock starts when the browser
 * context opens, before the page is even navigated to, so the two clocks do *not* start
 * together: `screenOffsetsMs[0]` is where the first screen begins in the recording, and the
 * session's own clock starts at 0 on that screen by the timeline's own rule
 * (`src/session/timeline.ts`). That is the pair, and it is the one the contract stores for
 * exactly this. Without it the whole first stretch of the map would be interpolated from an
 * origin nothing measured, and a frame still loading the page would be shown under
 * mid-session attention.
 *
 * The later screens' offsets are deliberately left alone: a screen *begins* at its first
 * fixation, which is the timeline's rule, and pairing those would mean deriving that rule a
 * second time here. An action is stamped on both clocks already.
 */
export interface VideoClock {
  /** The recording's own length: what the file holds, and what a citation addresses. */
  readonly videoDurationMs: number;
  /** The session's own length, which is what the scrubber runs over. */
  readonly sessionDurationMs: number;
  /** The stretches the agent spent waiting, in the order the session met them. */
  readonly waits: readonly Wait[];
  /** Where in the session a point in the recording falls. */
  sessionMsAt(videoMs: number): number;
  /** Where in the recording a moment of the session falls. */
  videoMsAt(sessionMs: number): number;
  /** The wait the session's clock is inside at this moment, or `null` between them. */
  waitAt(sessionMs: number): Wait | null;
}

/**
 * How much longer the recording has to have run than the session for the stretch between
 * two actions to be a **wait** rather than the two clocks disagreeing by a rounding.
 *
 * Two seconds. Under that the stretch is played through, because the label a wait carries
 * reads in whole seconds and a marker on the track saying `1 s` is noise on a track a
 * reader is trying to drag. Over it the page was standing still for long enough that
 * playing it would be four fifths of the replay showing a picture that does not move,
 * which is the defect this screen was built to stop (#414).
 */
export const WAIT_MS = 2000;

/**
 * One stretch between two actions that the recording spent waiting.
 *
 * It is **not a new field in the contract**: a wait is exactly what the two clocks
 * disagree about, so it is read off the anchor pairs the recording already stores. The
 * session's clock is the gaze model's own and advances by what the eye did; the recorder's
 * is wall time and advances through every second spent asking the model what to do next.
 * Where the second moved far more than the first, nothing happened on the page.
 */
export interface Wait {
  /** The moment of the session the stretch begins at: the action before it. */
  readonly fromSessionMs: number;
  /** The moment of the session it ends at: the action the wait ends on. */
  readonly toSessionMs: number;
  /** The real milliseconds it took: the recording's own difference between the two. */
  readonly waitedMs: number;
  /** Where the stretch begins on the track, as a percentage of the session's length. */
  readonly fromPct: number;
  /** How much of the track it covers. */
  readonly widthPct: number;
}

/** What a wait says, on the track and over the stage: `deciding… 14 s`. */
export function waitLabel(waitedMs: number): string {
  return `deciding… ${String(Math.round(Math.max(waitedMs, 0) / 1000))} s`;
}

/**
 * The pairs, in order and monotone. The recorder stamps actions in time order on both
 * clocks, so sorting by the recording's clock sorts both; a pair that would still go
 * backwards on the session's clock is dropped rather than inverting the map, because a map
 * that is not monotone would move the gaze backwards as the video played forwards.
 */
function anchorsOf(session: Session, video: Recording): Anchor[] {
  const pairs: Anchor[] = [];
  video.actionOffsetsMs.forEach((offsetMs, index) => {
    const action = session.actions[index];
    if (offsetMs !== null && action !== undefined) {
      pairs.push({ sessionMs: action.tMs, videoMs: offsetMs });
    }
  });
  pairs.sort((left, right) => left.videoMs - right.videoMs);

  // The first screen: session time 0, at the offset the recording says it begins at. A
  // recording truncated before its own first screen has no such offset, and then the two
  // clocks are left running together from zero.
  const kept: Anchor[] = [{ sessionMs: 0, videoMs: video.screenOffsetsMs[0] ?? 0 }];
  for (const pair of pairs) {
    const last = kept[kept.length - 1] as Anchor;
    if (pair.videoMs > last.videoMs && pair.sessionMs > last.sessionMs) kept.push(pair);
  }
  return kept;
}

/**
 * Whether nothing happened on the page between two pairs.
 *
 * The recording ran `WAIT_MS` longer than the session did over the same stretch, which on
 * a browser-driven run is the agent waiting to be told what to do next: the gaze model's
 * clock advances by what the eye did and costs no wall time, while the recorder's runs
 * through every second of the decision. There is nothing in such a stretch to play.
 */
function isWait(before: Anchor, after: Anchor): boolean {
  return after.videoMs - before.videoMs - (after.sessionMs - before.sessionMs) >= WAIT_MS;
}

/**
 * One clock read on the other: linear between the pairs, one to one outside them, and a
 * **step** across a wait.
 *
 * The step is the whole of this ticket in one line. A stretch nothing happened in has no
 * inside to be at, so either clock reads the moment the stretch **ends** on as soon as it
 * has left the moment it began on. Read forwards that holds the recording still on the
 * frame the wait ends on while the session's clock crosses the stretch — the replay crosses
 * it at once rather than playing a page that is not moving. Read backwards it is what makes
 * a `?t=` that lands inside a wait open on the action the wait ends on.
 */
function along(
  anchors: readonly Anchor[],
  read: (anchor: Anchor) => number,
  write: (anchor: Anchor) => number,
  value: number,
): number {
  const first = anchors[0] as Anchor;
  // Before the first pair and after the last one there is nothing to interpolate between,
  // so the two clocks run together: a second of one is a second of the other.
  if (value <= read(first)) return write(first) + (value - read(first));

  let before = first;
  let after: Anchor | null = null;
  for (const anchor of anchors) {
    if (read(anchor) <= value) before = anchor;
    else {
      after = anchor;
      break;
    }
  }
  // A pair's own moment is both clocks' answer for it, whichever stretch follows it.
  if (value === read(before)) return write(before);
  if (after === null) return write(before) + (value - read(before));
  if (isWait(before, after)) return write(after);
  const span = read(after) - read(before);
  const share = (value - read(before)) / span;
  return write(before) + share * (write(after) - write(before));
}

/**
 * The waits, in the order the session meets them, each placed on the track the scrubber
 * runs over — which is the session's own clock, so a wait covers the session time between
 * the two actions and carries the recording's own difference as the seconds it took.
 */
function waitsOf(anchors: readonly Anchor[], sessionDurationMs: number): Wait[] {
  const share = sessionDurationMs > 0 ? 100 / sessionDurationMs : 0;
  const waits: Wait[] = [];

  for (let index = 1; index < anchors.length; index += 1) {
    const before = anchors[index - 1] as Anchor;
    const after = anchors[index] as Anchor;
    if (!isWait(before, after)) continue;
    waits.push({
      fromSessionMs: before.sessionMs,
      toSessionMs: after.sessionMs,
      waitedMs: after.videoMs - before.videoMs,
      fromPct: before.sessionMs * share,
      widthPct: (after.sessionMs - before.sessionMs) * share,
    });
  }

  return waits;
}

export function videoClock(session: Session, video: Recording): VideoClock {
  const anchors = anchorsOf(session, video);
  const waits = waitsOf(anchors, session.durationMs);
  const clamp = (value: number, upTo: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(value, 0), upTo) : 0;

  return {
    videoDurationMs: video.durationMs,
    sessionDurationMs: session.durationMs,
    waits,
    sessionMsAt: (videoMs) =>
      clamp(
        along(
          anchors,
          (anchor) => anchor.videoMs,
          (anchor) => anchor.sessionMs,
          clamp(videoMs, video.durationMs),
        ),
        session.durationMs,
      ),
    videoMsAt: (sessionMs) =>
      clamp(
        along(
          anchors,
          (anchor) => anchor.sessionMs,
          (anchor) => anchor.videoMs,
          clamp(sessionMs, session.durationMs),
        ),
        video.durationMs,
      ),
    // Strictly inside: on either action the stretch is over, and the frame is that action's
    // own. The same boundary `along` steps on, so the badge is up exactly while the
    // recording is being held still.
    waitAt: (sessionMs) =>
      waits.find((wait) => sessionMs > wait.fromSessionMs && sessionMs < wait.toSessionMs) ?? null,
  };
}

/* ---- The clicks over the frame ----------------------------------------- */

/** One click, placed in the frame and named in the run's own words. */
export interface ClickMark {
  /** Its index in the session's own `actions`: stable, and what a test names a mark by. */
  readonly index: number;
  readonly xPct: number;
  readonly yPct: number;
  /** What was clicked, as the run names it. */
  readonly label: string;
  /** The click the scrubber is on, drawn apart from the rest. */
  readonly current: boolean;
}

/**
 * The clicks on the screen the scrubber is on, up to its moment.
 *
 * **A click carries no coordinates.** The session records what it was aimed at — an area of
 * interest — and the run records where that area is, so a mark is the centre of the area's
 * own box, in the viewport the frame is showing. That is the honest placement: it is where
 * the thing that was clicked sits, rather than a pixel nobody measured. A click that named
 * no area, or an area the run does not hold, draws nothing; the event log still carries the
 * row, which is where that click is read.
 *
 * The box is page-space and the frame is one viewport, so the screen's own `scrollY` comes
 * off it — the same offset the screenshot and the fold are placed from. A mark that lands
 * outside the frame is left undrawn rather than pinned to an edge it is not on.
 */
export function clickMarks(input: {
  run: Run;
  session: Session;
  timeline: SessionTimeline;
  moment: TimelineMoment;
  box: GazeBox;
}): readonly ClickMark[] {
  const { run, session, timeline, moment, box } = input;
  const screen = moment.screen;
  if (screen === null) return [];
  const { width, height } = box.viewport;
  const scrollY = moment.scrollY ?? 0;
  const marks: ClickMark[] = [];

  session.actions.forEach((action, index) => {
    if (action.type !== 'click' || action.tMs > moment.tMs || action.aoiId === null) return;
    if (timeline.at(action.tMs).screenIndex !== moment.screenIndex) return;
    const aoi = run.aois.find(
      (candidate) =>
        candidate.id === action.aoiId &&
        candidate.variant === session.variant &&
        candidate.step === screen.step,
    );
    if (aoi === undefined) return;
    const xPct = ((aoi.bbox.x + aoi.bbox.width / 2) / width) * 100;
    const yPct = ((aoi.bbox.y + aoi.bbox.height / 2 - scrollY) / height) * 100;
    if (xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) return;
    marks.push({
      index,
      xPct,
      yPct,
      label: aoi.label,
      current: moment.eventLogIndex === index,
    });
  });

  return marks;
}
