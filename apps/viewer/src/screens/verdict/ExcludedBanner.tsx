import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import type { OutcomeStatus } from '@/session';
import { paths } from '@/shell/paths';
import { useExcluded } from '@/shell/useRun';
import styles from './excludedBanner.module.css';

/**
 * The banner naming the people whose session ended because our own automation broke, and
 * saying plainly that they are excluded from both figures: the `.notice` of `#screen-verdict`.
 *
 * A business decision-maker has no way of knowing that a selector timeout is our problem
 * and not their checkout's unless the product says so, which is why this sits above the
 * headline rather than in a footnote (`docs/FLOW.md` section 5).
 *
 * Who is excluded is **read, never re-derived**: `useExcluded` counts the sessions that
 * carry the stored `excludedFromScores` and `attribution` fields, and this file formats
 * that count.
 */

/**
 * The Sessions screen's outcome filter, and the value that lists these people and no one
 * else. The parameter is one of the contract's evidence-link parameters and the value is an
 * `outcomeStatusSchema` member, so the link cannot drift from the screen it opens.
 */
const OUTCOME_PARAM = 'outcome';
const AUTOMATION_FAILURE: OutcomeStatus = 'automation_failure';

/** The Sessions route, filtered to the people this banner is about. */
const excludedSessionsPath = (runId: string): string =>
  `${paths.sessions(runId)}?${new URLSearchParams({ [OUTCOME_PARAM]: AUTOMATION_FAILURE }).toString()}`;

export function ExcludedBanner({ run }: { run: Run }) {
  const state = useExcluded(run);

  if (state.status === 'loading') {
    // The banner's own height, held while the sessions are read, so that the headline below
    // it does not move when the count arrives.
    return (
      <div data-section="excluded-banner" data-state="loading" aria-hidden="true">
        <Skeleton className={styles.reserved} />
      </div>
    );
  }

  // A run whose sessions cannot be read is the shell's state to render, not this banner's:
  // it says nothing rather than naming a count it does not have. A run that excluded nobody
  // renders no banner at all, not an empty one.
  if (state.status === 'unreadable' || state.people.length === 0) return null;

  const { people } = state;
  const reasons = new Set(people.map((person) => person.reason));
  // What broke, in the pipeline's words, when every one of these sessions ended the same way.
  const cause = reasons.size === 1 ? [...reasons][0] : null;

  return (
    <div className="notice" data-section="excluded-banner">
      <span>
        {people.length} of the {run.sessionIds.length} people could not be simulated to the end: our
        own browser automation broke{cause === null ? '' : ` (${cause})`}. They are{' '}
        <b>excluded from both figures</b> and are not counted against either version.{' '}
        <Link to={excludedSessionsPath(run.runId)}>
          {people.length === 1 ? 'See that person' : `See those ${people.length}`}
        </Link>
        .
      </span>
    </div>
  );
}
