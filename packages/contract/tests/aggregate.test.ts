import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Aggregate, Violation } from '../src/index.js';
import {
  aggregateSchema,
  readRun,
  runPaths,
  SCHEMA_VERSION,
  validate,
  writeAggregate,
  writeRun,
} from '../src/index.js';
import {
  CART,
  CHECKOUT_AOI,
  CONFIRM,
  funnelSliceOf,
  oneVariantArtifact,
  SEGMENT,
  temporaryRunDir,
  validAggregate,
  validArtifact,
} from './fixtures.js';

/**
 * `aggregate.json`: the one agreed shape the funnel, the timing, the bins and the paths are
 * written into, and the run directory it is optional in.
 *
 * The figures come from `docs/FLOW.md` section 14 read against `#screen-funnel` and
 * `#screen-heatmaps` of `docs/design/prototype.html`, so that every number on those screens
 * has a stored field. What is asserted here is the two rules that make four parallel workers
 * agree without meeting — a slice no session falls in is left out, and every millisecond is
 * an integer while every share is rounded to four places — and the references, which are held
 * to the names `run.json` declares exactly as a citation is.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const rejections = (document: unknown): string[] => {
  const result = aggregateSchema.safeParse(document);
  if (result.success) throw new Error('the document was accepted, and should not have been');
  return result.error.issues.map((issue) => `${issue.path.join('/')} — ${issue.message}`);
};

const paths = (document: unknown): string[] =>
  rejections(document).map((rejection) => rejection.split(' — ')[0]);

const accepted = (document: unknown): Aggregate => aggregateSchema.parse(document);

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

/** The fixture with its whole-run funnel slice changed; it stays the whole-run slice. */
const withWholeRunSlice = (changes: Record<string, unknown>): unknown => {
  const document = validAggregate();
  const [whole, ...rest] = document.funnelSlices;
  return { ...document, funnelSlices: [{ ...whole, ...changes }, ...rest] };
};

/** The fixture with the outcome its first screen slice is filtered to changed. */
const withScreenSliceOutcome = (outcome: string): unknown => {
  const document = validAggregate();
  const [slice, ...rest] = document.screenSlices;
  return { ...document, screenSlices: [{ ...slice, outcome }, ...rest] };
};

/** The fixture with its first screen row changed. */
const withScreen = (changes: Record<string, unknown>): unknown => {
  const document = validAggregate();
  const [slice, ...rest] = document.screenSlices;
  const [screen, ...others] = slice.screens;
  return {
    ...document,
    screenSlices: [{ ...slice, screens: [{ ...screen, ...changes }, ...others] }, ...rest],
  };
};

describe('the aggregate file', () => {
  it('states what it is of, and that a reader may be looking at an open run', () => {
    const aggregate = accepted(validAggregate());

    expect(aggregate.schemaVersion).toBe(SCHEMA_VERSION);
    expect(aggregate.runStatus).toBe('finished');
    expect(aggregate.scoredSessionCount).toBe(2);
    expect(aggregate.excludedAutomationFailures).toBe(0);
  });

  it('carries the funnel, the timing, the paths and the figures per screen', () => {
    const aggregate = accepted(validAggregate());
    const [whole] = aggregate.funnelSlices;

    expect(whole.key).toBe('all');
    expect(whole.variant).toBeNull();
    expect(whole.segment).toBeNull();
    expect(whole.label).toBe('Every segment');
    expect(whole.funnel.map((row) => row.step)).toEqual([CART, CONFIRM]);
    expect(whole.funnel[0]).toEqual({
      step: CART,
      reached: 2,
      completed: 2,
      abandoned: 0,
      failed: 0,
      reachedShare: 1,
    });
    expect(whole.biggestDrop).toBeNull();
    expect(whole.timing.total.p50Ms).toBe(38_000);
    expect(whole.timing.total.bins.reduce((total, bin) => total + bin, 0)).toBe(2);
    expect(whole.timing.perStep.map((row) => row.step)).toEqual([CART, CONFIRM]);
    expect(whole.timing.slowest[0]).toEqual({
      sessionId: 'S-01',
      totalMs: 38_000,
      dominantStep: CART,
      dominantStepMs: 12_000,
    });
    expect(whole.paths).toEqual([{ steps: [CART, CONFIRM], sessionCount: 2 }]);

    const [everyOutcome] = aggregate.screenSlices;
    expect(everyOutcome.segment).toBeNull();
    expect(everyOutcome.outcome).toBeNull();
    expect(everyOutcome.screens[0]).toEqual({
      variant: 'A',
      step: CART,
      reached: 1,
      leftHere: 0,
      medianMsOnIt: 12_000,
      clicksByAoi: [{ aoiId: CHECKOUT_AOI, clicks: 1 }],
      scrollDepth: { bins: [1], pastFoldSessions: 0 },
    });
  });

  it('slices the two screens the two ways they filter', () => {
    const aggregate = accepted(validAggregate());

    expect(aggregate.funnelSlices.map((slice) => [slice.segment, slice.variant])).toEqual([
      [null, null],
      [SEGMENT, null],
      [null, 'A'],
    ]);
    // The Heatmaps screen composes a segment and an outcome, so the pair is a slice of its own.
    expect(aggregate.screenSlices.map((slice) => [slice.segment, slice.outcome])).toEqual([
      [null, null],
      [SEGMENT, 'success'],
    ]);
  });

  it('counts the clicks that landed on nothing the DOM explained as their own row', () => {
    const [, onNothing] = accepted(validAggregate()).screenSlices[0].screens;

    expect(onNothing.clicksByAoi).toEqual([{ aoiId: null, clicks: 1 }]);
  });

  it('declares no "automation_failure" outcome to slice by', () => {
    const [rejection] = rejections(withScreenSliceOutcome('automation_failure'));

    expect(rejection).toContain('screenSlices/0/outcome');
  });

  it('is rejected for a field the contract does not declare', () => {
    // Pixel-level click points are the field this file deliberately does not have.
    expect(rejections({ ...validAggregate(), clickPoints: [] })[0]).toContain('clickPoints');
    expect(rejections(withWholeRunSlice({ conversionLift: 0.1 }))[0]).toContain('conversionLift');
  });

  it('is rejected for a schemaVersion it was not written for', () => {
    const [rejection] = rejections({ ...validAggregate(), schemaVersion: SCHEMA_VERSION + 1 });

    expect(rejection).toContain('schemaVersion');
  });
});

/** The one rounding rule of the file, which is what makes re-aggregating it a no-op. */
describe('the aggregate rounds one way', () => {
  it('rejects a millisecond figure that is not whole', () => {
    expect(paths(withScreen({ medianMsOnIt: 12_000.5 }))).toEqual([
      'screenSlices/0/screens/0/medianMsOnIt',
    ]);
  });

  it('rejects a share written to more than four decimal places', () => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    const [first, ...rest] = whole.funnel;
    const [rejection] = rejections(
      withWholeRunSlice({
        funnel: [{ ...first, reached: 1, completed: 1, reachedShare: 0.500_01 }, ...rest],
      }),
    );

    expect(rejection).toContain('funnelSlices/0/funnel/0/reachedShare');
    expect(rejection).toContain('rounded to 4 decimal places');
  });

  it('rejects a share that is not the count it claims to be of', () => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    const [first, ...rest] = whole.funnel;
    const [rejection] = rejections(
      withWholeRunSlice({
        funnel: [{ ...first, reached: 1, completed: 1, reachedShare: 1 }, ...rest],
      }),
    );

    expect(rejection).toContain('funnelSlices/0/funnel/0/reachedShare');
    expect(rejection).toContain('expected 0.5, found 1');
  });
});

describe('a figure of nobody is left out rather than stored as a zero', () => {
  it('rejects a slice no session falls in', () => {
    expect(paths(withWholeRunSlice({ sessionCount: 0 }))).toContain('funnelSlices/0/sessionCount');
  });

  it('rejects a distribution of no samples', () => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    const total = { ...whole.timing.total, sampleCount: 0, bins: [0] };

    expect(paths(withWholeRunSlice({ timing: { ...whole.timing, total } }))).toContain(
      'funnelSlices/0/timing/total/sampleCount',
    );
  });

  it('stores no slice at all for an aggregate of nothing scored yet', () => {
    const open = { ...validAggregate(), runStatus: 'open' as const, scoredSessionCount: 0 };

    expect(accepted({ ...open, funnelSlices: [], screenSlices: [] }).funnelSlices).toEqual([]);
    expect(paths(open)).toEqual(['funnelSlices', 'screenSlices']);
  });
});

describe('the slices agree with the summary they are read beside', () => {
  it('holds the whole run as a slice of its own', () => {
    const document = validAggregate();
    const [rejection] = rejections({ ...document, funnelSlices: document.funnelSlices.slice(1) });

    expect(rejection).toContain('funnelSlices');
    expect(rejection).toContain('every version and every segment');
  });

  it('rejects a whole-run slice that disagrees with the count the file is of', () => {
    const [rejection] = rejections({ ...validAggregate(), scoredSessionCount: 3 });

    expect(rejection).toContain('it carries 2 sessions and the aggregate is of 3');
  });

  it('rejects a slice holding more people than the run scored', () => {
    const document = validAggregate();
    const [whole, , variantSlice] = document.funnelSlices;
    // Internally consistent for nine sessions, and the run scored two.
    const nine = funnelSliceOf('segment:phone', 'Phone 9', 9, { segment: 'phone · first time' });
    const [rejection] = rejections({ ...document, funnelSlices: [whole, nine, variantSlice] });

    expect(rejection).toContain('funnelSlices/1/sessionCount');
    expect(rejection).toContain('a slice is a narrowing of the run');
  });

  it('rejects two slices narrowing to the same people under different keys', () => {
    const document = validAggregate();
    const [everyOutcome, pair] = document.screenSlices;
    const [rejection] = rejections({
      ...document,
      screenSlices: [everyOutcome, pair, { ...pair, key: 'another-name-for-the-same-people' }],
    });

    expect(rejection).toContain('screenSlices/2');
    expect(rejection).toContain('one filter is one slice');
  });

  it('rejects two slices answering to one key', () => {
    const document = validAggregate();
    const [whole, segment] = document.funnelSlices;

    expect(paths({ ...document, funnelSlices: [whole, { ...segment, key: whole.key }] })).toContain(
      'funnelSlices/1/key',
    );
  });
});

describe('a distribution is quantiles plus the bars behind them', () => {
  const withTotal = (changes: Record<string, unknown>): unknown => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    return withWholeRunSlice({
      timing: { ...whole.timing, total: { ...whole.timing.total, ...changes } },
    });
  };

  it('rejects quantiles that do not rise', () => {
    const [rejection] = rejections(withTotal({ p75Ms: 1_000 }));

    expect(rejection).toContain('funnelSlices/0/timing/total/p75Ms');
    expect(rejection).toContain('the quantiles of a distribution rise');
  });

  it('rejects bars that do not account for every sample', () => {
    const [rejection] = rejections(withTotal({ bins: [1], medianBin: 0 }));

    expect(rejection).toContain('funnelSlices/0/timing/total/bins');
    expect(rejection).toContain('these hold 1 and the distribution is of 2');
  });

  it('rejects a median bar that is not one of the bars', () => {
    const [rejection] = rejections(withTotal({ medianBin: 99 }));

    expect(rejection).toContain('funnelSlices/0/timing/total/medianBin');
  });

  it('rejects a median bar the median does not fall in', () => {
    // 38 s of 5 s bars is the eighth bar, and a dark first bar beside a median of 38 s is
    // the screen disagreeing with the numbers printed next to it.
    const [rejection] = rejections(withTotal({ bins: [2], medianBin: 0 }));

    expect(rejection).toContain('funnelSlices/0/timing/total/medianBin');
    expect(rejection).toContain('falls in bar 7');
  });

  it('rejects bars that do not reach the figures they are of', () => {
    const [rejection] = rejections(withTotal({ p90Ms: 90_000 }));

    expect(rejection).toContain('funnelSlices/0/timing/total/bins');
    expect(rejection).toContain('these reach 40000 ms and the 90th is 90000 ms');
  });
});

describe('the funnel of a slice', () => {
  it('rejects a step listed twice', () => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    const [first] = whole.funnel;

    expect(paths(withWholeRunSlice({ funnel: [first, first] }))).toContain(
      'funnelSlices/0/funnel/1/step',
    );
  });

  it('rejects more people becoming something than reached the step', () => {
    const document = validAggregate();
    const [whole] = document.funnelSlices;
    const [first, ...rest] = whole.funnel;
    const [rejection] = rejections(
      withWholeRunSlice({ funnel: [{ ...first, abandoned: 2 }, ...rest] }),
    );

    expect(rejection).toContain('funnelSlices/0/funnel/0');
    expect(rejection).toContain('what became of the people who reached the step');
  });

  it('rejects a biggest drop that is not one of its own rows', () => {
    const [rejection] = rejections(
      withWholeRunSlice({
        biggestDrop: { step: 'wishlist', left: 1, ofReached: 2, reason: 'Gave up waiting.' },
      }),
    );

    expect(rejection).toContain('funnelSlices/0/biggestDrop/step');
    expect(rejection).toContain('is not one');
  });

  it('accepts the biggest drop with the commonest reason beside it', () => {
    const drop = { step: CONFIRM, left: 1, ofReached: 2, reason: 'Could not find Complete order.' };

    expect(accepted(withWholeRunSlice({ biggestDrop: drop })).funnelSlices[0].biggestDrop).toEqual(
      drop,
    );
  });
});

describe('the screens of a slice', () => {
  it('rejects two rows for one version and step', () => {
    const document = validAggregate();
    const [slice, ...rest] = document.screenSlices;
    const [screen] = slice.screens;

    expect(
      paths({ ...document, screenSlices: [{ ...slice, screens: [screen, screen] }, ...rest] }),
    ).toContain('screenSlices/0/screens/1');
  });

  it('rejects more people leaving a screen than reached it', () => {
    const [rejection] = rejections(withScreen({ leftHere: 2 }));

    expect(rejection).toContain('screenSlices/0/screens/0/leftHere');
  });

  it('rejects more people past the fold than reached the screen', () => {
    const [rejection] = rejections(withScreen({ scrollDepth: { bins: [1], pastFoldSessions: 2 } }));

    expect(rejection).toContain('screenSlices/0/screens/0/scrollDepth/pastFoldSessions');
  });

  it('rejects one area of interest counted twice', () => {
    const [rejection] = rejections(
      withScreen({
        clicksByAoi: [
          { aoiId: CHECKOUT_AOI, clicks: 1 },
          { aoiId: CHECKOUT_AOI, clicks: 2 },
        ],
      }),
    );

    expect(rejection).toContain('screenSlices/0/screens/0/clicksByAoi/1/aoiId');
  });

  it('rejects a scroll-depth bar holding more sessions than reached the screen', () => {
    const [rejection] = rejections(
      withScreen({ scrollDepth: { bins: [1, 2], pastFoldSessions: 1 } }),
    );

    expect(rejection).toContain('screenSlices/0/screens/0/scrollDepth/bins/1');
  });

  it('rejects a slice with no screen behind it', () => {
    const document = validAggregate();
    const [slice, ...rest] = document.screenSlices;

    expect(paths({ ...document, screenSlices: [{ ...slice, screens: [] }, ...rest] })).toContain(
      'screenSlices/0/screens',
    );
  });

  it('accepts a screen nobody was timed on as a null, not a zero', () => {
    expect(
      accepted(withScreen({ medianMsOnIt: null })).screenSlices[0].screens[0].medianMsOnIt,
    ).toBeNull();
  });
});

describe('the aggregate in a run directory', () => {
  let dir = '';
  let cleanup = async (): Promise<void> => {};

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('is absent for a run that computed none, which is not a violation', async () => {
    const artifact = await readRun(dir);

    expect(artifact.aggregate).toBeUndefined();
    expect(await validate(dir)).toEqual([]);
  });

  it('writes, reads back and is the same value', async () => {
    const aggregate = validAggregate();
    await writeAggregate(dir, aggregate);

    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).aggregate).toEqual(aggregate);
  });

  it('survives writeRun handed the artifact it was read from, byte for byte', async () => {
    await writeAggregate(dir, validAggregate());
    const written = await readFile(runPaths(dir).aggregate, 'utf8');

    await writeRun(dir, await readRun(dir));

    expect(await readFile(runPaths(dir).aggregate, 'utf8')).toBe(written);
    expect((await readRun(dir)).aggregate).toEqual(validAggregate());
  });

  it('is removed by writeRun handed a run that carries none, rather than left to contradict it', async () => {
    await writeAggregate(dir, validAggregate());

    // The same run with one variant and one session: the stored aggregate names the other
    // variant and the other session, so a directory that kept it could never be read again.
    await writeRun(dir, oneVariantArtifact());

    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).aggregate).toBeUndefined();
  });

  it('reports an aggregate that is not one as violations of its own, not as a crash', async () => {
    await expect(writeRun(dir, { ...validArtifact(), aggregate: {} as Aggregate })).rejects.toThrow(
      /aggregate\.json/,
    );
  });

  it('refuses to write one that would not read back', async () => {
    await expect(
      writeAggregate(dir, { ...validAggregate(), scoredSessionCount: 3 }),
    ).rejects.toThrow(/aggregate\.json/);
  });

  it('reports a file that is not valid JSON against the file itself', async () => {
    await writeFile(runPaths(dir).aggregate, '{');

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([label.aggregate]);
    expect(violations[0].message).toMatch(/not valid JSON/);
  });

  it('reports a field the contract does not declare at the field itself', async () => {
    const document = { ...validAggregate(), clickPoints: [] };
    await writeFile(runPaths(dir).aggregate, `${JSON.stringify(document, null, 2)}\n`);

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([`${label.aggregate}/clickPoints`]);
    expect(violations[0].message).toMatch(/the contract declares no "clickPoints" here/);
  });

  it('reports a schemaVersion it was not written for against that field', async () => {
    const document = { ...validAggregate(), schemaVersion: SCHEMA_VERSION + 1 };
    await writeFile(runPaths(dir).aggregate, `${JSON.stringify(document, null, 2)}\n`);

    expect(offenders(await validate(dir))).toEqual([`${label.aggregate}/schemaVersion`]);
  });

  it('refuses a funnel step the run does not declare, at that step', async () => {
    const document = validAggregate();
    const [whole, ...rest] = document.funnelSlices;
    const [first, second] = whole.funnel;
    await writeAggregate(dir, {
      ...document,
      funnelSlices: [{ ...whole, funnel: [first, { ...second, step: 'wishlist' }] }, ...rest],
    });

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([`${label.aggregate}/funnelSlices/0/funnel/1/step`]);
    expect(violations[0].message).toMatch(/names no step declared in this run's steps/);
  });

  it('refuses a funnel out of the order run.json declares its steps', async () => {
    const document = validAggregate();
    const [whole, ...rest] = document.funnelSlices;
    const [first, second] = whole.funnel;
    await writeAggregate(dir, {
      ...document,
      funnelSlices: [{ ...whole, funnel: [second, first] }, ...rest],
    });

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([`${label.aggregate}/funnelSlices/0/funnel/1/step`]);
    expect(violations[0].message).toMatch(/in the order run.json declares its steps/);
  });

  it('refuses a version, an area of interest and a session the run does not hold', async () => {
    const document = validAggregate();
    const [whole, , variantSlice] = document.funnelSlices;
    const [screenSlice, ...otherScreens] = document.screenSlices;
    const [screen, ...others] = screenSlice.screens;
    await writeAggregate(dir, {
      ...document,
      funnelSlices: [
        {
          ...whole,
          timing: {
            ...whole.timing,
            slowest: [{ ...whole.timing.slowest[0], sessionId: 'S-99' }],
          },
        },
        { ...variantSlice, variant: 'C' },
      ],
      screenSlices: [
        {
          ...screenSlice,
          screens: [{ ...screen, clicksByAoi: [{ aoiId: 'z-nothing', clicks: 1 }] }, ...others],
        },
        ...otherScreens,
      ],
    });

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([
      `${label.aggregate}/funnelSlices/0/timing/slowest/0/sessionId`,
      `${label.aggregate}/funnelSlices/1/variant`,
      `${label.aggregate}/screenSlices/0/screens/0/clicksByAoi/0/aoiId`,
    ]);
    expect(violations[0].message).toMatch(/names no session listed in run.json sessionIds/);
    expect(violations[1].message).toMatch(/names no variant declared in this run/);
    expect(violations[2].message).toMatch(/names no area of interest declared in this run/);
  });

  it('refuses a path, a per-step timing and a slowest row naming a step the run does not declare', async () => {
    const document = validAggregate();
    const [whole, ...rest] = document.funnelSlices;
    await writeAggregate(dir, {
      ...document,
      funnelSlices: [
        {
          ...whole,
          timing: {
            ...whole.timing,
            perStep: [{ step: 'wishlist', distribution: whole.timing.total }],
            slowest: [{ ...whole.timing.slowest[0], dominantStep: 'wishlist' }],
          },
          paths: [{ steps: [CART, 'wishlist'], sessionCount: 2 }],
        },
        ...rest,
      ],
    });

    expect(offenders(await validate(dir))).toEqual([
      `${label.aggregate}/funnelSlices/0/timing/perStep/0/step`,
      `${label.aggregate}/funnelSlices/0/timing/slowest/0/dominantStep`,
      `${label.aggregate}/funnelSlices/0/paths/0/steps/1`,
    ]);
  });

  it('makes a run with a dangling reference in its aggregate an unreadable directory', async () => {
    const document = validAggregate();
    const [whole, ...rest] = document.funnelSlices;
    const [first, second] = whole.funnel;
    await writeAggregate(dir, {
      ...document,
      funnelSlices: [{ ...whole, funnel: [first, { ...second, step: 'wishlist' }] }, ...rest],
    });

    await expect(readRun(dir)).rejects.toThrow(/aggregate\.json\/funnelSlices\/0\/funnel\/1\/step/);
  });
});
