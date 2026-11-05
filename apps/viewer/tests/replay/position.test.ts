import { beforeAll, describe, expect, it } from 'vitest';
import type { Run, Session } from '@personavision/contract';
import { EXAMPLE_RUN_BASE, exampleRunFetch } from '../../src/session/fixtures.js';
import { openRun, sessionTimeline } from '../../src/session/index.js';
import {
  clockLabel,
  fixationFromParam,
  fixationLabel,
  frameGeometry,
  gazeTrail,
  timeLabel,
  videoClock,
  videoTimeFromParam,
  waitLabel,
} from '../../src/screens/replay/position';
import type { Recording } from '../../src/screens/replay/position';
import { captureFor } from '../../src/screens/replay/runWords';

/**
 * The replay's arithmetic, over the committed example run.
 *
 * Beat 6 of `docs/FLOW.md` section 7 is `S-15`: the rushed buyer on mobile, variant B,
 * seed 3, who abandons on the review step after the total jumps. Its 23 fixations run
 * across three screens, which is what makes it the session to check the numbering and the
 * scroll offset against.
 */

/** One captured page of the run, which `captureFor` finds for a session's screen. */
type Capture = NonNullable<ReturnType<typeof captureFor>>;

let run: Run;
let session: Session;

beforeAll(async () => {
  const { fetch } = exampleRunFetch();
  const opened = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });
  run = opened.run;
  session = await opened.session('S-15');
});

describe('?fix=', () => {
  it('opens on the first fixation when nothing asks for one', () => {
    expect(fixationFromParam(null, 23)).toBe(1);
  });

  it('carries a fixation number as it is', () => {
    expect(fixationFromParam('12', 23)).toBe(12);
  });

  it('clamps a number outside the session rather than refusing the link', () => {
    expect(fixationFromParam('0', 23)).toBe(1);
    expect(fixationFromParam('-4', 23)).toBe(1);
    expect(fixationFromParam('99', 23)).toBe(23);
  });

  it('opens on the first fixation when the parameter is not a number', () => {
    expect(fixationFromParam('halfway', 23)).toBe(1);
    expect(fixationFromParam('', 23)).toBe(1);
  });

  it('has no position at all in a session that recorded no fixations', () => {
    expect(fixationFromParam('3', 0)).toBe(0);
  });
});

describe('the clock', () => {
  it('reads elapsed against total, floored to the second', () => {
    expect(clockLabel(15828, 38000)).toBe('0:15 / 0:38');
    expect(clockLabel(0, 38000)).toBe('0:00 / 0:38');
  });

  it('carries minutes once a session is longer than one', () => {
    expect(timeLabel(95000)).toBe('1:35');
  });

  it('says which fixation of how many', () => {
    expect(fixationLabel(12, 23)).toBe('fixation 12 of 23');
  });
});

describe('the frame', () => {
  it('holds one viewport of the device, with the page scrolled behind it', () => {
    const capture = captureFor(run, 'B', 'review');
    expect(capture).not.toBeNull();

    // The review screen is 1540px of page in an 844px viewport, scrolled to 696px.
    const geometry = frameGeometry(capture as Capture, 696);

    expect(geometry.portrait).toBe(true);
    expect(geometry.pageHeightPct).toBeCloseTo(182.46, 2);
    expect(geometry.pageTopPct).toBeCloseTo(-82.46, 2);
  });

  it('draws the fold where the first viewport ends, measured from the scroll offset', () => {
    const capture = captureFor(run, 'B', 'review') as Capture;

    // Unscrolled, the fold is the bottom edge of the frame: everything in view is above it.
    expect(frameGeometry(capture, 0).foldTopPct).toBeCloseTo(100, 6);
    // Scrolled to 696, 148px of the first viewport are left in a frame 844px tall.
    expect(frameGeometry(capture, 696).foldTopPct).toBeCloseTo(17.54, 2);
    // Scrolled past it, the marker is not drawn at all rather than clamped to an edge.
    expect(frameGeometry(capture, 900).foldTopPct).toBeNull();
  });

  it('names no capture for a step the run did not capture', () => {
    expect(captureFor(run, 'B', 'not-a-step')).toBeNull();
  });
});

describe('the gaze over the current screen', () => {
  const trailAt = (fixationNumber: number) => {
    const timeline = sessionTimeline(session);
    const moment = timeline.at(timeline.timeAtFixation(fixationNumber));
    const screen = moment.screen as NonNullable<typeof moment.screen>;
    return {
      moment,
      trail: gazeTrail(session, moment, captureFor(run, session.variant, screen.step) as Capture),
    };
  };

  it('draws the fixations up to the scrubber and no more', () => {
    const { moment, trail } = trailAt(12);

    expect(moment.screen?.step).toBe('payment');
    expect(trail.marks.map((mark) => mark.number)).toEqual([8, 9, 10, 11, 12]);
    expect(trail.marks.filter((mark) => mark.current).map((mark) => mark.number)).toEqual([12]);
  });

  it('numbers them continuously across screens, so the order of attention is the number', () => {
    // Fixation 20 is the first on the review screen, and it is 20 — not 1 again.
    const { moment, trail } = trailAt(20);

    expect(moment.screen?.step).toBe('review');
    expect(trail.marks.map((mark) => mark.number)).toEqual([20]);
  });

  it('draws a saccade only between two fixations that are both on this screen', () => {
    const { trail } = trailAt(12);

    expect(trail.hops.map((hop) => [hop.fromNumber, hop.toNumber])).toEqual([
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
    ]);
  });

  it('places a fixation as a percentage of the frame, from its viewport position', () => {
    const { trail } = trailAt(12);
    const current = trail.marks.at(-1) as NonNullable<(typeof trail.marks)[number]>;

    // Fixation 12 sits at (99.8, 351.9) in a 390 × 844 viewport.
    expect(current.xPct).toBeCloseTo(25.59, 2);
    expect(current.yPct).toBeCloseTo(41.69, 2);
  });
});

/* ---- The two clocks, and the waits between them ----------------------- */

/**
 * The recording `S-15` would have had, as the recorder writes one: the offsets are
 * positional, the first screen is where the session's own clock starts, and `waits` is the
 * one knob these tests turn — milliseconds the agent spent being told what to do next
 * before the action of that index, which is time the recording ran and the session did not.
 *
 * It is the same arithmetic `tests/replay/harness.tsx` builds a served fixture from, written
 * here against the session's own figures so the numbers below are this file's own.
 */
const recordingOver = (options: { shiftMs?: number; waits?: Record<number, number> } = {}) => {
  const shiftMs = options.shiftMs ?? 0;
  const waits = options.waits ?? {};
  const before = (index: number): number =>
    Object.entries(waits)
      .filter(([at]) => Number(at) <= index)
      .reduce((total, [, ms]) => total + ms, 0);

  const actionOffsetsMs = session.actions.map(
    (action, index) => action.tMs + shiftMs + before(index),
  );
  return {
    state: 'recorded',
    path: `videos/S-15.webm`,
    durationMs: session.durationMs + shiftMs + before(session.actions.length),
    truncated: null,
    screenOffsetsMs: [shiftMs],
    actionOffsetsMs,
  } as Recording;
};

describe('the session’s clock and the recording’s', () => {
  it('runs the two together when every action landed where the session says it did', () => {
    const clock = videoClock(session, recordingOver());

    expect(clock.sessionDurationMs).toBe(38_000);
    expect(clock.videoDurationMs).toBe(38_000);
    expect(clock.waits).toEqual([]);
    expect(clock.videoMsAt(16_000)).toBe(16_000);
    expect(clock.sessionMsAt(16_000)).toBe(16_000);
  });

  it('puts the session’s zero where the recording says the first screen began', () => {
    // The recorder's clock starts when the browser context opens, 32 seconds before this
    // session's own first figure.
    const clock = videoClock(session, recordingOver({ shiftMs: 32_000 }));

    expect(clock.sessionDurationMs).toBe(38_000);
    expect(clock.videoDurationMs).toBe(70_000);
    expect(clock.videoMsAt(0)).toBe(32_000);
    expect(clock.videoMsAt(16_000)).toBe(48_000);
    expect(clock.sessionMsAt(48_000)).toBe(16_000);
    // A second of the recording before the page had even loaded is before the session.
    expect(clock.sessionMsAt(10_000)).toBe(0);
  });

  it('reads a stretch the recording ran far longer than the session as a wait', () => {
    // Eight seconds of waiting to be told what to do next, between the click on Checkout
    // (8 s) and typing the card number (14 s): six seconds of session in fourteen of tape.
    const clock = videoClock(session, recordingOver({ waits: { 1: 8_000 } }));

    expect(clock.waits).toEqual([
      {
        fromSessionMs: 8_000,
        toSessionMs: 14_000,
        waitedMs: 14_000,
        fromPct: (8_000 / 38_000) * 100,
        widthPct: (6_000 / 38_000) * 100,
      },
    ]);
    expect(waitLabel(clock.waits[0]?.waitedMs ?? 0)).toBe('deciding… 14 s');
  });

  it('holds the recording on the frame a wait ends on while the session crosses it', () => {
    const clock = videoClock(session, recordingOver({ waits: { 1: 8_000 } }));

    // The action the wait begins on is its own frame.
    expect(clock.videoMsAt(8_000)).toBe(8_000);
    // Every moment after it is the frame the wait ends on: there is nothing between them
    // to play, so the replay is already there.
    expect(clock.videoMsAt(8_001)).toBe(22_000);
    expect(clock.videoMsAt(11_000)).toBe(22_000);
    expect(clock.videoMsAt(14_000)).toBe(22_000);
    // And the stretch after it, which the two clocks crossed together, is interpolated.
    expect(clock.videoMsAt(18_500)).toBe(26_500);
  });

  it('says which wait a moment of the session is inside, and which is between two', () => {
    const clock = videoClock(session, recordingOver({ waits: { 1: 8_000 } }));

    expect(clock.waitAt(11_000)?.waitedMs).toBe(14_000);
    // Both ends are the actions themselves, where the wait is over.
    expect(clock.waitAt(8_000)).toBeNull();
    expect(clock.waitAt(14_000)).toBeNull();
    expect(clock.waitAt(20_000)).toBeNull();
  });

  it('resolves a cited second inside a wait to the action the wait ends on', () => {
    const clock = videoClock(session, recordingOver({ waits: { 1: 8_000 } }));

    // 0:22 is where the recorder stamped typing the card number, which the session's own
    // clock has at 14 s.
    expect(clock.sessionMsAt(22_000)).toBe(14_000);
    // A citation prints whole seconds, so it lands a fraction short of the offset it means
    // — inside the wait, which resolves forwards to the action rather than to a frozen
    // frame four seconds earlier.
    expect(clock.sessionMsAt(21_000)).toBe(14_000);
    expect(clock.sessionMsAt(15_000)).toBe(14_000);
    // The action the wait began on still reads as itself.
    expect(clock.sessionMsAt(8_000)).toBe(8_000);
  });

  it('leaves a stretch the clocks nearly agreed about played through', () => {
    // A second and a half of drift is a rounding, not a wait: under the threshold the
    // stretch is interpolated as it always was.
    const clock = videoClock(session, recordingOver({ waits: { 1: 1_500 } }));

    expect(clock.waits).toEqual([]);
    expect(clock.videoMsAt(11_000)).toBe(11_750);
  });

  it('reads ?t= as seconds of the recording, past its end included', () => {
    expect(videoTimeFromParam('22', 46_000)).toEqual({
      videoMs: 22_000,
      pastEnd: false,
      askedMs: 22_000,
    });
    expect(videoTimeFromParam('90', 46_000)).toEqual({
      videoMs: 46_000,
      pastEnd: true,
      askedMs: 90_000,
    });
    expect(videoTimeFromParam(null, 46_000)).toBeNull();
  });
});
