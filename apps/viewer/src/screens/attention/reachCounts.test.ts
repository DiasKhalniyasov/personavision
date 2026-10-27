import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { reachCounts } from './reachCounts';

/**
 * The filmstrip's counts over the repository's own example-run fixture: 24 session files on
 * disk, two versions, one session per version lost to our own automation.
 *
 * These are the numbers a designer reads above the heatmaps, so what they are worth is
 * whether they come from the right population — this version, scored only — and whether a
 * step nobody reached still gets a row that says so.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
/**
 * The hand-authored example run under `tests/fixtures/runs/`, not the committed artifact
 * under `runs/`: same id, same schema, and numbers fixed by hand rather than whatever the
 * engine measured over the demo shop on the day (#78). The counts below are a claim about
 * this screen, so they need data that does not move when the shop or the engine does.
 */
const runsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../tests/fixtures/runs',
);
const layout = runPaths('');

const read = (file: string): unknown =>
  JSON.parse(readFileSync(join(runsRoot, RUN_ID, file), 'utf8'));

const seedRun = (): Run => runSchema.parse(read(layout.run));

/** Every session file of the committed run, parsed by the contract that declares them. */
const seedSessions = (run: Run): Session[] =>
  run.sessionIds.map((sessionId) => sessionSchema.parse(read(layout.session(sessionId))));

const run = seedRun();
const sessions = seedSessions(run);

const counted = (variant: string): Record<string, number> =>
  Object.fromEntries(
    reachCounts(run.steps, sessions, variant).map(({ step, reached }) => [step.id, reached]),
  );

describe('the counts over the committed example run', () => {
  it('gives one row per step of the artifact, in the artifact’s order', () => {
    const rows = reachCounts(run.steps, sessions, 'A');

    expect(rows.map(({ step }) => step.id)).toEqual(['cart', 'payment', 'review', 'confirm']);
    expect(rows.map(({ step }) => step.label)).toEqual([
      'Cart',
      'Payment',
      'Review',
      'Confirmation',
    ]);
  });

  it('counts the current checkout’s audience thinning out step by step', () => {
    expect(counted('A')).toEqual({ cart: 11, payment: 9, review: 9, confirm: 9 });
  });

  it('counts the redesign’s audience, where almost nobody confirms', () => {
    // The finding the whole run exists to show: ten of eleven people reach payment on the
    // redesign and two of them ever confirm.
    expect(counted('B')).toEqual({ cart: 11, payment: 10, review: 9, confirm: 2 });
  });

  it('leaves out the sessions our own automation broke', () => {
    const onA = sessions.filter((session) => session.variant === 'A');
    const broken = onA.filter((session) => session.outcome.excludedFromScores);

    // Twelve people were sent to this version and one of them is excluded, so a count of
    // twelve on the first step would be the pipeline's exclusion quietly undone here.
    expect(onA).toHaveLength(12);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.outcome.status).toBe('automation_failure');
    expect(counted('A').cart).toBe(onA.length - broken.length);
    expect(counted('A').cart).toBe(
      run.scores.find((score) => score.variant === 'A' && score.taskId === run.task.id)
        ?.scoredSessionCount,
    );
  });

  it('counts only the version asked for', () => {
    // The two versions differ on the last step, so a count that pooled them would read 11.
    expect(counted('A').confirm + counted('B').confirm).toBe(11);
    expect(counted('A').confirm).toBe(9);
  });

  it('counts a session once, however many screens of the step it stood on', () => {
    // Somebody who went back to the cart and out again has two cart screens; the strip
    // counts people, so they are one person who got that far rather than two.
    const first = sessions.find(
      (session) => session.variant === 'B' && !session.outcome.excludedFromScores,
    ) as Session;
    const wentBack: Session = {
      ...first,
      screens: [...first.screens, ...first.screens.filter((screen) => screen.step === 'cart')],
    };

    expect(wentBack.screens.filter((screen) => screen.step === 'cart').length).toBeGreaterThan(1);
    expect(reachCounts(run.steps, [wentBack], 'B')[0]?.reached).toBe(1);
  });
});

describe('a step nobody reached', () => {
  it('keeps its row and reads zero', () => {
    const neverSeen = sessions.map((session) => ({
      ...session,
      screens: session.screens.filter((screen) => screen.step !== 'confirm'),
    }));

    const rows = reachCounts(run.steps, neverSeen, 'B');

    expect(rows.map(({ step }) => step.id)).toContain('confirm');
    expect(rows.find(({ step }) => step.id === 'confirm')?.reached).toBe(0);
  });

  it('reads zero for a step of the plan no session has a screen for', () => {
    const withExtra: Run['steps'] = [...run.steps, { id: 'thanks', label: 'Thank you' }];

    expect(reachCounts(withExtra, sessions, 'B').at(-1)).toEqual({
      step: { id: 'thanks', label: 'Thank you' },
      reached: 0,
    });
  });
});
