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
 * The run fixture generates one person, so the holdout names that one. Seeds the change was
 * never chosen against are the generator's invariant and are proved there (#298): what the
 * contract holds is that the ids are people this run carries.
 */
const HOLDOUT: Holdout = { personaIds: ['rushed-buyer'], confirmed: true };

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

/** The fixture run as a path-2 test: a change, its preview, a holdout, and its figures. */
const withChange = (change: Partial<Improve> = {}): Run => {
  const run = validRun();
  // Deep, because two tests here delete and add fields inside the block: a test that
  // mutates a fixture must not reach the next one.
  run.improve = structuredClone({ ...CHANGE, ...change });
  run.verdict.holdout = 'confirmed';
  run.scores[0].holdout = { ...FIGURES };
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
      withChange({ holdout: { personaIds: ['rushed-buyer', 'nobody-at-all'], confirmed: true } }),
    );

    expect(rejection).toContain('improve/holdout/personaIds/1');
    expect(rejection).toContain('"nobody-at-all"');
    expect(rejection).toContain('people the run generated');
  });

  it('records whether it confirmed the gain, and is rejected when it ran and does not', () => {
    const [rejection] = rejections(
      withChange({ holdout: { personaIds: ['rushed-buyer'], confirmed: null } }),
    );

    expect(rejection).toContain('improve/holdout/confirmed');
    expect(rejection).toContain('whether the holdout confirmed the gain');
  });

  it('is nobody and nothing confirmed when no holdout ran', () => {
    const run = withChange({ holdout: { personaIds: [], confirmed: null } });
    run.verdict.holdout = 'none';

    expect(accepted(run).improve?.holdout).toEqual({ personaIds: [], confirmed: null });
  });

  it('is rejected when it names nobody and still claims the gain was confirmed', () => {
    const [rejection] = rejections(withChange({ holdout: { personaIds: [], confirmed: false } }));

    expect(rejection).toContain('improve/holdout/confirmed');
    expect(rejection).toContain('names nobody');
  });
});

describe('the verdict on the holdout', () => {
  it('is confirmed, not confirmed, or none', () => {
    expect(holdoutVerdictSchema.options).toEqual(['confirmed', 'not_confirmed', 'none']);
  });

  it('renders a change that did not hold from data, not from the sentence', () => {
    const run = withChange({ holdout: { personaIds: ['rushed-buyer'], confirmed: false } });
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
    const run = withChange({ holdout: { personaIds: ['rushed-buyer'], confirmed: false } });
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
