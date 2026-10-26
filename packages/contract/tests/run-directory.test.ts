import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Violation } from '../src/index.js';
import { readRun, runPaths, validate, writeRun } from '../src/index.js';
import {
  CHECKOUT_AOI,
  temporaryRunDir,
  validArtifact,
  validFindings,
  validRun,
  validSession,
} from './fixtures.js';

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

/** `sessions/S-01.json/fixations/1/index` — the file and the JSON path together. */
const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('a run directory', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('validates with no violations when it is sound', async () => {
    expect(await validate(dir)).toEqual([]);
  });

  it('parses into values the compiler knows the shape of', async () => {
    const { run, sessions, findings } = await readRun(dir);

    const median: number = run.scores[0].frictionScore.median;
    const neverFixated: number | null = run.aoiMetrics[1].timeToFirstFixationMs;
    const status: 'success' | 'abandoned' | 'failed' | 'automation_failure' =
      sessions[0].outcome.status;
    const severity: string = findings.findings[0].severity;

    expect(median).toBe(22);
    expect(neverFixated).toBeNull();
    expect(status).toBe('success');
    expect(severity).toBe('critical');
  });

  it('reads back exactly what the writer wrote, sessions and findings included', async () => {
    const written = validArtifact();
    await writeRun(dir, written);

    expect(await readRun(dir)).toEqual(written);
  });

  it('refuses to be read at all while it has a violation', async () => {
    await writeFile(runPaths(dir).run, 'not json');

    await expect(readRun(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('reports a missing file rather than throwing', async () => {
    const { dir: empty, cleanup: throwAway } = await temporaryRunDir();
    try {
      expect(offenders(await validate(empty))).toEqual([label.run, label.findings]);
    } finally {
      await throwAway();
    }
  });
});

describe('a mutated run directory is rejected at the path of the offending value', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('rejects run.json with no schemaVersion', async () => {
    const run: Record<string, unknown> = { ...validRun() };
    delete run.schemaVersion;
    await writeFile(runPaths(dir).run, asJson(run));

    const violations = await validate(dir);

    expect(offenders(violations)).toContain(`${label.run}/schemaVersion`);
    expect(violations[0].message).toMatch(/every artifact file states the schema version/);
  });

  it('rejects findings.json with no schemaVersion', async () => {
    const findings: Record<string, unknown> = { ...validFindings() };
    delete findings.schemaVersion;
    await writeFile(runPaths(dir).findings, asJson(findings));

    expect(offenders(await validate(dir))).toContain(`${label.findings}/schemaVersion`);
  });

  it('rejects an outcome status that is not one of the four', async () => {
    const session: Record<string, unknown> = { ...validSession('S-01', 'A') };
    session.outcome = { ...validSession('S-01', 'A').outcome, status: 'gave-up' };
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-01')}/outcome/status`);
  });

  it('rejects a lookedAtShare outside 0..1', async () => {
    const run = validRun();
    run.aoiMetrics[0].lookedAtShare = 1.4;
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/aoiMetrics/0/lookedAtShare`);
  });

  it('rejects a persona trait outside 0..1', async () => {
    const run = validRun();
    run.personas[0].traits.patience = -0.1;
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/personas/0/traits/patience`);
  });

  it('rejects a fixation whose aoiId names no area of interest', async () => {
    const session = validSession('S-01', 'A');
    session.fixations[1].aoiId = 'no-such-area';
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    const violations = await validate(dir);

    expect(offenders(violations)).toContain(`${label.session('S-01')}/fixations/1/aoiId`);
    expect(violations[0].message).toMatch(/names no area of interest/);
  });

  it('rejects an action whose aoiId names no area of interest', async () => {
    const session = validSession('S-01', 'A');
    session.actions[0].aoiId = 'no-such-area';
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-01')}/actions/0/aoiId`);
  });

  it('rejects an aoiMetrics row whose aoiId names no area of interest', async () => {
    const run = validRun();
    run.aoiMetrics[0].aoiId = 'no-such-area';
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/aoiMetrics/0/aoiId`);
  });

  it('rejects fixation indices that are not contiguous across the session', async () => {
    const session = validSession('S-01', 'A');
    session.fixations[1].index = 5;
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    const violations = await validate(dir);

    expect(offenders(violations)).toContain(`${label.session('S-01')}/fixations/1/index`);
    expect(violations[0].message).toMatch(/continuously across the session/);
  });

  it('rejects a duplicated fixation index', async () => {
    const session = validSession('S-01', 'A');
    session.fixations[2].index = 1;
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-01')}/fixations/2/index`);
  });

  it('rejects a session file whose name and sessionId disagree', async () => {
    await writeFile(runPaths(dir).session('S-02'), asJson(validSession('S-01', 'A')));

    const violations = await validate(dir);

    expect(offenders(violations)).toContain(`${label.session('S-02')}/sessionId`);
    expect(violations[0].message).toMatch(/named for session "S-02" but carries "S-01"/);
  });

  it('rejects a sessionId listed more than once', async () => {
    const run = validRun();
    run.sessionIds = ['S-01', 'S-01', 'S-02'];
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/sessionIds/1`);
  });

  it('rejects a variant that the run does not declare', async () => {
    const run = validRun();
    run.verdict.harderVariant = 'Z';
    run.aois[0].variant = 'Z';
    run.screenshots[0].variant = 'Z';
    run.scores[0].variant = 'Z';
    run.stepCaptions[0].variant = 'Z';
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toEqual(
      expect.arrayContaining([
        `${label.run}/aois/0/variant`,
        `${label.run}/screenshots/0/variant`,
        `${label.run}/scores/0/variant`,
        `${label.run}/verdict/harderVariant`,
        `${label.run}/stepCaptions/0/variant`,
      ]),
    );
  });

  it('rejects a step caption against a step that the run does not declare', async () => {
    const run = validRun();
    run.stepCaptions[0].step = 'checkout';
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/stepCaptions/0/step`);
  });

  it('rejects a session on a variant that the run does not declare', async () => {
    const session = validSession('S-01', 'Z');
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-01')}/variant`);
  });

  it('rejects a finding that points at nothing in the run', async () => {
    const findings = validFindings();
    findings.findings[0].aoiId = 'no-such-area';
    findings.findings[0].variant = 'Z';
    findings.findings[0].sessionIds = ['S-77'];
    await writeFile(runPaths(dir).findings, asJson(findings));

    expect(offenders(await validate(dir))).toEqual([
      `${label.findings}/findings/0/aoiId`,
      `${label.findings}/findings/0/variant`,
      `${label.findings}/findings/0/sessionIds/0`,
    ]);
  });

  it("rejects a fixation whose screenIndex is past the session's screens", async () => {
    const session = validSession('S-01', 'A');
    session.fixations[0].screenIndex = 42;
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(
      `${label.session('S-01')}/fixations/0/screenIndex`,
    );
  });

  it("rejects a saccade whose ends are past the session's fixations", async () => {
    const session = validSession('S-01', 'A');
    session.saccades[0].toFixation = 99;
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    expect(offenders(await validate(dir))).toContain(
      `${label.session('S-01')}/saccades/0/toFixation`,
    );
  });

  it('rejects a session that run.json does not list', async () => {
    await writeFile(runPaths(dir).session('S-99'), asJson(validSession('S-99', 'A')));

    expect(offenders(await validate(dir))).toContain(`${label.session('S-99')}/sessionId`);
  });

  it('rejects a listed session that is not on disk', async () => {
    const run = validRun();
    run.sessionIds = ['S-01', 'S-02', 'S-03'];
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/sessionIds/2`);
  });

  it('reports every violation rather than stopping at the first', async () => {
    const run = validRun();
    run.aoiMetrics[0].lookedAtShare = 1.4;
    run.verdict.seedGroupsAgreeing = -1;
    await writeFile(runPaths(dir).run, asJson(run));

    const session: Record<string, unknown> = { ...validSession('S-02', 'B') };
    session.outcome = { ...validSession('S-02', 'B').outcome, status: 'gave-up' };
    await writeFile(runPaths(dir).session('S-02'), asJson(session));

    expect(offenders(await validate(dir))).toEqual([
      `${label.run}/aoiMetrics/0/lookedAtShare`,
      `${label.run}/verdict/seedGroupsAgreeing`,
      `${label.session('S-02')}/outcome/status`,
    ]);
  });

  it('checks references only once run.json itself parses, and says so by reporting it', async () => {
    const run: Record<string, unknown> = { ...validRun() };
    delete run.aois;
    const session = validSession('S-01', 'A');
    session.fixations[1].aoiId = 'no-such-area';
    await writeFile(runPaths(dir).run, asJson(run));
    await writeFile(runPaths(dir).session('S-01'), asJson(session));

    // Nothing declares an area of interest to check against, so the dangling reference is
    // not reported; the reason it is not is.
    expect(offenders(await validate(dir))).toEqual([`${label.run}/aois`]);
  });
});

describe('the writer refuses an artifact that would not read back', () => {
  it('names every violation instead of writing it', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      const artifact = validArtifact();
      artifact.sessions[0].fixations[1].aoiId = 'no-such-area';
      artifact.run.sessionIds = ['S-01'];

      await expect(writeRun(dir, artifact)).rejects.toThrow(/names no area of interest/);
      expect(offenders(await validate(dir))).toEqual([label.run, label.findings]);
    } finally {
      await cleanup();
    }
  });

  it('replaces a run in place without inheriting the sessions it no longer lists', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      await writeRun(dir, validArtifact());

      const shorter = validArtifact();
      shorter.run.sessionIds = ['S-01'];
      shorter.sessions = [validSession('S-01', 'A')];
      shorter.findings.findings[0].sessionIds = ['S-01'];
      await writeRun(dir, shorter);

      expect(await validate(dir)).toEqual([]);
      expect(await readRun(dir)).toEqual(shorter);
    } finally {
      await cleanup();
    }
  });

  it('accepts an area of interest whose box starts off the left or top edge', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      const artifact = validArtifact();
      artifact.run.aois[0].bbox = { x: -120, y: -8, width: 220, height: 48 };
      await writeRun(dir, artifact);

      expect(await validate(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('keeps areas of interest that are never fixated, because that is a result', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      await writeRun(dir, validArtifact());
      const { run } = await readRun(dir);

      expect(run.aoiMetrics.find((metric) => metric.aoiId !== CHECKOUT_AOI)).toMatchObject({
        timeToFirstFixationMs: null,
        fixationCount: 0,
        lookedAtShare: 0,
      });
    } finally {
      await cleanup();
    }
  });
});
