import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPaths, validate } from '@personavision/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { personavision } from './cli-process.js';
import { temporaryWorkspace } from './workspace.js';
import type { TestWorkspace } from './workspace.js';

/**
 * `validate` and `run`, asserted by running the command: the output and the exit code are
 * what a developer and CI see, so nothing here calls an internal function instead.
 */

/**
 * `--help` and the `run` arguments read no run directory — a test that was not started
 * only has to leave none behind — so they share one empty workspace. The `validate` tests
 * get a written artifact each, because one of them breaks it on purpose.
 *
 * What a run that *does* start produces is asserted in `run.test.ts` and
 * `run-live.test.ts`: a swarm cannot be driven through this process runner, because `tsx`
 * compiles the page callbacks the browser step evaluates with esbuild's name helpers, which
 * do not exist inside the page.
 */
let workspace: TestWorkspace;

beforeAll(async () => {
  workspace = await temporaryWorkspace({ withRun: false });
});

afterAll(async () => {
  await workspace.cleanup();
});

describe('personavision --help', () => {
  it('lists every subcommand, the product’s first', async () => {
    const { code, stdout } = await personavision(['--help'], workspace.dir);

    expect(code).toBe(0);
    for (const command of ['serve', 'validate', 'run', 'open', 'calibrate']) {
      expect(stdout).toContain(command);
    }
    // `serve` is the product; the other three are documented as internal tools.
    expect(stdout.indexOf('serve')).toBeLessThan(stdout.indexOf('validate'));
  });

  it('names every flag of run and what it does', async () => {
    const { code, stdout } = await personavision(['run', '--help'], workspace.dir);

    expect(code).toBe(0);
    for (const flag of [
      '--url',
      '--task',
      '--audience',
      '--personas',
      '--repeats',
      '--seed',
      '--engine',
      '--mode',
      '--steps',
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('what counts as finishing');
    // The two things a reader has to know before spending anything: which model `--mode`
    // picks, and that the cheap one may be trained on.
    expect(stdout).toContain('contributor');
    expect(stdout).toContain('train its models');
  });

  it('names every flag of open and what it does', async () => {
    const { code, stdout } = await personavision(['open', '--help'], workspace.dir);

    expect(code).toBe(0);
    for (const flag of ['--port', '--no-open', '--no-build', '--viewer']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('apps/viewer/dist');
  });

  it('names what validate takes', async () => {
    const { code, stdout } = await personavision(['validate', '--help'], workspace.dir);

    expect(code).toBe(0);
    expect(stdout).toContain('runDir');
    expect(stdout).toContain('JSON path');
  });
});

describe('personavision validate', () => {
  let written: TestWorkspace;

  beforeEach(async () => {
    written = await temporaryWorkspace();
  });

  afterEach(async () => {
    await written.cleanup();
  });

  it('exits 0 on a valid run directory and says so', async () => {
    const { code, stdout } = await personavision(['validate', written.runDir], written.dir);

    expect(code).toBe(0);
    expect(stdout).toContain('is a valid run directory');
  });

  it('exits non-zero and prints every violation with its JSON path', async () => {
    const file = runPaths(written.runDir).run;
    const run = JSON.parse(await readFile(file, 'utf8')) as {
      createdAt: string;
      scores: { completionRate: number }[];
    };
    run.createdAt = 'yesterday';
    run.scores[0]!.completionRate = 7;
    await writeFile(file, JSON.stringify(run, null, 2));

    const { code, stderr } = await personavision(['validate', written.runDir], written.dir);

    expect(code).not.toBe(0);
    expect(stderr).toContain('is not a valid run directory');
    expect(stderr).toContain('run.json/createdAt');
    expect(stderr).toContain('run.json/scores/0/completionRate');
    expect(Number(/\((\d+) violations\)/.exec(stderr)?.[1])).toBeGreaterThanOrEqual(2);
  });

  it("reports a violation in the run's progress and usage at its JSON path", async () => {
    const file = runPaths(written.runDir).run;
    const run = JSON.parse(await readFile(file, 'utf8')) as {
      progress: { finishedSessions: number };
      usage: { cachedInputTokens: number };
    };
    run.progress.finishedSessions = 9;
    run.usage.cachedInputTokens = 5;
    await writeFile(file, JSON.stringify(run, null, 2));

    const { code, stderr } = await personavision(['validate', written.runDir], written.dir);

    expect(code).not.toBe(0);
    expect(stderr).toContain('run.json/progress/finishedSessions');
    expect(stderr).toContain('run.json/usage/cachedInputTokens');
  });

  it('fails with a message about the path, not a stack trace', async () => {
    const missing = `${written.runDir}-nope`;

    const { code, stderr } = await personavision(['validate', missing], written.dir);

    expect(code).not.toBe(0);
    expect(stderr).toContain(missing);
    expect(stderr).toContain('there is no such directory');
    expect(stderr).not.toContain('at ');
  });
});

describe('personavision run', () => {
  const runsBefore = async (): Promise<string[]> => readdir(workspace.runsRoot);

  it('rejects a malformed URL and a task that does not say what counts as finishing', async () => {
    const before = await runsBefore();

    const { code, stderr } = await personavision(
      [
        'run',
        '--url',
        'http://localhost:4173/checkout-a',
        '--url',
        'localhost:4173/checkout-b',
        '--task',
        'Have a look around',
      ],
      workspace.dir,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('The test was not started.');
    expect(stderr).toContain(
      '--url "localhost:4173/checkout-b" — Needs a scheme: http:// or https://',
    );
    expect(stderr).toContain(
      'The task has to say what finishing means, or nobody can be counted as having completed it.',
    );
    expect(await runsBefore()).toEqual(before);
  });

  it('rejects an argument that is not a number before doing any work', async () => {
    const { code, stderr } = await personavision(
      [
        'run',
        '--url',
        'http://localhost:4173/checkout-a',
        '--task',
        'Buy the boots',
        '--repeats',
        'three',
      ],
      workspace.dir,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('--repeats "three" — Needs a whole number.');
  });

  it('rejects an audience it cannot resolve, and writes no run directory', async () => {
    const before = await runsBefore();

    const { code, stderr } = await personavision(
      [
        'run',
        '--url',
        'http://localhost:4173/checkout-a',
        '--task',
        'Buy the boots',
        '--audience',
        'nobody-in-particular',
      ],
      workspace.dir,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('there is no audience "nobody-in-particular"');
    expect(stderr).toContain('no run directory was created');
    expect(await runsBefore()).toEqual(before);
  });

  it('refuses the standard model with no key in the environment, and simulates nobody', async () => {
    const { code, stderr } = await personavision(
      [
        'run',
        '--url',
        'http://localhost:4173/checkout-a',
        '--task',
        'Buy the boots',
        '--mode',
        'standard',
      ],
      workspace.dir,
    );

    expect(code).not.toBe(0);
    // Naming the standard model is naming a paying customer's test: it is refused rather
    // than run on the cheaper model or on the offline engine (#143, #144).
    expect(stderr).toContain('Test failed to start');
    expect(stderr).toContain('The standard model could not be used');
    expect(stderr).toContain('Nobody was simulated and no result was saved.');
    expect(stderr).not.toContain('contributor mode');
    // The failure is on the record, with no session beside it.
    const runs = await readdir(workspace.runsRoot);
    expect(runs).toHaveLength(1);
    const runDir = join(workspace.runsRoot, String(runs[0]));
    expect(await validate(runDir)).toEqual([]);
    const run = JSON.parse(await readFile(runPaths(runDir).run, 'utf8')) as {
      status: string;
      sessionIds: string[];
      engine: { mode: string; modelMode?: string };
    };
    expect(run.status).toBe('failed');
    expect(run.sessionIds).toEqual([]);
    expect(run.engine.mode).toBe('model');
    expect(run.engine.modelMode).toBe('standard');
    await rm(runDir, { recursive: true, force: true });
  });
});
