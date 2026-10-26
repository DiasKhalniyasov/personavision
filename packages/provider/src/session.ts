import type {
  Decision,
  DecisionContext,
  DecisionSession,
  DecisionSessionIdentity,
} from './types.js';

/**
 * The handle one agent session decides through, and the one guarantee no provider should
 * have to re-implement: a session that has ended decides nothing further.
 *
 * `createDecisionSession` is the body of `beginSession` for every provider. It takes the
 * session's identity, what the session decides and what ending it releases, and it owns the
 * closing: the guard runs **before** the provider's own `decide` body, so a decision asked
 * of a closed session never reaches the conversation, the request builder or the trajectory
 * sink — it is refused, and nothing is written after the end. A provider that wrote its own
 * handle could put that check after the first `await` and leave a line in a file whose
 * session is over; the contract suite catches it, and this helper means there is no reason
 * to be caught.
 *
 * What it deliberately does not do is hold the session's state. The conversation, the cache
 * key and the file handle are the provider's own business and stay in the closure the
 * provider passes in — this module knows only that a session begins, decides and ends.
 */

/**
 * Thrown when a decision is asked of a session that has already ended.
 *
 * It names the session, because a swarm runs many at once and "the session is closed" is of
 * no use to the run that has to find out which one.
 */
export class DecisionSessionClosedError extends Error {
  readonly personaId: string;
  readonly seed: number;

  constructor(identity: DecisionSessionIdentity) {
    super(
      `the decision session for persona ${identity.personaId} on seed ${identity.seed} has been closed, so it decides nothing further`,
    );
    this.name = 'DecisionSessionClosedError';
    this.personaId = identity.personaId;
    this.seed = identity.seed;
  }
}

export interface DecisionSessionOptions extends DecisionSessionIdentity {
  /** What this session decides, over whatever state the provider keeps for it. */
  decide(context: DecisionContext): Promise<Decision>;
  /**
   * What ending the session releases — a trajectory sink to flush and close (#139), a
   * conversation to drop. Called once however often `close` is. Absent for a provider that
   * holds nothing, which is the offline policy.
   */
  close?(): Promise<void> | void;
}

export const createDecisionSession = (options: DecisionSessionOptions): DecisionSession => {
  const identity: DecisionSessionIdentity = {
    personaId: options.personaId,
    seed: options.seed,
  };
  let closed = false;

  return {
    ...identity,
    decide: (context) =>
      closed ? Promise.reject(new DecisionSessionClosedError(identity)) : options.decide(context),
    close: async () => {
      if (closed) return;
      // Flipped before anything is awaited, so a decision that arrives while the sink is
      // still flushing is refused rather than appended after the end.
      closed = true;
      await options.close?.();
    },
  };
};
