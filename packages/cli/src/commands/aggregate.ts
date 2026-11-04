import { stat } from 'node:fs/promises';
import { readRun, runPaths, writeAggregate, type RunArtifact } from '@personavision/contract';
import { aggregateComputedAt, composeAggregate } from '@personavision/scoring';
import { CliError } from '../cli-error.js';

/**
 * `personavision aggregate <runDir>` — re-compute a run's aggregate from the sessions on
 * disk and write it.
 *
 * This is what makes the figures recomputable: a run can be re-aggregated after a fix to a
 * figure without re-driving a single browser, and because the composition is deterministic
 * the diff is the fix and nothing else. It is also how the committed example run gets its
 * aggregate, and how anybody checks a claim the results page makes — delete the file, run
 * the command, get the same bytes back.
 *
 * It reads the directory through the contract's own reader, so a directory that is not a
 * valid run fails with the contract's violations the way `personavision validate` does and
 * nothing is written; it composes with `@personavision/scoring`, which owns every figure;
 * and it writes through the contract's writer, so it spells no path of its own. It reaches
 * no network and reads no credential: a run directory is all it touches.
 */

export interface AggregateCommandOptions {
  runDir: string;
  log?: (line: string) => void;
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Bytes as a reader reads them: a small file in bytes, anything larger in KiB. */
const sized = (bytes: number): string =>
  bytes < 1_024 ? plural(bytes, 'byte', 'bytes') : `${String(Math.round(bytes / 1_024))} KiB`;

export const aggregateCommand = async ({
  runDir,
  log = (line) => process.stdout.write(`${line}\n`),
}: AggregateCommandOptions): Promise<void> => {
  let artifact: RunArtifact;
  try {
    artifact = await readRun(runDir);
  } catch (error) {
    // The contract's reader reports every violation in one message, in the shape
    // `validate` prints: an invalid directory is named, not re-worded, and nothing is
    // written, because the composition never runs.
    throw new CliError((error as Error).message);
  }

  const { run, sessions } = artifact;
  const aggregate = composeAggregate({
    run,
    sessions,
    // **The run's own clock, never this invocation's**, and the same rule the run loop
    // aggregates by, so that re-aggregating a run it wrote gives the bytes back rather than
    // a fresh timestamp. `aggregateComputedAt` is where that rule lives and why.
    computedAt: aggregateComputedAt(run),
  });
  await writeAggregate(runDir, aggregate);

  const file = runPaths(runDir).aggregate;
  log(
    [
      `Aggregated ${plural(aggregate.scoredSessionCount, 'session', 'sessions')} of ${run.runId}`,
      `${plural(aggregate.excludedAutomationFailures, 'automation failure', 'automation failures')} left out`,
      `${plural(aggregate.funnelSlices.length, 'funnel slice', 'funnel slices')} and ${plural(aggregate.screenSlices.length, 'screen slice', 'screen slices')} stored`,
    ].join(', ') + '.',
  );
  log(`${file} — ${sized((await stat(file)).size)}`);
};
