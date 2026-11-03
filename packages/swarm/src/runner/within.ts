/**
 * A cap on something that cannot be cancelled: race it, and say which won.
 *
 * Shared by both runners, because both have work that may never answer and neither may wait
 * on it for ever — a session that hangs where no budget inside it reaches, and a remote
 * session's output that never comes back. The work is **not** stopped; a caller that can stop
 * it does so itself once this says the cap won, which is what the Cloud Run runner's cancel is.
 */

/** The cap won: the work is still running, and nobody is waiting for it any more. */
export const EXPIRED = Symbol('the work passed its cap');

export const withinTimeout = async <T>(
  work: Promise<T>,
  withinMs: number,
): Promise<T | typeof EXPIRED> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof EXPIRED>([
      work,
      new Promise<typeof EXPIRED>((settle) => {
        timer = setTimeout(() => settle(EXPIRED), withinMs);
      }),
    ]);
  } finally {
    // Left behind, the timer keeps the process alive for the length of the cap — twenty-four
    // sessions of a replaying run would hold a minute of timers for a run that took a second.
    clearTimeout(timer);
  }
};
