import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPaths, validate } from '@personavision/contract';
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

const hashTree = (dir: string): Record<string, string> => {
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        hashes[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return hashes;
};

const jsonOnly = (hashes: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(hashes).filter(([file]) => file.endsWith('.json')));

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
    expect(clean.perSeedGroup.map((entry) => entry.frictionScore).sort()).toEqual([19, 22, 25]);
    expect(defective.perSeedGroup.map((entry) => entry.frictionScore).sort()).toEqual([63, 67, 71]);
  });

  it('states the verdict the Comparison screen reads out', () => {
    expect(run.verdict).toEqual({
      harderVariant: 'B',
      gapPoints: 45,
      bandsDisjoint: true,
      seedGroupsAgreeing: 3,
      sentence:
        'Variant B is harder. The gap held in all 3 seed groups (A 19–25, B 63–71 — the bands do not overlap).',
    });
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

  it('metres every area the prototype’s table lists, against the sessions that reached it', () => {
    const declared = new Set(run.aois.map((aoi) => aoi.id));
    for (const metric of run.aoiMetrics) {
      expect(declared.has(metric.aoiId)).toBe(true);
      expect(metric.sessionCount).toBeGreaterThan(0);
      expect(metric.lookedAtShare).toBeGreaterThanOrEqual(0);
      expect(metric.lookedAtShare).toBeLessThanOrEqual(1);
    }
    const promo = run.aoiMetrics.find((metric) => metric.aoiId === 'B-payment-promo');
    expect(promo).toMatchObject({
      timeToFirstFixationMs: 400,
      firstFixationDurationMs: 520,
      totalDwellMs: 3100,
      fixationCount: 4.2,
      revisits: 1.8,
      lookedAtShare: 0.92,
      sessionCount: 10,
    });
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
    expect(
      run.stepCaptions.find((caption) => caption.variant === 'B' && caption.step === 'review')
        ?.caption,
    ).toContain('0 of 9 agents who reached this step ever fixated it');
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
    expect(findings.findings[0].claim).toBe(
      'Nobody ever looked at the button that completes the order on variant B.',
    );
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
