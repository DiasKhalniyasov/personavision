import { rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Recommendations, Violation } from '../src/index.js';
import { readRun, recommendationsSchema, runPaths, validate, writeRun } from '../src/index.js';
import {
  CART,
  CONFIRM,
  FINDING_ID,
  temporaryRunDir,
  validArtifact,
  validRecommendations,
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
