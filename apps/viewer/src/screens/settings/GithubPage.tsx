import { Link } from 'react-router';
import { newTestStep } from '@/shell/paths';
import { useGithubConnection } from './connection';
import type { GithubConnectionState } from './connection';
import {
  APP_NOT_REGISTERED,
  APP_NOT_REGISTERED_NEXT,
  CONNECT_REASON,
  CONNECTION_UNREADABLE,
  COUNTS_AS_VERIFICATION,
} from './words';
import styles from './settings.module.css';

/**
 * `/settings/github` — **where would the pull request go?**
 *
 * The one question `docs/FLOW.md` section 13 gives this screen, and the way in to path 2 of
 * section 11, which is shown and locked until a repository is connected. The prototype does
 * not draw it: it is a plain `.wrap-narrow` page in the same frame, which #271 states as a
 * deliberate addition rather than a departure.
 *
 * It is the **entry point and nothing more**. What connecting is, what the app would be
 * allowed to do, that it never merges, and what a connection is worth beyond this path — and
 * then where this workspace stands. The installation, the repository and the pull request
 * itself are path 2's own step.
 *
 * While the GitHub App is not registered the screen says exactly that and offers **no
 * button that leads nowhere**. That the App is not registered is the platform's answer, from
 * its own environment, never a flag on this screen.
 */
export function GithubPage() {
  const connection = useGithubConnection();

  return (
    <div className="strip strip-sm">
      <div className="wrap-narrow">
        <div className="pagehead">
          <h1>Where would the pull request go?</h1>
        </div>
        <p className="lede">{CONNECT_REASON}</p>

        <Standing connection={connection} />

        <div className="card card-lg">
          <h2>What PersonaVision would be allowed to do</h2>
          <ul className={styles.allowed}>
            <li>
              <b>One repository</b> — the one you install the app on, and no other.
            </li>
            <li>Read that repository, and open and update pull requests on it.</li>
            <li>
              <b>It never merges anything.</b> You merge.
            </li>
          </ul>
          <p className="footnote">{COUNTS_AS_VERIFICATION}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Where this workspace stands, in one box in every state, so the answer to *can I connect?*
 * is in the same place before and after it is read.
 *
 * A state that could not be read says so and carries what the platform answered: a reader
 * of a failure is told what failed, which is this product's rule for every other check.
 */
function Standing({ connection }: { connection: GithubConnectionState }) {
  return (
    <div className="notice info" role="status">
      {connection.status === 'loading' ? (
        <span>Checking whether this workspace has a connected repository&hellip;</span>
      ) : connection.status === 'unregistered' ? (
        <span>
          {APP_NOT_REGISTERED} {APP_NOT_REGISTERED_NEXT}{' '}
          <Link to={newTestStep('path')}>Start a test</Link>.
        </span>
      ) : connection.status === 'disconnected' ? (
        <span>
          No repository is connected to this workspace yet. When the app is installed on one, it is
          named here.
        </span>
      ) : connection.status === 'connected' ? (
        <span>
          Connected to <b>{connection.repository}</b>. Pull requests go there, and the site that
          repository deploys counts as verified.
        </span>
      ) : (
        <span>
          {CONNECTION_UNREADABLE} {connection.problem}
        </span>
      )}
    </div>
  );
}
