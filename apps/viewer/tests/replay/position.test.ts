import { beforeAll, describe, expect, it } from 'vitest';
import type { Run, Session } from '@personavision/contract';
import { EXAMPLE_RUN_BASE, exampleRunFetch } from '../../src/session/fixtures.js';
import { openRun, sessionTimeline } from '../../src/session/index.js';
import {
  captureFor,
  clockLabel,
  fixationFromParam,
  fixationLabel,
  frameGeometry,
  gazeTrail,
  timeLabel,
} from '../../src/screens/replay/position';

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
