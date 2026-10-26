import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDirName, writeRun } from '@personavision/contract';
import { validArtifact } from '../../contract/tests/fixtures.js';

/**
 * A temporary data directory and runs root for a platform test.
 *
 * The run artifacts are written through `@personavision/contract`'s own writer from its
 * fixtures, so a change to the schemas reaches these tests as a compile error.
 */

export interface TestDirectories {
  dir: string;
  dataDir: string;
  runsRoot: string;
  cleanup: () => Promise<void>;
}

export const temporaryDirectories = async (): Promise<TestDirectories> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-platform-'));
  return {
    dir,
    dataDir: join(dir, '.personavision'),
    runsRoot: join(dir, 'runs'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

/** One run directory under `runsRoot`, named for `stamp` and recording `createdAt`. */
export const writeRunAt = async (
  runsRoot: string,
  { stamp, name }: { stamp: string; name: string },
): Promise<string> => {
  const runId = runDirName(new Date(stamp), name);
  const artifact = validArtifact();
  artifact.run = { ...artifact.run, runId, createdAt: stamp };
  artifact.findings = { ...artifact.findings, runId };
  await writeRun(join(runsRoot, runId), artifact);
  return runId;
};
