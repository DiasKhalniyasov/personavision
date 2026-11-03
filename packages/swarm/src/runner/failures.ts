/**
 * What a remote execution did instead of running a session, read as one of **our existing**
 * automation failures.
 *
 * A failed execution is a typed automation failure and not a lost run: it counts towards the
 * run's own automation-failure total, the rule that a run whose failures are more than a
 * fifth of its sessions says so above its summary holds unchanged, and the other
 * ninety-nine sessions are untouched.
 *
 * **No new kind is invented**, for the reason `run-swarm.ts` already gives for a session that
 * threw: `AUTOMATION_FAILURE_KINDS` is the vocabulary `docs/FLOW.md` section 8 is written
 * against, and a sixth word there that only one runner ever produces would be a word the
 * screens, the scores and the counters have no reading for. So:
 *
 * - an execution that outstayed the session's wall-clock cap is `wall_clock_timeout`, which
 *   is exactly what it is and is the kind the swarm's own race already uses;
 * - everything else — a task that died, a quota that refused us, an image that would not
 *   start, an execution that reported success and left no session behind — is
 *   `navigation_error`, the kind this repository already records "our breakage we cannot
 *   place" as.
 *
 * **The kind is never the record.** What a person reads is `detail`, and every sentence below
 * carries *what was asked* and *what was answered*: the job, the image and the session on one
 * side, the API's own status and words on the other. That is the whole point of the mapping —
 * a quota refusal and an unstartable image are the same kind and are never the same sentence.
 */

import type { AutomationFailure, AutomationFailureKind } from '../outcome.js';

/** What we asked for, as every sentence below names it. */
export interface Asked {
  /** `projects/<project>/locations/<region>/jobs/<job>`. */
  readonly job: string;
  /** The image the job runs, tag included. */
  readonly image: string;
  readonly sessionId: string;
}

/** What came back, as the Jobs API put it. */
export interface Answered {
  /** The API's own status word, or `''` when it named none. */
  readonly status: string;
  /** What it said, verbatim. */
  readonly said: string;
}

/**
 * Which of the four things that go wrong with an execution this is. They are told apart from
 * the API's own status and words, which is all a caller gets.
 */
export type RemoteBreakage =
  'quota_refused' | 'image_unstartable' | 'task_died' | 'nothing_landed' | 'past_the_cap';

/** The statuses Google answers a quota or rate limit with. */
const QUOTA_STATUS = new Set(['RESOURCE_EXHAUSTED', 'HTTP_429', 'QUOTA_EXCEEDED']);

/** What a quota refusal says when it does not say it in the status. */
const QUOTA_WORDS = /quota|rate limit|exceeded the maximum number|too many requests/i;

/**
 * What Cloud Run says about an image it could not run: a tag that is not in the registry, a
 * registry that will not serve it to this service account, or a container that exited before
 * it listened. All three are "the image does not start here", and all three are fixed by
 * building and pushing the image again rather than by re-running the session.
 */
const IMAGE_WORDS =
  /image .*not found|manifest unknown|denied: |permission .*(?:artifactregistry|registry)|failed to (?:start|pull)|unable to (?:pull|retrieve) image|no such image|exec format error|ImagePull/i;

export const readBreakage = ({ status, said }: Answered): RemoteBreakage => {
  if (QUOTA_STATUS.has(status) || QUOTA_WORDS.test(said)) return 'quota_refused';
  if (IMAGE_WORDS.test(said)) return 'image_unstartable';
  return 'task_died';
};

/** The kind each breakage is recorded as, and why, is in this module's own note. */
const KIND: Record<RemoteBreakage, AutomationFailureKind> = {
  quota_refused: 'navigation_error',
  image_unstartable: 'navigation_error',
  task_died: 'navigation_error',
  nothing_landed: 'navigation_error',
  past_the_cap: 'wall_clock_timeout',
};

const SENTENCE: Record<RemoteBreakage, (asked: Asked, answered: Answered) => string> = {
  quota_refused: (asked, answered) =>
    `asked ${asked.job} to run ${asked.sessionId}; the Jobs API refused on quota (${answered.status}): ${answered.said}`,
  image_unstartable: (asked, answered) =>
    `asked ${asked.job} to run ${asked.sessionId} from ${asked.image}; the image would not start (${answered.status}): ${answered.said}`,
  task_died: (asked, answered) =>
    `asked ${asked.job} to run ${asked.sessionId} from ${asked.image}; the task did not finish (${answered.status}): ${answered.said}`,
  nothing_landed: (asked, answered) =>
    `asked ${asked.job} to run ${asked.sessionId} from ${asked.image}; the execution reported success and left no session behind: ${answered.said}`,
  past_the_cap: (asked, answered) =>
    `asked ${asked.job} to run ${asked.sessionId} from ${asked.image}; it was still running at its cap, so it was cancelled: ${answered.said}`,
};

/**
 * The typed failure, with the step the session had reached — which for a remote session is
 * whatever the task managed to write, or `start` when it never wrote anything at all.
 */
export const remoteFailure = (
  breakage: RemoteBreakage,
  asked: Asked,
  answered: Answered,
  step: string,
): AutomationFailure => ({
  kind: KIND[breakage],
  detail: SENTENCE[breakage](asked, {
    status: answered.status === '' ? 'no status' : answered.status,
    said: answered.said,
  }),
  step,
});
