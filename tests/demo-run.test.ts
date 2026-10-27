import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, validate } from '@personavision/contract';
import { declaredDefects } from '@personavision/northwind-demo/defects.ts';
import { evaluateAgainstPlantedDefects, findingRuleIdOf } from '@personavision/scoring';
import { DEMO_RUN_COMMAND, RUN_ID, SEED_GROUPS } from '../scripts/generate-demo-run.js';
import type { Findings, Run, Session } from '@personavision/contract';
import type { Finding } from '@personavision/scoring';

/**
 * The committed example run at `runs/2026-10-24-1402-northwind-demo/` — the genuine artifact
 * `pnpm demo:run` produces over the demo shop (#78), read from disk as a screen reads it.
 *
 * It asserts what is **true of the artifact**, never what the engine happened to measure:
 * the shape the contract declares, the weight the repository can carry, and the reading
 * `docs/FLOW.md` section 5 requires of a clean checkout against a defective one. A figure
 * restated here is one of those thresholds and not a transcription of an output — the numbers
 * this run produced are reported on #78 and #10, and `tests/seed-example-run.test.ts` is the
 * suite that pins the hand-authored fixture's own values.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not run the pipeline.** A regeneration needs Chromium, a free port and about a
 *   minute; this reads what was committed. Byte-stability is a property of the generator, and
 *   `demo/README.md` says how to check it.
 * - **It does not gate the planted-defect figures.** #78 was asked to set those floors from
 *   the first real run and #79 is where they become a gate. What is asserted here is that the
 *   evaluation runs over this artifact and that the defect the demo leads with is found.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runDir = join(repoRoot, 'runs', RUN_ID);
const paths = runPaths(runDir);

const readJson = <Parsed>(file: string): Parsed => JSON.parse(readFileSync(file, 'utf8')) as Parsed;

const run = readJson<Run>(paths.run);
const findings = readJson<Findings>(paths.findings);
const sessions = run.sessionIds.map((sessionId) => readJson<Session>(paths.session(sessionId)));

const SESSION_IDS = Array.from(
  { length: 24 },
  (_, index) => `S-${String(index + 1).padStart(2, '0')}`,
);

/** `docs/FLOW.md` section 5's acceptance table, which is what this run has to read as. */
const SECTION_5 = {
  cleanAtMost: 25,
  defectiveAtLeast: 60,
  gapAtLeast: 30,
  seedGroupsAgreeing: 3,
  cleanCompletionAtLeast: 0.6,
  defectiveCompletionAtMost: 0.3,
} as const;

/** The size budget the committed directory carries, so a clone stays a clone. */
const BUDGET = { screenshotBytes: 400 * 1024, directoryBytes: 20 * 1024 * 1024 } as const;

const scoreOf = (variant: string): Run['scores'][number] => {
  const score = run.scores.find((candidate) => candidate.variant === variant);
  if (score === undefined) throw new Error(`no score for variant ${variant}`);
  return score;
};

/** The clean version and the defective one, as the verdict itself names them. */
const clean = scoreOf(run.verdict.preferredVariant);
const defective = scoreOf(run.verdict.harderVariant);

/** Every file under `dir`, by its path relative to it, depth first and sorted. */
const filesUnder = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(dir, '');
  return files;
};

describe('the committed example run', () => {
  it('parses through the contract with no violation', async () => {
    await expect(validate(runDir)).resolves.toEqual([]);
  });

  it('holds 24 sessions, S-01 to S-24, and the files and the list agree both ways', () => {
    expect(run.sessionIds).toEqual(SESSION_IDS);
    const onDisk = readdirSync(paths.sessionsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    expect(onDisk).toEqual(SESSION_IDS);
    for (const session of sessions) {
      expect(session.runId).toBe(run.runId);
    }
  });

  it('crosses four people, three seed groups and two versions', () => {
    expect(run.personas).toHaveLength(4);
    expect(run.seedGroups).toEqual(SEED_GROUPS);
    expect(run.variants.map((variant) => variant.id)).toEqual(['A', 'B']);

    const simulated = sessions.map((session) => {
      // Every session of this run is a simulated one, so each carries a persona rather than
      // a participant: a `null` here would be a recorded human session in the demo.
      expect(session.persona, session.sessionId).not.toBeNull();
      return { ...session, persona: session.persona as NonNullable<Session['persona']> };
    });

    const crossed = new Set(
      simulated.map(
        (session) => `${session.persona.id}/${String(session.seed)}/${session.variant}`,
      ),
    );
    expect(crossed.size).toBe(24);
    for (const session of simulated) {
      expect(run.seedGroups).toContain(session.seed);
      expect(run.personas.map((persona) => persona.id)).toContain(session.persona.id);
    }
  });

  it('carries the audience by value, and people generated from it', () => {
    expect(run.audience.id).toBe('outdoor-gear-shoppers');
    expect(run.audience.size).toBe(run.personas.length);
    for (const persona of run.personas) {
      expect(persona.audienceId).toBe(run.audience.id);
      expect(persona.segment.length).toBeGreaterThan(0);
    }
  });

  it('records how to reproduce itself: the command, the seeds, the engine and the step rules', () => {
    const { reproduce } = run;
    expect(reproduce).toBeDefined();
    if (reproduce === undefined) return;

    expect(reproduce.command).toBe(DEMO_RUN_COMMAND);
    expect(reproduce.seeds).toEqual(run.seedGroups);
    expect(reproduce.engineMode).toBe(run.engine.mode);
    expect(reproduce.engineVersion).toBe(run.engine.version);
    // The devices the run drove are the ones its audience declares: one claim, not two.
    expect(reproduce.devices.map((device) => device.name).sort()).toEqual(
      [...new Set(run.audience.devices.map((device) => device.name))].sort(),
    );
    expect(reproduce.steps.map((step) => step.id)).toEqual(run.steps.map((step) => step.id));
    for (const step of reproduce.steps) {
      expect(step.urlPattern.length).toBeGreaterThan(0);
      expect(step.requiredSelector.length).toBeGreaterThan(0);
      expect(step.primaryActionSelector.length).toBeGreaterThan(0);
    }
  });

  it('was produced by the offline engine, with no model and nothing to pay for', () => {
    expect(run.engine.mode).toBe('offline');
    expect(run.engine.models).toBeNull();
    expect(run.usage?.estimatedCostUsd ?? 0).toBe(0);
    expect(run.usage?.calls ?? 0).toBe(0);
  });

  it('names no account, no workspace and no email anywhere in it', () => {
    const text = filesUnder(runDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => readFileSync(join(runDir, file), 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/"(accountId|workspaceId|ownerId|email)"/);
  });
});

describe('what the run measured, against docs/FLOW.md section 5', () => {
  it('reads the clean version at or under 25 and the defective one at or over 60', () => {
    expect(clean.frictionScore.median).toBeLessThanOrEqual(SECTION_5.cleanAtMost);
    expect(defective.frictionScore.median).toBeGreaterThanOrEqual(SECTION_5.defectiveAtLeast);
  });

  it('separates them by at least thirty points, in the verdict the artifact stores', () => {
    expect(run.verdict.gapPoints).toBeGreaterThanOrEqual(SECTION_5.gapAtLeast);
    expect(run.verdict.gapPoints).toBeCloseTo(
      defective.frictionScore.median - clean.frictionScore.median,
      6,
    );
    expect(run.verdict.preferredVariant).not.toBe(run.verdict.harderVariant);
  });

  it('holds in every seed group, not only in the medians', () => {
    expect(run.verdict.seedGroupsAgreeing).toBe(SECTION_5.seedGroupsAgreeing);
    expect(run.verdict.bandsDisjoint).toBe(true);

    const band = (score: Run['scores'][number], seed: number): { low: number; high: number } => {
      const group = score.perSeedGroup.find((entry) => entry.seed === seed);
      if (group === undefined) throw new Error(`no seed group ${String(seed)}`);
      return {
        low: group.frictionScore - score.frictionScore.sd,
        high: group.frictionScore + score.frictionScore.sd,
      };
    };
    for (const seed of run.seedGroups) {
      expect(band(clean, seed).high, `seed group ${String(seed)}`).toBeLessThan(
        band(defective, seed).low,
      );
    }
  });

  it('completes the clean version and not the defective one', () => {
    expect(clean.completionRate).toBeGreaterThanOrEqual(SECTION_5.cleanCompletionAtLeast);
    expect(defective.completionRate).toBeLessThanOrEqual(SECTION_5.defectiveCompletionAtMost);
  });

  it('agrees with the outcome counts it stores', () => {
    for (const score of run.scores) {
      const counted = score.outcomeCounts;
      expect(counted.success + counted.abandoned + counted.failed).toBe(score.scoredSessionCount);
      expect(score.completionRate).toBeCloseTo(counted.success / score.scoredSessionCount, 2);

      const ofVariant = sessions.filter((session) => session.variant === score.variant);
      expect(ofVariant).toHaveLength(12);
      expect(ofVariant.filter((session) => session.outcome.excludedFromScores)).toHaveLength(
        counted.automationFailure,
      );
    }
  });

  it('excludes a session only for our own breakage, and says why in every one', () => {
    for (const session of sessions) {
      expect(session.outcome.excludedFromScores).toBe(
        session.outcome.status === 'automation_failure',
      );
      expect(session.outcome.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('the defect the demo leads with', () => {
  const complete = run.aois.find((aoi) => aoi.id === 'B-review-complete');
  const metric = run.aoiMetrics.find((row) => row.aoiId === 'B-review-complete');

  it('is declared as an area of interest, below the fold, on the defective version', () => {
    expect(complete).toBeDefined();
    expect(complete?.isPrimaryAction).toBe(true);
    expect(complete?.belowFold).toBe(true);
  });

  it('says honestly that nobody looked at it, rather than leaving it out', () => {
    expect(metric).toBeDefined();
    expect(metric?.timeToFirstFixationMs).toBeNull();
    expect(metric?.totalDwellMs).toBe(0);
    expect(metric?.fixationCount).toBe(0);
    expect(metric?.lookedAtShare).toBe(0);
    // And the sessions that got that far are counted, or "nobody looked" says nothing.
    expect(metric?.sessionCount ?? 0).toBeGreaterThan(0);
  });

  it('is the critical finding, and every finding names an area this run declares', () => {
    const declared = new Set(run.aois.map((aoi) => aoi.id));
    const headline = findings.findings.find(
      (finding) => findingRuleIdOf(finding as Finding) === 'never-fixated-primary-action',
    );
    expect(headline?.aoiId).toBe('B-review-complete');
    expect(headline?.severity).toBe('critical');
    for (const finding of findings.findings) {
      if (finding.aoiId !== null) expect([...declared]).toContain(finding.aoiId);
    }
  });

  it('is credited to the shop’s own declared defect 1', () => {
    const evaluated = evaluateAgainstPlantedDefects(
      findings.findings as Finding[],
      declaredDefects().defects,
    );
    expect(evaluated.matched.find((entry) => entry.defectId === 'D-1')?.findingId).not.toBeNull();
  });

  it('leaves sessions on the defective version ending before confirmation', () => {
    const scored = sessions.filter(
      (session) => session.variant === 'B' && !session.outcome.excludedFromScores,
    );
    expect(
      scored.filter((session) => !session.screens.some((screen) => screen.step === 'confirm'))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('the weight the repository carries', () => {
  const screenshots = filesUnder(runDir).filter((file) => file.endsWith('.png'));

  it('holds a screenshot for every variant and step the run reached', () => {
    const reached = new Set(
      sessions.flatMap((session) =>
        session.screens.map((screen) => `${session.variant}/${screen.step}`),
      ),
    );
    const recorded = new Set(run.screenshots.map((row) => `${row.variant}/${row.step}`));
    expect([...recorded].sort()).toEqual([...reached].sort());
    for (const row of run.screenshots) {
      expect(screenshots).toContain(row.path);
      expect(row.viewport.width).toBeGreaterThan(0);
      expect(row.pageHeight).toBeGreaterThanOrEqual(row.viewport.height);
      expect(row.foldY).toBe(row.viewport.height);
    }
  });

  it('keeps every screenshot inside 400 KB', () => {
    expect(screenshots.length).toBeGreaterThan(0);
    for (const file of screenshots) {
      expect(statSync(join(runDir, file)).size, file).toBeLessThanOrEqual(BUDGET.screenshotBytes);
    }
  });

  it('keeps the whole directory inside 20 MB', () => {
    const bytes = filesUnder(runDir).reduce(
      (total, file) => total + statSync(join(runDir, file)).size,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(BUDGET.directoryBytes);
  });

  it('carries nothing but artifact: no capture cache, no stray file', () => {
    for (const file of filesUnder(runDir)) {
      expect(file, 'a dotted path is working state, not artifact').not.toMatch(/(^|\/)\./);
      expect(file).toMatch(
        /^(run\.json|findings\.json|sessions\/S-\d\d\.json|screenshots\/.+\.png)$/,
      );
    }
  });
});
