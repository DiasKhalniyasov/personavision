import { readFile, readdir, writeFile } from 'node:fs/promises';
import { runPaths } from '@personavision/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { personavision } from './cli-process.js';
import { temporaryWorkspace } from './workspace.js';
import type { TestWorkspace } from './workspace.js';

/**
 * `validate` and `run`, asserted by running the command: the output and the exit code are
 * what a developer and CI see, so nothing here calls an internal function instead.
 */

/**
 * `--help` and `run` read no run directory — `run` only has to leave none behind — so they
 * share one empty workspace. The `validate` tests get a written artifact each, because one
 * of them breaks it on purpose.
 */
let workspace: TestWorkspace;

beforeAll(async () => {
  workspace = await temporaryWorkspace({ withRun: false });
});

afterAll(async () => {
  await workspace.cleanup();
});

describe('personavision --help', () => {
  it('lists the four subcommands, the product’s first', async () => {
    const { code, stdout } = await personavision(['--help'], workspace.dir);

    expect(code).toBe(0);
    for (const command of ['serve', 'validate', 'run', 'open']) {
      expect(stdout).toContain(command);
    }
    // `serve` is the product; the other three are documented as internal tools.
    expect(stdout.indexOf('serve')).toBeLessThan(stdout.indexOf('validate'));
  });

  it('names every flag of run and what it does', async () => {
    const { code, stdout } = await personavision(['run', '--help'], workspace.dir);

    expect(code).toBe(0);
    for (const flag of ['--url', '--task', '--personas', '--repeats', '--seed', '--engine']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('what counts as finishing');
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

  it('parses the invocation the product prints, then stops at the step that runs a test', async () => {
    const before = await runsBefore();

    const { code, stdout, stderr } = await personavision(
      [
        'run',
        '--url',
        'http://localhost:4173/checkout-a',
        '--url',
        'http://localhost:4173/checkout-b',
        '--task',
        'Buy the boots',
        '--personas',
        'default',
        '--repeats',
        '3',
      ],
      workspace.dir,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('#8');
    expect(stderr).toContain('no run directory was created');
    const request = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      variants: { id: string; name: string; url: string }[];
      audienceId: string;
      repeats: number;
      engineMode: string;
    };
    expect(request.variants).toEqual([
      { id: 'A', name: 'Current checkout', url: 'http://localhost:4173/checkout-a' },
      { id: 'B', name: 'Redesign candidate', url: 'http://localhost:4173/checkout-b' },
    ]);
    expect(request.audienceId).toBe('default');
    expect(request.repeats).toBe(3);
    expect(request.engineMode).toBe('offline');
    expect(await runsBefore()).toEqual(before);
  });
});
