import type { Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  funnelOfSlice,
  funnelSliceSpecs,
  scoredSessions,
  type FunnelSliceSpec,
} from '../src/index.js';
import { smallRun, smallRunSessions } from './fixtures/aggregate.js';

/**
 * The funnel of the small fixture, counted by hand.
 *
 * Five sessions are scored — S-05 is the automation failure and is in none of these counts,
 * because the slices the funnel is given come from the shared reading and that reading has
 * already dropped it.
 *
 * | session | version | segment | screens walked                          | outcome              |
 * | ------- | ------- | ------- | --------------------------------------- | -------------------- |
 * | S-01    | A       | phone   | landing, prompt, generate, preview      | success on preview   |
 * | S-02    | A       | phone   | landing, prompt, generate               | abandoned on generate|
 * | S-03    | A       | desktop | landing, prompt                         | failed on prompt     |
 * | S-04    | B       | phone   | landing, prompt, generate, prompt, prev | success on preview   |
 * | S-06    | B       | phone   | landing, prompt, generate, preview      | abandoned on preview |
 */

const SPECS = funnelSliceSpecs(smallRun, smallRunSessions);

const sliceOf = (key: string): FunnelSliceSpec => {
  const found = SPECS.find((spec) => spec.key === key);
  if (found === undefined) throw new Error(`the fixture enumerates no slice "${key}"`);
  return found;
};

const sessionOf = (sessionId: string): Session => {
  const found = smallRunSessions.find((session) => session.sessionId === sessionId);
  if (found === undefined) throw new Error(`the fixture carries no ${sessionId}`);
  return found;
};

/** A slice built by hand, for the cases the six fixture sessions cannot reach on their own. */
const handSlice = (sessions: readonly Session[]): FunnelSliceSpec => ({
  key: 'hand',
  variant: null,
  segment: null,
  label: `Hand ${sessions.length}`,
  sessions,
});

const funnelOf = (slice: FunnelSliceSpec): ReturnType<typeof funnelOfSlice> =>
  funnelOfSlice({ run: smallRun, slice });

describe('the funnel of a slice', () => {
  it('counts every step of the whole run as the fixture walked it', () => {
    expect(funnelOf(sliceOf('all')).funnel).toEqual([
      { step: 'landing', reached: 5, completed: 5, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 5, completed: 4, abandoned: 0, failed: 1, reachedShare: 1 },
      { step: 'generate', reached: 4, completed: 3, abandoned: 1, failed: 0, reachedShare: 0.8 },
      { step: 'preview', reached: 3, completed: 2, abandoned: 1, failed: 0, reachedShare: 0.6 },
    ]);
  });

  it('holds the shares of a slice that does not divide evenly to four places', () => {
    expect(funnelOf(sliceOf('variant:A')).funnel).toEqual([
      { step: 'landing', reached: 3, completed: 3, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 3, completed: 2, abandoned: 0, failed: 1, reachedShare: 1 },
      { step: 'generate', reached: 2, completed: 1, abandoned: 1, failed: 0, reachedShare: 0.6667 },
      { step: 'preview', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 0.3333 },
    ]);
  });

  it('counts one segment of the run on its own', () => {
    expect(funnelOf(sliceOf('segment:phone')).funnel).toEqual([
      { step: 'landing', reached: 4, completed: 4, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 4, completed: 4, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'generate', reached: 4, completed: 3, abandoned: 1, failed: 0, reachedShare: 1 },
      { step: 'preview', reached: 3, completed: 2, abandoned: 1, failed: 0, reachedShare: 0.75 },
    ]);
  });

  it('reads a step nobody reached as zero and still as a row', () => {
    const desktop = funnelOf(sliceOf('segment:desktop'));

    expect(desktop.funnel).toEqual([
      { step: 'landing', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 1, completed: 0, abandoned: 0, failed: 1, reachedShare: 1 },
      { step: 'generate', reached: 0, completed: 0, abandoned: 0, failed: 0, reachedShare: 0 },
      { step: 'preview', reached: 0, completed: 0, abandoned: 0, failed: 0, reachedShare: 0 },
    ]);
    expect(desktop.funnel.map((row) => row.step)).toEqual(smallRun.steps.map((step) => step.id));
  });

  it('leaves the automation failure out of every count, through the shared reading', () => {
    expect(scoredSessions(smallRunSessions).excludedAutomationFailures).toBe(1);
    expect(
      SPECS.flatMap((spec) => spec.sessions.map((session) => session.sessionId)),
    ).not.toContain('S-05');

    const all = sliceOf('all');
    expect(all.sessions).toHaveLength(5);
    // S-05 walked landing and prompt, so a funnel that held it would read 6 and 6 here.
    expect(funnelOf(all).funnel[0]).toMatchObject({ step: 'landing', reached: 5 });
    expect(funnelOf(all).funnel[1]).toMatchObject({ step: 'prompt', reached: 5 });
  });

  it('counts a session that gave up on a step it reached in exactly one of the three', () => {
    expect(funnelOf(handSlice([sessionOf('S-02')])).funnel).toEqual([
      { step: 'landing', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'generate', reached: 1, completed: 0, abandoned: 1, failed: 0, reachedShare: 1 },
      { step: 'preview', reached: 0, completed: 0, abandoned: 0, failed: 0, reachedShare: 0 },
    ]);
  });

  it('lets the stored outcome win over the walk where the two could disagree', () => {
    // The revisit session, stored as having given up on the step it came back to: it did
    // reach the step after `prompt`, and its own outcome says `prompt` is where it ended.
    const cameBackAndGaveUp: Session = {
      ...sessionOf('S-04'),
      outcome: {
        ...sessionOf('S-04').outcome,
        status: 'abandoned',
        step: 'prompt',
        reason: 'gave up re-writing the prompt',
      },
    };

    expect(funnelOf(handSlice([cameBackAndGaveUp])).funnel).toEqual([
      { step: 'landing', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 1, completed: 0, abandoned: 1, failed: 0, reachedShare: 1 },
      { step: 'generate', reached: 1, completed: 1, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'preview', reached: 1, completed: 0, abandoned: 0, failed: 0, reachedShare: 1 },
    ]);
  });

  it('keeps every row inside the slice, the way the contract holds a funnel to', () => {
    for (const spec of SPECS) {
      for (const row of funnelOf(spec).funnel) {
        expect(row.reached).toBeLessThanOrEqual(spec.sessions.length);
        expect(row.completed + row.abandoned + row.failed).toBeLessThanOrEqual(row.reached);
      }
    }
  });
});

describe('the biggest drop', () => {
  it('names the step that lost the most, with a reason off a real session', () => {
    expect(funnelOf(sliceOf('segment:phone')).biggestDrop).toEqual({
      step: 'generate',
      left: 1,
      ofReached: 4,
      reason: 'gave up waiting for the render',
    });
  });

  it('can be the last step, where everybody got to the end and one gave up on it', () => {
    expect(funnelOf(sliceOf('variant:B')).funnel).toEqual([
      { step: 'landing', reached: 2, completed: 2, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'prompt', reached: 2, completed: 2, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'generate', reached: 2, completed: 2, abandoned: 0, failed: 0, reachedShare: 1 },
      { step: 'preview', reached: 2, completed: 1, abandoned: 1, failed: 0, reachedShare: 1 },
    ]);
    expect(funnelOf(sliceOf('variant:B')).biggestDrop).toEqual({
      step: 'preview',
      left: 1,
      ofReached: 2,
      reason: 'gave up waiting for the render',
    });
  });

  it('breaks a tie on the earliest step the run declares', () => {
    // The whole run loses one person on `prompt`, one on `generate` and one on `preview`.
    expect(funnelOf(sliceOf('all')).biggestDrop).toEqual({
      step: 'prompt',
      left: 1,
      ofReached: 5,
      reason: 'the prompt was rejected',
    });
  });

  it('is the one reason the most of them gave, not the first one stored', () => {
    const gaveUpOnGenerate = (sessionId: string, reason: string): Session => ({
      ...sessionOf('S-02'),
      sessionId,
      outcome: { ...sessionOf('S-02').outcome, reason },
    });

    expect(
      funnelOf(
        handSlice([
          gaveUpOnGenerate('S-21', 'the spinner never stopped'),
          gaveUpOnGenerate('S-22', 'nothing said it was working'),
          gaveUpOnGenerate('S-23', 'nothing said it was working'),
        ]),
      ).biggestDrop,
    ).toEqual({
      step: 'generate',
      left: 3,
      ofReached: 3,
      reason: 'nothing said it was working',
    });
  });

  it('is null on a slice that lost nobody at all', () => {
    // Both of them walked every step and finished, S-04 by way of a revisit.
    expect(funnelOf(handSlice([sessionOf('S-01'), sessionOf('S-04')])).biggestDrop).toBeNull();
  });
});
