import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Violation } from '../src/index.js';
import {
  changeSchema,
  goalSchema,
  improveSchema,
  readRun,
  runPaths,
  runSchema,
  validate,
  writeRun,
} from '../src/index.js';
import { temporaryRunDir, validArtifact, validChange, validGoal, validRun } from './fixtures.js';

/**
 * Two of the four things Muse Wonder answers, as words in the artifact: the **goal** a run
 * ran (`docs/FLOW.md` section 12) and the **change** Wonder decided from its own
 * recommendations (sections 15 and 16).
 *
 * Nothing calls either of them yet. What is asserted here is what the contract refuses — a
 * goal with no stated author, a criterion that is a paragraph, a change with no patch — and
 * the path each refusal lands at, because a caller is told where it went wrong and not that
 * something did.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Where a schema rejected a value, and what it said about it. */
const rejections = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('the value was accepted, and should not have been');
  return {
    paths: result.error.issues.map((issue) => issue.path.join('/')),
    messages: result.error.issues.map((issue) => issue.message),
  };
};

/** The fixture goal with one field replaced or removed. */
const goalWith = (changes: Record<string, unknown>): unknown => ({ ...validGoal(), ...changes });

const withoutGoalField = (field: string): unknown => {
  const goal: Record<string, unknown> = { ...validGoal() };
  delete goal[field];
  return goal;
};

describe('the goal a run ran', () => {
  it('carries the task, the observable success criterion and who last wrote it', () => {
    const goal = goalSchema.parse(validGoal());

    expect(goal.task).toBe('Buy the Ridgeline hiking boots in size 43.');
    expect(goal.successCriterion).toBe('The confirmation step shows the text "Order complete".');
    expect(goal.lastWrittenBy).toBe('user');
  });

  it('was last written by the model or by the user, and by nobody else', () => {
    expect(goalSchema.parse(goalWith({ lastWrittenBy: 'model' })).lastWrittenBy).toBe('model');
    expect(rejections(goalSchema, goalWith({ lastWrittenBy: 'wonder' })).paths).toEqual([
      'lastWrittenBy',
    ]);
  });

  it('names the field a goal is missing', () => {
    for (const field of ['task', 'successCriterion', 'lastWrittenBy']) {
      expect(rejections(goalSchema, withoutGoalField(field)).paths).toEqual([field]);
    }
  });

  it('refuses a task or a criterion that is more than one sentence', () => {
    const twoSentences = 'Buy the boots. Then check the receipt.';

    expect(rejections(goalSchema, goalWith({ task: twoSentences })).paths).toEqual(['task']);
    expect(
      rejections(goalSchema, goalWith({ successCriterion: twoSentences })).messages[0],
    ).toMatch(/one plain sentence/);
  });

  it('keeps a full stop inside a number out of it', () => {
    expect(
      goalSchema.parse(goalWith({ successCriterion: 'The page shows "2.5 kg" under the boots.' }))
        .successCriterion,
    ).toContain('2.5 kg');
  });

  it('refuses a field the shape does not declare, naming it', () => {
    expect(rejections(goalSchema, goalWith({ confidence: 0.8 })).messages.join(' ')).toContain(
      'confidence',
    );
  });
});

describe('a run may carry a goal', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('parses a run that carries none, and reads it back carrying none', async () => {
    await writeRun(dir, validArtifact());

    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).run.goal).toBeUndefined();
  });

  it('reads back the goal it was written with', async () => {
    await writeRun(dir, { ...validArtifact(), run: { ...validRun(), goal: validGoal() } });

    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).run.goal).toEqual(validGoal());
  });

  it('reports a goal it cannot read at the path of the offending value', async () => {
    await writeRun(dir, validArtifact());
    await writeFile(
      runPaths(dir).run,
      asJson({ ...validRun(), goal: goalWith({ lastWrittenBy: 'nobody' }) }),
    );

    expect(offenders(await validate(dir))).toEqual([`${label.run}/goal/lastWrittenBy`]);
  });

  it('refuses to write a goal that would not read back', async () => {
    await expect(
      writeRun(dir, {
        ...validArtifact(),
        run: {
          ...validRun(),
          goal: { ...validGoal(), successCriterion: 'It is better. Much better.' },
        },
      }),
    ).rejects.toThrow(/one plain sentence/);
  });
});

/** The fixture change with one field replaced. */
const changeWith = (changes: Record<string, unknown>): unknown => ({
  ...validChange(),
  ...changes,
});

const withoutChangeField = (field: string): unknown => {
  const change: Record<string, unknown> = { ...validChange() };
  delete change[field];
  return change;
};

describe('the change Muse Wonder decided', () => {
  it('carries the recommendation it answers, the file, the patch and the pull request', () => {
    const change = changeSchema.parse(validChange());

    expect(change.recommendationId).toBe('R-01');
    expect(change.changedFile).toBe('app/checkout/confirm/page.tsx');
    expect(change.patch).toContain('--- a/app/checkout/confirm/page.tsx');
    expect(change.pullRequest.title).toMatch(/^Move Complete order/);
    expect(change.pullRequest.body).toContain('R-01');
  });

  it('names the field a change is missing', () => {
    for (const field of ['recommendationId', 'changedFile', 'patch', 'pullRequest']) {
      expect(rejections(changeSchema, withoutChangeField(field)).paths).toEqual([field]);
    }
  });

  it('refuses a change with nothing in its patch', () => {
    const { paths, messages } = rejections(changeSchema, changeWith({ patch: '' }));

    expect(paths).toEqual(['patch']);
    expect(messages[0]).toMatch(/an empty patch changes nothing/);
  });

  it('refuses a pull request with no title or no body, at that field', () => {
    expect(
      rejections(changeSchema, changeWith({ pullRequest: { title: '', body: 'why' } })).paths,
    ).toEqual(['pullRequest/title']);
    expect(rejections(changeSchema, changeWith({ pullRequest: { title: 'what' } })).paths).toEqual([
      'pullRequest/body',
    ]);
  });

  it('is one change and not a list', () => {
    expect(rejections(changeSchema, changeWith({ changedFile: ['a.tsx', 'b.tsx'] })).paths).toEqual(
      ['changedFile'],
    );
  });

  it('refuses a field the shape does not declare, naming it', () => {
    expect(
      rejections(changeSchema, changeWith({ branch: 'wonder/r-01' })).messages.join(' '),
    ).toContain('branch');
  });

  it('spells the recommendation and the file the way the change a run tested spells them', () => {
    // The decision and the record share those two fields rather than restating them, so
    // neither can drift into a second spelling of one fact.
    for (const field of ['recommendationId', 'changedFile']) {
      expect(rejections(changeSchema, withoutChangeField(field)).paths).toEqual([field]);
      expect(rejections(improveSchema, {}).paths).toContain(field);
    }
  });

  it('is the decision and not the outcome: a run records the change it tested elsewhere', () => {
    // `changeSchema` has no pull-request number and no URL, because when Wonder decides
    // there is no pull request yet; `improveSchema` is what the run records once there is.
    expect(changeSchema.safeParse({ ...validChange(), preview: { url: null } }).success).toBe(
      false,
    );
    expect(runSchema.safeParse({ ...validRun(), change: validChange() }).success).toBe(false);
  });
});
