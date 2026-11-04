import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateSchema, runPaths, validate } from '@personavision/contract';
import { CAPS, ONE_URL_VARIANT_ID } from '@personavision/platform';
import { MODEL_ID_BY_MODE } from '@personavision/provider';
import { engineOnTheRecord } from '@personavision/swarm';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../src/cli-error.js';
import { runCommand } from '../src/commands/run.js';
import { DERIVED_STEP_SCREENS } from '../src/run/task.js';
import { fakeModelProvider, runFixture, STAND_IN_CREDENTIAL } from './run-swarm.js';
import type { CaptureSource } from '@personavision/browser';
import type { Run, Session } from '@personavision/contract';
import type { RunCommandOptions } from '../src/commands/run.js';
import type { RunFixture } from './run-swarm.js';

/**
 * `personavision run`, doing the thing it exists for: a swarm into a run directory, with
 * progress a person can read.
 *
 * Every test here drives the command itself — the arguments in, the lines out, the
 * directory on disk — through a capture source that replays `packages/browser`'s committed
 * set. So the whole command is covered with **no browser, no network and no API key**,
 * which is the promise step #8 makes about a cold clone; `run-live.test.ts` is the one
 * suite that drives Chromium against a page.
 *
 * What a session does on a replayed page is not asserted here: the outcomes are
 * `decideOutcome`'s and the sessions are `runSession`'s, and both have their own suites.
 * What is asserted is the run: the artifact this command owns, the record of what ran, the
 * report, and what it leaves behind when it cannot start or is stopped.
 */

let fixture: RunFixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

/** The one run directory the command wrote, and its `run.json`. */
const theRun = async (runsRoot: string): Promise<{ runDir: string; run: Run }> => {
  const [runId, ...rest] = await readdir(runsRoot);
  expect(rest, 'one run directory per run').toEqual([]);
  const runDir = `${runsRoot}/${String(runId)}`;
  const run = JSON.parse(await readFile(runPaths(runDir).run, 'utf8')) as Run;
  return { runDir, run };
};

const failing = async (body: () => Promise<void>): Promise<CliError> => {
  try {
    await body();
  } catch (error) {
    expect(error, 'a failure a developer is meant to read').toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('the command was expected to fail and did not');
};

/** One session's log line, as the report stamps them. */
const LOG_LINE = /^\d\d:\d\d:\d\d {2}S-\d\d /;

describe('a run that goes through', () => {
  it('writes a complete, schema-valid run directory for the whole swarm', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    expect(run.status).toBe('finished');
    // Two people × one seed × two versions, and the counts agree with the sessions on disk.
    expect(run.progress?.totalSessions).toBe(4);
    expect(run.progress?.finishedSessions).toBe(4);
    expect(run.sessionIds).toEqual(['S-01', 'S-02', 'S-03', 'S-04']);
    expect((await readdir(runPaths(runDir).sessionsDir)).sort()).toEqual([
      'S-01.json',
      'S-02.json',
      'S-03.json',
      'S-04.json',
    ]);
  });

  it('records the audience by value, and the people generated from it', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const { run } = await theRun(fixture.runsRoot);
    expect(run.audience.id).toBe('fixture-shoppers');
    expect(run.audience.size).toBe(2);
    // By value: the whole description travels, so a later edit to the file cannot restate
    // what this test was run for.
    expect(run.audience.goals).toEqual(['Buy one item quickly']);
    expect(run.personas).toHaveLength(2);
    for (const persona of run.personas) expect(persona.audienceId).toBe('fixture-shoppers');
    expect(run.seedGroups).toEqual([11]);
  });

  it('refuses a contributor run with no key rather than running it offline', async () => {
    fixture = await runFixture({ size: 2 });

    const options = fixture.options({ engine: 'model', env: {} });
    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('Test failed to start');
    const { run } = await theRun(fixture.runsRoot);
    expect(run.status).toBe('failed');
    expect(run.engine.mode).toBe('model');
    expect(run.sessionIds).toEqual([]);
  });

  it('carries the engine’s calibration block and the version that earned it', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const { run } = await theRun(fixture.runsRoot);
    // The two fields the header badge reads, from the engine that actually ran (#92). The
    // figures are not restated here: they are the engine's own, which is what makes them
    // honest, and `packages/swarm` is where they are asserted against the committed fit.
    expect(run.calibration).toEqual(engineOnTheRecord().calibration);
    expect(run.engine.version).toBe(engineOnTheRecord().version);
  });

  it('names the task, the versions, the audience and the engine before anybody has finished', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const printed = fixture.printed();
    expect(printed[0]).toBe('Running · Buy the canvas tote bag and place the order');
    expect(printed[1]).toBe('0 of 4 sessions finished · offline deterministic engine');
    expect(printed.slice(2, 4)).toEqual([
      '  A Current checkout · 2 sessions · https://fixture.test/cart.html',
      '  B Redesign candidate · 2 sessions · https://fixture.test/b/cart.html',
    ]);
    expect(printed[4]).toBe('  Fixture shoppers · 2 people · seeds 11');
  });

  it('prints one line per finished session, in the Running log’s wording and order', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const { run } = await theRun(fixture.runsRoot);
    const log = fixture.printed().filter((line) => LOG_LINE.test(line));
    expect(log).toHaveLength(4);
    // One line per entry in the artifact's own progress log, in the order it landed them.
    const landed = run.progress?.sessions ?? [];
    expect(landed).toHaveLength(4);
    log.forEach((line, index) => {
      const entry = landed[index];
      expect(entry).toBeDefined();
      expect(line).toContain(`${String(entry?.sessionId)} ${String(entry?.personaName)}`);
      expect(line).toContain(` · ${String(entry?.variant)} · seed 11 — `);
    });
    // The outcome's own word, and never a word from another outcome's row.
    for (const line of log) {
      expect(line).toMatch(/— (success in \d+\.\d s|(abandoned|failed|automation failure) at the)/);
    }
  });

  it('never writes over a run of the same minute, which is a finished test', async () => {
    fixture = await runFixture({ size: 2 });
    // One fixed clock, so both runs want the same name: the minute and the task are all a
    // run directory is named for.
    const sameMinute = (): Date => new Date('2026-10-27T14:02:30.000Z');

    await runCommand(fixture.options({ now: sameMinute }));
    await runCommand(fixture.options({ now: sameMinute }));

    const runs = (await readdir(fixture.runsRoot)).sort();
    expect(runs).toEqual([
      '2026-10-27-1402-buy-the-canvas-tote-bag-and',
      '2026-10-27-1402-buy-the-canvas-tote-bag-and-2',
    ]);
    // Both are whole runs, and the first still holds its own sessions.
    for (const runId of runs) {
      expect(await validate(join(fixture.runsRoot, runId))).toEqual([]);
    }
  });

  it('ends on the counts, the split per version and the run directory', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options());

    const { runDir } = await theRun(fixture.runsRoot);
    const printed = fixture.printed();
    expect(printed.at(-1)).toBe(runDir);
    expect(printed.at(-3)).toBe('  A 2 / 2 sessions');
    expect(printed.at(-2)).toBe('  B 2 / 2 sessions');
    expect(printed.at(-4)).toContain('4 of 4 sessions finished');
    expect(printed.at(-4)).toContain('offline deterministic engine');
  });
});

describe('a run on a model', () => {
  /** Model mode, a key in the environment, and a provider that answers without a network. */
  const onAModel = (over: Partial<RunCommandOptions> = {}): Partial<RunCommandOptions> => ({
    engine: 'model',
    mode: 'contributor',
    env: { MODEL_API_KEY: STAND_IN_CREDENTIAL },
    createModelProvider: ({ modelMode }) => fakeModelProvider(modelMode),
    ...over,
  });

  it('records which model and mode ran, and what it cost', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(onAModel()));

    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    expect(run.engine.mode).toBe('model');
    expect(run.engine.modelMode).toBe('contributor');
    expect(run.engine.models?.decision).toBe(MODEL_ID_BY_MODE.contributor);
    // One call per session, each reporting its own tokens: the run's total is the sum, and
    // nothing here recomputes a price.
    expect(run.usage?.calls).toBe(4);
    expect(run.usage?.inputTokens).toBe(4_000);
    expect(run.usage?.cachedInputTokens).toBe(1_600);
    expect(run.usage?.reasoningTokens).toBe(600);
    expect(run.usage?.estimatedCostUsd).toBeCloseTo(0.000_48, 6);
  });

  it('names the model and the mode and prints the calls and the cost so far', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(onAModel()));

    const printed = fixture.printed();
    expect(printed[1]).toContain('Muse Spark 1.3 · contributor mode');
    const log = printed.filter((line) => LOG_LINE.test(line));
    expect(log).toHaveLength(4);
    // A cost under a cent says so rather than rounding itself away to $0.00.
    expect(log.at(0)).toContain('1 call · under $0.01 so far');
    expect(log.at(-1)).toContain('4 calls · under $0.01 so far');
    expect(printed.at(-4)).toContain('Muse Spark 1.3 · contributor mode');
  });

  it('never prints the credential’s value, on any path', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(onAModel()));

    for (const line of fixture.printed()) expect(line).not.toContain(STAND_IN_CREDENTIAL);
    // Nor into the artifact, which is the other place a credential must never reach.
    const { runDir } = await theRun(fixture.runsRoot);
    expect(await readFile(runPaths(runDir).run, 'utf8')).not.toContain(STAND_IN_CREDENTIAL);
  });
});

describe('a run that cannot start', () => {
  it('refuses --mode standard with no key, records the failure and runs nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ engine: 'model', mode: 'standard', env: {} });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.exitCode).not.toBe(0);
    expect(error.message).toContain('Test failed to start');
    expect(error.message).toContain('The standard model could not be used');
    expect(error.message).toContain('Nobody was simulated and no result was saved.');
    // It never ran contributor and never ran offline: the record says standard, and the
    // notice says nothing stood in for it.
    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    expect(run.status).toBe('failed');
    expect(run.failure?.reason).toBe('The standard model could not be used');
    expect(run.failure?.detail).toContain('MODEL_API_KEY');
    expect(run.engine.mode).toBe('model');
    expect(run.engine.modelMode).toBe('standard');
    expect(run.sessionIds).toEqual([]);
    expect(run.progress?.finishedSessions).toBe(0);
    expect(run.progress?.sessions).toEqual([]);
    await expect(readdir(runPaths(runDir).sessionsDir)).resolves.toEqual([]);
  });

  it('carries what the engine reported on a run nobody ran, and never a figure of its own', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ engine: 'model', mode: 'standard', env: {} });

    await failing(async () => {
      await runCommand(options);
    });

    // A failed run never reaches the loop, so this record is the command's last word on it:
    // the engine's own block, so the Test failed screen's badge states the same figure every
    // other screen does, and `null` there would say "not calibrated" about an engine that is.
    const { run } = await theRun(fixture.runsRoot);
    expect(run.calibration).toEqual(engineOnTheRecord().calibration);
    expect(run.engine.version).toBe(engineOnTheRecord().version);
  });

  it('reports the model it was to run on, and sends nobody to check a URL', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ engine: 'model', mode: 'standard', env: {} });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('Muse Spark 1.3 · standard mode');
    expect(error.message).toContain('no other engine’s result was saved in its place');
    // The prototype's three checks are about a page that could not be opened. This failure
    // reached no page at all, so printing them would send a reader the wrong way.
    expect(error.message).not.toContain('Both versions have to be reachable');
    expect(error.message).not.toContain('reachable at that address');
  });

  it('refuses --engine offline together with --mode standard before anything is written', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ engine: 'offline', mode: 'standard' });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('The test was not started.');
    expect(error.message).toContain('--mode "standard"');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('names what a --steps file got wrong, and writes nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const steps = join(fixture.runsRoot, '..', 'not-steps.json');
    await writeFile(steps, JSON.stringify({ steps: [{ id: 'cart' }] }));
    const options = fixture.options({ steps });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('does not declare the task’s steps');
    expect(error.message).toContain('steps.0.label');
    expect(error.message).toContain('no run directory was created');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses a seed the generator cannot tell from another, and writes nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ seed: '4294967297' });

    const error = await failing(async () => {
      await runCommand(options);
    });

    // Reduced modulo 2³² it would be sampled at seed 1, and the artifact would record a
    // number that does not reproduce it.
    expect(error.message).toContain('--seed "4294967297"');
    expect(error.message).toContain('Needs to be 0..4294967295');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('leaves no empty run directory behind when it throws before writing one', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({
      engine: 'model',
      mode: 'contributor',
      env: { MODEL_API_KEY: STAND_IN_CREDENTIAL },
      createModelProvider: () => {
        throw new Error('the provider could not be built');
      },
    });

    // Not a refusal this command knows how to word: it is handed on as the failure it is.
    await expect(runCommand(options)).rejects.toThrow('the provider could not be built');
    // And the directory it had claimed for the run is swept: a directory named like a run
    // is the one `personavision open` resolves to and `personavision validate` checks.
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('names an audience it does not know, and writes nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ audience: 'nobody-in-particular' });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('there is no audience "nobody-in-particular"');
    expect(error.message).toContain('outdoor-gear-shoppers');
    expect(error.message).toContain('no run directory was created');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });
});

describe('a run that is stopped', () => {
  it('keeps the sessions already written and leaves a directory that validates', async () => {
    // Six sessions and a pool of four, so that stopping after the first one lands leaves
    // sessions the swarm had not taken yet: a swarm no bigger than its pool has every
    // session in flight already, and stopping it could only ever keep all of them.
    fixture = await runFixture({ size: 3 });
    let stop = (): void => undefined;
    const options = fixture.options({
      // Stop as soon as the first session has landed: the run ends on what it kept.
      onStop: (ask) => {
        stop = ask;
        return () => undefined;
      },
      log: (line: string) => {
        if (LOG_LINE.test(line)) stop();
      },
    });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('The test was stopped.');
    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    // Ended, not left running: a stopped test is a test that is over, and the counts say
    // how many of the planned sessions it kept.
    expect(run.status).toBe('finished');
    expect(run.progress?.totalSessions).toBe(6);
    expect(run.progress?.finishedSessions).toBeGreaterThan(0);
    expect(run.progress?.finishedSessions).toBeLessThan(6);
    expect(run.sessionIds).toHaveLength(run.progress?.finishedSessions ?? 0);

    // The figures are of the run as it ended, not of the moment it was interrupted (#293).
    // The loop writes `aggregate.json` as its sessions land and says `open` in every one of
    // them, because at the time it writes them the run is; the file carried through this
    // close unchanged would tell a reader a finished run's figures are partial for ever, and
    // its `computedAt` would no longer be the one `personavision aggregate` derives.
    const aggregate = aggregateSchema.parse(
      JSON.parse(await readFile(runPaths(runDir).aggregate, 'utf8')),
    );
    expect(aggregate.runStatus).toBe('finished');
    expect(aggregate.computedAt).toBe(run.finishedAt);
    expect(aggregate.scoredSessionCount + aggregate.excludedAutomationFailures).toBe(
      run.sessionIds.length,
    );
  });
});

describe('a run of one site', () => {
  /**
   * The one-URL form: the site, the feature in the user's own words, and the two halves of
   * the goal — `--task` is the task the people attempt, and `--criterion` is what has to be
   * observable for an attempt to have worked (`docs/FLOW.md` sections 11 and 12).
   */
  const oneSite = (over: Partial<RunCommandOptions> = {}): Partial<RunCommandOptions> => ({
    url: [],
    site: 'https://fixture.test/cart.html',
    feature: 'buying a canvas tote bag  on the phone',
    successCriterion: 'The order confirmation is visible.',
    ...over,
  });

  it('writes one variant named for the site, carrying the feature and the goal', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(oneSite()));

    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    // The platform's one-URL variant, under the one spelling both surfaces write (#282):
    // `site` rather than `A`, named for the site's host.
    expect(run.variants).toEqual([
      { id: ONE_URL_VARIANT_ID, name: 'fixture.test', url: 'https://fixture.test/cart.html' },
    ]);
    // The user's own sentence, as typed: the double space between its words survives.
    expect(run.feature).toBe('buying a canvas tote bag  on the phone');
    // A person typed it on the command line, so the author is the user and not the model.
    expect(run.goal).toEqual({
      task: 'Buy the canvas tote bag and place the order',
      successCriterion: 'The order confirmation is visible.',
      lastWrittenBy: 'user',
    });
    // Two people, one seed, one version — and the sessions on disk agree.
    expect(run.progress?.totalSessions).toBe(2);
    expect(run.progress?.finishedSessions).toBe(2);
    expect(run.sessionIds).toEqual(['S-01', 'S-02']);
  });

  /**
   * The `site` block of `run.json` is the **platform's**, and this command is not it (#243).
   *
   * `--site` names a URL to drive, and that is all the command knows: there is no workspace
   * holding a site record, and the URL the command was given is already on the record as the
   * version it drove. So no block is written at all, which is exactly why the field is
   * optional.
   */
  it('writes no site block, because the URL is already on the record as a version', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(oneSite()));

    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(await validate(runDir)).toEqual([]);
    expect(run.site).toBeUndefined();
    expect('site' in run).toBe(false);
    // The URL is still on the record, where a run has always carried it: as the version it
    // drove.
    expect(run.variants[0]?.url).toBe('https://fixture.test/cart.html');
  });

  it('names the site where the progress report names a version', async () => {
    fixture = await runFixture({ size: 2 });

    await runCommand(fixture.options(oneSite()));

    const printed = fixture.printed();
    expect(printed[0]).toBe('Running · Buy the canvas tote bag and place the order');
    expect(printed[1]).toBe('0 of 2 sessions finished · offline deterministic engine');
    // One row, not two, in the shape every other row has: nothing of the feature or the
    // goal is printed into the artifact or the log beside it.
    expect(printed[2]).toBe('  site fixture.test · 2 sessions · https://fixture.test/cart.html');
    expect(printed[3]).toBe('  Fixture shoppers · 2 people · seeds 11');
  });

  /**
   * The other half of the derived task's budget (#413): a task that declares its steps is
   * untouched by it. `DERIVED_STEP_SCREENS` is the budget of the one step a derived task
   * stands the whole site up as, and `serve-run.test.ts` walks a session to it.
   */
  it('leaves a declared task on the swarm’s eight screens per step it declares', async () => {
    fixture = await runFixture({ size: 1 });

    // The same site run with `--steps`: a task that says where its steps are keeps the
    // swarm's own cap, which is what the demo, the committed example run and
    // `tests/acceptance/` walk.
    await runCommand(fixture.options(oneSite()));

    const { runDir, run } = await theRun(fixture.runsRoot);
    expect(run.steps.length).toBeGreaterThan(1);
    const session = JSON.parse(await readFile(runPaths(runDir).session('S-01'), 'utf8')) as Session;
    expect(session.screens.length).toBeLessThanOrEqual(8 * run.steps.length);
    expect(session.screens.length).toBeLessThan(DERIVED_STEP_SCREENS);
  }, 60_000);

  it('refuses a site with no feature, and writes nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options(oneSite({ feature: '  ' }));

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.exitCode).not.toBe(0);
    expect(error.message).toContain('The test was not started.');
    expect(error.message).toContain('--feature');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses a site with no success criterion, and writes nothing', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options(oneSite({ successCriterion: undefined }));

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('--criterion');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses a criterion that is two sentences at the flag that carries it', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options(
      oneSite({ successCriterion: 'The order confirmation is visible. The basket is empty.' }),
    );

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('--criterion');
    expect(error.message).toContain('one plain sentence');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses the feature of a site on a comparison of versions', async () => {
    fixture = await runFixture({ size: 2 });
    // The two-version form, with a flag that belongs to the other one: it is refused rather
    // than read and dropped.
    const options = fixture.options({ feature: 'buying a canvas tote bag' });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('--feature');
    expect(error.message).toContain('--site');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses an address that is not a whole URL, in the platform’s own words', async () => {
    fixture = await runFixture({ size: 2 });
    // The same refusal the New test form gives, because both surfaces parse a site URL
    // through `variantForSite`: nothing is assumed on the typist's behalf.
    const options = fixture.options(oneSite({ site: 'fixture.test/cart.html' }));

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.exitCode).not.toBe(0);
    expect(error.message).toContain('--site');
    expect(error.message).toContain('is not a whole web address');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });

  it('refuses a command that names both a site and a version, naming both', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options(oneSite({ url: ['https://fixture.test/b/cart.html'] }));

    const error = await failing(async () => {
      await runCommand(options);
    });

    // Neither form is guessed at: both flags are named, with what they were given.
    expect(error.message).toContain('--site');
    expect(error.message).toContain('https://fixture.test/cart.html');
    expect(error.message).toContain('--url');
    expect(error.message).toContain('https://fixture.test/b/cart.html');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });
});

/**
 * The capture source, with the sessions open at once counted.
 *
 * A session is in flight from the moment it is handed a page to the moment the page is
 * closed, which is where a real run holds a browser — so the peak here is the number of
 * browsers this command had open on the site at once.
 */
const counting = (inner: CaptureSource): { source: CaptureSource; peak: () => number } => {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    source: {
      openSession: async (variant, device) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return await inner.openSession(variant, device);
      },
      capture: (page, ctx) => inner.capture(page, ctx),
      act: (page, action, ctx, options) => inner.act(page, action, ctx, options),
      close: async (page) => {
        inFlight -= 1;
        await inner.close(page);
      },
    },
  };
};

/**
 * `--concurrency`: this command's own, and bounded by the same per-site cap the platform
 * holds its runs to (#241).
 *
 * A developer driving a run from the command line is driving somebody's site, so the number
 * that binds a run started through the product binds this one too — and a number that was
 * lowered is **said** rather than silently obeyed, because a run going past ten at a time
 * when fifty were asked for is otherwise something to be counted and guessed at.
 */
describe('a run bounded by the per-site cap', () => {
  /** Twelve sessions: six people, one seed, two versions — more than the cap, so it shows. */
  const MORE_SESSIONS_THAN_THE_CAP = { size: 6 };

  it('bounds --concurrency above the cap, and says so before the run starts', async () => {
    fixture = await runFixture(MORE_SESSIONS_THAN_THE_CAP);
    const counted = counting(fixture.options().source as CaptureSource);

    await runCommand(fixture.options({ concurrency: '50', source: counted.source }));

    // Said in the platform's own words, so the terminal and a screen state one sentence.
    expect(fixture.printed()).toContain(
      `A site takes ${String(CAPS.concurrentSessionsPerSite)} browsers at a time, so this run is bounded to ${String(CAPS.concurrentSessionsPerSite)} rather than the 50 it asked for.`,
    );
    // And bounded, not merely announced: never more than the cap had a page open at once.
    expect(counted.peak()).toBeLessThanOrEqual(CAPS.concurrentSessionsPerSite);
    expect(counted.peak()).toBeGreaterThan(1);
    // Every session it planned still ran: the ones over the bound waited.
    const { run } = await theRun(fixture.runsRoot);
    expect(run.progress?.finishedSessions).toBe(12);
    expect(run.status).toBe('finished');
  }, 60_000);

  it('honours a concurrency under the cap, and says nothing', async () => {
    // A developer asking for two browsers on a laptop is asking for less load, not more.
    fixture = await runFixture({ size: 2 });
    const counted = counting(fixture.options().source as CaptureSource);

    await runCommand(fixture.options({ concurrency: '2', source: counted.source }));

    expect(fixture.printed().some((line) => line.includes('browsers at a time'))).toBe(false);
    expect(counted.peak()).toBeLessThanOrEqual(2);
  }, 60_000);

  it('refuses a concurrency of nobody at the flag that carries it', async () => {
    fixture = await runFixture({ size: 2 });
    const options = fixture.options({ concurrency: '0' });

    const error = await failing(async () => {
      await runCommand(options);
    });

    expect(error.message).toContain('--concurrency');
    expect(error.message).toContain('at least 1');
    expect(await readdir(fixture.runsRoot).catch(() => [])).toEqual([]);
  });
});
