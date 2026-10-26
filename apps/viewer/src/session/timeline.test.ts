import { describe, expect, it } from 'vitest';
import { openRun, sessionTimeline } from './index.js';
import { EXAMPLE_RUN_BASE, exampleRunFetch } from './fixtures.js';

/**
 * One clock, over the committed example run. S-15 is the session the demo turns on (beat 6
 * of `docs/FLOW.md` section 7): three screens, a total that changes on the third, and a
 * person who leaves. S-16 is the long one, and is where continuous numbering shows.
 */
const session = async (sessionId: string) => {
  const { fetch } = exampleRunFetch();
  const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });
  return run.session(sessionId);
};

describe('a session at a time', () => {
  it('answers with the screen, the scroll offset, the fixation and the event-log row', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    const moment = timeline.at(30_000);

    expect(moment.screenIndex).toBe(2);
    expect(moment.screen?.step).toBe('review');
    expect(moment.scrollY).toBe(696);
    expect(moment.fixationNumber).toBe(20);
    expect(moment.fixation?.aoiId).toBe('B-review-summary');
    expect(moment.eventLogIndex).toBe(4);
    expect(moment.eventLogRow?.type).toBe('scroll');
  });

  it('is on the first screen from the start, before anything has been looked at or done', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    const start = timeline.at(0);

    expect(start.screenIndex).toBe(0);
    expect(start.screen?.step).toBe('cart');
    expect(start.scrollY).toBe(0);
    expect(start.fixationNumber).toBeNull();
    expect(start.eventLogRow).toBeNull();
  });

  it('stays on the screen the person is on between its fixations', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    const moment = timeline.at(5_000);

    expect(moment.screen?.step).toBe('cart');
    expect(moment.fixationNumber).toBe(4);
    expect(moment.eventLogRow, 'nothing has been clicked yet').toBeNull();
  });

  it('clamps a time outside the session into it', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    expect(timeline.at(-5_000).tMs).toBe(0);
    expect(timeline.at(120_000).tMs).toBe(38_000);
    expect(timeline.at(120_000).screen?.step).toBe('review');
  });

  it('numbers fixations continuously across screens, never restarting at 1', async () => {
    const timeline = sessionTimeline(await session('S-16'));

    const secondScreen = timeline.at(14_781);

    expect(secondScreen.screenIndex, 'the second screen').toBe(1);
    expect(secondScreen.fixationNumber, 'the 18th fixation of the session').toBe(18);
    expect(timeline.fixationCount).toBe(71);
  });

  it('puts fixations, saccades and actions on one clock, in time order', async () => {
    const replayed = await session('S-15');
    const timeline = sessionTimeline(replayed);

    const times = timeline.track.map((entry) => entry.tMs);

    expect(timeline.track).toHaveLength(
      replayed.fixations.length + replayed.saccades.length + replayed.actions.length,
    );
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(timeline.track.slice(0, 3).map((entry) => entry.kind)).toEqual([
      'fixation',
      'saccade',
      'fixation',
    ]);
    expect(timeline.track.at(-1)).toEqual({ kind: 'action', tMs: 38_000, index: 5 });
  });
});

describe('a session whose data is not what a replay expects', () => {
  it('leaves a screen nobody looked at covering no time, rather than its neighbour’s', async () => {
    const replayed = await session('S-16');
    // S-16's fourth screen is a scroll back up with one fixation on it. Without it, that
    // screen was never looked at, and the screens around it keep their own spans.
    const unlooked = {
      ...replayed,
      fixations: replayed.fixations
        .filter((fixation) => fixation.screenIndex !== 3)
        .map((fixation, index) => ({ ...fixation, index })),
    };

    const timeline = sessionTimeline(unlooked);

    expect(timeline.at(40_000).screenIndex, 'still the third screen').toBe(2);
    expect(timeline.at(40_000).scrollY).toBe(696);
    expect(timeline.at(43_407).screenIndex, 'the fifth screen keeps its own start').toBe(4);
  });

  it('answers from the start of the session for a time that is not a number', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    const moment = timeline.at(Number('not a time'));

    expect(moment.tMs).toBe(0);
    expect(moment.screenIndex).toBe(0);
    expect(moment.fixationNumber).toBeNull();
  });
});

describe('stepping by fixation', () => {
  it('moves to the next and the previous fixation’s time', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    const forward = timeline.stepFixation(29_042, 1);
    const back = timeline.stepFixation(29_042, -1);

    expect(forward).toBe(31_114);
    expect(back).toBe(25_572);
    expect(timeline.at(forward).fixationNumber).toBe(21);
    expect(timeline.at(back).fixationNumber).toBe(19);
  });

  it('clamps at both ends of the session', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    expect(timeline.stepFixation(0, -1), 'nothing before the first fixation').toBe(0);
    expect(timeline.stepFixation(35_412, 1), 'the last fixation stays the last').toBe(35_412);
    expect(timeline.stepFixation(120_000, 1)).toBe(35_412);
    expect(timeline.stepFixation(1_034, -1), 'back from the first fixation stays there').toBe(
      1_034,
    );
  });

  it('steps the number the screen is showing, from a time between two fixations', async () => {
    const timeline = sessionTimeline(await session('S-15'));
    expect(timeline.at(30_000).fixationNumber, 'the scrubber was dragged past 20').toBe(20);

    const back = timeline.stepFixation(30_000, -1);
    const forward = timeline.stepFixation(30_000, 1);

    expect(timeline.at(back).fixationNumber).toBe(19);
    expect(timeline.at(forward).fixationNumber).toBe(21);
  });

  it('deep-links a fixation number to its time, clamped to the fixations there are', async () => {
    const timeline = sessionTimeline(await session('S-15'));

    expect(timeline.timeAtFixation(1)).toBe(1_034);
    expect(timeline.timeAtFixation(20)).toBe(29_042);
    expect(timeline.timeAtFixation(0), 'before the first is the first').toBe(1_034);
    expect(timeline.timeAtFixation(999), 'past the last is the last').toBe(35_412);
    expect(timeline.timeAtFixation(Number('abc')), 'a ?fix= that is not a number').toBe(1_034);
  });
});
