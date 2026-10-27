import { readFile } from 'node:fs/promises';
import {
  readRun,
  runPaths,
  runSchema,
  SCHEMA_VERSION,
  writeRun,
  ZERO_USAGE,
} from '@personavision/contract';
import { stepsOf } from './task.js';
import type { TaskDefinition } from '@personavision/browser';
import type { Audience, Persona, Run, RunFailure } from '@personavision/contract';

/**
 * The run directory this command owns, start to finish: opened before the swarm runs,
 * failed where the swarm could not start at all.
 *
 * `runSwarm` appends each session as it lands and closes the run as `finished` (#49); what
 * it does not do is decide what the run *is*. The audience, the task, the versions, the
 * people, the seeds and the engine are the caller's, and this is where they are written —
 * once, before anything runs, so that the Running screen has a run to read from the first
 * moment and a run stopped half way leaves a directory that still validates.
 *
 * Two fields of the record exist only to satisfy the contract while a run is open, and both
 * are replaced by the pipeline that produces them:
 *
 * - **The verdict.** Every `run.json` carries one, and an open run has nothing to lead with,
 *   so it carries a placeholder that says so in words rather than a sentence nobody measured.
 * - **One declared screen.** A verdict names the evidence it turns on, and the evidence has
 *   to be a screenshot the run declares — so the first version's first step is declared with
 *   the viewport the first person will see it at. A session that captures that screen
 *   replaces the row with the real geometry as it lands.
 *
 * Both outlive the run where the pipeline that replaces them has not run. This command
 * writes **no scores**: the friction score, the findings and the verdict are the scoring
 * step's (#26, #27, #28), so a run it produces reads as "nothing has been scored yet" and
 * its hero evidence still names the placeholder screen — which, on a run where the first
 * version's first step was never captured, names an image that is not on disk. Nothing
 * downstream of this command can mend that while a verdict has to name a declared
 * screenshot, so whichever ticket scores a run is the one that replaces both. Recorded on
 * #54.
 */

/** What an open run says where a finished one leads with its verdict. */
const NOTHING_SCORED_YET = 'Nothing has been scored yet.';

export interface RunRecord {
  /** `2026-10-27-1402-buy-the-boots`: the directory's name and the run's own id. */
  readonly runId: string;
  /** When the test was asked for. `startedAt` is when the swarm began. */
  readonly createdAt: Date;
  readonly task: TaskDefinition;
  readonly variants: Run['variants'];
  /** Copied into the artifact by value: a later edit cannot restate this run. */
  readonly audience: Audience;
  /** Generated from the audience with the base seed (#31). */
  readonly personas: readonly Persona[];
  readonly seedGroups: readonly number[];
  readonly engine: Run['engine'];
}

/** What the swarm plans, as `planSwarm` counts it: the total and the split per version. */
export interface PlannedSessions {
  readonly totalSessions: number;
  /** One row per version, in the order the versions are declared. */
  readonly perVariant: readonly { readonly variant: string; readonly totalSessions: number }[];
}

/**
 * The run as it stands before a single session has run: status `open`, nothing finished, and
 * every claim about what is *about* to happen — the plan's counts, the people, the seeds and
 * the engine — already on the record.
 */
export const openRunRecord = (record: RunRecord, planned: PlannedSessions): Run => {
  const steps = stepsOf(record.task);
  const firstVariant = record.variants[0]?.id ?? '';
  const firstStep = steps[0]?.id ?? '';
  const viewport = record.personas[0]?.device.viewport ?? { width: 1, height: 1 };
  const startedAt = record.createdAt.toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: record.runId,
    createdAt: startedAt,
    status: 'open',
    startedAt,
    progress: {
      totalSessions: planned.totalSessions,
      finishedSessions: 0,
      perVariant: planned.perVariant.map((row) => ({ ...row, finishedSessions: 0 })),
      sessions: [],
    },
    usage: { ...ZERO_USAGE },
    task: { id: record.task.id, prompt: record.task.prompt },
    variants: [...record.variants],
    steps,
    stepCaptions: [],
    audience: record.audience,
    personas: [...record.personas],
    seedGroups: [...record.seedGroups],
    engine: record.engine,
    sessionIds: [],
    screenshots: [
      {
        variant: firstVariant,
        step: firstStep,
        path: runPaths('').screenshot(firstVariant, firstStep),
        viewport,
        // What a page's height and fold are is measured when it is captured; until then the
        // declared screen is one viewport tall, which is the least a rendered page can be.
        pageHeight: viewport.height,
        foldY: viewport.height,
      },
    ],
    aois: [],
    aoiMetrics: [],
    scores: [],
    verdict: {
      harderVariant: record.variants.at(-1)?.id ?? firstVariant,
      gapPoints: 0,
      bandsDisjoint: false,
      seedGroupsAgreeing: 0,
      sentence: NOTHING_SCORED_YET,
      preferredVariant: firstVariant,
      audienceSentence: NOTHING_SCORED_YET,
      reasons: [NOTHING_SCORED_YET],
      headlineFindingIds: [],
      heroEvidence: { variant: firstVariant, step: firstStep, aoiId: null },
    },
    calibration: null,
  };
};

/**
 * The same run, recorded as having failed to start: the reason, what was captured, and no
 * session at all.
 *
 * The contract holds a failed run to finishing nobody — so *nobody was simulated and no
 * result was saved*, which the Test failed screen states outright, is a fact of the artifact
 * rather than a hope.
 */
export const failedRunRecord = (run: Run, failure: RunFailure, finishedAt: Date): Run => ({
  ...run,
  status: 'failed',
  finishedAt: finishedAt.toISOString(),
  failure,
  progress:
    run.progress === undefined ? undefined : { ...run.progress, finishedSessions: 0, sessions: [] },
  sessionIds: [],
});

/**
 * The run directory, written through the contract's own writer: `run.json`, an empty
 * `findings.json`, and no session. Every violation is thrown rather than written.
 */
export const writeRunRecord = async (runDir: string, run: Run): Promise<void> => {
  await writeRun(runDir, {
    run,
    sessions: [],
    findings: { schemaVersion: SCHEMA_VERSION, runId: run.runId, findings: [] },
  });
};

/**
 * `run.json` as it now stands, and nothing else of the directory.
 *
 * The progress report reads this once per landed session, and a session carries every
 * fixation it made: reading the whole artifact each time would parse every session file
 * again for a line about one of them. The path and the schema are the contract's, so no
 * field name and no file name is restated here.
 */
export const readRunRecord = async (runDir: string): Promise<Run> =>
  runSchema.parse(JSON.parse(await readFile(runPaths(runDir).run, 'utf8')));

/**
 * A run that was stopped part way, closed on what it kept.
 *
 * The prototype's Running screen offers *Stop test* beside the sentence "each person is
 * saved as they finish; stopping keeps everyone who is already done", so a stopped run is a
 * run that has **ended**: left open it would read as still running for ever, and the one
 * thing the artifact must not do is claim a test is in flight when nothing is driving it.
 * `progress` still says how many of the planned sessions landed, which is how a reader tells
 * a stopped run from one that ran to the end.
 *
 * It goes out through the contract's own reader and writer, so a directory that would not
 * read back is thrown rather than written: that is what "still validates" is checked by.
 */
export const closeStoppedRun = async (
  runDir: string,
  plannedOrder: readonly string[],
  finishedAt: Date,
): Promise<Run> => {
  const artifact = await readRun(runDir);
  const landed = new Set(artifact.run.sessionIds);
  const run: Run = {
    ...artifact.run,
    status: 'finished',
    finishedAt: finishedAt.toISOString(),
    // The plan's order, which is the order the Sessions screen lists them in; the progress
    // log keeps the order they finished in, which is what it is for.
    sessionIds: plannedOrder.filter((sessionId) => landed.has(sessionId)),
  };
  await writeRun(runDir, { ...artifact, run });
  return run;
};
