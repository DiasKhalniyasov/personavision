import { sessionSchema, type Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { funnelSliceSpecs, pathsOfSlice, type FunnelSliceSpec } from '../src/index.js';
import { smallRun, smallRunSessions } from './fixtures/aggregate.js';

/**
 * The routes of the small fixture, read off the screens each session walked:
 *
 * | session | route                                                  |
 * | ------- | ------------------------------------------------------ |
 * | S-01    | landing, prompt, generate, preview                      |
 * | S-02    | landing, prompt, generate                               |
 * | S-03    | landing, prompt                                         |
 * | S-04    | landing, prompt, generate, prompt, preview (a revisit)   |
 * | S-06    | landing, prompt, generate, preview                      |
 *
 * S-01 and S-06 walked the same route, so that one is the only common path of the run.
 * S-05, the automation failure, walked `landing, prompt` and is in none of this.
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

const copyAs = (sessionId: string, of: string): Session => ({ ...sessionOf(of), sessionId });

/**
 * A copy of a fixture session that walked exactly these screens, looking once at each. The
 * step ids may repeat: that is how a scroll and then a click on one step are two screens.
 */
const walking = (sessionId: string, steps: readonly string[]): Session => {
  const base = sessionOf('S-01');
  const [screen] = base.screens;
  const [fixation] = base.fixations;
  if (screen === undefined || fixation === undefined) throw new Error('S-01 walked screens');
  const lastStep = steps[steps.length - 1];
  if (lastStep === undefined) throw new Error('a session walks at least one screen');

  return sessionSchema.parse({
    ...base,
    sessionId,
    durationMs: steps.length * 1000 + 500,
    screens: steps.map((step, index) => ({
      ...screen,
      index,
      step,
      screenshot: `screens/A-${step}.png`,
    })),
    fixations: steps.map((step, index) => ({
      ...fixation,
      index,
      screenIndex: index,
      tMs: index * 1000 + 100,
      aoiId: `a-${step}-body`,
    })),
    actions: [],
    outcome: { ...base.outcome, step: lastStep },
  });
};

const handSlice = (sessions: readonly Session[]): FunnelSliceSpec => ({
  key: 'hand',
  variant: null,
  segment: null,
  label: `Hand ${sessions.length}`,
  sessions,
});

const pathsOf = (slice: FunnelSliceSpec): ReturnType<typeof pathsOfSlice> =>
  pathsOfSlice({ slice });

describe('the common paths of a slice', () => {
  it('keeps the one route of the whole run that two people walked', () => {
    expect(pathsOf(sliceOf('all'))).toEqual([
      { steps: ['landing', 'prompt', 'generate', 'preview'], sessionCount: 2 },
    ]);
  });

  it('keeps nothing a single session walked, however it walked it', () => {
    const all = pathsOf(sliceOf('all'));

    expect(all.map((path) => path.steps)).not.toContainEqual([
      'landing',
      'prompt',
      'generate',
      'prompt',
      'preview',
    ]);
    expect(all.map((path) => path.steps)).not.toContainEqual(['landing', 'prompt']);
  });

  it('keeps no path at all on a slice of one person', () => {
    expect(sliceOf('segment:desktop').sessions).toHaveLength(1);
    expect(pathsOf(sliceOf('segment:desktop'))).toEqual([]);
  });

  it('keeps no path where every route is its own', () => {
    expect(pathsOf(sliceOf('variant:A'))).toEqual([]);
  });

  it('counts one segment of the run on its own', () => {
    expect(pathsOf(sliceOf('segment:phone'))).toEqual([
      { steps: ['landing', 'prompt', 'generate', 'preview'], sessionCount: 2 },
    ]);
  });

  it('keeps a route that went back and forward as one path with its repeats', () => {
    expect(pathsOf(handSlice([sessionOf('S-04'), copyAs('S-07', 'S-04')]))).toEqual([
      { steps: ['landing', 'prompt', 'generate', 'prompt', 'preview'], sessionCount: 2 },
    ]);
  });

  it('reads a step captured twice in a row as one visit to it', () => {
    // One of them scrolled on `prompt` and was captured again there; both walked the same
    // three screens, and a route taken screen by screen would match neither to the other.
    expect(
      pathsOf(
        handSlice([
          walking('S-11', ['landing', 'prompt', 'prompt', 'generate']),
          walking('S-12', ['landing', 'prompt', 'generate']),
        ]),
      ),
    ).toEqual([{ steps: ['landing', 'prompt', 'generate'], sessionCount: 2 }]);
  });

  it('keeps a revisit, which is the repeat the figure is about', () => {
    expect(
      pathsOf(
        handSlice([
          walking('S-13', ['landing', 'prompt', 'generate', 'generate', 'prompt', 'preview']),
          walking('S-14', ['landing', 'prompt', 'generate', 'prompt', 'prompt', 'preview']),
        ]),
      ),
    ).toEqual([
      {
        steps: ['landing', 'prompt', 'generate', 'prompt', 'preview'],
        sessionCount: 2,
      },
    ]);
  });

  it('orders the paths by how many walked them, commonest first', () => {
    expect(
      pathsOf(
        handSlice([
          sessionOf('S-01'),
          sessionOf('S-06'),
          sessionOf('S-02'),
          copyAs('S-08', 'S-02'),
          copyAs('S-09', 'S-02'),
        ]),
      ),
    ).toEqual([
      { steps: ['landing', 'prompt', 'generate'], sessionCount: 3 },
      { steps: ['landing', 'prompt', 'generate', 'preview'], sessionCount: 2 },
    ]);
  });

  it('breaks a tie on the route itself, so the file is the same on every machine', () => {
    const walked = [
      sessionOf('S-01'),
      sessionOf('S-06'),
      sessionOf('S-02'),
      copyAs('S-08', 'S-02'),
    ];

    expect(pathsOf(handSlice(walked))).toEqual([
      { steps: ['landing', 'prompt', 'generate'], sessionCount: 2 },
      { steps: ['landing', 'prompt', 'generate', 'preview'], sessionCount: 2 },
    ]);
    expect(pathsOf(handSlice([...walked].reverse()))).toEqual(pathsOf(handSlice(walked)));
  });
});
