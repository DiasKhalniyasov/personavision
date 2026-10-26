/**
 * The per-session cap on retries and wall-clock time.
 *
 * One broken page must not stall a swarm of twenty-four sessions, so every attempt at a
 * page operation goes through a budget that can refuse to try again, and what it spent is
 * reported so that a session's artifact can say how hard we worked before giving up.
 *
 * **Neutral seam.** The budget runs what it is given, once, and caps nothing; its counters
 * are zero. A capture therefore behaves exactly as it would with an unexhausted budget,
 * which is what lets the rest of the module be tested before this lands. The budget ticket
 * of this step fills this file and no other.
 */

export interface SessionBudgetLimits {
  /** How many further attempts one operation may make after its first. */
  readonly maxRetries?: number;
  /** How long the whole session may take, in milliseconds. */
  readonly wallClockMs?: number;
}

/** What a session spent — the retry count a session artifact records. */
export interface BudgetIntegrity {
  readonly attempts: number;
  readonly retries: number;
  readonly elapsedMs: number;
  /** `true` once a cap has been reached and no further attempt will be made. */
  readonly exhausted: boolean;
}

const ZERO_INTEGRITY: BudgetIntegrity = {
  attempts: 0,
  retries: 0,
  elapsedMs: 0,
  exhausted: false,
};

export class SessionBudget {
  readonly limits: SessionBudgetLimits;

  constructor(limits: SessionBudgetLimits = {}) {
    this.limits = limits;
  }

  /** Runs one page operation under the budget. Neutral: runs it once, caps nothing. */
  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** What has been spent so far. Neutral: zero, because nothing is counted yet. */
  integrity(): BudgetIntegrity {
    return ZERO_INTEGRITY;
  }
}
