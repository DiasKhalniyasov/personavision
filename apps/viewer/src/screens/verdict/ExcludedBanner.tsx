import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import type { OutcomeStatus } from '@/session';
import { sessionsWithOutcome } from '@/shell/paths';
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
 * carry the stored `excludedFromScores` and `attribution` fields, and this file words that
 * count. The words are the user's, as `docs/FLOW.md` section 8 asks of this screen: the
 * step a session stopped on is named by the label the run gives it, and the reason the
 * pipeline stored is left for the People screen one click deeper.
 */

/** The outcome that lists these people on the Sessions screen. */
const AUTOMATION_FAILURE: OutcomeStatus = 'automation_failure';

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
  // Where it broke, named as the reader's own step, when every one of these sessions
  // stopped in the same place and the run plans that step. A session may end somewhere the
  // run never planned to go, and an id is not a word a reader knows.
  const steps = new Set(people.map((person) => person.step));
  const step = steps.size === 1 ? [...steps][0] : undefined;
  const label = run.steps.find((candidate) => candidate.id === step)?.label ?? null;

  return (
    <div className="notice" data-section="excluded-banner">
      <span>
        {people.length} of the {run.sessionIds.length} people could not be simulated to the end: our
        own browser automation broke{label === null ? '' : ` on the ${label} step`}. They are{' '}
        <b>excluded from both figures</b> and are not counted against either version.{' '}
        <Link to={sessionsWithOutcome(run.runId, AUTOMATION_FAILURE)}>
          {people.length === 1 ? 'See that person' : `See those ${people.length}`}
        </Link>
        .
      </span>
    </div>
  );
}
