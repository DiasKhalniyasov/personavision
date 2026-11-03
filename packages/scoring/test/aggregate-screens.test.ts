import {
  runSchema,
  sessionSchema,
  type Run,
  type ScreenSlice,
  type Session,
} from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { screenFiguresOfSlice, screenSliceSpecs } from '../src/index.js';
import { smallRun, smallRunSessions } from './fixtures/aggregate.js';

/**
 * The clicks and the scroll depth per screen, counted by hand off the small shared fixture.
 *
 * Every figure below is a value somebody can check against the fixture's own table: S-01
 * walks all four steps and scrolls the preview to 300, S-02 gives up on the generate screen,
 * S-03 is the one desktop session that counts, S-04 walks the prompt twice by way of a
 * `back`, S-05 is the automation failure that is in none of this, and S-06 reaches a generate
 * screen **nobody looked at**.
 */

type ScreenFigures = ScreenSlice['screens'][number];

/** The two areas the fixture declares per screen, and the clicks that named no area. */
interface Clicks {
  readonly body?: number;
  readonly primary?: number;
  readonly none?: number;
}

/**
 * One expected row, written out: the bins are given as the bars that are not empty, so a row
 * says which bin its people landed in rather than carrying ten numbers nine of which are nil.
 */
const row = (
  variant: string,
  step: string,
  expected: {
    readonly reached: number;
    readonly leftHere: number;
    readonly medianMsOnIt: number | null;
    readonly clicks?: Clicks;
    readonly bins?: Readonly<Record<number, number>>;
    readonly pastFoldSessions?: number;
  },
): ScreenFigures => ({
  variant,
  step,
  reached: expected.reached,
  leftHere: expected.leftHere,
  medianMsOnIt: expected.medianMsOnIt,
  clicksByAoi: [
    { aoiId: `${variant.toLowerCase()}-${step}-body`, clicks: expected.clicks?.body ?? 0 },
    { aoiId: `${variant.toLowerCase()}-${step}-primary`, clicks: expected.clicks?.primary ?? 0 },
    { aoiId: null, clicks: expected.clicks?.none ?? 0 },
  ],
  scrollDepth: {
    bins: Array.from({ length: 10 }, (_unused, bin) => expected.bins?.[bin] ?? 0),
    pastFoldSessions: expected.pastFoldSessions ?? 0,
  },
});

const figuresOf = (key: string): ScreenSlice['screens'] => {
  const slice = screenSliceSpecs(smallRun, smallRunSessions).find((spec) => spec.key === key);
  if (slice === undefined) throw new Error(`the fixture enumerates no "${key}" slice`);
  return screenFiguresOfSlice({ run: smallRun, slice });
};

const rowOf = (figures: ScreenSlice['screens'], variant: string, step: string): ScreenFigures => {
  const found = figures.find((one) => one.variant === variant && one.step === step);
  if (found === undefined) throw new Error(`no row for ${variant} ${step}`);
  return found;
};

describe('the screens of a slice', () => {
  it('counts the whole run, screen by screen and version by version', () => {
    expect(figuresOf('all')).toEqual([
      row('A', 'landing', { reached: 3, leftHere: 0, medianMsOnIt: 3000, bins: { 5: 3 } }),
      row('A', 'prompt', {
        reached: 3,
        leftHere: 1,
        medianMsOnIt: 4000,
        clicks: { primary: 3, none: 1 },
        bins: { 5: 3 },
      }),
      row('A', 'generate', {
        reached: 2,
        leftHere: 1,
        medianMsOnIt: 5500,
        clicks: { none: 1 },
        bins: { 5: 2 },
      }),
      row('A', 'preview', {
        reached: 1,
        leftHere: 1,
        medianMsOnIt: 5000,
        bins: { 7: 1 },
        pastFoldSessions: 1,
      }),
      row('B', 'landing', { reached: 2, leftHere: 0, medianMsOnIt: 2500, bins: { 5: 2 } }),
      row('B', 'prompt', {
        reached: 2,
        leftHere: 0,
        medianMsOnIt: 7000,
        clicks: { primary: 3 },
        bins: { 5: 2 },
      }),
      row('B', 'generate', { reached: 2, leftHere: 0, medianMsOnIt: 5000, bins: { 5: 2 } }),
      row('B', 'preview', {
        reached: 2,
        leftHere: 2,
        medianMsOnIt: 5500,
        bins: { 5: 1, 6: 1 },
        pastFoldSessions: 1,
      }),
    ]);
  });

  it('counts a segment slice: the one desktop session, and zeroes where it never got', () => {
    expect(figuresOf('segment:desktop')).toEqual([
      row('A', 'landing', { reached: 1, leftHere: 0, medianMsOnIt: 2000, bins: { 5: 1 } }),
      row('A', 'prompt', {
        reached: 1,
        leftHere: 1,
        medianMsOnIt: 4000,
        clicks: { primary: 1, none: 1 },
        bins: { 5: 1 },
      }),
      row('A', 'generate', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('A', 'preview', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('B', 'landing', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('B', 'prompt', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('B', 'generate', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('B', 'preview', { reached: 0, leftHere: 0, medianMsOnIt: null }),
    ]);
  });

  it('counts an outcome slice: the two who gave up, on both versions', () => {
    expect(figuresOf('outcome:abandoned')).toEqual([
      row('A', 'landing', { reached: 1, leftHere: 0, medianMsOnIt: 3000, bins: { 5: 1 } }),
      row('A', 'prompt', {
        reached: 1,
        leftHere: 0,
        medianMsOnIt: 4000,
        clicks: { primary: 1 },
        bins: { 5: 1 },
      }),
      row('A', 'generate', { reached: 1, leftHere: 1, medianMsOnIt: 5000, bins: { 5: 1 } }),
      row('A', 'preview', { reached: 0, leftHere: 0, medianMsOnIt: null }),
      row('B', 'landing', { reached: 1, leftHere: 0, medianMsOnIt: 2000, bins: { 5: 1 } }),
      row('B', 'prompt', {
        reached: 1,
        leftHere: 0,
        medianMsOnIt: 4000,
        clicks: { primary: 1 },
        bins: { 5: 1 },
      }),
      // The screen nobody looked at: reached, and nothing measured on it.
      row('B', 'generate', { reached: 1, leftHere: 0, medianMsOnIt: null, bins: { 5: 1 } }),
      row('B', 'preview', { reached: 1, leftHere: 1, medianMsOnIt: 4000, bins: { 5: 1 } }),
    ]);
  });

  it('counts a segment-and-outcome slice: the people on phones who finished', () => {
    expect(figuresOf('segment:phone|outcome:success')).toEqual([
      row('A', 'landing', { reached: 1, leftHere: 0, medianMsOnIt: 4000, bins: { 5: 1 } }),
      row('A', 'prompt', {
        reached: 1,
        leftHere: 0,
        medianMsOnIt: 5000,
        clicks: { primary: 1 },
        bins: { 5: 1 },
      }),
      row('A', 'generate', {
        reached: 1,
        leftHere: 0,
        medianMsOnIt: 6000,
        clicks: { none: 1 },
        bins: { 5: 1 },
      }),
      row('A', 'preview', {
        reached: 1,
        leftHere: 1,
        medianMsOnIt: 5000,
        bins: { 7: 1 },
        pastFoldSessions: 1,
      }),
      row('B', 'landing', { reached: 1, leftHere: 0, medianMsOnIt: 3000, bins: { 5: 1 } }),
      // The prompt twice, by way of the `back`: one row, and the two spans added up.
      row('B', 'prompt', {
        reached: 1,
        leftHere: 0,
        medianMsOnIt: 10_000,
        clicks: { primary: 2 },
        bins: { 5: 1 },
      }),
      row('B', 'generate', { reached: 1, leftHere: 0, medianMsOnIt: 5000, bins: { 5: 1 } }),
      row('B', 'preview', {
        reached: 1,
        leftHere: 1,
        medianMsOnIt: 7000,
        bins: { 6: 1 },
        pastFoldSessions: 1,
      }),
    ]);
  });
});

describe('where the clicks landed', () => {
  it('counts the clicks that named no area under no area rather than dropping them', () => {
    const generate = rowOf(figuresOf('all'), 'A', 'generate');

    expect(generate.clicksByAoi).toEqual([
      { aoiId: 'a-generate-body', clicks: 0 },
      { aoiId: 'a-generate-primary', clicks: 0 },
      { aoiId: null, clicks: 1 },
    ]);
  });

  it('gives an area nobody clicked a row reading zero', () => {
    const prompt = rowOf(figuresOf('all'), 'A', 'prompt');

    expect(prompt.clicksByAoi.find((entry) => entry.aoiId === 'a-prompt-body')).toEqual({
      aoiId: 'a-prompt-body',
      clicks: 0,
    });
  });

  it('counts a click whether it worked or not: the failed session pressed the button', () => {
    const prompt = rowOf(figuresOf('segment:desktop'), 'A', 'prompt');

    expect(prompt.clicksByAoi).toEqual([
      { aoiId: 'a-prompt-body', clicks: 0 },
      { aoiId: 'a-prompt-primary', clicks: 1 },
      { aoiId: null, clicks: 1 },
    ]);
  });
});

describe('how far down they got', () => {
  it('counts a session that never scrolled as having seen its own first screen and no fold', () => {
    // The desktop session: it saw the 900 its own screen holds of a 1600-tall page, which is
    // the sixth of the ten bands down the page, and it scrolled past nothing.
    const prompt = rowOf(figuresOf('segment:desktop'), 'A', 'prompt');

    expect(prompt.scrollDepth).toEqual({
      bins: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      pastFoldSessions: 0,
    });
  });

  it('bins the deepest point they saw: the position they scrolled to plus their own screen', () => {
    const all = figuresOf('all');

    // S-01 scrolled the preview to 300 and read on an 844-tall screen: 1144 of 1600, the
    // eighth band, and past the 844 fold.
    expect(rowOf(all, 'A', 'preview').scrollDepth).toEqual({
      bins: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      pastFoldSessions: 1,
    });
    // S-04 was at 120, so 964 of 1600 — one band further down than S-06, who scrolled
    // nowhere at all and is past no fold.
    expect(rowOf(all, 'B', 'preview').scrollDepth).toEqual({
      bins: [0, 0, 0, 0, 0, 1, 1, 0, 0, 0],
      pastFoldSessions: 1,
    });
  });

  it('gives a screen nobody reached empty bins rather than leaving the row out', () => {
    expect(rowOf(figuresOf('segment:desktop'), 'B', 'preview')).toEqual(
      row('B', 'preview', { reached: 0, leftHere: 0, medianMsOnIt: null }),
    );
  });
});

/** The fixture's own run and S-01, with a page too short to hold the scroll it records. */
const shortPage = (): { run: Run; session: Session } => {
  const run = runSchema.parse({
    ...structuredClone(smallRun),
    screenshots: smallRun.screenshots.map((shot) => ({ ...shot, pageHeight: 400 })),
  });
  const original = smallRunSessions.find((one) => one.sessionId === 'S-01');
  if (original === undefined) throw new Error('the fixture carries no S-01');
  const session = sessionSchema.parse({
    ...structuredClone(original),
    screens: original.screens.map((screen) =>
      screen.step === 'preview' ? { ...screen, scrollY: 600 } : screen,
    ),
  });
  return { run, session };
};

describe('a page shorter than the fold', () => {
  it('does not produce a share above one: the deepest point is the last bin', () => {
    const { run, session } = shortPage();

    const figures = screenFiguresOfSlice({
      run,
      slice: {
        key: 'all',
        segment: null,
        outcome: null,
        label: 'Every outcome',
        sessions: [session],
      },
    });

    expect(rowOf(figures, 'A', 'preview').scrollDepth).toEqual({
      bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      pastFoldSessions: 1,
    });
  });

  it('claims nothing about a screen the run captured no screenshot of', () => {
    const { session } = shortPage();
    const run = runSchema.parse({
      ...structuredClone(smallRun),
      screenshots: smallRun.screenshots.filter((shot) => shot.step !== 'preview'),
    });

    const figures = screenFiguresOfSlice({
      run,
      slice: {
        key: 'all',
        segment: null,
        outcome: null,
        label: 'Every outcome',
        sessions: [session],
      },
    });

    expect(rowOf(figures, 'A', 'preview').scrollDepth).toEqual({
      bins: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      pastFoldSessions: 0,
    });
  });
});

/**
 * S-06 with a click and a scroll made on its generate screen — **the screen nobody looked
 * at**. A session's clock only moves on its fixations, so both land in the span of the screen
 * before it: the step walk alone would count them against the prompt.
 */
const clickedWithoutLooking = (): Session => {
  const original = smallRunSessions.find((one) => one.sessionId === 'S-06');
  if (original === undefined) throw new Error('the fixture carries no S-06');
  return sessionSchema.parse({
    ...structuredClone(original),
    actions: [
      ...original.actions,
      {
        tMs: 5000,
        type: 'click',
        target: '#b-generate-primary',
        aoiId: 'b-generate-primary',
        value: null,
        ok: true,
      },
    ].sort((one, other) => one.tMs - other.tMs),
  });
};

describe('a click on a screen nobody looked at', () => {
  it('is counted on the screen the area it landed on is on', () => {
    const figures = screenFiguresOfSlice({
      run: smallRun,
      slice: {
        key: 'all',
        segment: null,
        outcome: null,
        label: 'Every outcome',
        sessions: [clickedWithoutLooking()],
      },
    });

    expect(rowOf(figures, 'B', 'generate').clicksByAoi).toEqual([
      { aoiId: 'b-generate-body', clicks: 0 },
      { aoiId: 'b-generate-primary', clicks: 1 },
      { aoiId: null, clicks: 0 },
    ]);
    // And not against a control the prompt screen does not have.
    expect(rowOf(figures, 'B', 'prompt').clicksByAoi).toEqual([
      { aoiId: 'b-prompt-body', clicks: 0 },
      { aoiId: 'b-prompt-primary', clicks: 1 },
      { aoiId: null, clicks: 0 },
    ]);
  });
});

describe('who is in the counts', () => {
  it('has the automation failure in no figure, through the shared reading', () => {
    const slices = screenSliceSpecs(smallRun, smallRunSessions);
    const everybody = slices.find((slice) => slice.key === 'all');
    if (everybody === undefined) throw new Error('the fixture enumerates no "all" slice');

    // S-05 is the automation failure, and it is the only desktop session on version B: the
    // whole run's own landing row on B counts the two phone sessions and nobody else.
    expect(everybody.sessions.map((session) => session.sessionId)).not.toContain('S-05');
    expect(rowOf(figuresOf('all'), 'B', 'landing').reached).toBe(2);
    expect(slices.map((slice) => slice.key)).not.toContain('outcome:automation_failure');
  });
});
