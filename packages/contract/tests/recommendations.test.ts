import { rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Aggregate,
  CitedRun,
  Recommendation,
  Recommendations,
  Violation,
} from '../src/index.js';
import {
  aggregateSchema,
  readRun,
  recommendationsSchema,
  runPaths,
  validate,
  validateRecommendations,
  writeRun,
} from '../src/index.js';
import {
  brokenSessionArtifact,
  CART,
  CONFIRM,
  FINDING_ID,
  temporaryRunDir,
  validAggregate,
  validArtifact,
  validRecommendations,
  validRun,
} from './fixtures.js';

/**
 * `recommendations.json`: the shape rules that make an uncitable claim impossible to write
 * down, and the round trip through the run directory it is optional in.
 *
 * The rules come from `docs/FLOW.md` section 14 — one plain sentence each, every claim
 * citing its evidence, the rank stored rather than computed — and they are asserted here
 * against the schema, because a prompt is not where a rule like that can live.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

/** `recommendations/0/rank` — where a rejection landed, and what it said. */
const rejections = (document: unknown): string[] => {
  const result = recommendationsSchema.safeParse(document);
  if (result.success) throw new Error('the document was accepted, and should not have been');
  return result.error.issues.map((issue) => `${issue.path.join('/')} — ${issue.message}`);
};

const paths = (document: unknown): string[] =>
  rejections(document).map((rejection) => rejection.split(' — ')[0]);

const accepted = (document: unknown): Recommendations => recommendationsSchema.parse(document);

/** The fixture with one recommendation changed. */
const withTop = (changes: Record<string, unknown>): unknown => {
  const document = validRecommendations();
  return {
    ...document,
    recommendations: [{ ...document.recommendations[0], ...changes }],
  };
};

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('a recommendation', () => {
  it('carries what the ranking was stored from and what it rests on', () => {
    const [top] = accepted(validRecommendations()).recommendations;

    expect(top.id).toBe('R-01');
    expect(top.rank).toBe(1);
    expect(top.peopleAffected).toBe(1);
    expect(top.step).toBe(CONFIRM);
    expect(top.findingIds).toEqual([FINDING_ID]);
    expect(top.citations).toHaveLength(3);
  });

  it('is one plain sentence, and a second sentence is rejected for what it is', () => {
    const [rejection] = rejections(
      withTop({ sentence: 'Move the button up. It is below the fold.' }),
    );

    expect(rejection).toContain('recommendations/0/sentence');
    expect(rejection).toContain('one plain sentence');
    expect(rejection).toContain('this is two or more');
  });

  it('keeps a full stop that is not the end of a sentence', () => {
    for (const sentence of [
      'Move Complete order 2.5 cm up so it clears the fold.',
      'Put the total above the fold, e.g. beside the item list.',
    ]) {
      expect(accepted(withTop({ sentence })).recommendations[0].sentence).toBe(sentence);
    }
  });

  it('is rejected when it cites nothing', () => {
    const [rejection] = rejections(withTop({ citations: [] }));

    expect(rejection).toContain('recommendations/0/citations');
    expect(rejection).toContain('nothing to cite is not published');
  });

  it('is rejected when it names no finding', () => {
    const [rejection] = rejections(withTop({ findingIds: [] }));

    expect(rejection).toContain('recommendations/0/findingIds');
    expect(rejection).toContain('names the findings it rests on');
  });
});

describe('the three citation kinds are a closed set', () => {
  it('takes a session with an offset, a heatmap region and a funnel step', () => {
    expect(
      accepted(
        withTop({
          citations: [
            { kind: 'session', sessionId: 'S-01', offsetMs: 0 },
            // `null` when the whole step is the region rather than one area on it.
            { kind: 'heatmap', variant: 'A', step: CART, aoiId: null },
            { kind: 'funnel', stepId: CART },
          ],
        }),
      ).recommendations[0].citations,
    ).toHaveLength(3);
  });

  it('names the path of a kind it does not know', () => {
    expect(
      paths(withTop({ citations: [{ kind: 'video', sessionId: 'S-01', offsetMs: 12 }] })),
    ).toEqual(['recommendations/0/citations/0/kind']);
  });

  it('names the path of an extra key on a kind it does know', () => {
    const [rejection] = rejections(
      withTop({
        citations: [{ kind: 'funnel', stepId: CONFIRM, url: 'https://example.test/funnel' }],
      }),
    );

    expect(rejection).toContain('recommendations/0/citations/0');
    expect(rejection).toContain('url');
  });

  it('holds a session citation to a session id and a heatmap citation to its three fields', () => {
    expect(
      paths(withTop({ citations: [{ kind: 'session', sessionId: 'S2', offsetMs: 12 }] })),
    ).toEqual(['recommendations/0/citations/0/sessionId']);
    expect(
      paths(withTop({ citations: [{ kind: 'heatmap', variant: 'B', step: CONFIRM }] })),
    ).toEqual(['recommendations/0/citations/0/aoiId']);
  });
});

describe('the ranked list', () => {
  const ranked = (ranks: number[]): unknown => {
    const document = validRecommendations();
    const [top] = document.recommendations;
    return {
      ...document,
      recommendations: ranks.map((rank, position) => ({ ...top, id: `R-0${position + 1}`, rank })),
    };
  };

  it('runs 1, 2, 3 … in array order', () => {
    expect(accepted(ranked([1, 2, 3])).recommendations.map((one) => one.rank)).toEqual([1, 2, 3]);
  });

  it('is rejected for a gap, at the rank that has it', () => {
    const [rejection] = rejections(ranked([1, 3]));

    expect(rejection).toContain('recommendations/1/rank');
    expect(rejection).toContain('expected 2, found 3');
  });

  it('is rejected for a repeat', () => {
    expect(paths(ranked([1, 1]))).toEqual(['recommendations/1/rank']);
  });
});

describe('a run with nothing to recommend', () => {
  const nothing = (changes: Record<string, unknown>): unknown => ({
    ...validRecommendations(),
    recommendations: [],
    writeUp: undefined,
    ...changes,
  });

  it('carries the reason in one stored sentence instead of an empty section', () => {
    const document = accepted(
      nothing({
        nothingToRecommend: 'Too few people reached the checkout for a claim to rest on.',
      }),
    );

    expect(document.recommendations).toEqual([]);
    expect(document.nothingToRecommend).toContain('Too few people');
  });

  it('parses with neither recommendations nor a reason', () => {
    expect(accepted(nothing({})).nothingToRecommend).toBeUndefined();
  });

  it('is rejected when it both recommends something and says there is nothing', () => {
    const [rejection] = rejections({
      ...validRecommendations(),
      nothingToRecommend: 'Nothing could be recommended.',
    });

    expect(rejection).toContain('nothingToRecommend');
    expect(rejection).toContain('either recommends something or says why it could not');
  });
});

describe('the provenance the Analysis screen prints', () => {
  it('says how many sessions were read of how many, how, and with what seed', () => {
    const { sample } = accepted(validRecommendations());

    expect(`Read ${sample.read} of ${sample.of} sessions`).toBe('Read 2 of 2 sessions');
    expect(sample.strategy).toBe('stratified by outcome, then segment');
    expect(sample.seed).toBe(20_261_024);
  });

  it('is rejected when it claims to have read more sessions than the run holds', () => {
    const document = validRecommendations();
    const [rejection] = rejections({ ...document, sample: { ...document.sample, read: 3 } });

    expect(rejection).toContain('sample/read');
    expect(rejection).toContain('never larger than the run');
  });
});

describe('the write-up block', () => {
  it('is an ordered list of claims, the last of them what was not found', () => {
    const writeUp = accepted(validRecommendations()).writeUp ?? [];

    expect(writeUp).toHaveLength(2);
    expect(writeUp[writeUp.length - 1].heading).toBe('What I did not find');
  });

  it('rejects a claim with nothing to cite', () => {
    const document = validRecommendations();
    const [rejection] = rejections({
      ...document,
      writeUp: [{ heading: 'A hunch', body: 'It feels slow.', citations: [] }],
    });

    expect(rejection).toContain('writeUp/0/citations');
    expect(rejection).toContain('nothing to cite is not published');
  });

  it('is left out rather than written empty', () => {
    expect(paths({ ...validRecommendations(), writeUp: [] })).toEqual(['writeUp']);
    expect(accepted({ ...validRecommendations(), writeUp: undefined }).writeUp).toBeUndefined();
  });
});

describe('recommendations.json in a run directory', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('reads back as the objects that were written', async () => {
    const written = { ...validArtifact(), recommendations: validRecommendations() };
    await writeRun(dir, written);

    expect(await validate(dir)).toEqual([]);
    expect(await readRun(dir)).toEqual(written);
  });

  it('is optional: a run directory without it is a run with no recommendation', async () => {
    await writeRun(dir, validArtifact());

    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).recommendations).toBeUndefined();
  });

  it('is swept when a run is written over one that had it, so no advice crosses runs', async () => {
    await writeRun(dir, { ...validArtifact(), recommendations: validRecommendations() });
    await writeRun(dir, validArtifact());

    expect((await readRun(dir)).recommendations).toBeUndefined();
    await expect(rm(runPaths(dir).recommendations)).rejects.toThrow(/ENOENT/);
  });

  it('is reported at the path of the offending value when it is on disk', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          { ...document.recommendations[0], citations: [{ kind: 'video', sessionId: 'S-02' }] },
        ],
      }),
    );

    expect(offenders(await validate(dir))).toEqual([
      `${label.recommendations}/recommendations/0/citations/0/kind`,
    ]);
  });

  it('is a violation when it is there but is not this contract', async () => {
    await writeRun(dir, validArtifact());
    await writeFile(runPaths(dir).recommendations, 'not json\n');

    expect(offenders(await validate(dir))).toEqual([label.recommendations]);
  });

  it('refuses a citation into a session the run does not hold, at that session id', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'session', sessionId: 'S-99', offsetMs: 2400 }],
          },
        ],
      }),
    );

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([
      `${label.recommendations}/recommendations/0/citations/0/sessionId`,
    ]);
    expect(violations[0].message).toMatch(/names no session listed in run.json sessionIds/);
  });

  it('holds a write-up claim to the same rule as the recommendation it comes from', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        writeUp: [
          {
            ...document.writeUp![0],
            citations: [{ kind: 'session', sessionId: 'S-99', offsetMs: 0 }],
          },
        ],
      }),
    );

    expect(offenders(await validate(dir))).toEqual([
      `${label.recommendations}/writeUp/0/citations/0/sessionId`,
    ]);
  });

  it('refuses a heatmap citation into a variant, a step or an area the run does not declare', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'heatmap', variant: 'C', step: 'wishlist', aoiId: 'z-nothing' }],
          },
        ],
      }),
    );

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([
      `${label.recommendations}/recommendations/0/citations/0/variant`,
      `${label.recommendations}/recommendations/0/citations/0/step`,
      `${label.recommendations}/recommendations/0/citations/0/aoiId`,
    ]);
    expect(violations[0].message).toMatch(/names no variant declared in this run/);
  });

  it('refuses a funnel citation into a step the run does not declare', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'funnel', stepId: 'wishlist' }],
          },
        ],
      }),
    );

    expect(offenders(await validate(dir))).toEqual([
      `${label.recommendations}/recommendations/0/citations/0/stepId`,
    ]);
  });

  it('accepts a heatmap citation whose region is the whole step', async () => {
    const document = validRecommendations();
    await writeRun(dir, {
      ...validArtifact(),
      recommendations: {
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'heatmap', variant: 'B', step: CONFIRM, aoiId: null }],
          },
        ],
      },
    });

    expect(await validate(dir)).toEqual([]);
  });

  it('refuses a recommendation resting on a finding findings.json does not carry', async () => {
    const document = validRecommendations();
    await writeRun(dir, { ...validArtifact(), recommendations: document });
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [{ ...document.recommendations[0], findingIds: ['F-99'] }],
      }),
    );

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([
      `${label.recommendations}/recommendations/0/findingIds/0`,
    ]);
    expect(violations[0].message).toMatch(/names no finding in findings.json/);
  });

  it('accepts a citation into a session the run does hold', async () => {
    const document = validRecommendations();
    await writeRun(dir, {
      ...validArtifact(),
      recommendations: {
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'session', sessionId: 'S-01', offsetMs: 120 }],
          },
        ],
      },
    });

    expect(await validate(dir)).toEqual([]);
  });

  it('refuses to write a citation that would not read back', async () => {
    const document = validRecommendations();

    await expect(
      writeRun(dir, {
        ...validArtifact(),
        recommendations: {
          ...document,
          recommendations: [
            {
              ...document.recommendations[0],
              citations: [{ kind: 'session', sessionId: 'S-99', offsetMs: 2400 }],
            },
          ],
        },
      }),
    ).rejects.toThrow(/names no session listed in run.json sessionIds/);
  });

  it('refuses to write recommendations that would not read back', async () => {
    const document = validRecommendations();

    await expect(
      writeRun(dir, {
        ...validArtifact(),
        recommendations: {
          ...document,
          recommendations: [
            { ...document.recommendations[0], sentence: 'Move it up. Then test again.' },
          ],
        },
      }),
    ).rejects.toThrow(/one plain sentence/);
  });
});

/**
 * Every citation held to the run it belongs to: the run-level half of the contract, which
 * the per-file schema above cannot do because it needs the sessions, the areas of interest,
 * the findings and the aggregate in hand at once.
 *
 * The validator is exported, so these assert it directly — the path and the wording of each
 * rejection, not just that something failed — and the run-directory suite above asserts
 * that `validate` runs it.
 */
describe('every citation against the run it belongs to', () => {
  /** The artifact, its aggregate and the recommendations, as one argument to the validator. */
  const cited = (changes: Partial<CitedRun> = {}): CitedRun => ({
    ...validArtifact(),
    aggregate: validAggregate(),
    recommendations: validRecommendations(),
    ...changes,
  });

  /** The top recommendation with some of its fields replaced. */
  const topRecommendation = (
    document: Recommendations,
    changes: Partial<Recommendation>,
  ): Recommendations => ({
    ...document,
    recommendations: [{ ...document.recommendations[0], ...changes }],
  });

  const complaints = (run: CitedRun): string[] =>
    validateRecommendations(run).map(
      (violation) => `${violation.file}${violation.path} — ${violation.message}`,
    );

  it('returns no violation for a run whose citations all resolve', () => {
    expect(validateRecommendations(cited())).toEqual([]);
  });

  it('returns no violation for a run that produced no recommendation at all', () => {
    expect(validateRecommendations({ ...validArtifact(), aggregate: validAggregate() })).toEqual(
      [],
    );
  });

  it('reports in the same shape validate does: the file, the pointer and the message', () => {
    const [violation] = validateRecommendations(
      cited({
        recommendations: topRecommendation(validRecommendations(), {
          citations: [{ kind: 'session', sessionId: 'S-99', offsetMs: 0 }],
        }),
      }),
    );

    expect(violation).toEqual({
      file: label.recommendations,
      path: '/recommendations/0/citations/0/sessionId',
      message: '"S-99" names no session listed in run.json sessionIds',
    });
  });

  describe('a funnel citation', () => {
    /** The same aggregate with the confirmation step walked by nobody, so its funnel loses it. */
    const withoutConfirm = (): Aggregate => {
      const aggregate = validAggregate();
      return {
        ...aggregate,
        funnelSlices: aggregate.funnelSlices.map((slice) => ({
          ...slice,
          funnel: slice.funnel.filter((row) => row.step === CART),
        })),
      };
    };

    it('is rejected when the step is not one the aggregate’s funnel carries', () => {
      const [complaint, ...rest] = complaints(cited({ aggregate: withoutConfirm() }));

      expect(complaint).toBe(
        // The third citation of the fixture: the one the Funnel and timing screen anchors.
        `${label.recommendations}/recommendations/0/citations/2/stepId — "${CONFIRM}" names no step the funnel in ${label.aggregate} carries`,
      );
      expect(rest).toEqual([]);
    });

    it('resolves against the funnel and not merely against the task’s steps', () => {
      // `confirm` is a step the run declares, which is what made the rejection above the
      // run-level check this ticket is about rather than the one a finding already gets.
      expect(validRun().steps.map((step) => step.id)).toContain(CONFIRM);
      expect(validateRecommendations(cited())).toEqual([]);
    });

    it('is held to the task’s own steps when the aggregate carries no funnel at all', () => {
      // `aggregateSchema` forbids a slice on an aggregate of no scored sessions, so a run
      // whose every session our automation broke has a readable aggregate with no funnel to
      // anchor in. Holding a citation to an empty funnel would refuse every one of them.
      const nothingScored = aggregateSchema.parse({
        ...validAggregate(),
        scoredSessionCount: 0,
        excludedAutomationFailures: 2,
        funnelSlices: [],
        screenSlices: [],
      });

      expect(
        validateRecommendations(
          cited({
            aggregate: nothingScored,
            recommendations: topRecommendation(validRecommendations(), {
              citations: [{ kind: 'funnel', stepId: CONFIRM }],
              // Nobody was scored, so the claim is about nobody either.
              peopleAffected: 0,
            }),
          }),
        ),
      ).toEqual([]);
    });

    it('is held to the task’s own steps on a run that computed no aggregate', () => {
      const [complaint] = complaints(
        cited({
          aggregate: undefined,
          recommendations: topRecommendation(validRecommendations(), {
            citations: [{ kind: 'funnel', stepId: 'wishlist' }],
          }),
        }),
      );

      expect(complaint).toBe(
        `${label.recommendations}/recommendations/0/citations/0/stepId — "wishlist" names no step declared in this run's steps`,
      );
    });
  });

  describe('no recommendation rests on an excluded session', () => {
    const broken = (): CitedRun => ({
      ...brokenSessionArtifact(),
      aggregate: validAggregate(),
      recommendations: validRecommendations(),
    });

    it('rejects a recommendation whose every cited session is one, in those words', () => {
      const [complaint, ...rest] = complaints({
        ...broken(),
        recommendations: topRecommendation(validRecommendations(), {
          citations: [{ kind: 'session', sessionId: 'S-03', offsetMs: 0 }],
        }),
      });

      expect(complaint).toContain(`${label.recommendations}/recommendations/0/citations`);
      expect(complaint).toContain('every session it cites is an automation failure');
      expect(complaint).toContain('about our harness and not about the site');
      expect(rest).toEqual([]);
    });

    it('accepts one cited among several, and does not count it in peopleAffected', () => {
      const run = {
        ...broken(),
        recommendations: topRecommendation(validRecommendations(), {
          citations: [
            { kind: 'session' as const, sessionId: 'S-01', offsetMs: 0 },
            { kind: 'session' as const, sessionId: 'S-03', offsetMs: 0 },
          ],
          // One of the two is ours: the claim is about the one person it is about.
          peopleAffected: 1,
        }),
      };

      expect(validateRecommendations(run)).toEqual([]);
      // Counting the excluded session would make this the same claim about two people.
      expect(
        complaints({
          ...run,
          recommendations: topRecommendation(run.recommendations as Recommendations, {
            citations: [
              { kind: 'session', sessionId: 'S-01', offsetMs: 0 },
              { kind: 'session', sessionId: 'S-02', offsetMs: 0 },
            ],
            peopleAffected: 1,
          }),
        })[0],
      ).toContain('fewer than its own evidence');
    });

    it('leaves a cited session whose file is not in hand to the reader that reports it', () => {
      const artifact = brokenSessionArtifact();

      // The run lists S-03 and the directory has no such file. Whether that session was one
      // our automation broke is readable only off the file, so counting it either way here
      // would be a second complaint about the one gap the reader already names.
      expect(
        validateRecommendations({
          ...artifact,
          sessions: artifact.sessions.filter((session) => session.sessionId !== 'S-03'),
          recommendations: topRecommendation(validRecommendations(), {
            citations: [
              { kind: 'session', sessionId: 'S-01', offsetMs: 0 },
              { kind: 'session', sessionId: 'S-03', offsetMs: 0 },
            ],
            peopleAffected: 1,
          }),
        }),
      ).toEqual([]);
    });

    it('holds a write-up claim to the same rule', () => {
      const document = validRecommendations();
      const [complaint, ...rest] = complaints({
        ...broken(),
        recommendations: {
          ...document,
          writeUp: [
            {
              ...document.writeUp![0],
              citations: [{ kind: 'session', sessionId: 'S-03', offsetMs: 0 }],
            },
          ],
        },
      });

      expect(complaint).toContain(`${label.recommendations}/writeUp/0/citations`);
      expect(complaint).toContain('every session it cites is an automation failure');
      expect(rest).toEqual([]);
    });
  });

  describe('peopleAffected, the stored ranking key', () => {
    it('is rejected when it is fewer people than the recommendation’s own citations', () => {
      const [complaint, ...rest] = complaints(
        cited({
          recommendations: topRecommendation(validRecommendations(), { peopleAffected: 0 }),
        }),
      );

      expect(complaint).toBe(
        `${label.recommendations}/recommendations/0/peopleAffected — peopleAffected is the people a change would reach, and this recommendation cites 1 of them by session: 0 is fewer than its own evidence`,
      );
      expect(rest).toEqual([]);
    });

    it('is rejected when it is more people than the aggregate measured', () => {
      const [complaint, ...rest] = complaints(
        cited({
          recommendations: topRecommendation(validRecommendations(), { peopleAffected: 3 }),
        }),
      );

      expect(complaint).toBe(
        `${label.recommendations}/recommendations/0/peopleAffected — peopleAffected is the ranking key, and it cannot be a number nobody measured: this says 3, and ${label.aggregate} is of 2 scored sessions`,
      );
      expect(rest).toEqual([]);
    });

    it('is held to the sessions our automation did not break when there is no aggregate', () => {
      const [complaint, ...rest] = complaints({
        ...brokenSessionArtifact(),
        recommendations: topRecommendation(validRecommendations(), { peopleAffected: 3 }),
      });

      expect(complaint).toBe(
        `${label.recommendations}/recommendations/0/peopleAffected — peopleAffected is the ranking key, and it cannot be a number nobody measured: this says 3, and the run holds 2 sessions our own automation did not break`,
      );
      expect(rest).toEqual([]);
    });

    it('takes a figure between the people cited and the people measured', () => {
      for (const peopleAffected of [1, 2]) {
        expect(
          validateRecommendations(
            cited({
              recommendations: topRecommendation(validRecommendations(), { peopleAffected }),
            }),
          ),
        ).toEqual([]);
      }
    });
  });
});

describe('validate on a run directory reports the run-level rules too', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('accepts a run whose aggregate, findings and recommendations all agree', async () => {
    await writeRun(dir, {
      ...validArtifact(),
      aggregate: validAggregate(),
      recommendations: validRecommendations(),
    });

    expect(await validate(dir)).toEqual([]);
  });

  it('refuses a recommendation resting only on a session our own automation broke', async () => {
    const artifact = brokenSessionArtifact();
    const document = validRecommendations();
    await writeRun(dir, artifact);
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [{ kind: 'session', sessionId: 'S-03', offsetMs: 0 }],
          },
        ],
      }),
    );

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([`${label.recommendations}/recommendations/0/citations`]);
    expect(violations[0].message).toContain('automation failure');
  });

  it('reports a missing session file once, and not again as a citation into it', async () => {
    const artifact = brokenSessionArtifact();
    const document = validRecommendations();
    await writeRun(dir, artifact);
    await rm(runPaths(dir).session('S-03'));
    await writeFile(
      runPaths(dir).recommendations,
      asJson({
        ...document,
        recommendations: [
          {
            ...document.recommendations[0],
            citations: [
              { kind: 'session', sessionId: 'S-01', offsetMs: 0 },
              { kind: 'session', sessionId: 'S-03', offsetMs: 0 },
            ],
            peopleAffected: 1,
          },
        ],
      }),
    );

    const violations = await validate(dir);

    expect(offenders(violations)).toEqual([`${label.run}/sessionIds/2`]);
    expect(violations[0].message).toMatch(/there is no sessions\/S-03.json/);
  });

  it('refuses to write a peopleAffected the aggregate did not measure', async () => {
    const document = validRecommendations();

    await expect(
      writeRun(dir, {
        ...validArtifact(),
        aggregate: validAggregate(),
        recommendations: {
          ...document,
          recommendations: [{ ...document.recommendations[0], peopleAffected: 9 }],
        },
      }),
    ).rejects.toThrow(/cannot be a number nobody measured/);
  });
});
