import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRun, runPaths, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { composeAggregate } from '@personavision/scoring';
import { NOTHING_READ, recommendationsOf, recommendOverRun } from '../scripts/recommendations.js';
import type { Aggregate, Recommendations, RunArtifact } from '@personavision/contract';

/**
 * The recommendations stage of the run pipeline (`scripts/recommendations.ts`), over the two
 * run directories this repository commits.
 *
 * It is the last mile of #224: a run that finishes carries `recommendations.json`, and both
 * committed runs carry one. What this suite asserts is the three promises that file is worth
 * anything on.
 *
 * 1. **The golden document.** Over the hand-authored fixture run, with the offline Wonder
 *    implementation, the same recommendations come back in the same order with the same
 *    citations — asserted as the values below and not as a shape, so a change to the sampler,
 *    the builder, the ranking or the offline stand-in is a diff in this file rather than a
 *    silently different document on a screen.
 * 2. **It is deterministic.** Running the stage twice over the same sessions writes the same
 *    file, byte for byte, which is what lets a run directory be committed and re-committed as
 *    a reviewable diff.
 * 3. **Validation happens before the write.** A document whose citations do not resolve
 *    against its run throws with the JSON path of the offending value, and no file is
 *    written — a run directory never holds a half-valid one.
 *
 * Offline: the Wonder implementation is the project's own offline default, so this suite
 * reads no key and reaches no network.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The id both committed run directories carry: the fixture's and the genuine artifact's. */
const RUN_ID = '2026-10-24-1402-northwind-demo';

/** The hand-authored fixture the viewer's suites read, and the artifact `pnpm demo:run` wrote. */
const fixtureDir = join(repoRoot, 'tests/fixtures/runs', RUN_ID);
const artifactDir = join(repoRoot, 'runs', RUN_ID);

const layout = runPaths('');

const stageOver = async (artifact: RunArtifact, aggregate?: Aggregate): Promise<Recommendations> =>
  recommendationsOf({
    run: artifact.run,
    sessions: artifact.sessions,
    findings: artifact.findings,
    aggregate: aggregate ?? mustAggregate(artifact),
  });

const mustAggregate = (artifact: RunArtifact): Aggregate => {
  if (artifact.aggregate === undefined) {
    throw new Error(`${artifact.run.runId} carries no aggregate.json`);
  }
  return artifact.aggregate;
};

const readJsonFile = async <Parsed>(file: string): Promise<Parsed> =>
  JSON.parse(await readFile(file, 'utf8')) as Parsed;

/**
 * The document the stage produces over the fixture run: five recommendations, worst first.
 *
 * Every value here is one the pipeline derives and not one anybody wrote. `peopleAffected` is
 * the `reached` of the step in the fixture's own whole-run funnel slice, which is why the two
 * payment recommendations carry the same 19 and are separated by their ids; the ranking is
 * that number, then how deep the step sits, then the id. The sentences are the offline
 * stand-in's, the evidence is the finding's own, and the three citations of each are the
 * session the builder drew, the region the finding names and the step it sits on.
 *
 * It carries **no write-up**: the fixture declares no status, so its aggregate reads `open`,
 * and a write-up generated from the figures so far would read as a finished run's (#260). The
 * genuine artifact under `runs/` is finished and carries one.
 */
const GOLDEN: Recommendations = {
  schemaVersion: SCHEMA_VERSION,
  runId: '2026-10-24-1402-northwind-demo',
  sample: {
    read: 20,
    of: 22,
    strategy: 'stratified by outcome, then segment',
    seed: 1,
  },
  recommendations: [
    {
      id: 'R-05',
      rank: 1,
      sentence: 'Change the Cart step, where 2 people of this run ran into trouble.',
      evidence:
        'Both were price-led shoppers; $8.95 shipping on a $129.00 order was read twice before they left. Reported for balance: the current checkout is the better version, not a perfect one.',
      findingIds: ['F-5'],
      citations: [
        {
          kind: 'session',
          sessionId: 'S-12',
          offsetMs: 0,
        },
        {
          kind: 'heatmap',
          variant: 'A',
          step: 'cart',
          aoiId: 'A-cart-cart-total',
        },
        {
          kind: 'funnel',
          stepId: 'cart',
        },
      ],
      peopleAffected: 22,
      step: 'cart',
    },
    {
      id: 'R-03',
      rank: 2,
      sentence:
        'Make the Payment step easier to get past, where 9 people of this run ran into trouble.',
      evidence:
        'It holds 3.1 s of attention against 1.2 s on the button beneath it, and nobody used the code: it costs attention without earning anything.',
      findingIds: ['F-3'],
      citations: [
        {
          kind: 'session',
          sessionId: 'S-24',
          offsetMs: 0,
        },
        {
          kind: 'heatmap',
          variant: 'B',
          step: 'payment',
          aoiId: 'B-payment-promo',
        },
        {
          kind: 'funnel',
          stepId: 'payment',
        },
      ],
      peopleAffected: 19,
      step: 'payment',
    },
    {
      id: 'R-04',
      rank: 3,
      sentence:
        'Make the Payment step easier to get past, where 3 people of this run ran into trouble.',
      evidence:
        'All three look for a confirmation on the next screen, then stop. They end with no order placed — a failure, not someone choosing to leave.',
      findingIds: ['F-4'],
      citations: [
        {
          kind: 'session',
          sessionId: 'S-13',
          offsetMs: 0,
        },
        {
          kind: 'heatmap',
          variant: 'B',
          step: 'payment',
          aoiId: 'B-payment-primary',
        },
        {
          kind: 'funnel',
          stepId: 'payment',
        },
      ],
      peopleAffected: 19,
      step: 'payment',
    },
    {
      id: 'R-01',
      rank: 4,
      sentence:
        'Fix what stops people on the Review step, where 9 people of this run ran into trouble.',
      evidence:
        'On the review step, “Confirm purchase” sits about 180 px below the fold. Of the 9 people who got that far, 0 looked at it. On your current checkout the same button was seen by 9 of 9, after 2.3 s on average.',
      findingIds: ['F-1'],
      citations: [
        {
          kind: 'session',
          sessionId: 'S-16',
          offsetMs: 0,
        },
        {
          kind: 'heatmap',
          variant: 'B',
          step: 'review',
          aoiId: 'B-review-complete',
        },
        {
          kind: 'funnel',
          stepId: 'review',
        },
      ],
      peopleAffected: 18,
      step: 'review',
    },
    {
      id: 'R-02',
      rank: 5,
      sentence: 'Change the Review step, where 4 people of this run ran into trouble.',
      evidence:
        'The fee holds the eye for 610 ms the first time and is returned to 2.4 times — the most re-read thing in the test. The total changes from $129.00 to $147.95 between the two steps.',
      findingIds: ['F-2'],
      citations: [
        {
          kind: 'session',
          sessionId: 'S-24',
          offsetMs: 0,
        },
        {
          kind: 'heatmap',
          variant: 'B',
          step: 'review',
          aoiId: 'B-review-fee-row',
        },
        {
          kind: 'funnel',
          stepId: 'review',
        },
      ],
      peopleAffected: 18,
      step: 'review',
    },
  ],
};

describe('the golden document, over the fixture run', () => {
  it('recommends the same things, in the same order, citing the same evidence', async () => {
    expect(await stageOver(await readRun(fixtureDir))).toEqual(GOLDEN);
  });

  it('is what the committed fixture carries on disk, so the file is generated and not written', async () => {
    expect(await readJsonFile(join(fixtureDir, layout.recommendations))).toEqual(GOLDEN);
  });

  it('reads the sessions the run is about, and never one our automation broke', async () => {
    const { run, sessions } = await readRun(fixtureDir);
    const broken = sessions.filter((session) => session.outcome.excludedFromScores).length;
    expect(GOLDEN.sample).toEqual({
      read: 20,
      of: sessions.length - broken,
      strategy: 'stratified by outcome, then segment',
      seed: run.seedGroups[0],
    });
  });
});

describe('the committed example run', () => {
  it('carries the recommendations the committed stage produces over it', async () => {
    const artifact = await readRun(artifactDir);
    expect(await readJsonFile(join(artifactDir, layout.recommendations))).toEqual(
      await stageOver(artifact),
    );
  });

  it('carries a write-up, generated from those recommendations', async () => {
    const document = await readJsonFile<Recommendations>(join(artifactDir, layout.recommendations));
    expect(document.recommendations.length).toBeGreaterThan(0);
    expect(document.writeUp?.length ?? 0).toBeGreaterThan(document.recommendations.length);
    // The closing claim of the write-up is the last of them, after one claim per
    // recommendation: the write-up is generated from the recommendations above it.
    expect(document.writeUp?.at(-1)?.heading).toBe('What I did not find');
  });
});

describe('writing it', () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    const artifact = await readRun(fixtureDir);
    first = await mkdtemp(join(tmpdir(), 'personavision-recs-a-'));
    second = await mkdtemp(join(tmpdir(), 'personavision-recs-b-'));
    for (const runsRoot of [first, second]) {
      await writeRun(join(runsRoot, RUN_ID), {
        ...artifact,
        recommendations: await stageOver(artifact),
      });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  it('writes a byte-identical file when the pipeline runs twice over the same sessions', async () => {
    const bytes = async (runsRoot: string): Promise<Buffer> =>
      readFile(join(runsRoot, RUN_ID, layout.recommendations));
    expect(await bytes(first)).toEqual(await bytes(second));
  });

  it('writes the same file over a run directory that already holds one', async () => {
    const runDir = join(first, RUN_ID);
    const before = await readFile(join(runDir, layout.recommendations));
    await recommendOverRun(runDir);
    expect(await readFile(join(runDir, layout.recommendations))).toEqual(before);
  });
});

describe('a run with nothing to recommend', () => {
  it('writes the file with the reason there is none, rather than no file and rather than an empty list on its own', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'personavision-recs-none-'));
    const runDir = join(runsRoot, RUN_ID);
    const read = await readRun(fixtureDir);
    // Every session our own automation broke: the sampler clears them out, so there is
    // nothing left for Muse Wonder to read and nothing the run can say about the site. The
    // aggregate is recomposed over the same sessions, so the run is one that could exist.
    const sessions = read.sessions.map((session) => ({
      ...session,
      outcome: { ...session.outcome, excludedFromScores: true },
    }));
    const artifact = {
      ...read,
      sessions,
      aggregate: composeAggregate({ run: read.run, sessions, computedAt: read.run.createdAt }),
    };

    const document = await stageOver(artifact);
    expect(document.recommendations).toEqual([]);
    expect(document.nothingToRecommend).toBe(NOTHING_READ);
    expect(document.writeUp).toBeUndefined();
    expect(document.sample).toEqual({
      read: 0,
      of: 0,
      strategy: 'every session of the run',
      seed: read.run.seedGroups[0],
    });

    await writeRun(runDir, { ...artifact, recommendations: document });
    expect(await readJsonFile(join(runDir, layout.recommendations))).toEqual(document);

    await rm(runsRoot, { recursive: true, force: true });
  });
});

describe('a document that does not resolve against its run', () => {
  it('throws with the JSON path of the offending value, and writes no file', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'personavision-recs-bad-'));
    const runDir = join(runsRoot, RUN_ID);
    const artifact = await readRun(fixtureDir);
    // The ranking key is the funnel's own `reached`, and the validator holds it to the
    // people the run measured at all. An aggregate claiming to be of one scored session is
    // a run whose two numbers disagree, which is exactly what must not reach a screen.
    const tampered: Aggregate = { ...mustAggregate(artifact), scoredSessionCount: 1 };

    await expect(
      stageOver(artifact, tampered).then((recommendations) =>
        writeRun(runDir, { ...artifact, recommendations }),
      ),
    ).rejects.toThrow(/recommendations\.json\/recommendations\/0\/peopleAffected/);
    expect(existsSync(join(runDir, layout.recommendations))).toBe(false);

    await rm(runsRoot, { recursive: true, force: true });
  });
});
