/**
 * The run artifact's calibration block: the badge's number, or an honest nothing.
 *
 * The figures are asserted **against the committed calibrated configuration** rather than
 * against literals copied into this file: a fit that moves them (#90) must move the badge
 * with them, and a test holding its own copy of 0.68 would pass a run that had gone stale.
 * The one figure restated here is `null`, which is the whole point of the honest-nothing
 * state.
 *
 * The committed fit was measured over the generated stand-in corpus (#82), which is not the
 * benchmark the block names, so the block a run carries **today** is `null`. The figures a
 * real fit would carry are asserted through the same committed configuration with its corpus
 * flag flipped — the same numbers, measured against the dataset instead — so the mapping is
 * covered without this file inventing a figure.
 *
 * The loop runs over the committed capture set with the offline deterministic provider — no
 * browser, no socket, no key — exactly as the rest of this suite does.
 */

import { readFile } from 'node:fs/promises';
import { createFixtureSource } from '@personavision/browser';
import { readRun, runPaths, validate, writeRun } from '@personavision/contract';
import { ENGINE_VERSION, resolveEngineConfig } from '@personavision/engine';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calibrationOf, engineOnTheRecord, runSwarm } from '../src/index.js';
import { sameCalibration } from '../src/calibration.js';
import {
  FOUR_PEOPLE,
  oneDeviceCaptureSet,
  runVariant,
  sweep,
  TASK,
  temporaryRunDir,
  withNothingRunning,
  writeOpenRun,
} from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run, Violation } from '@personavision/contract';
import type { CalibratedMetrics } from '@personavision/engine';
import type { RunSwarmInput } from '../src/index.js';

const VARIANTS: ReadonlyArray<Run['variants'][number]> = [runVariant('A'), runVariant('B')];

/** One person on one seed over two variants: two sessions, which is a whole run. */
const ONE_PERSON: readonly Persona[] = [FOUR_PEOPLE[0] as Persona];
const SEEDS = [11];

const NOON = '2026-10-27T12:00:00.000Z';

/**
 * The fit's own record, read the way a reviewer reads it.
 *
 * `packages/engine/config/calibrated.json` is where #90 committed the fitted values and the
 * figures they were measured at, and it is the document this block has to agree with.
 */
interface CommittedConfiguration {
  readonly engine: { readonly version: string };
  readonly metrics: {
    readonly cc: number;
    readonly nss: number;
    readonly scanMatch: number;
    readonly corpus: { readonly synthetic: boolean };
  };
}

const committedConfiguration = async (): Promise<CommittedConfiguration> =>
  JSON.parse(
    await readFile(new URL('../../engine/config/calibrated.json', import.meta.url), 'utf8'),
  ) as CommittedConfiguration;

/**
 * The committed fit as it will be once it is measured against the dataset rather than the
 * stand-in: the same figures, the same engine, the corpus flag the only difference.
 *
 * It is the engine's own resolved configuration and not an object assembled here, so the
 * figures under test are the committed ones to the last digit.
 */
const measuredAgainstTheBenchmark = (): CalibratedMetrics => {
  const { metrics } = resolveEngineConfig();
  if (metrics === null)
    throw new Error('the committed calibrated configuration is not in this build');
  return { ...metrics, corpus: { ...metrics.corpus, synthetic: false } };
};

let runDir: string;
let captures: string;
let source: CaptureSource;

beforeEach(async () => {
  runDir = await temporaryRunDir();
  captures = await oneDeviceCaptureSet();
  source = createFixtureSource(captures);
});

afterEach(async () => {
  await sweep(runDir);
  await sweep(captures);
});

const swarmOver = (over: Partial<RunSwarmInput> = {}): RunSwarmInput => ({
  runDir,
  variants: VARIANTS,
  personas: ONE_PERSON,
  seedGroups: SEEDS,
  task: TASK,
  source,
  providers: { decision: createOfflineDeterministicProvider({ seed: 11 }) },
  now: () => new Date(NOON),
  ...over,
});

/** The open run its creator wrote, naming an engine of its own. */
const open = (): Promise<Run> =>
  writeOpenRun(runDir, { personas: ONE_PERSON, variants: VARIANTS, seedGroups: SEEDS });

/** That run, left carrying a block the engine never earned. */
const openCarrying = async (calibration: Run['calibration']): Promise<void> => {
  const opened = await readRun(runDir);
  await writeRun(runDir, { ...opened, run: { ...opened.run, calibration } });
};

describe('the engine on the record', () => {
  it('carries the figures the committed calibrated configuration records, and no others', async () => {
    const committed = await committedConfiguration();

    expect(calibrationOf(measuredAgainstTheBenchmark())).toEqual({
      benchmark: 'UEyes',
      cc: committed.metrics.cc,
      nss: committed.metrics.nss,
      scanMatch: committed.metrics.scanMatch,
    });
  });

  it('carries them to the last digit, because the badge rounds and this does not', async () => {
    const committed = await committedConfiguration();
    const block = calibrationOf(measuredAgainstTheBenchmark());

    expect(block).not.toBeNull();
    // `Object.is` rather than equality, so a figure that arrived through a `toFixed` or a
    // multiply-and-divide is a failure rather than a near miss.
    expect(Object.is(block?.cc, committed.metrics.cc)).toBe(true);
    expect(Object.is(block?.nss, committed.metrics.nss)).toBe(true);
    expect(Object.is(block?.scanMatch, committed.metrics.scanMatch)).toBe(true);
    // And the figures really do have more digits than a badge shows, so the assertion above
    // is testing something: two decimal places is what `gaze similarity 0.68` states.
    expect(block?.cc).not.toBe(Number(block?.cc?.toFixed(2)));
  });

  it('names the engine the committed configuration was fitted against', async () => {
    const committed = await committedConfiguration();

    // The tie the badge rests on. `engine.version` is how a run is matched against a row of
    // `docs/calibration/report.md` (#89), so an engine that moved on without a refit has to
    // fail here rather than ship a figure another engine earned.
    expect(engineOnTheRecord().version).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toBe(committed.engine.version);
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
  });

  it('writes nothing at all for an engine nobody calibrated', () => {
    expect(calibrationOf(null)).toBeNull();
    expect(engineOnTheRecord({ metrics: null })).toEqual({
      version: ENGINE_VERSION,
      calibration: null,
    });
  });

  it('writes nothing while the committed figures were measured over a synthetic corpus', async () => {
    const committed = await committedConfiguration();

    // The premise, stated so this test says why it expects nothing: the committed fit was
    // measured over the generated stand-in (#82), and `docs/calibration/report.md` forbids
    // quoting any of its numbers as a UEyes score. The block names UEyes, so it stays empty.
    expect(committed.metrics.corpus.synthetic).toBe(true);
    expect(resolveEngineConfig().calibrated).toBe(true);
    expect(engineOnTheRecord().calibration).toBeNull();
    // Nothing fell back to a zero or to the figure the corpus did earn.
    expect(engineOnTheRecord().calibration).not.toEqual(
      expect.objectContaining({ cc: committed.metrics.cc }),
    );
  });

  it('tells two blocks apart by their figures, so a run that agrees is left alone', () => {
    const real = calibrationOf(measuredAgainstTheBenchmark());

    expect(real).not.toBeNull();
    expect(sameCalibration(real, calibrationOf(measuredAgainstTheBenchmark()))).toBe(true);
    expect(sameCalibration(null, null)).toBe(true);
    expect(sameCalibration(null, real)).toBe(false);
    expect(sameCalibration(real, null)).toBe(false);
    expect(sameCalibration(real, { ...(real as NonNullable<typeof real>), cc: 0.1 })).toBe(false);
  });
});

describe('a run’s calibration block', () => {
  it('is on the record before the first session and never changes value mid-run', async () => {
    const created = await open();
    const engine = engineOnTheRecord();
    // A run that arrived naming another engine and carrying a figure that engine never
    // earned, so that the correction below is a correction of something.
    await openCarrying({ benchmark: 'UEyes', cc: 0.99, nss: 9, scanMatch: 0.99 });
    expect(created.engine.version).not.toBe(engine.version);

    /** `run.json` alone, which is the file the badge's two fields are written to. */
    const recorded = async (): Promise<Pick<Run, 'calibration' | 'engine'>> =>
      JSON.parse(await readFile(runPaths(runDir).run, 'utf8')) as Run;

    const seen: Array<Pick<Run, 'calibration' | 'engine'>> = [];
    const violations: Violation[][] = [];
    const { run } = await withNothingRunning(() =>
      runSwarm(
        swarmOver({
          // One at a time, so that the directory a `session-finished` handler reads is the
          // state an interrupted run would be found in rather than a session mid-write.
          concurrency: 1,
          onProgress: async (event) => {
            seen.push(await recorded());
            if (event.kind === 'session-finished') violations.push(await validate(runDir));
          },
        }),
      ),
    );

    // The first of them is the `session-started` of `S-01`, read before any session had run:
    // the block is already the engine's, and it is the same at every event after it.
    expect(seen.length).toBeGreaterThan(1);
    expect(violations.length).toBeGreaterThan(0);
    for (const state of seen) {
      expect(state.calibration).toEqual(engine.calibration);
      expect(state.engine.version).toBe(engine.version);
    }
    for (const found of violations) expect(found).toEqual([]);

    expect(run.calibration).toEqual(engine.calibration);
    expect(run.engine.version).toBe(engine.version);
    expect((await readRun(runDir)).run.calibration).toEqual(engine.calibration);
    expect(await validate(runDir)).toEqual([]);
  });

  it('reaches disk as the engine reported it, with nothing rounded on the way', async () => {
    await open();
    const committed = await committedConfiguration();

    await withNothingRunning(() => runSwarm(swarmOver()));

    // Today's committed fit is synthetic, so what reaches disk is the honest nothing — and
    // not a figure, which is the assertion that matters here.
    const asRun = await readFile(runPaths(runDir).run, 'utf8');
    expect(asRun).toContain('"calibration": null');
    expect(asRun).not.toContain(`${committed.metrics.cc}`);

    // The figures' own path to disk, through the same writer: every digit survives it, so a
    // real fit's `cc` is not rounded between the configuration and the badge.
    const opened = await readRun(runDir);
    await writeRun(runDir, {
      ...opened,
      run: { ...opened.run, calibration: calibrationOf(measuredAgainstTheBenchmark()) },
    });
    const withFigures = await readFile(runPaths(runDir).run, 'utf8');
    expect(withFigures).toContain('"benchmark": "UEyes"');
    expect(withFigures).toContain(`"cc": ${committed.metrics.cc}`);
    expect(withFigures).toContain(`"nss": ${committed.metrics.nss}`);
    expect(withFigures).toContain(`"scanMatch": ${committed.metrics.scanMatch}`);
    expect(await validate(runDir)).toEqual([]);
  });

  it('is `null` on an uncalibrated engine’s run, and the directory still validates', async () => {
    await open();
    // The uncalibrated engine, asked for directly: `config/calibrated.json` is a build-time
    // import and cannot be made to disappear from this build, which is why the engine's own
    // suite exercises that branch through `resolveFrom(null)` and this one through the
    // resolution it would have returned. What is asserted is the whole of it — the artifact a
    // run by such an engine carries, and that a reader can still read the directory.
    const uncalibrated = engineOnTheRecord({ metrics: null });
    const opened = await readRun(runDir);
    await writeRun(runDir, {
      ...opened,
      run: {
        ...opened.run,
        engine: { ...opened.run.engine, version: uncalibrated.version },
        calibration: uncalibrated.calibration,
      },
    });

    expect((await readRun(runDir)).run.calibration).toBeNull();
    expect(await validate(runDir)).toEqual([]);
  });

  it('is whatever the engine reported on a run that failed to start, and never a figure', async () => {
    await open();
    const engine = engineOnTheRecord();
    const opened = await readRun(runDir);
    await writeRun(runDir, {
      ...opened,
      run: {
        ...opened.run,
        status: 'failed',
        finishedAt: NOON,
        failure: { reason: 'the site could not be reached', detail: 'ENOTFOUND shop.example' },
        engine: { ...opened.run.engine, version: engine.version },
        calibration: engine.calibration,
      },
    });

    const failed = await readRun(runDir);
    expect(failed.run.status).toBe('failed');
    expect(failed.run.sessionIds).toEqual([]);
    expect(failed.run.calibration).toEqual(engine.calibration);
    expect(failed.run.engine.version).toBe(engine.version);
    expect(await validate(runDir)).toEqual([]);

    // And the loop does not reach into it: a failed run's record is the creator's last word.
    await expect(withNothingRunning(() => runSwarm(swarmOver()))).rejects.toThrow(/"failed"/);
    expect((await readRun(runDir)).run.calibration).toEqual(engine.calibration);
  });
});
