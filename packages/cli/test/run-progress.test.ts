import { describe, expect, it } from 'vitest';
import {
  closingLines,
  enginePhrase,
  finishedPhrase,
  logLine,
  logStamp,
  OFFLINE_ENGINE,
  openingLines,
  outcomeSentence,
  reportLine,
  usagePhrase,
} from '../src/run/progress.js';
import { validArtifact } from '../../contract/tests/fixtures.js';
import type { Run, SessionProgress } from '@personavision/contract';

/**
 * The words the running report is made of, held to the prototype's own Running log.
 *
 * `docs/design/prototype.html`'s `#screen-running` writes the log lines this file quotes,
 * and `apps/viewer/src/screens/runstatus/` renders the same lines on the screen from the
 * same artifact fields (#18). The command and the screen are two faces of one run, so what
 * is asserted here is the wording itself: a change to either side that was not made to the
 * other shows up as a failure in one of these.
 */

const RUN_STARTED_AT = '2026-10-24T14:02:00.000Z';

/** The demo task's four steps, as `docs/design/prototype.html`'s `STEPS` labels them. */
const STEPS = [
  { id: 'cart', label: 'Cart' },
  { id: 'payment', label: 'Payment' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirmation' },
];

/** A run of the shape the Running screen reads: started, open, with a plan and a log. */
const runningRun = (over: Partial<Run> = {}): Run => {
  const { run } = validArtifact();
  return {
    ...run,
    status: 'open',
    startedAt: RUN_STARTED_AT,
    finishedAt: undefined,
    // A log line names a step as the run labels it, so the labels are the prototype's.
    steps: STEPS,
    progress: {
      totalSessions: 24,
      finishedSessions: 0,
      perVariant: [
        { variant: 'A', totalSessions: 12, finishedSessions: 0 },
        { variant: 'B', totalSessions: 12, finishedSessions: 0 },
      ],
      sessions: [],
    },
    ...over,
  };
};

/** One finished session, as `appendFinishedSession` writes its progress entry. */
const finished = (over: Partial<SessionProgress> = {}): SessionProgress => ({
  sessionId: 'S-24',
  personaName: 'Price-sensitive scanner',
  variant: 'B',
  seed: 3,
  // 00:03:11 into the run, which is the stamp the prototype's last log line carries.
  finishedAt: '2026-10-24T14:05:11.000Z',
  durationMs: 58_400,
  status: 'abandoned',
  step: 'review',
  reason: 'service fee revealed late',
  attribution: 'product',
  ...over,
});

describe('the counts', () => {
  it('counts sessions, because four people on three seeds against two versions are twenty-four', () => {
    expect(finishedPhrase(17, 24)).toBe('17 of 24 sessions finished');
  });

  it('says one session in the singular, and nought of them before anybody has finished', () => {
    expect(finishedPhrase(0, 24)).toBe('0 of 24 sessions finished');
    expect(finishedPhrase(1, 1)).toBe('1 of 1 session finished');
  });
});

describe('one session’s log line', () => {
  it('words an abandonment as the prototype’s log does', () => {
    const run = runningRun();

    expect(logLine(run, finished())).toBe(
      'S-24 Price-sensitive scanner · B · seed 3 — abandoned at the Review step (product: service fee revealed late)',
    );
  });

  it('words an automation failure as ours, never as the product’s', () => {
    const run = runningRun();
    const entry = finished({
      sessionId: 'S-09',
      personaName: 'First-time visitor',
      variant: 'A',
      status: 'automation_failure',
      step: 'payment',
      reason: 'selector timeout on card iframe',
      attribution: 'automation',
    });

    expect(logLine(run, entry)).toBe(
      'S-09 First-time visitor · A · seed 3 — automation failure at the Payment step (automation: selector timeout on card iframe)',
    );
  });

  it('times a success rather than naming a step it did not stop at', () => {
    const run = runningRun();
    const entry = finished({
      sessionId: 'S-16',
      personaName: 'Careful comparer',
      status: 'success',
      step: 'confirm',
      reason: '',
      durationMs: 58_400,
    });

    expect(outcomeSentence(run, entry)).toBe('success in 58.4 s');
  });

  it('keeps a captured detail on one line, however many lines it arrived on', () => {
    const run = runningRun();
    const entry = finished({ reason: 'the fee appeared\n  after the card\n\nwas entered' });

    expect(outcomeSentence(run, entry)).toBe(
      'abandoned at the Review step (product: the fee appeared after the card was entered)',
    );
  });

  it('names no seed for a real session, which carries a participant instead', () => {
    const run = runningRun();

    expect(logLine(run, finished({ seed: null }))).toContain(
      'S-24 Price-sensitive scanner · B — abandoned',
    );
  });

  it('stamps how far into the run it landed', () => {
    const run = runningRun();

    expect(logStamp(run, finished())).toBe('00:03:11');
    // A run that records no start has no offset to measure from, and says nothing rather
    // than a stamp from nowhere.
    expect(logStamp({ ...run, startedAt: undefined }, finished())).toBeNull();
  });
});

describe('the engine', () => {
  it('reads the offline deterministic engine, with no cost beside it', () => {
    const run = runningRun();

    expect(enginePhrase(run.engine)).toBe(OFFLINE_ENGINE);
    expect(usagePhrase(run)).toBeNull();
  });

  it('names the model and the mode on a model run, and what it has spent', () => {
    const run = runningRun({
      engine: {
        mode: 'model',
        modelMode: 'contributor',
        provider: 'meta-model-api',
        models: { decision: 'muse-spark-1.3-contributor', segmentation: 'none', planning: 'none' },
        weights: { alpha: 0.5, beta: 0.35, gamma: 0.15 },
        version: 'uncalibrated',
      },
      usage: {
        calls: 312,
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 200_000,
        reasoningTokens: 150_000,
        estimatedCostUsd: 0.42,
      },
    });

    expect(enginePhrase(run.engine)).toBe('Muse Spark 1.3 · contributor mode');
    expect(usagePhrase(run)).toBe('312 calls · $0.42 so far');
    // The spend travels on the session's own line, so the report stays one line per session.
    expect(reportLine(run, finished())).toBe(
      '00:03:11  S-24 Price-sensitive scanner · B · seed 3 — abandoned at the Review step (product: service fee revealed late) · 312 calls · $0.42 so far',
    );
  });

  it('says the standard mode by name, so a paying customer can see which model ran', () => {
    const run = runningRun({
      engine: {
        mode: 'model',
        modelMode: 'standard',
        provider: 'meta-model-api',
        models: { decision: 'muse-spark-1.3', segmentation: 'none', planning: 'none' },
        weights: { alpha: 0.5, beta: 0.35, gamma: 0.15 },
        version: 'uncalibrated',
      },
    });

    expect(enginePhrase(run.engine)).toBe('Muse Spark 1.3 · standard mode');
  });
});

describe('the report’s opening and closing', () => {
  it('opens on the task, the counts, the versions and the audience', () => {
    const run = runningRun();

    expect(openingLines(run)).toEqual([
      `Running · ${run.task.prompt}`,
      `0 of 24 sessions finished · ${OFFLINE_ENGINE}`,
      `  A ${String(run.variants[0]?.name)} · 12 sessions · ${String(run.variants[0]?.url)}`,
      `  B ${String(run.variants[1]?.name)} · 12 sessions · ${String(run.variants[1]?.url)}`,
      `  ${run.audience.name} · 1 person · seeds ${run.seedGroups.join(', ')}`,
    ]);
  });

  it('closes on what landed, not on what was planned', () => {
    const run = runningRun({
      progress: {
        totalSessions: 24,
        finishedSessions: 7,
        perVariant: [
          { variant: 'A', totalSessions: 12, finishedSessions: 5 },
          { variant: 'B', totalSessions: 12, finishedSessions: 2 },
        ],
        sessions: [],
      },
    });

    expect(closingLines(run, Date.parse('2026-10-24T14:05:11.000Z'))).toEqual([
      `7 of 24 sessions finished · 3 min elapsed · ${OFFLINE_ENGINE}`,
      '  A 5 / 12 sessions',
      '  B 2 / 12 sessions',
    ]);
  });
});
