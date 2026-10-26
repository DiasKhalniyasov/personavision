import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelMode, RunRequest, Violation } from '../src/index.js';
import { readRun, runPaths, runRequestSchema, validate, writeRun } from '../src/index.js';
import { AUDIENCE_ID, onTheModel, temporaryRunDir, validArtifact, validRun } from './fixtures.js';

/**
 * The model a run was run on, recorded beside what it cost.
 *
 * The owner's setting is per run — `contributor` (cheap, and the content may be trained on)
 * or `standard` (the published prices, and it may not). A cost figure cannot be checked
 * without knowing which price table produced it, and a customer could not tell which model
 * their content went to, so the mode is a field of its own: nothing parses it back out of a
 * model id, and nothing defaults it to a mode nobody chose.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('the model mode a run records', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  /** Overwrites `run.json` in a valid run directory, and returns what is wrong with it. */
  const writeRunJson = async (run: unknown): Promise<Violation[]> => {
    await writeFile(runPaths(dir).run, asJson(run));
    return validate(dir);
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it.each(['contributor', 'standard'] as const)(
    'accepts %s beside the model ids that run called',
    async (modelMode) => {
      expect(await writeRunJson(onTheModel(validRun(), modelMode))).toEqual([]);

      const { engine } = (await readRun(dir)).run;
      // What a screen and a cost reader take: the mode itself, not a model id to parse.
      expect(engine.modelMode).toBe(modelMode);
      expect(engine.models?.decision).toBe(
        modelMode === 'contributor' ? 'muse-spark-1.3-contributor' : 'muse-spark-1.3',
      );
    },
  );

  it('rejects a mode that is neither, such as a model id in the mode’s place', async () => {
    const run = onTheModel(validRun());

    const offending = await writeRunJson({
      ...run,
      engine: { ...run.engine, modelMode: 'muse-spark-1.3' },
    });

    expect(offenders(offending)).toContain(`${label.run}/engine/modelMode`);
  });

  it('rejects a run that called a model and recorded no mode', async () => {
    const run = onTheModel(validRun());
    const engine = { ...run.engine };
    delete engine.modelMode;

    const offending = await writeRunJson({ ...run, engine });

    expect(offenders(offending)).toContain(`${label.run}/engine/modelMode`);
  });

  it('rejects a run that called a model and named no model ids', async () => {
    const run = onTheModel(validRun());

    const offending = await writeRunJson({ ...run, engine: { ...run.engine, models: null } });

    expect(offenders(offending)).toContain(`${label.run}/engine/models`);
  });

  it('rejects an offline run that claims a model mode, and says why', async () => {
    const run = validRun();

    const offending = await writeRunJson({
      ...run,
      engine: { ...run.engine, modelMode: 'standard' },
    });

    const violation = offending.find((candidate) => candidate.path === '/engine/modelMode');
    expect(violation?.file).toBe(label.run);
    expect(violation?.message).toContain('offline');
    expect(violation?.message).toContain('standard');
  });

  it('rejects an offline run that names model ids', async () => {
    const run = validRun();

    const offending = await writeRunJson({
      ...run,
      engine: {
        ...run.engine,
        models: {
          decision: 'muse-spark-1.3',
          segmentation: 'muse-spark-1.3',
          planning: 'muse-spark-1.3',
        },
      },
    });

    expect(offenders(offending)).toContain(`${label.run}/engine/models`);
  });
});

describe('a run.json written before the model mode existed', () => {
  it('parses, and hands a screen undefined for a mode nobody recorded', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      // The offline engine of the committed example run: it carries neither field, and the
      // writer adds neither, because an absent mode is never defaulted to one of the two.
      await writeRun(dir, validArtifact());

      expect(await validate(dir)).toEqual([]);
      const { engine } = (await readRun(dir)).run;
      expect(engine.mode).toBe('offline');
      expect(engine.modelMode).toBeUndefined();
      expect(engine.models).toBeNull();

      const written = JSON.parse(await readFile(runPaths(dir).run, 'utf8')) as {
        engine: Record<string, unknown>;
      };
      expect('modelMode' in written.engine).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('the model mode a run was asked for', () => {
  const request = (modelMode?: ModelMode): Record<string, unknown> => {
    const asked: Record<string, unknown> = {
      task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
      variants: validRun().variants,
      audienceId: AUDIENCE_ID,
      repeats: 3,
      seed: 1,
      engineMode: 'model',
    };
    if (modelMode !== undefined) asked['modelMode'] = modelMode;
    return asked;
  };

  it.each(['contributor', 'standard'] as const)('accepts a request naming %s', (modelMode) => {
    const parsed = runRequestSchema.safeParse(request(modelMode));

    expect(parsed.success).toBe(true);
    expect((parsed.data as RunRequest).modelMode).toBe(modelMode);
  });

  it('rejects a model-mode request that names no model', () => {
    const parsed = runRequestSchema.safeParse(request());

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('/'))).toContain('modelMode');
  });

  it('rejects a mode that is neither', () => {
    expect(runRequestSchema.safeParse({ ...request(), modelMode: 'cheap' }).success).toBe(false);
  });

  /**
   * An offline request may still carry one: the CLI defaults `--mode` to `contributor`
   * while `--engine` defaults to `offline` (#54), so asking for the cheap model and then
   * running offline is an ordinary request. The *artifact* is where the rule bites, because
   * that is the record of what actually ran.
   */
  it('accepts an offline request that names the model it would have used', () => {
    expect(
      runRequestSchema.safeParse({ ...request('contributor'), engineMode: 'offline' }).success,
    ).toBe(true);
  });

  it('accepts an offline request that names none', () => {
    const asked = request();
    expect(runRequestSchema.safeParse({ ...asked, engineMode: 'offline' }).success).toBe(true);
  });
});
