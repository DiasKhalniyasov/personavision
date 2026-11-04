// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { aggregateSchema, runPaths, runSchema } from '@personavision/contract';
import type { Aggregate, Run, ScreenSlice } from '@personavision/contract';
import { readRunFile } from '../../../tests/app';
import { attentionAreas } from './useAttentionAreas';
import { screenFiguresFrom } from './useScreenFigures';
import type { ScreenFiguresView } from './useScreenFigures';
import { ThisStepPanel } from './ThisStepPanel';
import '../../../tests/setup';

/**
 * The *This screen* readings of `#screen-heatmaps`, over the repository's own committed
 * example run and the aggregate committed beside it.
 *
 * **What this suite is really asserting is that nothing here is computed.** Every figure the
 * panel prints is looked up in `aggregate.json` and printed, so each test below names a
 * stored field and the words it turns into — and the last of them changes a stored field and
 * watches the panel follow it, which is the only way to tell a reading from a re-derivation.
 *
 * The five states that are not a figure get their own tests, because each is a different
 * fact about the audience and the panel must not print a zero for any of them: a run with no
 * aggregate, a file that will not parse, a composition nobody satisfies, a screen none of
 * these people reached, and a read still in flight.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));
const seedAggregate = (): Aggregate => aggregateSchema.parse(readRunFile(RUN_ID, layout.aggregate));

/** The hook's answer, built from a state rather than from a server. */
const figuresFor = (
  aggregate: Aggregate,
  variant: string,
  step: string,
  segment: string | null = null,
  outcome: string | null = null,
): ScreenFiguresView =>
  screenFiguresFrom({ status: 'ready', aggregate }, variant, step, segment, outcome);

const stepOf = (run: Run, step: string) =>
  run.steps.find((candidate) => candidate.id === step) as Run['steps'][number];

/** What the panel reads for one heading, so a test asserts a reading and not a layout. */
const reading = (term: string): string =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

/** The clicks row's term, which names what it counts rather than the area it counts on. */
const clicksTerm = (): string =>
  screen.getByText(/^Clicks on /, { selector: 'dt' }).textContent ?? '';

const panel = (options: { run: Run; step: string; variant: string; screen: ScreenFiguresView }) => {
  const { run, step, variant } = options;
  const { areas } = attentionAreas(run, variant, step);
  return render(<ThisStepPanel step={stepOf(run, step)} screen={options.screen} areas={areas} />);
};

describe('the five readings of one screen', () => {
  it('reads all five out of the aggregate’s slice, and computes none of them', () => {
    const run = seedRun();
    const aggregate = seedAggregate();
    panel({ run, variant: 'B', step: 'review', screen: figuresFor(aggregate, 'B', 'review') });

    // Each of these is one stored field, printed. The redesign's review screen: nine of the
    // test's twenty-two scored people got there, seven of those nine left on it.
    expect(reading('Reached it')).toBe('9 of 22');
    expect(reading('Left here')).toBe('7 of 9');
    expect(reading('Median time on it')).toBe('10.8 s');
    expect(reading('Scrolled past the fold')).toBe('9 of 9');
    // Clicks, not people: a press count over a population would read `6 of 1 people` on a
    // screen one person pressed six times.
    expect(reading(clicksTerm())).toBe('2 clicks');
  });

  it('names the clicks row for what is stored, not for a repeat press', () => {
    const run = seedRun();
    panel({
      run,
      variant: 'B',
      step: 'review',
      screen: figuresFor(seedAggregate(), 'B', 'review'),
    });

    // Not "second click on …": what is stored is clicks on an area, and whether one is a
    // repeat depends on the screen (decision 137). The term is fixed words rather than the
    // area's own label, which a run may make as long as it likes.
    expect(clicksTerm()).toBe('Clicks on the primary action');
  });

  it('follows the stored figure rather than its own arithmetic', () => {
    const run = seedRun();
    const aggregate = seedAggregate();
    // One field changed in the file, and nothing else: a panel that re-derived this from the
    // sessions on disk would print the old number and this test would fail.
    const changed: Aggregate = {
      ...aggregate,
      screenSlices: aggregate.screenSlices.map((slice) =>
        slice.segment === null && slice.outcome === null
          ? ({
              ...slice,
              screens: slice.screens.map((one) =>
                one.variant === 'B' && one.step === 'review' ? { ...one, leftHere: 3 } : one,
              ),
            } as ScreenSlice)
          : slice,
      ),
    };

    panel({ run, variant: 'B', step: 'review', screen: figuresFor(changed, 'B', 'review') });
    expect(reading('Left here')).toBe('3 of 9');
  });

  it('reads the slice the filters compose to, not the whole run’s', () => {
    const run = seedRun();
    const aggregate = seedAggregate();
    const everybody = figuresFor(aggregate, 'B', 'review');
    const gaveUp = figuresFor(aggregate, 'B', 'review', null, 'abandoned');

    panel({ run, variant: 'B', step: 'review', screen: everybody }).unmount();
    panel({ run, variant: 'B', step: 'review', screen: gaveUp });

    const slice = aggregate.screenSlices.find(
      (one) => one.segment === null && one.outcome === 'abandoned',
    ) as ScreenSlice;
    const stored = slice.screens.find(
      (one) => one.variant === 'B' && one.step === 'review',
    ) as ScreenSlice['screens'][number];
    expect(reading('Reached it')).toBe(`${stored.reached} of ${slice.sessionCount}`);
  });

  it('says nobody was timed on a screen whose median the aggregate stores as null', () => {
    const run = seedRun();
    const aggregate = seedAggregate();
    // The people who gave up never reached the payment screen on A, so nothing timed them
    // on it: `medianMsOnIt` is null, which is not nought seconds.
    panel({
      run,
      variant: 'A',
      step: 'payment',
      screen: figuresFor(aggregate, 'A', 'payment', null, 'abandoned'),
    });
    expect(reading('Median time on it')).toBe('nobody was timed on it');
  });
});

describe('the five readings that are not a figure', () => {
  const states: ReadonlyArray<[string, ScreenFiguresView, string]> = [
    [
      'still reading',
      screenFiguresFrom({ status: 'loading' }, 'B', 'review', null, null),
      'reading…',
    ],
    [
      'a run that computed no aggregate',
      screenFiguresFrom({ status: 'none' }, 'B', 'review', null, null),
      'not computed',
    ],
    [
      'an aggregate that will not parse',
      screenFiguresFrom(
        { status: 'unreadable', runId: RUN_ID, url: '/x', problem: 'it is not valid JSON' },
        'B',
        'review',
        null,
        null,
      ),
      'unreadable',
    ],
  ];

  for (const [what, state, words] of states) {
    it(`prints no figure for ${what}, and says so in words`, () => {
      panel({ run: seedRun(), variant: 'B', step: 'review', screen: state });
      expect(reading('Reached it')).toBe(words);
      expect(reading('Left here')).toBe(words);
      expect(reading('Median time on it')).toBe(words);
      expect(reading('Scrolled past the fold')).toBe(words);
    });
  }

  it('prints no figure for a composition no session satisfies', () => {
    const aggregate = seedAggregate();
    // The aggregate stores no slice for the people who are both, which means there are none.
    panel({
      run: seedRun(),
      variant: 'B',
      step: 'review',
      screen: figuresFor(aggregate, 'B', 'review', 'mobile · price-sensitive', 'failed'),
    });
    expect(reading('Reached it')).toBe('nobody matches');
  });

  it('prints no figure for a screen none of these people reached', () => {
    const aggregate = seedAggregate();
    const slice = aggregate.screenSlices.find(
      (one) => one.segment === null && one.outcome === null,
    ) as ScreenSlice;
    // A slice with this version's step taken out of it: these people exist, and the
    // aggregate holds no row for them on this screen.
    const thinned: Aggregate = {
      ...aggregate,
      screenSlices: aggregate.screenSlices.map((one) =>
        one === slice
          ? ({
              ...one,
              screens: one.screens.filter((row) => !(row.variant === 'B' && row.step === 'review')),
            } as ScreenSlice)
          : one,
      ),
    };

    panel({
      run: seedRun(),
      variant: 'B',
      step: 'review',
      screen: figuresFor(thinned, 'B', 'review'),
    });
    expect(reading('Reached it')).toBe('none reached it');
  });
});
