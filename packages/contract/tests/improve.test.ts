import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  Holdout,
  HoldoutFigures,
  Improve,
  Preview,
  PullRequest,
  Run,
  Violation,
} from '../src/index.js';
import {
  holdoutVerdictSchema,
  readRun,
  runPaths,
  runSchema,
  validate,
  writeRun,
} from '../src/index.js';
import { temporaryRunDir, validArtifact, validRun } from './fixtures.js';

/**
 * The change a run tested: path 2's `improve` block, its pull request, its preview, the
 * holdout it was tested against and the holdout's own figures beside the two variants'.
 *
 * The rules come from `docs/FLOW.md` sections 15 and 16, and what is asserted here is the
 * behaviour of the contract at its boundary — an artifact parses, or it is rejected at the
 * JSON path of the offending value. Nothing here asserts the internal structure of a zod
 * schema, and nothing here produces an `improve` block: four later steps do that, against
 * these names.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const PULL_REQUEST: PullRequest = {
  repository: 'northwind/storefront',
  number: 128,
  url: 'https://github.com/northwind/storefront/pull/128',
  title: 'Move Complete order above the fold',
};

/**
 * The one person held out, who is a person **beside** the participant the run fixture's
 * audience generates: `audience.size` is the participants the user approved and the holdout
 * is people the run generated as well as them (#306, following #303's recommendation).
 * Seeds the change was never chosen against are the generator's invariant and are proved
 * there (#298): what the contract holds is that the ids are people this run carries.
 */
const HELD_OUT_ID = 'held-out-1';

const HOLDOUT: Holdout = { personaIds: [HELD_OUT_ID], confirmed: true };

/** One scored holdout session, and it completed: the rate the counts underneath it state. */
const FIGURES: HoldoutFigures = {
  completionRate: 1,
  outcomeCounts: { success: 1, abandoned: 0, failed: 0, automationFailure: 0 },
  scoredSessionCount: 1,
};

const CHANGE: Improve = {
  recommendationId: 'R-01',
  changedFile: 'app/checkout/page.tsx',
  pullRequest: PULL_REQUEST,
  preview: { url: 'https://storefront-git-pr-128.example.test/cart' },
  baselineVariant: 'A',
  changeVariant: 'B',
  holdout: HOLDOUT,
};

/**
 * One more person for each person the change was held out from, named `held-out-1` upwards.
 *
 * It is the count that matters here and not the names: a run carries its participants plus
 * the people it held out beside them, so a fixture that names two ids carries two more
 * people — whether or not the ids it named are theirs. That is what lets the tests below
 * name somebody the run never generated without also making the run the wrong size.
 */
const heldOutPeople = (howMany: number): Run['personas'] => {
  const [first] = validRun().personas;
  if (first === undefined) throw new Error('the run fixture generates nobody');
  return Array.from({ length: howMany }, (_unused, index) => ({
    ...structuredClone(first),
    id: `held-out-${String(index + 1)}`,
    name: `${first.name} (holdout)`,
  }));
};

/** The fixture run as a path-2 test: a change, its preview, a holdout, and its figures. */
const withChange = (change: Partial<Improve> = {}): Run => {
  const run = validRun();
  // Deep, because two tests here delete and add fields inside the block: a test that
  // mutates a fixture must not reach the next one.
  run.improve = structuredClone({ ...CHANGE, ...change });
  run.personas = [...run.personas, ...heldOutPeople(run.improve.holdout.personaIds.length)];
  run.verdict.holdout = 'confirmed';
  run.scores[0].holdout = { ...FIGURES };
  return run;
};

/** A path-2 run that ran no holdout: nobody held out, nothing confirmed, no figures. */
const ranNoHoldout = (): Run => {
  const run = withChange({ holdout: { personaIds: [], confirmed: null } });
  run.verdict.holdout = 'none';
  delete run.scores[0].holdout;
  return run;
};

/** `improve/pullRequest/url — <message>`: where a rejection landed, and what it said. */
const rejections = (run: unknown): string[] => {
  const result = runSchema.safeParse(run);
  if (result.success) throw new Error('the run was accepted, and should not have been');
  return result.error.issues.map((issue) => `${issue.path.join('/')} — ${issue.message}`);
};

const paths = (run: unknown): string[] =>
  rejections(run).map((rejection) => rejection.split(' — ')[0]);

const accepted = (run: unknown): Run => runSchema.parse(run);

/**
 * The violations a `run.json` causes, read back through `validate`: the artifact's own
 * boundary, where an unknown field is named at its own path rather than at its object's.
 */
const violationsFor = async (run: Run): Promise<Violation[]> => {
  const { dir, cleanup } = await temporaryRunDir();
  try {
    await writeRun(dir, validArtifact());
    await writeFile(runPaths(dir).run, asJson(run));
    return await validate(dir);
  } finally {
    await cleanup();
  }
};

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

/** The same run with one field of its `improve` block deleted. */
const without = (field: string): unknown => {
  const run = withChange();
  const improve: Record<string, unknown> = run.improve as Record<string, unknown>;
  delete improve[field];
  return run;
};

describe('a run that tested no change', () => {
  it('parses unchanged, and carries neither a change nor a holdout verdict', () => {
    const run = accepted(validRun());

    expect(run.improve).toBeUndefined();
    expect(run.verdict.holdout).toBeUndefined();
    expect(run.scores.every((score) => score.holdout === undefined)).toBe(true);
  });

  it('is rejected for a holdout verdict it has no holdout for', () => {
    const run = validRun();
    run.verdict.holdout = 'confirmed';

    const [rejection] = rejections(run);

    expect(rejection).toContain('verdict/holdout');
    expect(rejection).toContain('tested no change');
  });
});

describe('the change a run tested', () => {
  it('carries the recommendation it answers, its pull request, its preview and its variants', () => {
    const { improve } = accepted(withChange());

    expect(improve?.recommendationId).toBe('R-01');
    expect(improve?.changedFile).toBe('app/checkout/page.tsx');
    expect(improve?.pullRequest).toEqual(PULL_REQUEST);
    expect(improve?.preview.url).toBe('https://storefront-git-pr-128.example.test/cart');
    expect([improve?.baselineVariant, improve?.changeVariant]).toEqual(['A', 'B']);
  });

  it('is impossible to write down with no recommendation', () => {
    expect(paths(without('recommendationId'))).toContain('improve/recommendationId');
  });

  it('is rejected when its pull request has no URL', () => {
    const run = withChange();
    const pullRequest: Record<string, unknown> = run.improve!.pullRequest;
    delete pullRequest['url'];

    expect(paths(run)).toContain('improve/pullRequest/url');
  });

  it('is rejected when its pull request names no repository the way GitHub spells one', () => {
    const [rejection] = rejections(
      withChange({ pullRequest: { ...PULL_REQUEST, repository: 'storefront' } }),
    );

    expect(rejection).toContain('improve/pullRequest/repository');
    expect(rejection).toContain('owner/name');
  });

  it('has nowhere to hold a credential: an unknown field is rejected at its own path', async () => {
    const run = withChange();
    const improve: Record<string, unknown> = run.improve as Record<string, unknown>;
    improve['installationToken'] = 'ghs-not-a-real-token';
    const pullRequest: Record<string, unknown> = run.improve!.pullRequest;
    pullRequest['authorization'] = 'Bearer not-a-real-token';

    const violations = await violationsFor(run);

    expect(offenders(violations)).toEqual(
      expect.arrayContaining([
        `${label.run}/improve/installationToken`,
        `${label.run}/improve/pullRequest/authorization`,
      ]),
    );
    expect(violations.every((violation) => !violation.message.includes('not-a-real-token'))).toBe(
      true,
    );
  });
});

describe('the two versions a path-2 run compared', () => {
  it('are named by their ids in the run, and a name the run does not carry is rejected', () => {
    const [rejection] = rejections(withChange({ baselineVariant: 'ZZZ' }));

    expect(rejection).toContain('improve/baselineVariant');
    expect(rejection).toContain("not one of this run's variants");
  });

  it('are two: a before and after of one version is rejected', () => {
    const [rejection] = rejections(withChange({ changeVariant: 'A' }));

    expect(rejection).toContain('improve/changeVariant');
    expect(rejection).toContain('not a comparison');
  });
});

describe('the addresses a path-2 run records', () => {
  it('are http or https with a host, so a scheme that runs code is rejected', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script></script>', 'file:///etc']) {
      expect(paths(withChange({ preview: { url } }))).toContain('improve/preview/url');
      expect(paths(withChange({ pullRequest: { ...PULL_REQUEST, url } }))).toContain(
        'improve/pullRequest/url',
      );
    }
  });

  it('name a repository an API path can be composed from, so a walk out of one is rejected', () => {
    for (const repository of ['../..', 'owner/..', 'owner/name?x=1', 'owner name/x']) {
      expect(paths(withChange({ pullRequest: { ...PULL_REQUEST, repository } }))).toContain(
        'improve/pullRequest/repository',
      );
    }
  });
});

describe('the preview the change was tested at', () => {
  it('is accepted as a reason with no URL, which is a repository with no preview deployment', () => {
    const preview: Preview = {
      url: null,
      reason: 'This repository has no preview deployment for its pull requests.',
    };

    expect(accepted(withChange({ preview })).improve?.preview).toEqual(preview);
  });

  it('is rejected when it has neither a URL nor a reason', () => {
    const [rejection] = rejections(withChange({ preview: { url: null } }));

    expect(rejection).toContain('improve/preview/reason');
    expect(rejection).toContain('records why there is no preview');
  });

  it('is rejected when it is a URL and a reason there is none at once', () => {
    const [rejection] = rejections(
      withChange({
        preview: { url: 'https://storefront.example.test', reason: 'There is no preview.' },
      }),
    );

    expect(rejection).toContain('improve/preview/reason');
    expect(rejection).toContain('never both');
  });

  it('is rejected when its URL is not a URL', () => {
    expect(paths(withChange({ preview: { url: 'storefront.example.test' } }))).toContain(
      'improve/preview/url',
    );
  });
});

describe('the holdout the change was never chosen against', () => {
  it('names people the run generated, and is rejected on the first id it does not carry', () => {
    const [rejection] = rejections(
      withChange({ holdout: { personaIds: [HELD_OUT_ID, 'nobody-at-all'], confirmed: true } }),
    );

    expect(rejection).toContain('improve/holdout/personaIds/1');
    expect(rejection).toContain('"nobody-at-all"');
    expect(rejection).toContain('people the run generated');
  });

  /**
   * The third state, and the common one on twenty people: the holdout ran, its own bands
   * overlapped, and `judgeHoldout` answered `null` rather than accusing the change
   * (`@personavision/scoring`, #304). It reads as the verdict `none`, and the people it ran
   * on are still named — which is how it is told apart from a run that held nobody out.
   */
  it('records a holdout that ran and could not judge as confirmed nothing', () => {
    const run = withChange({ holdout: { personaIds: [HELD_OUT_ID], confirmed: null } });
    run.verdict.holdout = 'none';

    const parsed = accepted(run);

    expect(parsed.improve?.holdout).toEqual({ personaIds: [HELD_OUT_ID], confirmed: null });
    expect(parsed.verdict.holdout).toBe('none');
  });

  it('is rejected when a holdout that could not judge is reported as a verdict anyway', () => {
    const run = withChange({ holdout: { personaIds: [HELD_OUT_ID], confirmed: null } });
    run.verdict.holdout = 'confirmed';

    const [rejection] = rejections(run);

    expect(rejection).toContain('verdict/holdout');
    expect(rejection).toContain('one claim');
  });

  it('is nobody and nothing confirmed when no holdout ran', () => {
    const run = ranNoHoldout();

    expect(accepted(run).improve?.holdout).toEqual({ personaIds: [], confirmed: null });
    expect(accepted(run).scores[0].holdout).toBeUndefined();
  });

  it('is rejected when it names nobody and still claims the gain was confirmed', () => {
    const run = ranNoHoldout();
    run.improve!.holdout.confirmed = false;

    const [rejection] = rejections(run);

    expect(rejection).toContain('improve/holdout/confirmed');
    expect(rejection).toContain('names nobody');
  });

  it('is rejected when the same person is held out twice', () => {
    const [rejection] = rejections(
      withChange({
        holdout: { personaIds: [HELD_OUT_ID, HELD_OUT_ID], confirmed: true },
      }),
    );

    expect(rejection).toContain('improve/holdout/personaIds/1');
    expect(rejection).toContain('held out more than once');
  });

  it('is rejected on a run that failed to start, which simulated nobody', () => {
    const run = withChange();
    run.status = 'failed';
    run.failure = { reason: 'The site never answered.', detail: '' };

    expect(paths(run)).toContain('improve/holdout/personaIds');
  });

  /**
   * The count rule a path-2 run is held to: the participants the user approved, **plus**
   * the people held out beside them. `audience.size` is not raised to cover the holdout,
   * because it is the number the user approved and `holdoutSize` reads it back.
   */
  it('is people the run carries as well as its participants, and the count says so', () => {
    const run = withChange();

    expect(run.audience.size).toBe(1);
    expect(accepted(run).personas).toHaveLength(2);
  });

  it('is rejected when the run carries no more people than its audience generates', () => {
    const run = withChange();
    run.personas = run.personas.filter((persona) => persona.id !== HELD_OUT_ID);

    const rejection = rejections(run).find((issue) => issue.startsWith('personas'));

    expect(rejection).toContain('holds out 1 person beside them');
    expect(rejection).toContain('it carries 1');
  });
});

describe('the verdict on the holdout', () => {
  it('is confirmed, not confirmed, or none', () => {
    expect(holdoutVerdictSchema.options).toEqual(['confirmed', 'not_confirmed', 'none']);
  });

  it('renders a change that did not hold from data, not from the sentence', () => {
    const run = withChange({ holdout: { personaIds: [HELD_OUT_ID], confirmed: false } });
    run.verdict.holdout = 'not_confirmed';

    expect(accepted(run).verdict.holdout).toBe('not_confirmed');
  });

  it('is required of a run that ran a holdout', () => {
    const run = withChange();
    delete run.verdict.holdout;

    const [rejection] = rejections(run);

    expect(rejection).toContain('verdict/holdout');
    expect(rejection).toContain('says whether it was confirmed');
  });

  it('is rejected when it says the opposite of what the run recorded', () => {
    const run = withChange({ holdout: { personaIds: [HELD_OUT_ID], confirmed: false } });
    run.verdict.holdout = 'confirmed';

    const [rejection] = rejections(run);

    expect(rejection).toContain('verdict/holdout');
    expect(rejection).toContain('one claim');
  });
});

describe("the holdout's own figures on a score", () => {
  it('are the third figure the Improve screen prints, stored and not computed', () => {
    const [score] = accepted(withChange()).scores;

    expect(score.holdout).toEqual(FIGURES);
  });

  it("hold the rate to the holdout's own counts, by the same arithmetic", () => {
    const run = withChange();
    run.scores[0].holdout = {
      completionRate: 0.5,
      outcomeCounts: { success: 9, abandoned: 2, failed: 0, automationFailure: 1 },
      scoredSessionCount: 11,
    };

    const [rejection] = rejections(run);

    expect(rejection).toContain('scores/0/holdout/completionRate');
    expect(rejection).toContain('disagrees with 9 of 11 scored sessions');
  });

  it('accept a rate stored rounded to two places, by the same tolerance', () => {
    const run = withChange();
    run.scores[0].holdout = {
      completionRate: 0.82,
      outcomeCounts: { success: 9, abandoned: 2, failed: 0, automationFailure: 1 },
      scoredSessionCount: 11,
    };

    expect(accepted(run).scores[0].holdout?.completionRate).toBe(0.82);
  });

  it('are rejected on a run that ran no holdout, because they are about nobody', () => {
    const run = ranNoHoldout();
    run.scores[0].holdout = { ...FIGURES };

    const [rejection] = rejections(run);

    expect(rejection).toContain('scores/0/holdout');
    expect(rejection).toContain('ran no holdout');
  });

  it('are rejected when the outcomes do not account for the sessions that were scored', () => {
    const run = withChange();
    run.scores[0].holdout = {
      completionRate: 1,
      outcomeCounts: { success: 5, abandoned: 5, failed: 0, automationFailure: 0 },
      scoredSessionCount: 5,
    };

    const [rejection] = rejections(run);

    expect(rejection).toContain('scores/0/holdout/scoredSessionCount');
    expect(rejection).toContain('the outcomes account for 10 of them');
  });
});

describe('a path-2 run through the writer and the reader', () => {
  it('reads back the change, the pull request, the preview, the holdout and its figures', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      const written = { ...validArtifact(), run: withChange() };
      await writeRun(dir, written);

      const read = await readRun(dir);

      expect(read).toEqual(written);
      expect(read.run.improve).toEqual(CHANGE);
      expect(read.run.improve?.pullRequest).toEqual(PULL_REQUEST);
      expect(read.run.improve?.holdout).toEqual(HOLDOUT);
      expect(read.run.scores[0].holdout).toEqual(FIGURES);
      expect(read.run.verdict.holdout).toBe('confirmed');
    } finally {
      await cleanup();
    }
  });

  it('reports a holdout naming somebody the run never generated at its path in run.json', async () => {
    const violations = await violationsFor(
      withChange({ holdout: { personaIds: ['somebody-else'], confirmed: true } }),
    );

    expect(offenders(violations)).toContain(`${label.run}/improve/holdout/personaIds/0`);
    expect(violations[0].message).toContain('"somebody-else"');
  });
});
