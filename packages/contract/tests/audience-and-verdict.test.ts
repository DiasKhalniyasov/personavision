import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Audience, Persona, Score, Verdict, Violation } from '../src/index.js';
import { readRun, runPaths, runSchema, validate, writeRun } from '../src/index.js';
import {
  AUDIENCE_ID,
  CART,
  CONFIRM,
  COMPLETE_AOI,
  FINDING_ID,
  temporaryRunDir,
  validArtifact,
  validFindings,
  validRun,
  validSession,
} from './fixtures.js';

/**
 * The three additions the owner's direction made load-bearing: the audience the test ran
 * for, the completion rate the product leads with, and the audience-facing verdict.
 *
 * What is asserted here is the behaviour of the contract at its boundary — an artifact
 * parses, or it is rejected at the JSON path of the offending value. Nothing here asserts
 * the internal structure of a zod schema.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

/** `run.json/audience/devices` — the file and the JSON path together. */
const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The violations a mutated `run.json` produces, read back through `validate`. */
const describeRunDir = () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  return {
    /** Writes `run.json` as `change` leaves it, and returns every violation it causes. */
    async afterRunChange(change: (run: ReturnType<typeof validRun>) => void): Promise<string[]> {
      const run = validRun();
      change(run);
      await writeFile(runPaths(dir).run, asJson(run));
      return offenders(await validate(dir));
    },
    violations: async (): Promise<Violation[]> => validate(dir),
    dir: () => dir,
  };
};

describe('the audience a test was run for', () => {
  const runDir = describeRunDir();

  it('is carried by value, and read back as it was written', async () => {
    const { run } = await readRun(runDir.dir());

    expect(run.audience).toEqual(validRun().audience);
  });

  it('rejects an audience with a missing field, at that field', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        const audience: Record<string, unknown> = run.audience;
        delete audience['techSavviness'];
      }),
    ).toContain(`${label.run}/audience/techSavviness`);
  });

  it('rejects a techSavviness outside 0..1', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.techSavviness = 1.2;
      }),
    ).toContain(`${label.run}/audience/techSavviness`);
  });

  it('rejects a priceSensitivity outside 0..1', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.priceSensitivity = -0.2;
      }),
    ).toContain(`${label.run}/audience/priceSensitivity`);
  });

  it('rejects a device mix whose shares do not sum to 1', async () => {
    const run = validRun();
    run.audience.devices[0].share = 0.5;
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/audience/devices`);
    expect(violations[0].message).toMatch(/shares must sum to 1/);
  });

  it('accepts a device mix that sums to 1 only within the tolerance', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.devices = [
          { ...run.audience.devices[0], share: 1 / 3 },
          { ...run.audience.devices[1], share: 1 / 3 },
          { ...run.audience.devices[0], name: 'Tablet 820', share: 1 / 3 },
        ];
      }),
    ).toEqual([]);
  });

  it('rejects a device share outside 0..1', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.devices[0].share = 1.4;
      }),
    ).toContain(`${label.run}/audience/devices/0/share`);
  });

  it('rejects an age range that runs backwards', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.ageRange = { min: 65, max: 25 };
      }),
    ).toContain(`${label.run}/audience/ageRange`);
  });

  it('rejects an audience that generates nobody', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.audience.size = 0;
      }),
    ).toContain(`${label.run}/audience/size`);
  });

  it('rejects a missing generatedFrom seed, so a run stays reproducible', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        const generatedFrom: Record<string, unknown> = run.audience.generatedFrom;
        delete generatedFrom['seed'];
      }),
    ).toContain(`${label.run}/audience/generatedFrom/seed`);
  });
});

describe("a persona's provenance", () => {
  const runDir = describeRunDir();

  it('rejects a persona generated from another audience, at that persona', async () => {
    const run = validRun();
    run.personas[0].audienceId = 'somebody-elses-audience';
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/personas/0/audienceId`);
    expect(violations[0].message).toMatch(/is not this run's audience/);
  });

  it("rejects a run carrying fewer personas than its audience's size", async () => {
    const run = validRun();
    run.audience.size = 4;
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/personas`);
    expect(violations[0].message).toMatch(/generates 4 people, but this run carries 1/);
  });

  it('rejects a persona with no segment to group its results by', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.personas[0].segment = '';
      }),
    ).toContain(`${label.run}/personas/0/segment`);
  });
});

describe('the completion rate the product leads with', () => {
  const runDir = describeRunDir();

  it('rejects a rate outside 0..1', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.scores[0].completionRate = 1.2;
      }),
    ).toContain(`${label.run}/scores/0/completionRate`);
  });

  it('rejects a rate that disagrees with the outcome counts it summarises', async () => {
    const run = validRun();
    run.scores[0].outcomeCounts = { success: 9, abandoned: 2, failed: 0, automationFailure: 1 };
    run.scores[0].scoredSessionCount = 11;
    run.scores[0].completionRate = 0.5;
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/scores/0/completionRate`);
    expect(violations[0].message).toMatch(/disagrees with 9 of 11 scored sessions/);
  });

  it('accepts a rate stored rounded to two places, because that is the same number', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.scores[0].outcomeCounts = { success: 9, abandoned: 2, failed: 0, automationFailure: 1 };
        run.scores[0].scoredSessionCount = 11;
        run.scores[0].completionRate = 0.82;
      }),
    ).toEqual([]);
  });

  it('rejects a rate above zero when no session was scored at all', async () => {
    const run = validRun();
    run.scores[0].outcomeCounts = { success: 0, abandoned: 0, failed: 0, automationFailure: 2 };
    run.scores[0].scoredSessionCount = 0;
    run.scores[0].completionRate = 0.5;
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/scores/0/completionRate`);
    expect(violations[0].message).toMatch(/no session was scored/);
  });
});

describe('the audience-facing verdict', () => {
  const runDir = describeRunDir();

  it('rejects a preferredVariant the run does not declare', async () => {
    const run = validRun();
    run.verdict.preferredVariant = 'Z';
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/verdict/preferredVariant`);
    expect(violations[0].message).toMatch(/names no variant/);
  });

  it('rejects a verdict with no reason, because that is not a verdict', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.reasons = [];
      }),
    ).toContain(`${label.run}/verdict/reasons`);
  });

  it('rejects a third reason, because the contract caps it at two', async () => {
    const run = validRun();
    run.verdict.reasons = ['One.', 'Two.', 'Three.'];
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/verdict/reasons`);
    expect(violations[0].message).toMatch(/one or two reasons, never three/);
  });

  it('accepts one reason and accepts two', async () => {
    for (const reasons of [['One.'], ['One.', 'Two.']]) {
      expect(
        await runDir.afterRunChange((run) => {
          run.verdict.reasons = reasons;
        }),
      ).toEqual([]);
    }
  });

  it('rejects a fourth headline finding, because the screen shows at most three', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.headlineFindingIds = ['F-01', 'F-02', 'F-03', 'F-04'];
      }),
    ).toContain(`${label.run}/verdict/headlineFindingIds`);
  });

  it('rejects the same headline finding named twice', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.headlineFindingIds = [FINDING_ID, FINDING_ID];
      }),
    ).toContain(`${label.run}/verdict/headlineFindingIds/1`);
  });

  it('rejects an empty audienceSentence, because it is the headline', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.audienceSentence = '';
      }),
    ).toContain(`${label.run}/verdict/audienceSentence`);
  });
});

describe('a headline finding is checked across the two files', () => {
  const runDir = describeRunDir();

  it('rejects a headline id that findings.json does not carry', async () => {
    const run = validRun();
    run.verdict.headlineFindingIds = ['F-77'];
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/verdict/headlineFindingIds/0`);
    expect(violations[0].message).toMatch(/names no finding in findings.json/);
  });

  it('is a cross-file check: run.json alone parses, and the directory does not', async () => {
    const run = validRun();
    run.verdict.headlineFindingIds = ['F-77'];

    expect(runSchema.safeParse(run).success).toBe(true);

    await writeFile(runPaths(runDir.dir()).run, asJson(run));
    expect(offenders(await validate(runDir.dir()))).toEqual([
      `${label.run}/verdict/headlineFindingIds/0`,
    ]);
  });

  it('rejects a headline id once findings.json drops the finding it named', async () => {
    const findings = validFindings();
    findings.findings = [];
    await writeFile(runPaths(runDir.dir()).findings, asJson(findings));

    expect(offenders(await validate(runDir.dir()))).toContain(
      `${label.run}/verdict/headlineFindingIds/0`,
    );
  });
});

describe('the one heatmap the verdict embeds', () => {
  const runDir = describeRunDir();

  it('rejects hero evidence on a variant the run does not declare', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.heroEvidence = { variant: 'Z', step: CONFIRM, aoiId: null };
      }),
    ).toContain(`${label.run}/verdict/heroEvidence/variant`);
  });

  it('rejects hero evidence on a step the run does not declare', async () => {
    const run = validRun();
    run.verdict.heroEvidence = {
      variant: 'B',
      step: 'checkout-step-that-is-not-ours',
      aoiId: null,
    };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/verdict/heroEvidence/step`);
    expect(violations[0].message).toMatch(/names no step declared/);
  });

  it('rejects hero evidence whose aoiId names no area of interest', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.heroEvidence = { variant: 'B', step: CONFIRM, aoiId: 'no-such-area' };
      }),
    ).toContain(`${label.run}/verdict/heroEvidence/aoiId`);
  });

  it('rejects an area of interest that is not on the variant and step it claims', async () => {
    const run = validRun();
    // The area exists, but it is variant B's confirmation step, not variant A's cart.
    run.verdict.heroEvidence = { variant: 'A', step: CART, aoiId: COMPLETE_AOI };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/verdict/heroEvidence/aoiId`);
    expect(violations[0].message).toMatch(/is on B confirm, but the hero evidence is of A cart/);
  });

  it('accepts a null aoiId, which is the whole step as the evidence', async () => {
    expect(
      await runDir.afterRunChange((run) => {
        run.verdict.heroEvidence = { variant: 'B', step: CONFIRM, aoiId: null };
      }),
    ).toEqual([]);
  });
});

describe('an artifact written for the previous schema version', () => {
  const runDir = describeRunDir();

  it('is named as such rather than silently misread', async () => {
    const run: Record<string, unknown> = { ...validRun(), schemaVersion: 1 };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/schemaVersion`);
    expect(violations[0].message).toBe(
      'written for schema version 1, but this build reads schema version 2: regenerate the run directory',
    );
  });

  it('refuses to be read at all, rather than read as this version', async () => {
    const run: Record<string, unknown> = { ...validRun(), schemaVersion: 1 };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    await expect(readRun(runDir.dir())).rejects.toThrow(/written for schema version 1/);
  });

  it('names the old version in every file that carries one', async () => {
    const session: Record<string, unknown> = { ...validSession('S-01', 'A'), schemaVersion: 1 };
    const findings: Record<string, unknown> = { ...validFindings(), schemaVersion: 1 };
    await writeFile(runPaths(runDir.dir()).session('S-01'), asJson(session));
    await writeFile(runPaths(runDir.dir()).findings, asJson(findings));

    expect(offenders(await validate(runDir.dir()))).toEqual(
      expect.arrayContaining([
        `${label.findings}/schemaVersion`,
        `${label.session('S-01')}/schemaVersion`,
      ]),
    );
  });
});

describe('the artifact stays portable', () => {
  const runDir = describeRunDir();

  /** What the platform owns and an artifact must never carry (`docs/FLOW.md` section 8). */
  const PLATFORM_FIELDS = ['accountId', 'workspaceId', 'email', 'password', 'token'] as const;

  for (const field of PLATFORM_FIELDS) {
    it(`rejects ${field} on run.json rather than passing it through`, async () => {
      const run: Record<string, unknown> = {
        ...validRun(),
        [field]: 'something-the-platform-owns',
      };
      await writeFile(runPaths(runDir.dir()).run, asJson(run));

      expect(offenders(await validate(runDir.dir()))).toContain(`${label.run}/${field}`);
    });

    it(`rejects ${field} on the audience the run froze`, async () => {
      const run = validRun();
      const audience: Record<string, unknown> = run.audience;
      audience[field] = 'something-the-platform-owns';
      await writeFile(runPaths(runDir.dir()).run, asJson(run));

      expect(offenders(await validate(runDir.dir()))).toContain(`${label.run}/audience/${field}`);
    });

    it(`rejects ${field} on a session`, async () => {
      const session: Record<string, unknown> = {
        ...validSession('S-01', 'A'),
        [field]: 'something-the-platform-owns',
      };
      await writeFile(runPaths(runDir.dir()).session('S-01'), asJson(session));

      expect(offenders(await validate(runDir.dir()))).toContain(
        `${label.session('S-01')}/${field}`,
      );
    });

    it(`rejects ${field} on findings.json`, async () => {
      const findings: Record<string, unknown> = {
        ...validFindings(),
        [field]: 'something-the-platform-owns',
      };
      await writeFile(runPaths(runDir.dir()).findings, asJson(findings));

      expect(offenders(await validate(runDir.dir()))).toContain(`${label.findings}/${field}`);
    });
  }

  it('rejects an audienceRef, because the audience is carried by value', async () => {
    const run: Record<string, unknown> = { ...validRun(), audienceRef: AUDIENCE_ID };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    expect(offenders(await validate(runDir.dir()))).toContain(`${label.run}/audienceRef`);
  });

  it('rejects a field the contract does not declare, wherever it is nested', async () => {
    const run = validRun();
    const persona: Record<string, unknown> = run.personas[0];
    persona['accountEmail'] = 'someone@example.test';
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    expect(offenders(await validate(runDir.dir()))).toContain(
      `${label.run}/personas/0/accountEmail`,
    );
  });
});

describe('every new field is reachable as an inferred type from the entry point', () => {
  it('types the audience, the persona, the score and the verdict', () => {
    const run = validRun();
    const audience: Audience = run.audience;
    const persona: Persona = run.personas[0];
    const score: Score = run.scores[0];
    const verdict: Verdict = run.verdict;

    const size: number = audience.size;
    const share: number = audience.devices[0].share;
    const seed: number = audience.generatedFrom.seed;
    const audienceId: string = persona.audienceId;
    const segment: string = persona.segment;
    const completionRate: number = score.completionRate;
    const preferredVariant: string = verdict.preferredVariant;
    const audienceSentence: string = verdict.audienceSentence;
    const reasons: string[] = verdict.reasons;
    const headlineFindingIds: string[] = verdict.headlineFindingIds;
    const heroAoiId: string | null = verdict.heroEvidence.aoiId;

    expect({
      size,
      share,
      seed,
      audienceId,
      segment,
      completionRate,
      preferredVariant,
      audienceSentence,
      reasons,
      headlineFindingIds,
      heroAoiId,
    }).toEqual({
      size: 1,
      share: 0.6,
      seed: 20_261_024,
      audienceId: AUDIENCE_ID,
      segment: 'desktop · price-sensitive',
      completionRate: 1,
      preferredVariant: 'A',
      audienceSentence:
        'Your audience completes the purchase on the current checkout, not on the redesign.',
      reasons: ['The button that completes the order was never seen on the redesign.'],
      headlineFindingIds: [FINDING_ID],
      heroAoiId: COMPLETE_AOI,
    });
  });
});

describe('a round trip through the writer and the reader', () => {
  it('preserves the audience, the completion rates and the whole verdict', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      const written = validArtifact();
      await writeRun(dir, written);

      const read = await readRun(dir);

      expect(read).toEqual(written);
      expect(read.run.audience).toEqual(written.run.audience);
      expect(read.run.verdict).toEqual(written.run.verdict);
      expect(read.run.scores.map((score) => score.completionRate)).toEqual(
        written.run.scores.map((score) => score.completionRate),
      );
      expect(read.run.personas.map((persona) => [persona.audienceId, persona.segment])).toEqual(
        written.run.personas.map((persona) => [persona.audienceId, persona.segment]),
      );
    } finally {
      await cleanup();
    }
  });

  it('refuses to write an artifact whose verdict names a finding it does not carry', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      const artifact = validArtifact();
      artifact.run.verdict.headlineFindingIds = ['F-77'];

      await expect(writeRun(dir, artifact)).rejects.toThrow(/names no finding in findings.json/);
    } finally {
      await cleanup();
    }
  });
});

describe('a schemaVersion that is not a version at all', () => {
  const runDir = describeRunDir();

  it('says what it found rather than calling it missing', async () => {
    const run: Record<string, unknown> = { ...validRun(), schemaVersion: '2' };
    await writeFile(runPaths(runDir.dir()).run, asJson(run));

    const violations = await validate(runDir.dir());

    expect(offenders(violations)).toContain(`${label.run}/schemaVersion`);
    expect(violations[0].message).toBe('"2" is not a schema version: expected the number 2');
  });
});
