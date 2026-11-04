import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPaths,
  validate,
  writeRun,
  type Aggregate,
  type RunArtifact,
} from '@personavision/contract';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CART,
  openRunArtifact,
  RUN_ID,
  validAggregate,
  validArtifact,
  validSession,
} from '../../contract/tests/fixtures.js';
import { personavision } from './cli-process.js';

/**
 * `personavision aggregate`, asserted by running the command: the file it writes, the
 * summary it prints and the exit code are what a developer and CI see, so nothing here
 * calls the function instead.
 *
 * The run directories come from the contract package's own fixtures, so a change to the
 * schemas reaches this suite as a compile error rather than as a mystery violation.
 */

const directories: string[] = [];

const temporaryRun = async (artifact: RunArtifact): Promise<{ dir: string; runDir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-aggregate-'));
  const runDir = join(dir, 'runs', artifact.run.runId);
  await writeRun(runDir, artifact);
  directories.push(dir);
  return { dir, runDir };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The aggregate on disk, read back the way a screen fetches it. */
const written = async (runDir: string): Promise<Aggregate> =>
  JSON.parse(await readFile(runPaths(runDir).aggregate, 'utf8')) as Aggregate;

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * The fixture run plus one session the harness lost: it is in no figure, and the count of
 * it is what the command reports beside the sessions it was over.
 */
const withAutomationFailure = (): RunArtifact => {
  const artifact = validArtifact();
  const lost = validSession('S-03', 'A');
  return {
    ...artifact,
    run: { ...artifact.run, sessionIds: [...artifact.run.sessionIds, lost.sessionId] },
    sessions: [
      ...artifact.sessions,
      {
        ...lost,
        outcome: {
          status: 'automation_failure',
          step: CART,
          reason: 'the checkout selector timed out',
          attribution: 'automation',
          excludedFromScores: false,
        },
      },
    ],
  };
};

/**
 * Every test below spawns `personavision` as a process, two and three times over, and each
 * spawn pays for the whole module graph through `tsx`. That is a second or more of real work
 * per test on a developer's machine and several on CI, which vitest's 5 s default does not
 * cover — so these carry a timeout, as the other suites here that spawn the command do
 * (`open.test.ts`, `run.test.ts`). A suite whose failure mode is the clock rather than the
 * command teaches nobody anything.
 */
const SPAWNS_THE_COMMAND = 30_000;

describe('personavision aggregate', () => {
  it(
    'is one of the commands --help lists, and says what it takes',
    async () => {
      const { dir } = await temporaryRun(validArtifact());

      const all = await personavision(['--help'], dir);
      expect(all.code).toBe(0);
      expect(all.stdout).toContain('aggregate');

      const own = await personavision(['aggregate', '--help'], dir);
      expect(own.code).toBe(0);
      expect(own.stdout).toContain('runDir');
      expect(own.stdout).toContain('sessions on disk');
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'writes an aggregate the run directory validates with',
    async () => {
      const { dir, runDir } = await temporaryRun(validArtifact());

      const { code, stdout } = await personavision(['aggregate', runDir], dir);

      expect(code).toBe(0);
      expect(await validate(runDir)).toEqual([]);
      const aggregate = await written(runDir);
      expect(aggregate.runId).toBe(RUN_ID);
      expect(aggregate.funnelSlices.length).toBeGreaterThan(0);
      // The file it wrote is the file it named, and its size is the one on disk.
      expect(stdout).toContain(runPaths(runDir).aggregate);
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'reports the sessions it was over and the automation failures it left out',
    async () => {
      const { dir, runDir } = await temporaryRun(withAutomationFailure());

      const { code, stdout } = await personavision(['aggregate', runDir], dir);

      expect(code).toBe(0);
      const aggregate = await written(runDir);
      // Three sessions on disk, one of them the harness's own failure: two were scored.
      expect(aggregate.scoredSessionCount).toBe(2);
      expect(aggregate.excludedAutomationFailures).toBe(1);
      expect(stdout).toContain('2 sessions');
      expect(stdout).toContain('1 automation failure left out');
      expect(stdout).toContain(`${String(aggregate.funnelSlices.length)} funnel slices`);
      expect(stdout).toContain(`${String(aggregate.screenSlices.length)} screen slices`);
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'leaves byte-identical files when it is run twice',
    async () => {
      const { dir, runDir } = await temporaryRun(validArtifact());
      const file = runPaths(runDir).aggregate;

      const first = await personavision(['aggregate', runDir], dir);
      const once = await readFile(file, 'utf8');
      const second = await personavision(['aggregate', runDir], dir);

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(await readFile(file, 'utf8')).toBe(once);
      // Deleting it and computing it again gives the same bytes back, which is how a claim
      // the results page makes is checked.
      await rm(file);
      await personavision(['aggregate', runDir], dir);
      expect(await readFile(file, 'utf8')).toBe(once);
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'replaces an aggregate the directory already has',
    async () => {
      const stale: Aggregate = { ...validAggregate(), scoredSessionCount: 2 };
      const { dir, runDir } = await temporaryRun({ ...validArtifact(), aggregate: stale });
      expect((await written(runDir)).computedAt).toBe(stale.computedAt);

      const { code } = await personavision(['aggregate', runDir], dir);

      expect(code).toBe(0);
      expect(await validate(runDir)).toEqual([]);
      const aggregate = await written(runDir);
      expect(aggregate).not.toEqual(stale);
      expect(aggregate.funnelSlices.map((slice) => slice.key)).not.toEqual(
        stale.funnelSlices.map((slice) => slice.key),
      );
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'writes zero counts for a run with no sessions rather than failing',
    async () => {
      const { dir, runDir } = await temporaryRun(openRunArtifact());

      const { code, stdout } = await personavision(['aggregate', runDir], dir);

      expect(code).toBe(0);
      expect(await validate(runDir)).toEqual([]);
      const aggregate = await written(runDir);
      expect(aggregate.scoredSessionCount).toBe(0);
      expect(aggregate.excludedAutomationFailures).toBe(0);
      expect(aggregate.funnelSlices).toEqual([]);
      expect(aggregate.screenSlices).toEqual([]);
      // A run that is still open never reads as final.
      expect(aggregate.runStatus).toBe('open');
      expect(stdout).toContain('0 sessions');
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'exits non-zero with every violation and writes nothing on an invalid run directory',
    async () => {
      const { dir, runDir } = await temporaryRun(validArtifact());
      const file = runPaths(runDir).run;
      const run = JSON.parse(await readFile(file, 'utf8')) as { createdAt: string };
      run.createdAt = 'yesterday';
      await writeFile(file, JSON.stringify(run, null, 2));

      const { code, stderr } = await personavision(['aggregate', runDir], dir);

      expect(code).not.toBe(0);
      expect(stderr).toContain('is not a valid run directory');
      expect(stderr).toContain('run.json/createdAt');
      expect(await exists(runPaths(runDir).aggregate)).toBe(false);
    },
    SPAWNS_THE_COMMAND,
  );

  it(
    'fails with the contract’s violations on a directory that is no run at all',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'personavision-aggregate-'));
      directories.push(dir);

      const { code, stderr } = await personavision(['aggregate', dir], dir);

      expect(code).not.toBe(0);
      expect(stderr).toContain('run.json');
      expect(stderr).toContain('missing from the run directory');
      expect(await exists(join(dir, 'aggregate.json'))).toBe(false);
    },
    SPAWNS_THE_COMMAND,
  );
});
