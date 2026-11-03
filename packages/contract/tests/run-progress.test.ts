import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run, RunUsage, Score, SessionProgress, Violation } from '../src/index.js';
import {
  appendFinishedSession,
  AUTOMATION_FAILURE_NOTICE_SHARE,
  automationFailureNoticeIsDue,
  readRun,
  runPaths,
  runSchema,
  validate,
  writeRun,
  writeSession,
  ZERO_USAGE,
} from '../src/index.js';
import {
  CART,
  CONFIRM,
  finishedEntry,
  finishedProgress,
  onTheModel,
  openRunArtifact,
  temporaryRunDir,
  validArtifact,
  validRun,
  validSession,
} from './fixtures.js';

/**
 * The run artifact's status, progress and usage: the fields the Running and Test failed
 * screens read, and the writer that appends a finished session as the swarm lands it.
 *
 * What is asserted is observable: a directory validates or names the path of what is wrong,
 * and a run written mid-run reads back as what was written.
 */

/** The layout, relative, for the file a violation names. */
const label = runPaths('');

const offenders = (violations: ReadonlyArray<Violation>): string[] =>
  violations.map((violation) => `${violation.file}${violation.path}`);

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A bill from a provider that caches its prompts and spends reasoning tokens. */
const MODEL_USAGE: RunUsage = {
  calls: 3,
  inputTokens: 1200,
  cachedInputTokens: 900,
  outputTokens: 182,
  reasoningTokens: 172,
  estimatedCostUsd: 0.0042,
};

describe('a run that is still open', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('validates with zeroed counts and an empty log before anybody has finished', async () => {
    await writeRun(dir, openRunArtifact());

    expect(await validate(dir)).toEqual([]);
    const { run } = await readRun(dir);
    expect(run.status).toBe('open');
    expect(run.progress).toEqual({
      totalSessions: 2,
      finishedSessions: 0,
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 0 },
        { variant: 'B', totalSessions: 1, finishedSessions: 0 },
      ],
      sessions: [],
    });
    expect(run.finishedAt).toBeUndefined();
  });

  it('is written, read back and deeply equal with a partial progress block and usage', async () => {
    const artifact = openRunArtifact();
    artifact.run = onTheModel(artifact.run);
    artifact.run.progress = {
      totalSessions: 2,
      finishedSessions: 1,
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 1 },
        { variant: 'B', totalSessions: 1, finishedSessions: 0 },
      ],
      sessions: [finishedEntry('S-01', 'A')],
    };
    artifact.run.sessionIds = ['S-01'];
    artifact.sessions = [validSession('S-01', 'A')];
    artifact.run.usage = MODEL_USAGE;

    await writeRun(dir, artifact);

    expect(await validate(dir)).toEqual([]);
    expect(await readRun(dir)).toEqual(artifact);
  });
});

describe('writing one finished session', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('writes it at sessions/S-NN.json, and it reads back as what was written', async () => {
    const session = validSession('S-01', 'A');

    await writeSession(dir, session);

    expect(JSON.parse(await readFile(runPaths(dir).session('S-01'), 'utf8'))).toEqual(session);
  });

  it('makes the sessions directory, so the first session of a run needs no setup', async () => {
    // The run it belongs to is written by whatever is driving the run, and a session can
    // land before it: `runSession` (#44) writes one session and nothing else.
    await writeSession(dir, validSession('S-02', 'B'));

    expect(JSON.parse(await readFile(runPaths(dir).session('S-02'), 'utf8'))).toMatchObject({
      sessionId: 'S-02',
      variant: 'B',
    });
  });

  it('refuses a session that would not read back, naming the field', async () => {
    const broken = { ...validSession('S-01', 'A'), durationMs: -1 };

    await expect(writeSession(dir, broken)).rejects.toThrow('/durationMs');
    await expect(readFile(runPaths(dir).session('S-01'), 'utf8')).rejects.toThrow();
  });
});

describe('appending a finished session', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, openRunArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('updates the overall and per-variant counts, and the directory validates throughout', async () => {
    expect(await validate(dir)).toEqual([]);

    const after = await appendFinishedSession(dir, validSession('S-01', 'A'));

    expect(await validate(dir)).toEqual([]);
    expect(after.progress).toEqual({
      totalSessions: 2,
      finishedSessions: 1,
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 1 },
        { variant: 'B', totalSessions: 1, finishedSessions: 0 },
      ],
      sessions: [finishedEntry('S-01', 'A')],
    });

    await appendFinishedSession(dir, validSession('S-02', 'B'));

    expect(await validate(dir)).toEqual([]);
    const { run, sessions } = await readRun(dir);
    expect(run.progress).toEqual(finishedProgress());
    expect(run.sessionIds).toEqual(['S-01', 'S-02']);
    expect(sessions.map((session) => session.sessionId)).toEqual(['S-01', 'S-02']);
  });

  it('derives the log entry from the session and the run, and stores no sentence', async () => {
    const { progress } = await appendFinishedSession(dir, validSession('S-01', 'A'));

    expect(progress?.sessions[0]).toEqual({
      sessionId: 'S-01',
      personaName: 'Rushed buyer',
      variant: 'A',
      seed: 1,
      finishedAt: '2026-10-24T14:02:48.000Z',
      durationMs: 38_000,
      status: 'success',
      step: CONFIRM,
      reason: 'Order placed.',
      attribution: 'product',
    });
  });

  it('leaves the run open: closing it is the swarm’s to do', async () => {
    const after = await appendFinishedSession(dir, validSession('S-01', 'A'));

    expect(after.status).toBe('open');
    expect(after.finishedAt).toBeUndefined();
  });

  it('adds what the session spent to the run’s totals', async () => {
    const artifact = openRunArtifact();
    artifact.run = onTheModel(artifact.run);
    artifact.run.usage = { ...ZERO_USAGE };
    await writeRun(dir, artifact);

    await appendFinishedSession(dir, validSession('S-01', 'A'), { usage: MODEL_USAGE });
    const after = await appendFinishedSession(dir, validSession('S-02', 'B'), {
      usage: MODEL_USAGE,
    });

    expect(after.usage).toEqual({
      calls: 6,
      inputTokens: 2400,
      cachedInputTokens: 1800,
      outputTokens: 364,
      reasoningTokens: 344,
      estimatedCostUsd: 0.0084,
    });
    expect(await validate(dir)).toEqual([]);
  });

  it('declares the areas and screens a session reports, one row each', async () => {
    const area = {
      id: 'a-cart-basket',
      variant: 'A',
      step: CART,
      label: 'Basket',
      source: 'dom' as const,
      role: 'region',
      bbox: { x: 40, y: 80, width: 300, height: 200 },
      isPrimaryAction: false,
      belowFold: false,
    };
    const screen = {
      variant: 'A',
      step: CART,
      path: runPaths('').screenshot('A', CART),
      viewport: { width: 1440, height: 900 },
      pageHeight: 2000,
      foldY: 900,
    };

    await appendFinishedSession(dir, validSession('S-01', 'A'), {
      aois: [area],
      screenshots: [screen],
    });
    // A second session saw the same screen, as every session of a variant does, and found it
    // a little longer — a cart with three things in it rather than one.
    const taller = { ...screen, pageHeight: 2400 };
    const after = await appendFinishedSession(dir, validSession('S-02', 'B'), {
      aois: [area],
      screenshots: [taller],
    });

    // One row per key, and the row is the last one reported: the image on disk is the last
    // one written, and a row describing the shorter page would not fit it.
    expect(after.screenshots.filter((row) => row.step === CART)).toEqual([taller]);
    expect(after.aois.filter((row) => row.id === area.id)).toEqual([area]);
    expect(after.aois).toHaveLength(validRun().aois.length + 1);
    expect(await validate(dir)).toEqual([]);
  });

  it('refuses a session the run planned no room for, and writes nothing', async () => {
    await appendFinishedSession(dir, validSession('S-01', 'A'));

    await expect(appendFinishedSession(dir, validSession('S-03', 'A'))).rejects.toThrow(
      /one more than the run planned/,
    );
    expect(await validate(dir)).toEqual([]);
    expect((await readRun(dir)).run.sessionIds).toEqual(['S-01']);
  });

  it('refuses the same session twice', async () => {
    await appendFinishedSession(dir, validSession('S-01', 'A'));

    await expect(appendFinishedSession(dir, validSession('S-01', 'A'))).rejects.toThrow(
      /one more than the run planned/,
    );
  });

  it('takes the name for a session whose persona the run does not declare', async () => {
    const stranger = validSession('S-01', 'A');
    stranger.persona = { ...validSession('S-01', 'A').persona, id: 'nobody' } as never;

    await expect(appendFinishedSession(dir, stranger)).rejects.toThrow(
      /declares no persona "nobody"/,
    );

    const after = await appendFinishedSession(dir, stranger, { personaName: 'Walk-in visitor' });

    expect(after.progress?.sessions[0].personaName).toBe('Walk-in visitor');
    expect(await validate(dir)).toEqual([]);
  });
});

describe('a run that failed to start', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  const failed = (): Run => {
    const run: Run = {
      ...openRunArtifact().run,
      status: 'failed',
      finishedAt: '2026-10-24T14:02:08.000Z',
      failure: {
        reason: 'The second URL could not be opened',
        detail: 'playwright: net::ERR_CONNECTION_REFUSED at http://localhost:4173/checkout-b',
      },
      progress: {
        totalSessions: 2,
        finishedSessions: 0,
        perVariant: [
          { variant: 'A', totalSessions: 1, finishedSessions: 0 },
          { variant: 'B', totalSessions: 1, finishedSessions: 0 },
        ],
        sessions: [],
      },
    };
    return run;
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, { ...openRunArtifact(), run: failed() });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('validates with its reason, its captured detail and no progress', async () => {
    expect(await validate(dir)).toEqual([]);
    const { run } = await readRun(dir);

    expect(run.status).toBe('failed');
    expect(run.failure?.reason).toBe('The second URL could not be opened');
    expect(run.failure?.detail).toContain('ERR_CONNECTION_REFUSED');
    expect(run.progress?.sessions).toEqual([]);
  });

  it('is rejected when it claims somebody finished', async () => {
    const run = failed();
    run.progress = { ...finishedProgress(), sessions: [finishedEntry('S-01', 'A')] };
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/progress`);
  });

  it('is rejected when it does not say why it failed', async () => {
    const run = failed();
    delete run.failure;
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/failure`);
  });

  it('is rejected when a run that did not fail carries a failure', async () => {
    const run = { ...validRun(), failure: failed().failure };
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toContain(`${label.run}/status`);
  });
});

/**
 * The fifth: a run whose automation failures are more than a fifth of its sessions is a
 * measurement of our harness and says so above its own summary (`docs/FLOW.md` section 11).
 *
 * The threshold is one exported constant and the answer is one exported predicate over the
 * counters a run already carries. Nothing here restates the fraction: the counts either
 * side of it are computed from the constant, so a later change to the constant moves this
 * suite with it rather than leaving it asserting the old figure.
 */
describe('the automation failures that make a run about our own harness', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Ten sessions: one person, two variants, five seeds each. */
  const FINISHED = 10;
  /** Exactly the share, in sessions — two of ten — and the first count above it. */
  const AT_THE_SHARE = Math.round(FINISHED * AUTOMATION_FAILURE_NOTICE_SHARE);

  const ourFailure = (sessionId: string, variant: string): SessionProgress => ({
    ...finishedEntry(sessionId, variant),
    status: 'automation_failure',
    attribution: 'automation',
    reason: 'The page never loaded.',
  });

  /** The site's own failure, which is not ours however many of them there are. */
  const theirFailure = (sessionId: string, variant: string): SessionProgress => ({
    ...finishedEntry(sessionId, variant),
    status: 'failed',
    attribution: 'product',
    reason: 'The promo code was refused.',
  });

  /**
   * A run of ten finished sessions, the first `ours` of them our own automation failures and
   * the rest as `make` writes them. The score rows are rebuilt from those entries, so the
   * counts the notice is derived from are the counts a reader sees printed beside it.
   */
  const runOf = (
    ours: number,
    make: (sessionId: string, variant: string) => SessionProgress = finishedEntry,
  ): Run => {
    const sessions = Array.from({ length: FINISHED }, (_, index) => {
      const sessionId = `S-${String(index + 1).padStart(2, '0')}`;
      const variant = index % 2 === 0 ? 'A' : 'B';
      return index < ours ? ourFailure(sessionId, variant) : make(sessionId, variant);
    });
    const scoreOf = (variant: string): Score => {
      const ofVariant = sessions.filter((entry) => entry.variant === variant);
      const excluded = ofVariant.filter((entry) => entry.status === 'automation_failure');
      const scored = ofVariant.length - excluded.length;
      const failed = ofVariant.filter((entry) => entry.status === 'failed').length;
      return {
        ...validRun().scores[0],
        variant,
        completionRate: (scored - failed) / scored,
        outcomeCounts: {
          success: scored - failed,
          abandoned: 0,
          failed,
          automationFailure: excluded.length,
        },
        scoredSessionCount: scored,
      };
    };
    return {
      ...validRun(),
      sessionIds: sessions.map((entry) => entry.sessionId),
      progress: {
        totalSessions: FINISHED,
        finishedSessions: FINISHED,
        perVariant: ['A', 'B'].map((variant) => ({
          variant,
          totalSessions: FINISHED / 2,
          finishedSessions: FINISHED / 2,
        })),
        sessions,
      },
      scores: [scoreOf('A'), scoreOf('B')],
    };
  };

  it('is not due at the share, and is due one session above it', () => {
    expect(automationFailureNoticeIsDue(runOf(AT_THE_SHARE).progress)).toBe(false);
    expect(automationFailureNoticeIsDue(runOf(AT_THE_SHARE + 1).progress)).toBe(true);
  });

  it('is read off counters a run really carries, on both sides of the share', async () => {
    for (const ours of [AT_THE_SHARE, AT_THE_SHARE + 1]) {
      const run = runOf(ours);

      expect(runSchema.safeParse(run).success).toBe(true);
      // The counts and the answer are one claim: the entries beneath the counter are the
      // failures the share was computed from.
      const logged = (run.progress?.sessions ?? []).filter(
        (entry) => entry.status === 'automation_failure',
      );
      expect(logged).toHaveLength(ours);
      expect(automationFailureNoticeIsDue(run.progress)).toBe(ours > AT_THE_SHARE);
    }
  });

  it("counts what the outcome was, not whose the session's failure was", () => {
    // Every session the site failed, and not one of ours: the aggregate is still about the
    // site, which is the whole point of the line.
    const theirs = runOf(0, theirFailure);

    expect(theirs.progress?.sessions.every((entry) => entry.status === 'failed')).toBe(true);
    expect(automationFailureNoticeIsDue(theirs.progress)).toBe(false);
  });

  it('is the share so far on a run that is still landing sessions', () => {
    // Two of ten planned have landed and one of them was ours. Half of what has finished is
    // our own failure, so what the run has so far *is* about our harness; the counter the
    // share is over is the sessions that produced an outcome, not the plan.
    const landing = runOf(1);
    const sessions = (landing.progress?.sessions ?? []).slice(0, 2);
    const run: Run = {
      ...landing,
      status: 'open',
      progress: {
        totalSessions: FINISHED,
        finishedSessions: sessions.length,
        perVariant: ['A', 'B'].map((variant) => ({
          variant,
          totalSessions: FINISHED / 2,
          finishedSessions: sessions.filter((entry) => entry.variant === variant).length,
        })),
        sessions,
      },
    };
    delete run.finishedAt;

    expect(automationFailureNoticeIsDue(run.progress)).toBe(true);
  });

  it('has nothing to disclaim before a session has finished, or with no progress at all', () => {
    expect(automationFailureNoticeIsDue(openRunArtifact().run.progress)).toBe(false);
    expect(automationFailureNoticeIsDue(undefined)).toBe(false);
  });

  it('is derived and never stored, so no boolean can disagree with the counts', async () => {
    const run: Record<string, unknown> = {
      ...runOf(AT_THE_SHARE + 1),
      aboutOurHarness: true,
    };
    await writeFile(runPaths(dir).run, asJson(run));

    expect(offenders(await validate(dir))).toEqual([`${label.run}/aboutOurHarness`]);
  });
});

describe('a run written before this step', () => {
  it('validates with none of the new fields, and claims no status it never recorded', async () => {
    const { dir, cleanup } = await temporaryRunDir();
    try {
      await writeRun(dir, validArtifact());
      const run: Record<string, unknown> = { ...validRun() };
      for (const field of ['status', 'startedAt', 'finishedAt', 'progress', 'failure', 'usage']) {
        delete run[field];
      }
      await writeFile(runPaths(dir).run, asJson(run));

      expect(await validate(dir)).toEqual([]);
      const read = await readRun(dir);
      expect(read.run.status).toBeUndefined();
      expect(read.run.progress).toBeUndefined();
      expect(read.run.usage).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('the run’s usage', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  const writeUsage = async (usage: RunUsage, run: Run = validRun()): Promise<string[]> => {
    await writeFile(runPaths(dir).run, asJson({ ...run, usage }));
    return offenders(await validate(dir));
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('records zero calls, zero tokens and zero cost for a run that made none', async () => {
    expect(await validate(dir)).toEqual([]);

    expect((await readRun(dir)).run.usage).toEqual({
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it('carries cached input and reasoning output as fields of their own', async () => {
    expect(await writeUsage(MODEL_USAGE, onTheModel(validRun()))).toEqual([]);

    const { usage } = (await readRun(dir)).run;
    expect(usage?.cachedInputTokens).toBe(900);
    expect(usage?.reasoningTokens).toBe(172);
  });

  it('accepts a provider that reports neither, as zero for both', async () => {
    const reported: RunUsage = {
      ...MODEL_USAGE,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };

    expect(await writeUsage(reported, onTheModel(validRun()))).toEqual([]);
  });

  it('rejects more cached tokens than input tokens', async () => {
    const offending = await writeUsage(
      { ...MODEL_USAGE, cachedInputTokens: 1300 },
      onTheModel(validRun()),
    );

    expect(offending).toContain(`${label.run}/usage/cachedInputTokens`);
  });

  it('rejects more reasoning tokens than output tokens', async () => {
    const offending = await writeUsage(
      { ...MODEL_USAGE, reasoningTokens: 400 },
      onTheModel(validRun()),
    );

    expect(offending).toContain(`${label.run}/usage/reasoningTokens`);
  });

  it('rejects a negative cost', async () => {
    expect(await writeUsage({ ...ZERO_USAGE, estimatedCostUsd: -1 })).toContain(
      `${label.run}/usage/estimatedCostUsd`,
    );
  });

  it('rejects tokens that no call accounts for', async () => {
    expect(await writeUsage({ ...ZERO_USAGE, inputTokens: 1200 })).toContain(
      `${label.run}/usage/calls`,
    );
  });

  it('rejects an offline run that bills for model calls', async () => {
    expect(await writeUsage(MODEL_USAGE)).toContain(`${label.run}/usage/calls`);
  });
});

describe('the run’s progress is structured, and is held to its own counts', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  const writeRunJson = async (run: unknown): Promise<string[]> => {
    await writeFile(runPaths(dir).run, asJson(run));
    return offenders(await validate(dir));
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await temporaryRunDir());
    await writeRun(dir, validArtifact());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('rejects a log entry carrying a pre-composed sentence', async () => {
    const run = validRun();
    const sessions = [
      { ...finishedEntry('S-01', 'A'), sentence: 'S-01 abandoned at the review step' },
      finishedEntry('S-02', 'B'),
    ];

    expect(await writeRunJson({ ...run, progress: { ...finishedProgress(), sessions } })).toContain(
      `${label.run}/progress/sessions/0/sentence`,
    );
  });

  it('rejects a log entry on a variant the run does not declare', async () => {
    const run = validRun();
    run.progress = {
      totalSessions: 2,
      finishedSessions: 1,
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 1 },
        { variant: 'B', totalSessions: 1, finishedSessions: 0 },
      ],
      sessions: [finishedEntry('S-01', 'Z')],
    };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/sessions/0/variant`);
  });

  it('rejects per-variant counts on a variant the run does not declare', async () => {
    const run = validRun();
    run.progress = {
      ...finishedProgress(),
      perVariant: [{ variant: 'Z', totalSessions: 2, finishedSessions: 2 }],
    };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/perVariant/0/variant`);
  });

  it('rejects a log entry naming a session the run does not list', async () => {
    const run = validRun();
    run.progress = {
      ...finishedProgress(),
      finishedSessions: 3,
      totalSessions: 3,
      perVariant: [
        { variant: 'A', totalSessions: 2, finishedSessions: 2 },
        { variant: 'B', totalSessions: 1, finishedSessions: 1 },
      ],
      sessions: [
        finishedEntry('S-01', 'A'),
        finishedEntry('S-02', 'B'),
        finishedEntry('S-09', 'A'),
      ],
    };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/sessions/2/sessionId`);
  });

  it('rejects the same session recorded as finished twice', async () => {
    const run = validRun();
    run.progress = {
      ...finishedProgress(),
      sessions: [finishedEntry('S-01', 'A'), finishedEntry('S-01', 'A')],
    };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/sessions/1/sessionId`);
  });

  it('rejects a count that disagrees with the log beneath it', async () => {
    const run = validRun();
    run.progress = { ...finishedProgress(), finishedSessions: 1 };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/sessions`);
  });

  it('rejects more finished sessions than the run has', async () => {
    const run = validRun();
    run.progress = { ...finishedProgress(), totalSessions: 1 };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/finishedSessions`);
  });

  it('rejects per-variant counts that do not add up to the run’s own', async () => {
    const run = validRun();
    run.progress = {
      ...finishedProgress(),
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 1 },
        { variant: 'B', totalSessions: 4, finishedSessions: 1 },
      ],
    };

    expect(await writeRunJson(run)).toContain(`${label.run}/progress/perVariant`);
  });

  it('rejects more finished than planned on one variant', async () => {
    const run = validRun();
    run.progress = {
      ...finishedProgress(),
      perVariant: [
        { variant: 'A', totalSessions: 0, finishedSessions: 1 },
        { variant: 'B', totalSessions: 2, finishedSessions: 1 },
      ],
    };

    expect(await writeRunJson(run)).toContain(
      `${label.run}/progress/perVariant/0/finishedSessions`,
    );
  });

  it('rejects a finishing time on a run that is still open', async () => {
    const run = { ...validRun(), status: 'open' as const };

    expect(await writeRunJson(run)).toContain(`${label.run}/finishedAt`);
  });

  it('rejects a run that finished before it started', async () => {
    const run = { ...validRun(), finishedAt: '2026-10-24T14:01:00.000Z' };

    expect(await writeRunJson(run)).toContain(`${label.run}/finishedAt`);
  });

  it('rejects a finishing time with no starting time', async () => {
    const run: Record<string, unknown> = { ...validRun() };
    delete run.startedAt;

    expect(await writeRunJson(run)).toContain(`${label.run}/startedAt`);
  });

  it('rejects a status the contract does not declare', async () => {
    expect(await writeRunJson({ ...validRun(), status: 'running' })).toContain(
      `${label.run}/status`,
    );
  });
});
