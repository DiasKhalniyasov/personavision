import type {
  Decision,
  DecisionContext,
  DecisionSession,
  DecisionSessionIdentity,
} from './types.js';

/**
 * The handle one agent session decides through, and the guarantees no provider should have
 * to re-implement around the end of a session.
 *
 * `createDecisionSession` is the body of `beginSession` for every provider. It takes the
 * session's identity, what the session decides and what ending it releases, and it owns the
 * closing — three things that are easy to get subtly wrong and expensive to get wrong,
 * because what a session holds is an append-only file (#139):
 *
 * 1. **A decision asked for after `close` never reaches the provider's body.** The refusal
 *    happens before `options.decide` is called, so it cannot reach a conversation, a
 *    request builder or a trajectory sink: nothing is written, rather than one more line
 *    after the end.
 * 2. **A decision already in flight is the session's last, and `close` waits for it.** The
 *    sink is shut once that turn has settled, so a flush never races the line it is meant
 *    to contain. Whether that turn succeeded is the caller's business; it is not a reason
 *    to leave the sink open.
 * 3. **`close` releases exactly once, and every caller waits for the same release.** An
 *    overlapping `close` resolves when the flush does rather than straight away, and a
 *    flush that failed is reported to every caller instead of becoming a quiet success on
 *    the second attempt.
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
   * conversation to drop. Called once however often `close` is, and only once every turn
   * still in flight has settled. Absent for a provider that holds nothing, which is the
   * offline policy.
   */
  close?(): Promise<void> | void;
}

export const createDecisionSession = (options: DecisionSessionOptions): DecisionSession => {
  const identity: DecisionSessionIdentity = {
    personaId: options.personaId,
    seed: options.seed,
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  const inFlight = new Set<Promise<Decision>>();

  const release = async (): Promise<void> => {
    // Flipped before anything is awaited, so a turn that arrives while the sink is still
    // flushing is refused rather than appended behind it.
    closed = true;
    // `allSettled`, not `all`: a last turn that failed still has to be out of the way
    // before the sink is shut, and its rejection belongs to whoever asked for it.
    await Promise.allSettled([...inFlight]);
    await options.close?.();
  };

  return {
    ...identity,
    // `async`, so that a provider body which throws synchronously — a request it cannot
    // build, a context it rejects — comes back as a rejected promise rather than throwing
    // out of the caller's `.map()` and stranding its sibling sessions' promises.
    decide: async (context) => {
      if (closed) throw new DecisionSessionClosedError(identity);

      const pending = options.decide(context);
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
    close: () => (closing ??= release()),
  };
};
