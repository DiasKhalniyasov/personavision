import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPaths, validate } from '@personavision/contract';
import { aggregate } from '@personavision/engine';
import type { Findings, Run, Session } from '@personavision/contract';
import { RUN_ID, writeSeedRun } from '../scripts/seed-example-run.js';

/**
 * The committed seed example run, read from disk as a screen would read it, and asserted
 * against the two documents that are binding on it: `docs/design/prototype.html`'s
 * representative run and the required reading of `docs/FLOW.md` section 5. Every number
 * restated here is restated on purpose — that is the assertion.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const committedDir = join(repoRoot, 'runs', RUN_ID);
const paths = runPaths(committedDir);

const readJson = <Parsed>(file: string): Parsed => JSON.parse(readFileSync(file, 'utf8')) as Parsed;

const run = readJson<Run>(paths.run);
const findings = readJson<Findings>(paths.findings);
const sessions = run.sessionIds.map((sessionId) => readJson<Session>(paths.session(sessionId)));

const SESSION_IDS = Array.from(
  { length: 24 },
  (_, index) => `S-${String(index + 1).padStart(2, '0')}`,
);
const STEP_IDS = ['cart', 'payment', 'review', 'confirm'];
const VARIANT_IDS = ['A', 'B'];

/** The weights `docs/FLOW.md` section 5 states; they live in `@personavision/scoring`. */
const WEIGHTS = {
  taskFailureRate: 0.3,
  abandonment: 0.2,
  timeToFirstFixationPrimary: 0.35,
  deadEndRevisits: 0.15,
};

const scoreOf = (variant: string): Run['scores'][number] => {
  const score = run.scores.find((candidate) => candidate.variant === variant);
  if (score === undefined) throw new Error(`no score for variant ${variant}`);
  return score;
};

const scored = (session: Session): boolean => !session.outcome.excludedFromScores;
const reached = (session: Session, step: string): boolean =>
  session.screens.some((screen) => screen.step === step);

/** Every file under `dir`, by its path relative to it, depth first and sorted. */
const filesUnder = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(dir, full));
    }
  };
  walk(dir);
  return files.sort();
};

const hashTree = (dir: string): Record<string, string> =>
  Object.fromEntries(
    filesUnder(dir).map((file) => {
      const bytes = readFileSync(join(dir, file));
      return [file, createHash('sha256').update(bytes).digest('hex')];
    }),
  );

const jsonOnly = (hashes: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(hashes).filter(([file]) => file.endsWith('.json')));

/** Every JSON file of the committed artifact, as raw text, by its path inside the run. */
const jsonFiles = (): Array<[string, string]> =>
  filesUnder(committedDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file, readFileSync(join(committedDir, file), 'utf8')]);

const pngHeader = (file: string): { width: number; height: number } => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe('the committed run directory', () => {
  it('parses through the contract with no violation', async () => {
    expect(await validate(committedDir)).toEqual([]);
  });

  it('is named for the run it holds', () => {
    expect(RUN_ID).toBe('2026-10-24-1402-northwind-demo');
    expect(run.runId).toBe(RUN_ID);
  });

  it('holds every file the layout fixes, at the path the contract spells', () => {
    expect(existsSync(paths.run)).toBe(true);
    expect(existsSync(paths.findings)).toBe(true);
    for (const sessionId of SESSION_IDS) {
      expect(existsSync(paths.session(sessionId))).toBe(true);
    }
    for (const variant of VARIANT_IDS) {
      for (const step of STEP_IDS) {
        expect(existsSync(paths.screenshot(variant, step))).toBe(true);
      }
    }
  });

  it('agrees with the session files on disk in both directions', () => {
    const onDisk = readdirSync(paths.sessionsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(run.sessionIds).toEqual(SESSION_IDS);
    expect(onDisk).toEqual([...run.sessionIds].sort());
    for (const session of sessions) {
      expect(session.runId).toBe(run.runId);
    }
  });

  it('marks itself as the offline seed fixture and reaches nothing', () => {
    expect(run.engine.mode).toBe('offline');
    expect(run.engine.version).toBe('seed-fixture');
    expect(run.engine.provider).toBeNull();
    expect(run.engine.models).toBeNull();
  });

  it('carries the UEyes figures the header badge shows', () => {
    expect(run.calibration).toEqual({ benchmark: 'UEyes', cc: 0.68, nss: 1.9, scanMatch: 0.54 });
  });

  it('names nobody: no address and no account field in any of its JSON', () => {
    // The fixture is committed to a public repository and shipped as the example run, so it
    // carries the test and nothing about whoever ran it. The schemas are strict objects, so
    // an undeclared `accountId` cannot parse at all — but an address can ride inside a
    // declared string, which is what the first assertion is for. The second is a cheap guard
    // on the fields by name, for a schema that later gains one. `Email field` is a form label
    // on the payment step, which is why neither looks for the word.
    //
    // The eight PNGs are out of scope: they are drawn by this generator from the labels
    // asserted above, and carry no text of their own.
    const IDENTITY_KEYS = [
      'accountId',
      'workspaceId',
      'organizationId',
      'organisationId',
      'tenantId',
      'userId',
      'ownerId',
      'authorId',
      'apiKey',
      'token',
    ];
    for (const [file, text] of jsonFiles()) {
      expect(text, `${file} holds an email address`).not.toMatch(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      );
      for (const key of IDENTITY_KEYS) {
        expect(text, `${file} holds a "${key}"`).not.toContain(`"${key}"`);
      }
    }
  });
});

describe('the generator', () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    first = await mkdtemp(join(tmpdir(), 'personavision-seed-a-'));
    second = await mkdtemp(join(tmpdir(), 'personavision-seed-b-'));
    await writeSeedRun(first);
    await writeSeedRun(second);
  }, 60_000);

  afterAll(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  it('writes a byte-identical directory when it runs twice', () => {
    expect(hashTree(join(first, RUN_ID))).toEqual(hashTree(join(second, RUN_ID)));
  });

  it('wrote the committed artifact: regenerating it changes no byte of its data', () => {
    // The placeholder screenshots rasterise text, so their bytes follow the fonts the
    // machine has. The data is stable everywhere, and that is what the screens read.
    expect(jsonOnly(hashTree(join(first, RUN_ID)))).toEqual(jsonOnly(hashTree(committedDir)));
  });
});

describe('the required reading of docs/FLOW.md section 5', () => {
  const clean = scoreOf('A');
  const defective = scoreOf('B');

  it('separates the clean checkout from the defective one', () => {
    expect(clean.frictionScore.median).toBeLessThanOrEqual(25);
    expect(defective.frictionScore.median).toBeGreaterThanOrEqual(60);
    expect(defective.frictionScore.median - clean.frictionScore.median).toBeGreaterThanOrEqual(30);
  });

  it('reads as the prototype prints it: 22 ± 3 against 67 ± 4', () => {
    expect(clean.frictionScore).toEqual({ median: 22, sd: 3 });
    expect(defective.frictionScore).toEqual({ median: 67, sd: 4 });
  });

  it('holds the gap in all three seed groups, with the ± 1σ bands disjoint', () => {
    expect(run.seedGroups).toEqual([1, 2, 3]);
    for (const seed of run.seedGroups) {
      const band = (score: Run['scores'][number]): { low: number; high: number } => {
        const group = score.perSeedGroup.find((entry) => entry.seed === seed);
        if (group === undefined) throw new Error(`no seed group ${seed}`);
        return {
          low: group.frictionScore - score.frictionScore.sd,
          high: group.frictionScore + score.frictionScore.sd,
        };
      };
      expect(band(clean).high).toBeLessThan(band(defective).low);
    }
    const ascending = (score: Run['scores'][number]): number[] =>
      score.perSeedGroup.map((entry) => entry.frictionScore).sort((left, right) => left - right);
    expect(ascending(clean)).toEqual([19, 22, 25]);
    expect(ascending(defective)).toEqual([63, 67, 71]);
  });

  it('states the verdict the Comparison screen reads out', () => {
    expect(run.verdict).toMatchObject({
      harderVariant: 'B',
      gapPoints: 45,
      bandsDisjoint: true,
      seedGroupsAgreeing: 3,
      sentence:
        'Variant B is harder. The gap held in all 3 seed groups (A 19–25, B 63–71 — the bands do not overlap).',
    });
  });

  it('leads with the verdict in the audience’s words, and the evidence behind it', () => {
    expect(run.verdict.preferredVariant).toBe('A');
    expect(run.verdict.audienceSentence).toBe(
      'Your audience completes the purchase on the current checkout, not on the redesign.',
    );
    expect(run.verdict.reasons).toHaveLength(2);
    expect(run.verdict.heroEvidence).toEqual({ variant: 'B', step: 'review', aoiId: null });
    // The headline findings are the top three ranks, not a hand-picked three.
    const topThree = [...findings.findings]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 3)
      .map((finding) => finding.id);
    expect(run.verdict.headlineFindingIds).toEqual(topThree);
  });

  it('completes on 9 of 11 scored sessions against 2 of 11', () => {
    for (const score of run.scores) {
      expect(score.completionRate).toBeCloseTo(
        score.outcomeCounts.success / score.scoredSessionCount,
        6,
      );
    }
    expect(scoreOf('A').completionRate).toBeCloseTo(9 / 11, 6);
    expect(scoreOf('B').completionRate).toBeCloseTo(2 / 11, 6);
  });

  it('carries the audience the four personas were generated from', () => {
    expect(run.audience.id).toBe('outdoor-gear-shoppers');
    // `size` is how many people the audience generates, which the contract checks against
    // the personas: the 24 sessions are those four across two variants and three seeds.
    expect(run.audience.size).toBe(4);
    expect(run.personas).toHaveLength(4);
    expect(run.audience.devices.reduce((total, device) => total + device.share, 0)).toBeCloseTo(
      1,
      6,
    );
    // The device mix is the audience's own, as the Audiences screen draws it: a class of
    // device and the share on it, not the models the four generated people ran on.
    expect(run.audience.devices).toEqual([
      {
        name: 'mobile',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        touch: true,
        share: 0.6,
      },
      {
        name: 'desktop',
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        touch: false,
        share: 0.4,
      },
    ]);
    for (const persona of run.personas) {
      expect(persona.audienceId).toBe(run.audience.id);
      expect(persona.segment).toMatch(/^(mobile|desktop) · \S/);
    }
  });
});

describe('each score', () => {
  for (const variant of VARIANT_IDS) {
    describe(`variant ${variant}`, () => {
      const score = scoreOf(variant);

      it('weights and sums its four components back to the headline score', () => {
        const { components } = score;
        const weighted =
          components.taskFailureRate * WEIGHTS.taskFailureRate +
          components.abandonment * WEIGHTS.abandonment +
          components.timeToFirstFixationPrimary.value * WEIGHTS.timeToFirstFixationPrimary +
          components.deadEndRevisits * WEIGHTS.deadEndRevisits;
        expect(Math.round(weighted * 100)).toBe(score.frictionScore.median);
      });

      it('counts its components out of the scored sessions', () => {
        const counts = score.outcomeCounts;
        expect(score.scoredSessionCount).toBe(11);
        expect(counts.success + counts.abandoned + counts.failed + counts.automationFailure).toBe(
          12,
        );
        expect(counts.failed / score.scoredSessionCount).toBeCloseTo(
          score.components.taskFailureRate,
          5,
        );
        expect(counts.abandoned / score.scoredSessionCount).toBeCloseTo(
          score.components.abandonment,
          5,
        );
      });

      it('agrees with the outcomes of the sessions on disk', () => {
        const mine = sessions.filter((session) => session.variant === variant);
        const counted = (status: Session['outcome']['status']): number =>
          mine.filter((session) => session.outcome.status === status).length;
        expect(score.outcomeCounts).toEqual({
          success: counted('success'),
          abandoned: counted('abandoned'),
          failed: counted('failed'),
          automationFailure: counted('automation_failure'),
        });
        expect(score.scoredSessionCount).toBe(mine.filter(scored).length);
      });
    });
  }

  it('prints the prototype’s outcome footnotes', () => {
    expect(scoreOf('A').outcomeCounts).toEqual({
      success: 9,
      abandoned: 2,
      failed: 0,
      automationFailure: 1,
    });
    expect(scoreOf('B').outcomeCounts).toEqual({
      success: 2,
      abandoned: 6,
      failed: 3,
      automationFailure: 1,
    });
  });

  it('names the review step as the worst for the primary action, never fixated on B', () => {
    expect(scoreOf('A').components.timeToFirstFixationPrimary).toEqual({
      worstStep: 'review',
      medianSeconds: 2.3,
      value: 0.383333,
    });
    expect(scoreOf('B').components.timeToFirstFixationPrimary).toEqual({
      worstStep: 'review',
      medianSeconds: null,
      value: 1,
    });
  });
});

describe('the two automation failures', () => {
  it('leaves 22 of the 24 sessions scored', () => {
    expect(sessions).toHaveLength(24);
    expect(sessions.filter(scored)).toHaveLength(22);
  });

  it('excludes exactly S-09 and S-23, both attributed to the automation', () => {
    const excluded = sessions.filter((session) => session.outcome.excludedFromScores);
    expect(excluded.map((session) => session.sessionId)).toEqual(['S-09', 'S-23']);
    for (const session of excluded) {
      expect(session.outcome.status).toBe('automation_failure');
      expect(session.outcome.attribution).toBe('automation');
      expect(session.integrity).toEqual({ selectorFailures: 1, retries: 1 });
    }
    expect(excluded.map((session) => session.variant)).toEqual(['A', 'B']);
  });

  it('attributes every other session to the product', () => {
    for (const session of sessions.filter(scored)) {
      expect(session.outcome.attribution).toBe('product');
      expect(session.integrity).toEqual({ selectorFailures: 0, retries: 0 });
    }
  });
});

describe('the moment the demo turns on', () => {
  const completeOnB = 'B-review-complete';

  it('has no fixation anywhere in "complete" on variant B’s review step', () => {
    const landed = sessions
      .filter((session) => session.variant === 'B')
      .flatMap((session) => session.fixations)
      .filter((fixation) => fixation.aoiId === completeOnB);
    expect(landed).toEqual([]);
  });

  it('records that absence as a reading rather than a missing entry', () => {
    const metric = run.aoiMetrics.find((candidate) => candidate.aoiId === completeOnB);
    expect(metric).toEqual({
      aoiId: completeOnB,
      timeToFirstFixationMs: null,
      firstFixationDurationMs: null,
      totalDwellMs: 0,
      fixationCount: 0,
      revisits: 0,
      lookedAtShare: 0,
      sessionCount: 9,
    });
  });

  it('puts the button about 180 px below the fold', () => {
    const aoi = run.aois.find((candidate) => candidate.id === completeOnB);
    const shot = run.screenshots.find(
      (candidate) => candidate.variant === 'B' && candidate.step === 'review',
    );
    if (aoi === undefined || shot === undefined) throw new Error('the review step is missing');
    expect(aoi.isPrimaryAction).toBe(true);
    expect(aoi.belowFold).toBe(true);
    expect(aoi.bbox.y - shot.foldY).toBe(180);
  });

  it('keeps the same button above the fold on variant A', () => {
    const aoi = run.aois.find((candidate) => candidate.id === 'A-review-complete');
    if (aoi === undefined) throw new Error('variant A has no completing action');
    expect(aoi.belowFold).toBe(false);
  });
});

describe('the sessions', () => {
  it('numbers fixations contiguously and continuously across each session', () => {
    for (const session of sessions) {
      expect(session.fixations.map((fixation) => fixation.index)).toEqual(
        session.fixations.map((_, index) => index),
      );
      expect(session.fixations.length).toBeGreaterThan(0);
      for (const fixation of session.fixations) {
        expect(fixation.screenIndex).toBeLessThan(session.screens.length);
        expect(fixation.tMs + fixation.durationMs).toBeLessThanOrEqual(session.durationMs);
      }
    }
  });

  it('joins every pair of consecutive fixations with a saccade', () => {
    for (const session of sessions) {
      expect(session.saccades).toHaveLength(session.fixations.length - 1);
      session.saccades.forEach((saccade, index) => {
        expect(saccade.fromFixation).toBe(index);
        expect(saccade.toFixation).toBe(index + 1);
      });
    }
  });

  it('logs a scroll for every change of offset its own screens record', () => {
    for (const session of sessions) {
      let offset = 0;
      const changes: number[] = [];
      for (const screen of session.screens) {
        if (screen.scrollY === offset) continue;
        offset = screen.scrollY;
        changes.push(screen.scrollY);
      }
      const scrolls = session.actions
        .filter((action) => action.type === 'scroll')
        .map((action) => Number(action.value));
      expect(scrolls).toEqual(changes);
    }
  });

  it('logs its actions in the order they happened', () => {
    for (const session of sessions) {
      const times = session.actions.map((action) => action.tMs);
      expect(times).toEqual([...times].sort((left, right) => left - right));
    }
  });

  it('anchors every fixation to an area of interest this run declares', () => {
    const declared = new Set(run.aois.map((aoi) => aoi.id));
    for (const session of sessions) {
      for (const fixation of session.fixations) {
        expect(fixation.aoiId).not.toBeNull();
        expect(declared.has(fixation.aoiId as string)).toBe(true);
      }
    }
  });

  it('reaches each step as often as the prototype’s filmstrip says', () => {
    const reach = (variant: string): number[] =>
      STEP_IDS.map(
        (step) =>
          sessions.filter(
            (session) => session.variant === variant && scored(session) && reached(session, step),
          ).length,
      );
    expect(reach('A')).toEqual([11, 9, 9, 9]);
    expect(reach('B')).toEqual([11, 10, 9, 2]);
  });

  it('is one row per persona, variant and seed', () => {
    const rows = sessions.map(
      (session) => `${session.persona?.id}-${session.variant}-${session.seed}`,
    );
    expect(new Set(rows).size).toBe(24);
    for (const session of sessions) {
      expect(session.kind).toBe('simulated');
      expect(session.participant).toBeNull();
      expect(run.seedGroups).toContain(session.seed);
    }
  });

  it('opens the demo on S-15, the rushed buyer on mobile on variant B', () => {
    const replay = sessions.find((session) => session.sessionId === 'S-15');
    if (replay === undefined) throw new Error('S-15 is missing');
    expect(replay.persona?.id).toBe('rushed');
    expect(replay.persona?.device.viewport).toEqual({ width: 390, height: 844 });
    expect(replay.variant).toBe('B');
    expect(replay.durationMs).toBe(38_000);
    expect(replay.fixations).toHaveLength(23);
    // The prototype's replay: 7 fixations over the cart, 12 over payment, 4 over review.
    expect(replay.screens.map((screen) => screen.step)).toEqual(['cart', 'payment', 'review']);
    expect(
      replay.screens.map(
        (screen) =>
          replay.fixations.filter((fixation) => fixation.screenIndex === screen.index).length,
      ),
    ).toEqual([7, 12, 4]);
    expect(replay.screens[1].intent).toBe('Pay as fast as possible, the card is saved.');
    expect(replay.actions.map((action) => action.type)).toEqual([
      'click',
      'type',
      'hesitate',
      'click',
      // The scroll that reveals the service fee, and leaves the completing action below
      // the fold: the beat the replay exists to show.
      'scroll',
      'abandon',
    ]);
    expect(replay.outcome.status).toBe('abandoned');
    expect(replay.outcome.step).toBe('review');
    expect(replay.outcome.attribution).toBe('product');
  });
});

describe('the areas of interest', () => {
  it('declares one per variant and step, found by the DOM, the a11y tree or segmentation', () => {
    expect(new Set(run.aois.map((aoi) => aoi.source))).toEqual(new Set(['dom', 'a11y', 'sam']));
    for (const aoi of run.aois) {
      expect(VARIANT_IDS).toContain(aoi.variant);
      expect(STEP_IDS).toContain(aoi.step);
      expect(aoi.id).toBe(`${aoi.variant}-${aoi.step}-${aoi.id.split('-').slice(2).join('-')}`);
    }
  });

  it('metres one area per declared area, against the sessions that reached it', () => {
    expect(run.aoiMetrics).toHaveLength(run.aois.length);
    run.aoiMetrics.forEach((metric, index) => {
      expect(metric.aoiId).toBe(run.aois[index].id);
      expect(metric.sessionCount).toBeGreaterThan(0);
      expect(metric.lookedAtShare).toBeGreaterThanOrEqual(0);
      expect(metric.lookedAtShare).toBeLessThanOrEqual(1);
    });
  });

  // The one assertion that keeps the fixture honest: the engine is the only place in the
  // project where a per-area number is made, so the committed artifact has to be exactly
  // what it produces from the sessions committed beside it. Without this, a hand-written
  // table can claim attention no fixation ever paid and nothing fails.
  it('carries exactly what the engine computes from the sessions beside it', () => {
    expect(run.aoiMetrics).toEqual(aggregate(sessions, run.aois));
  });

  it('reports a reading only where a fixation backs it, and a null where none does', () => {
    const fixated = new Set(
      sessions
        .filter((session) => !session.outcome.excludedFromScores)
        .flatMap((session) => session.fixations.map((fixation) => fixation.aoiId)),
    );
    for (const metric of run.aoiMetrics) {
      const looked = fixated.has(metric.aoiId);
      expect(metric.lookedAtShare > 0).toBe(looked);
      expect(metric.timeToFirstFixationMs !== null).toBe(looked);
      expect(metric.firstFixationDurationMs !== null).toBe(looked);
      if (!looked) {
        expect(metric.totalDwellMs).toBe(0);
        expect(metric.fixationCount).toBe(0);
        expect(metric.revisits).toBe(0);
      }
    }
  });

  it('counts a fixation and a revisit as whole numbers, as the engine floors them', () => {
    for (const metric of run.aoiMetrics) {
      expect(Number.isInteger(metric.fixationCount)).toBe(true);
      expect(Number.isInteger(metric.revisits)).toBe(true);
    }
  });

  it('captions every variant and step for the Attention screen', () => {
    expect(run.stepCaptions).toHaveLength(8);
    for (const variant of VARIANT_IDS) {
      for (const step of STEP_IDS) {
        const caption = run.stepCaptions.find(
          (candidate) => candidate.variant === variant && candidate.step === step,
        );
        expect(caption?.caption).toMatch(/\S/);
      }
    }
  });

  it('reads the prototype’s eight captions back word for word', () => {
    // In the prototype's own order: both variants of each step, cart to confirmation.
    expect(
      run.stepCaptions.map((caption) => `${caption.variant}-${caption.step}: ${caption.caption}`),
    ).toEqual([
      'A-cart: Variant A, cart. The up-front $8.95 shipping line is read as part of the total; two price-led people left here over it.',
      'B-cart: Variant B, cart. The promo banner takes the first fixation, and "calculated later" draws a second fixation in 8 of 11 sessions before Checkout is clicked.',
      'A-payment: Variant A, payment step. Attention settles on the card field, then the total, then the primary action: 9 of 9 people who reached this step fixated "Continue to review", median 1.8 s in.',
      'B-payment: Variant B, payment step. The promo banner takes the first fixation in 9 of 10 sessions and holds 3.1 s of dwell. The primary action here says "Place order", but it only advances to the review step.',
      'A-review: Variant A, review step. The total is read once, then the primary action; 9 of 9 people placed the order.',
      'B-review: Variant B, review step. The newly revealed $9.95 service fee holds 3.6 s of dwell with 2.4 revisits, and "Confirm purchase" sits below the fold: 0 of 9 people who reached this step ever fixated it.',
      'A-confirm: Variant A, confirmation. 9 of 11 people reached it.',
      'B-confirm: Variant B, confirmation. Only 2 of 11 people reached it, and both re-read the amount paid: 2.2 s of dwell with 1.5 revisits on a total they had not agreed to.',
    ]);
  });
});

describe('the findings', () => {
  it('ranks all six of the prototype’s findings by severity, then by sessions behind them', () => {
    expect(findings.findings.map((finding) => finding.id)).toEqual([
      'F-1',
      'F-2',
      'F-3',
      'F-4',
      'F-5',
      'F-6',
    ]);
    expect(findings.findings.map((finding) => finding.severity)).toEqual([
      'critical',
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ]);
    expect(findings.findings.map((finding) => finding.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(findings.findings.map((finding) => finding.sessionCount)).toEqual([9, 4, 9, 3, 2, 2]);
  });

  it('names the sessions behind each claim, and counts them', () => {
    const listed = new Set(run.sessionIds);
    for (const finding of findings.findings) {
      expect(finding.sessionIds).toHaveLength(finding.sessionCount);
      for (const sessionId of finding.sessionIds) expect(listed.has(sessionId)).toBe(true);
      expect(finding.claim).toMatch(/\S/);
      expect(finding.evidence).toMatch(/\S/);
    }
  });

  it('carries the prototype’s six claims and evidence sentences, character for character', () => {
    expect(findings.findings.map((finding) => [finding.claim, finding.evidence])).toEqual([
      [
        'Nobody in your audience ever looked at the button that completes the order on the redesign.',
        'On the review step, “Confirm purchase” sits about 180 px below the fold. Of the 9 people who got that far, 0 looked at it. On your current checkout the same button was seen by 9 of 9, after 2.3 s on average.',
      ],
      [
        'A $9.95 service fee only appears after the card is entered, and 4 of 9 people left within 5 seconds of seeing it.',
        'The fee holds the eye for 610 ms the first time and is returned to 2.4 times — the most re-read thing in the test. The total changes from $129.00 to $147.95 between the two steps.',
      ],
      [
        'The sale banner takes the first look in 9 of 10 people, about 1.3 s before they look at any form field.',
        'It holds 3.1 s of attention against 1.2 s on the button beneath it, and nobody used the code: it costs attention without earning anything.',
      ],
      [
        'The payment button says “Place order” but only moves to a review step, and 3 of 11 people stopped there believing they had bought the boots.',
        'All three look for a confirmation on the next screen, then stop. They end with no order placed — a failure, not someone choosing to leave.',
      ],
      [
        'On your current checkout, 2 of 11 people gave up at the cart after re-reading the shipping line.',
        'Both were price-led shoppers; $8.95 shipping on a $129.00 order was read twice before they left. Reported for balance: the current checkout is the better version, not a perfect one.',
      ],
      [
        '2 of 24 people could not be simulated to the end, and are excluded from both figures.',
        'Our own browser automation timed out on the card field (one person on each version) after one retry. This is a weakness of the simulation, never evidence against your checkout.',
      ],
    ]);
  });

  it('words every claim for a business reader, with none of the product’s own jargon', () => {
    // `docs/FLOW.md` section 6 as PR #98 rewrites it: no jargon in a claim sentence. The
    // evidence sentence under it may carry a number and a unit, and the Attention screen's
    // captions may say `fixation`.
    //
    // The table above pins today's six claims, so this cannot fail on its own. It guards the
    // next edit: whoever rewords a claim in the generator updates that table to match, and
    // this is what then refuses a claim that reads like the product's internals. The six
    // words are the ones #106 names.
    const JARGON = ['fixation', 'fixated', 'dwell', 'saccade', 'aoi', 'area of interest'];
    for (const finding of findings.findings) {
      const claim = finding.claim.toLowerCase();
      for (const word of JARGON) {
        expect(claim, `${finding.id} says "${word}" in its claim`).not.toContain(word);
      }
    }
  });

  it('carries the link the Comparison screen navigates by', () => {
    expect(findings.findings[0].evidence_link).toEqual({
      screen: 'attention',
      params: { variant: 'B', step: 'review', aoi: 'B-review-complete' },
    });
    expect(findings.findings[5].evidence_link).toEqual({
      screen: 'sessions',
      params: { outcome: 'automation_failure' },
    });
  });

  it('attributes the automation failures to the automation and to no single variant', () => {
    const automation = findings.findings[5];
    expect(automation.attribution).toBe('automation');
    expect(automation.variant).toBeNull();
    expect(automation.sessionIds).toEqual(['S-09', 'S-23']);
  });
});

describe('the placeholder screenshots', () => {
  it('is one PNG per variant and step, at the viewport run.json records', () => {
    expect(run.screenshots).toHaveLength(8);
    for (const shot of run.screenshots) {
      expect(shot.path).toBe(runPaths('').screenshot(shot.variant, shot.step));
      const header = pngHeader(join(committedDir, shot.path));
      expect(header.width).toBe(shot.viewport.width);
      expect(header.height).toBe(shot.pageHeight);
      expect(shot.foldY).toBeLessThan(shot.pageHeight);
      expect(shot.foldY).toBe(shot.viewport.height);
    }
  });

  it('is the image every session’s screens point at', () => {
    const paths = new Set(run.screenshots.map((shot) => shot.path));
    for (const session of sessions) {
      for (const screen of session.screens) {
        expect(paths.has(screen.screenshot)).toBe(true);
        const shot = run.screenshots.find((candidate) => candidate.path === screen.screenshot);
        expect(screen.scrollY).toBeLessThanOrEqual(
          (shot?.pageHeight ?? 0) - (shot?.viewport.height ?? 0),
        );
      }
    }
  });
});
