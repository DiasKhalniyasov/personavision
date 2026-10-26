/**
 * The per-session caps and the counters a session artifact records.
 *
 * Two promises are held here. **A cap is a cap**: reaching the retry cap or the wall-clock
 * cap ends the session at once, as an automation failure that names which cap was hit, and
 * no later attempt silently extends it — one broken page must not stall a swarm of
 * twenty-four sessions. **The counters are the artifact's**: `selectorFailures` and
 * `retries` are what the Sessions screen and the replay's integrity card read, so they count
 * failures and retries, not operations.
 *
 * The thrown errors below are hand-built in the shape Chromium's driver really throws.
 * `failures.test.ts` is what keeps that shape honest: it drives a real browser against the
 * fixture site and reads the errors it actually raises.
 */

import { describe, expect, it } from 'vitest';
import { AutomationFailure, DEFAULT_SESSION_BUDGET, SessionBudget } from '../src/index.js';

/** A Playwright selector timeout, as `locator.waitFor` raises it. */
const selectorTimeout = (selector: string): Error => {
  const error = new Error(
    `locator.waitFor: Timeout 300ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible\n`,
  );
  error.name = 'TimeoutError';
  return error;
};

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Whatever the budget threw, as an `AutomationFailure`, or a failed assertion. */
const failureFrom = async (attempt: Promise<unknown>): Promise<AutomationFailure> => {
  const thrown = await attempt.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof AutomationFailure)) {
    throw new Error(`expected an AutomationFailure, got ${String(thrown)}`);
  }
  return thrown;
};

describe('a session budget', () => {
  it('has sane defaults, and resolves the limits it was given', () => {
    expect(DEFAULT_SESSION_BUDGET.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_BUDGET.wallClockMs).toBeGreaterThan(0);
    expect(new SessionBudget().limits).toEqual(DEFAULT_SESSION_BUDGET);
    expect(new SessionBudget({ maxRetries: 5 }).limits).toEqual({
      maxRetries: 5,
      wallClockMs: DEFAULT_SESSION_BUDGET.wallClockMs,
    });
  });

  it('runs an operation that works once, and counts one attempt', async () => {
    const budget = new SessionBudget({ maxRetries: 2, wallClockMs: 1000 });
    let runs = 0;

    await expect(
      budget.attempt(async () => {
        runs += 1;
        return 'done';
      }, 'opening the cart'),
    ).resolves.toBe('done');

    expect(runs).toBe(1);
    expect(budget.integrity()).toMatchObject({
      attempts: 1,
      retries: 0,
      selectorFailures: 0,
      exhausted: false,
    });
    expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 0, retries: 0 });
  });

  it('retries a failure of ours, and counts the retry and the selector failure', async () => {
    const budget = new SessionBudget({ maxRetries: 2, wallClockMs: 1000 });
    let runs = 0;

    await expect(
      budget.attempt(async () => {
        runs += 1;
        if (runs === 1) throw selectorTimeout('#cart-checkout');
        return 'done';
      }, 'waiting for the cart checkout link'),
    ).resolves.toBe('done');

    expect(runs).toBe(2);
    // The shape the example run records for a session that recovered: one selector failure,
    // one retry — counted per failure, not per operation.
    expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 1, retries: 1 });
    expect(budget.integrity()).toMatchObject({ attempts: 2, exhausted: false });
  });

  it('ends the session when the retry cap is reached, naming that cap', async () => {
    const budget = new SessionBudget({ maxRetries: 1, wallClockMs: 1000 });
    let runs = 0;

    const failure = await failureFrom(
      budget.attempt(async () => {
        runs += 1;
        throw selectorTimeout('#cart-checkout');
      }, 'waiting for the cart checkout link'),
    );

    expect(runs).toBe(2);
    expect(failure.reason).toBe('selector_not_found');
    expect(failure.message).toContain('retry cap');
    expect(failure.message).toContain('waiting for the cart checkout link');
    expect(budget.integrity()).toMatchObject({ attempts: 2, retries: 1, exhausted: true });
    expect(budget.sessionIntegrity()).toEqual({ selectorFailures: 2, retries: 1 });
  });

  it('ends the session when the wall-clock cap is reached, naming that cap', async () => {
    const budget = new SessionBudget({ maxRetries: 4, wallClockMs: 60 });

    const failure = await failureFrom(
      budget.attempt(async () => {
        await delay(400);
        return 'a page that answered far too late';
      }, 'waiting for the review step'),
    );

    expect(failure.reason).toBe('timeout');
    expect(failure.message).toContain('wall-clock cap');
    expect(failure.message).toContain('waiting for the review step');
    expect(budget.integrity().exhausted).toBe(true);
  });

  it('never extends a cap once it has been reached', async () => {
    const budget = new SessionBudget({ maxRetries: 0, wallClockMs: 1000 });

    await failureFrom(
      budget.attempt(async () => {
        throw selectorTimeout('#cart-checkout');
      }, 'waiting for the cart checkout link'),
    );
    expect(budget.integrity().exhausted).toBe(true);

    let ranAgain = false;
    const second = await failureFrom(
      budget.attempt(async () => {
        ranAgain = true;
        return 'a page that was never asked';
      }, 'opening the payment step'),
    );

    expect(ranAgain).toBe(false);
    expect(second.message).toContain('retry cap');
    expect(budget.integrity().attempts).toBe(1);
  });

  it('refuses the first attempt when the wall clock is already spent', async () => {
    const budget = new SessionBudget({ maxRetries: 2, wallClockMs: 20 });
    await delay(60);

    let ran = false;
    const failure = await failureFrom(
      budget.attempt(async () => {
        ran = true;
        return 'a page that was never opened';
      }, 'opening the cart'),
    );

    expect(ran).toBe(false);
    expect(failure.reason).toBe('timeout');
    expect(failure.message).toContain('wall-clock cap');
    expect(budget.integrity()).toMatchObject({ attempts: 0, exhausted: true });
  });

  it('counts down the wall clock it has left, which is what a page operation is given', () => {
    const budget = new SessionBudget({ wallClockMs: 500 });
    expect(budget.remainingMs()).toBeGreaterThan(0);
    expect(budget.remainingMs()).toBeLessThanOrEqual(500);
  });

  it('rethrows an error that is not ours, rather than retrying a mystery', async () => {
    const budget = new SessionBudget({ maxRetries: 3, wallClockMs: 1000 });
    const theirs = new Error('the shop declined the card');
    let runs = 0;

    await expect(
      budget.attempt(async () => {
        runs += 1;
        throw theirs;
      }, 'submitting the payment form'),
    ).rejects.toBe(theirs);

    expect(runs).toBe(1);
    expect(budget.integrity()).toMatchObject({ attempts: 1, retries: 0, exhausted: false });
  });
});
