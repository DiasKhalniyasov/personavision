/**
 * The per-session cap on retries and wall-clock time.
 *
 * One broken page must not stall a swarm of twenty-four sessions, so every attempt at a
 * page operation goes through a budget that can refuse to try again, and what it spent is
 * reported so that a session's artifact can say how hard we worked before giving up.
 *
 * **A cap ends the session.** Reaching the retry cap or the wall-clock cap raises an
 * `AutomationFailure` naming which cap was hit, and marks the budget exhausted: every later
 * attempt is refused without running, so a cap can never be silently extended by a caller
 * that keeps asking. The wall clock is enforced *during* an attempt as well as before one —
 * an operation handed no timeout of its own would otherwise hang past the cap, which is the
 * exact failure the cap exists for.
 *
 * **The counters are the artifact's.** `selectorFailures` and `retries` are the two fields
 * `@personavision/contract`'s session schema declares under `integrity`, and the Sessions
 * screen and the replay's integrity card read them. They count *failures and retries*, not
 * operations: an operation that failed on a selector once and then worked records one
 * selector failure and one retry.
 *
 * Only a failure of ours is retried. An error this module cannot place is rethrown
 * untouched on its first appearance (`mapToAutomationFailure`), because retrying a mystery
 * spends the session's wall clock on it and still records nothing true.
 */

import { AutomationFailure } from './errors.js';
import { toAutomationFailure } from './failure-mapping.js';

export interface SessionBudgetLimits {
  /** How many further attempts one operation may make after its first. */
  readonly maxRetries?: number;
  /** How long the whole session may take, in milliseconds. */
  readonly wallClockMs?: number;
}

/**
 * The caps a session runs under when it names none of its own: two retries per operation,
 * and a minute of wall clock. Both are per session, and a swarm of twenty-four sessions is
 * why they are this small — a broken variant costs a minute, not an afternoon.
 */
export const DEFAULT_SESSION_BUDGET: Required<SessionBudgetLimits> = {
  maxRetries: 2,
  wallClockMs: 60_000,
};

/** What a session spent — the retry count a session artifact records. */
export interface BudgetIntegrity {
  readonly attempts: number;
  readonly retries: number;
  /** Selector failures, counted once per failure rather than once per operation. */
  readonly selectorFailures: number;
  readonly elapsedMs: number;
  /** `true` once a cap has been reached and no further attempt will be made. */
  readonly exhausted: boolean;
}

/** The two counters the session artifact's `integrity` holds, and nothing else. */
export interface SessionIntegrity {
  readonly selectorFailures: number;
  readonly retries: number;
}

/** Which cap ended the session, in the words its reason uses. */
const CAP_NAMES = {
  retry: 'retry cap',
  wallClock: 'wall-clock cap',
} as const;

type Settled<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'expired' };

/**
 * Runs an operation against what is left of the wall clock. The operation is not cancelled
 * when the clock wins — nothing here can cancel a page operation — but its result is no
 * longer waited for, and its rejection is already handled, so it cannot surface later as an
 * unhandled one.
 */
const raceWallClock = async <T>(fn: () => Promise<T>, withinMs: number): Promise<Settled<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<Settled<T>>([
      fn().then(
        (value) => ({ kind: 'value', value }) as const,
        (error: unknown) => ({ kind: 'error', error }) as const,
      ),
      new Promise<Settled<T>>((settle) => {
        timer = setTimeout(() => settle({ kind: 'expired' }), withinMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class SessionBudget {
  /** The caps in force, with the defaults resolved: what the session actually runs under. */
  readonly limits: Required<SessionBudgetLimits>;

  readonly #startedAt = Date.now();
  #attempts = 0;
  #retries = 0;
  #selectorFailures = 0;
  /** The failure that ended the session, which every later attempt is refused with. */
  #spent: AutomationFailure | null = null;

  constructor(limits: SessionBudgetLimits = {}) {
    this.limits = {
      maxRetries: limits.maxRetries ?? DEFAULT_SESSION_BUDGET.maxRetries,
      wallClockMs: limits.wallClockMs ?? DEFAULT_SESSION_BUDGET.wallClockMs,
    };
  }

  /**
   * How much wall clock the session has left, in milliseconds. This is what a caller hands
   * a page operation as its own timeout, so that one operation cannot outlive the session.
   */
  remainingMs(): number {
    return Math.max(0, this.limits.wallClockMs - (Date.now() - this.#startedAt));
  }

  /**
   * Runs one page operation under the budget, retrying a failure of ours up to the retry
   * cap. `attempting` is what the operation was trying to do, and it is what a person reads
   * on the session that failed, so it names a thing on a page rather than a function.
   */
  async attempt<T>(fn: () => Promise<T>, attempting = 'a page operation'): Promise<T> {
    if (this.#spent !== null) throw this.#refuse(attempting);

    let retriesLeft = this.limits.maxRetries;
    let last: AutomationFailure | null = null;

    for (;;) {
      const remaining = this.remainingMs();
      if (remaining === 0) throw this.#endOn('wallClock', attempting, last);

      this.#attempts += 1;
      const settled = await raceWallClock(fn, remaining);

      if (settled.kind === 'value') return settled.value;
      if (settled.kind === 'expired') throw this.#endOn('wallClock', attempting, last);

      const failure = toAutomationFailure(settled.error, attempting);
      // Not ours to classify, so not ours to retry: the caller sees what really happened.
      if (failure === null) throw settled.error;

      if (failure.reason === 'selector_not_found') this.#selectorFailures += 1;
      last = failure;

      if (retriesLeft === 0) throw this.#endOn('retry', attempting, failure);
      retriesLeft -= 1;
      this.#retries += 1;
    }
  }

  /** What has been spent so far. */
  integrity(): BudgetIntegrity {
    return {
      attempts: this.#attempts,
      retries: this.#retries,
      selectorFailures: this.#selectorFailures,
      elapsedMs: Date.now() - this.#startedAt,
      exhausted: this.#spent !== null,
    };
  }

  /** The two counters a session artifact records under `integrity`. */
  sessionIntegrity(): SessionIntegrity {
    return { selectorFailures: this.#selectorFailures, retries: this.#retries };
  }

  /**
   * Ends the session on a cap. The reason names the cap that was hit and keeps the failure
   * that led there as its cause, so a session artifact says both what broke and that we
   * stopped trying rather than that the page recovered.
   */
  #endOn(
    cap: keyof typeof CAP_NAMES,
    attempting: string,
    last: AutomationFailure | null,
  ): AutomationFailure {
    const spent =
      cap === 'retry'
        ? `the ${CAP_NAMES.retry} of ${this.limits.maxRetries} was reached`
        : `the ${CAP_NAMES.wallClock} of ${this.limits.wallClockMs}ms was reached`;
    const because = last === null ? '' : ` — ${last.message}`;

    // A wall clock that ran out is the session timing out, whatever last broke; a retry cap
    // reached is the failure we kept hitting, named as itself.
    const reason = cap === 'retry' && last !== null ? last.reason : 'timeout';

    this.#spent = new AutomationFailure(reason, `${attempting}: ${spent}${because}`, {
      cause: last ?? undefined,
    });
    return this.#spent;
  }

  /** A caller that keeps asking after a cap gets the same failure, never another attempt. */
  #refuse(attempting: string): AutomationFailure {
    const spent = this.#spent;
    if (spent === null) throw new Error('the budget is not spent');
    return new AutomationFailure(spent.reason, `${attempting}: ${spent.message}`, {
      cause: spent,
    });
  }
}
