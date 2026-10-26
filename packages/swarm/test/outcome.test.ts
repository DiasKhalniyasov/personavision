import { SCHEMA_VERSION, sessionSchema, type Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  decideOutcome,
  type DecidingPersona,
  type SessionOutcome,
  type SessionTrace,
} from '../src/index.js';

/**
 * What a session's ending is decided from, on synthetic traces: no browser, no provider,
 * no network, no API key and no file read.
 *
 * The traces are written as the facts a walk records — screens, fixations, actions, a
 * duration, whether the browser saw the task's success condition — because that is all
 * `decideOutcome` is given. Every assertion is on the outcome it returns.
 */

/** A generated persona, with all six traits, as `packages/contract` spells them. */
const PERSONA_TRAITS = {
  persistence: 0.5,
  scanningVsReading: 0.6,
  detailOrientation: 0.4,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
} as const;

/** Patience and persistence near the bottom of the range: this one gives up early. */
const IMPATIENT: DecidingPersona = {
  traits: { ...PERSONA_TRAITS, patience: 0.1, persistence: 0.1 },
};
/** Near the top: this one keeps going through the same tedium. */
const PERSISTENT: DecidingPersona = {
  traits: { ...PERSONA_TRAITS, patience: 0.95, persistence: 0.95 },
};

const PRIMARY_ACTION_AOI = 'place-order';

function fixation(screenIndex: number, tMs: number, aoiId: string | null) {
  return { screenIndex, tMs, durationMs: 250, aoiId };
}

/**
 * The tedious checkout: four screens' worth of effort on the review step that gets
 * nowhere — a scroll, a hesitation on the total, a step back, another scroll — and then,
 * thirty seconds in, the primary action on the next step, clicked.
 *
 * One trace, walked by two personas: it is the fixture the abandonment rule turns on.
 */
const TEDIOUS_CHECKOUT: SessionTrace = {
  screens: [
    { index: 0, step: 'review' },
    { index: 1, step: 'complete' },
  ],
  fixations: [
    fixation(0, 500, 'summary'),
    fixation(0, 3_000, 'fee-notice'),
    fixation(0, 9_000, 'total'),
    fixation(0, 12_000, 'fee-notice'),
    fixation(0, 18_000, 'total'),
    fixation(1, 28_000, 'summary'),
    fixation(1, 29_000, PRIMARY_ACTION_AOI),
  ],
  actions: [
    { tMs: 2_000, type: 'scroll', aoiId: null, ok: true },
    { tMs: 8_000, type: 'hesitate', aoiId: 'total', ok: true },
    { tMs: 14_000, type: 'back', aoiId: null, ok: true },
    { tMs: 20_000, type: 'scroll', aoiId: null, ok: true },
    { tMs: 30_000, type: 'click', aoiId: PRIMARY_ACTION_AOI, ok: true },
  ],
  durationMs: 31_000,
  taskCompleted: true,
  primaryActionAoiId: PRIMARY_ACTION_AOI,
};

/** The agent decided to abandon: it said so, on the review step. */
const STATED_ABANDON: SessionTrace = {
  screens: [{ index: 0, step: 'review' }],
  fixations: [fixation(0, 500, 'fee-notice'), fixation(0, 4_000, 'fee-notice')],
  actions: [
    { tMs: 2_000, type: 'scroll', aoiId: null, ok: true },
    { tMs: 6_000, type: 'abandon', aoiId: null, ok: true },
  ],
  durationMs: 7_000,
  taskCompleted: false,
  primaryActionAoiId: PRIMARY_ACTION_AOI,
};

/** The product's own failure: the primary action was there, and nobody ever looked at it. */
const PRIMARY_ACTION_NEVER_SEEN: SessionTrace = {
  screens: [{ index: 0, step: 'review' }],
  fixations: [fixation(0, 500, 'summary'), fixation(0, 2_000, 'total')],
  actions: [{ tMs: 3_000, type: 'scroll', aoiId: null, ok: true }],
  durationMs: 5_000,
  taskCompleted: false,
  primaryActionAoiId: PRIMARY_ACTION_AOI,
};

/** Our own breakage: a selector that never resolved, typed by the browser driver (#50). */
const SELECTOR_TIMEOUT: SessionTrace = {
  ...PRIMARY_ACTION_NEVER_SEEN,
  automationFailure: {
    kind: 'selector_not_found',
    detail: 'waiting for the control that completes the order never resolved',
    step: 'review',
  },
};

/** The same walk, under a per-session wall-clock cap it ran past. */
const PAST_THE_WALL_CLOCK: SessionTrace = {
  ...PRIMARY_ACTION_NEVER_SEEN,
  durationMs: 95_000,
  wallClockBudgetMs: 90_000,
};

describe('decideOutcome', () => {
  it('records a voluntary give-up as abandoned, never as a failure', () => {
    const outcome = decideOutcome(STATED_ABANDON, PERSISTENT);

    expect(outcome.status).toBe('abandoned');
    expect(outcome.status).not.toBe('failed');
    expect(outcome.status).not.toBe('automation_failure');
    expect(outcome.step).toBe('review');
    expect(outcome.reason).toContain('Gave up');
    expect(outcome).toMatchObject({ attribution: 'product', excludedFromScores: false });
  });

  it('records a selector timeout as neither abandoned nor failed', () => {
    const outcome = decideOutcome(SELECTOR_TIMEOUT, IMPATIENT);

    expect(outcome.status).toBe('automation_failure');
    expect(outcome.status).not.toBe('abandoned');
    expect(outcome.status).not.toBe('failed');
    expect(outcome.reason).toContain('never resolved');
    expect(outcome).toMatchObject({ attribution: 'automation', excludedFromScores: true });
  });

  it('records a per-session wall-clock timeout as our breakage, not the product’s', () => {
    const outcome = decideOutcome(PAST_THE_WALL_CLOCK, PERSISTENT);

    expect(outcome.status).toBe('automation_failure');
    expect(outcome).toMatchObject({ attribution: 'automation', excludedFromScores: true });
    expect(outcome.reason).toContain('wall-clock cap');

    // The cap is what changed the verdict: the same walk inside it is the product's.
    const within = decideOutcome(
      { ...PAST_THE_WALL_CLOCK, wallClockBudgetMs: 120_000 },
      PERSISTENT,
    );
    expect(within).toMatchObject({ status: 'failed', attribution: 'product' });
  });

  it('ends the task-not-done walk as failed, naming the primary action nobody saw', () => {
    const outcome = decideOutcome(PRIMARY_ACTION_NEVER_SEEN, PERSISTENT);

    expect(outcome.status).toBe('failed');
    expect(outcome.step).toBe('review');
    expect(outcome.reason).toContain(`primary action in "${PRIMARY_ACTION_AOI}" was never fixated`);
    expect(outcome).toMatchObject({ attribution: 'product', excludedFromScores: false });
  });

  it('abandons for a low-patience persona where a persistent one keeps going', () => {
    const impatient = decideOutcome(TEDIOUS_CHECKOUT, IMPATIENT);
    const persistent = decideOutcome(TEDIOUS_CHECKOUT, PERSISTENT);

    // Same trace, two people: giving up is in character, not a stopwatch.
    expect(impatient.status).toBe('abandoned');
    expect(impatient.step).toBe('review');
    expect(impatient.reason).toContain('dwell');

    expect(persistent.status).toBe('success');
    expect(persistent.step).toBe('complete');
    expect(persistent.reason).toContain('and clicked');
  });

  it('counts persistence, not only patience, when the agent gets nowhere quickly', () => {
    // Six fruitless actions in nine seconds: inside any patience budget, past a
    // low-persistence one.
    const trace: SessionTrace = {
      ...PRIMARY_ACTION_NEVER_SEEN,
      actions: [1_000, 2_500, 4_000, 5_500, 7_000, 8_500].map((tMs) => ({
        tMs,
        type: 'click' as const,
        aoiId: 'fee-notice',
        ok: false,
      })),
      durationMs: 9_000,
    };

    expect(decideOutcome(trace, IMPATIENT)).toMatchObject({
      status: 'abandoned',
      reason: expect.stringContaining('Persistence spent'),
    });
    expect(decideOutcome(trace, PERSISTENT).status).toBe('failed');
  });

  it('attributes every outcome and derives exclusion from the attribution alone', () => {
    const outcomes = allOutcomes();

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'abandoned',
      'automation_failure',
      'automation_failure',
      'failed',
      'success',
    ]);
    for (const outcome of outcomes) {
      expect(outcome.attribution).toBe(
        outcome.status === 'automation_failure' ? 'automation' : 'product',
      );
      expect(outcome.excludedFromScores).toBe(outcome.attribution === 'automation');
    }
  });

  it('names a step and a reason in the vocabulary of the flow contract', () => {
    // `docs/FLOW.md` section 8: the product's words, never an exception message.
    const vocabulary = /fixat|dwell|area of interest|primary action|revisit|step|session|browsing/i;
    const machinery = /error:|exception|undefined|\bnull\b|TypeError|\.ts:\d|stack/i;

    for (const outcome of allOutcomes()) {
      expect(outcome.step.length).toBeGreaterThan(0);
      expect(outcome.reason).toMatch(vocabulary);
      expect(outcome.reason).not.toMatch(machinery);
      expect(outcome.reason.endsWith('.')).toBe(true);
    }
  });

  it('returns the session outcome shape declared in packages/contract', () => {
    for (const outcome of allOutcomes()) {
      expect(Object.keys(outcome).sort()).toEqual([
        'attribution',
        'excludedFromScores',
        'reason',
        'status',
        'step',
      ]);
      // The closed session schema rejects a field the contract does not declare, so a
      // session carrying this outcome parsing is the shape's own check.
      expect(() =>
        sessionSchema.parse(sessionWith(PRIMARY_ACTION_NEVER_SEEN, outcome)),
      ).not.toThrow();
    }
  });
});

/** One outcome per status, plus the two ways our own browsing breaks. */
function allOutcomes(): readonly SessionOutcome[] {
  return [
    decideOutcome(TEDIOUS_CHECKOUT, PERSISTENT),
    decideOutcome(STATED_ABANDON, PERSISTENT),
    decideOutcome(PRIMARY_ACTION_NEVER_SEEN, PERSISTENT),
    decideOutcome(SELECTOR_TIMEOUT, PERSISTENT),
    decideOutcome(PAST_THE_WALL_CLOCK, PERSISTENT),
  ];
}

/** A whole session carrying a trace and an outcome, for the contract's own parser. */
function sessionWith(trace: SessionTrace, outcome: SessionOutcome): Session {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: 'S-01',
    runId: 'run',
    variant: 'A',
    taskId: 'checkout',
    kind: 'simulated',
    persona: {
      id: 'P-1',
      traits: PERSONA_TRAITS,
      device: {
        name: 'iPhone 15',
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        touch: true,
      },
    },
    participant: null,
    seed: 7,
    startedAt: '2026-10-27T10:00:00.000Z',
    durationMs: trace.durationMs,
    screens: trace.screens.map((screen) => ({
      index: screen.index,
      step: screen.step,
      screenshot: `${screen.step}.png`,
      scrollY: 0,
      intent: 'check the total before paying',
      decidedAction: 'scroll',
    })),
    fixations: trace.fixations.map((entry, index) => ({
      index,
      screenIndex: entry.screenIndex,
      tMs: entry.tMs,
      durationMs: entry.durationMs,
      x: 120,
      y: 240,
      pageX: 120,
      pageY: 240,
      aoiId: entry.aoiId,
    })),
    saccades: [],
    actions: trace.actions.map((action) => ({
      tMs: action.tMs,
      type: action.type,
      target: null,
      aoiId: action.aoiId,
      value: null,
      ok: action.ok,
    })),
    outcome,
    integrity: { selectorFailures: 0, retries: 0 },
  };
}
