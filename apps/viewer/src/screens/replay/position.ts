import type { Run, Session } from '@personavision/contract';
import type { TimelineMoment } from '@/session/index.js';

/**
 * The arithmetic behind the replay: where the scrubber is, what the clock reads, where the
 * screenshot sits in the frame, and which gaze marks are drawn over it.
 *
 * It is pure, so the screen is a rendering of these answers and a test can check the
 * answers themselves. The session's own clock — which screen covers a time, which fixation
 * is current, how a step moves — is `src/session/timeline.ts` (#20) and is not re-derived
 * here; what this module adds is the **geometry**, which is the screen's own business: a
 * fixation is recorded in page pixels and has to be drawn in a frame of a different size.
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

/** One captured page, as `run.json`'s `screenshots[]` records it. */
export type Capture = Run['screenshots'][number];

/**
 * The capture a session's screen was taken from: the one for this session's variant and
 * that screen's step. `null` when the run records no such capture, which leaves the frame
 * saying so rather than drawing a page at a guessed size.
 */
export function captureFor(run: Run, variant: string, step: string): Capture | null {
  return run.screenshots.find((shot) => shot.variant === variant && shot.step === step) ?? null;
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
export function gazeTrail(session: Session, moment: TimelineMoment, capture: Capture): GazeTrail {
  const { width, height } = capture.viewport;
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
