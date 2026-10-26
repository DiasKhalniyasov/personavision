import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunDirs, runDirName, writeRun } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validArtifact } from '../../contract/tests/fixtures.js';
import { startRunServer } from '../src/server.js';
import type { RunServer, RunSummary } from '../src/index.js';

/**
 * The listing is the one generated resource, and the one thing to keep in step with the
 * directory. Two runs are enough to assert the order it promises.
 */

/**
 * A run written under its own directory. `stamp` is what the directory is named for and
 * `createdAt` what the run records: the two are deliberately in opposite orders below, so
 * that the order the listing comes back in can only be the one it promises.
 */
const writeRunAt = async (
  runsRoot: string,
  { stamp, createdAt, name }: { stamp: string; createdAt: string; name: string },
): Promise<string> => {
  const runId = runDirName(new Date(stamp), name);
  const artifact = validArtifact();
  artifact.run = { ...artifact.run, runId, createdAt };
  artifact.findings = { ...artifact.findings, runId };
  await writeRun(join(runsRoot, runId), artifact);
  return runId;
};

describe('GET /runs/index.json', () => {
  let root: string;
  let server: RunServer;
  let newest: string;
  let oldest: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'personavision-index-'));
    const runsRoot = join(root, 'runs');
    // The newest run sits in the earlier-named directory and carries its timestamp in an
    // offset of its own, so neither the directory order nor the text of the timestamps is
    // what the listing can be sorting by.
    newest = await writeRunAt(runsRoot, {
      stamp: '2026-10-20T00:01:00Z',
      createdAt: '2026-10-25T08:00:00-05:00',
      name: 'newest test',
    });
    oldest = await writeRunAt(runsRoot, {
      stamp: '2026-10-26T00:01:00Z',
      createdAt: '2026-10-21T09:30:00+02:00',
      name: 'oldest test',
    });
    server = await startRunServer({ runsRoot, viewerDist: join(root, 'absent'), port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists every run directory, newest first by the run\u2019s own timestamp', async () => {
    expect(await listRunDirs(join(root, 'runs')), 'the directory order is the other one').toEqual([
      oldest,
      newest,
    ]);

    const response = await fetch(new URL('runs/index.json', server.url));

    expect(response.status).toBe(200);
    expect(((await response.json()) as RunSummary[]).map((entry) => entry.runId)).toEqual([
      newest,
      oldest,
    ]);
  });
});
