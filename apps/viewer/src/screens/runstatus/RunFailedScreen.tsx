import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';
import { engineFailureNotice } from './engine';
import './RunFailedScreen.css';

/**
 * `/runs/:runId` for a test that failed to start — `#screen-error` of
 * `docs/design/prototype.html`: what could not be opened, that nobody was simulated, the
 * captured detail, the things to check, and the three ways on.
 *
 * The reason and the detail are the artifact's `failure` block, shown as the pipeline wrote
 * them and never guessed at. *Nobody was simulated and no result was saved* is safe to
 * state outright: the contract refuses a failed run that records any finished session.
 *
 * The notice at the foot is driven by the engine the test asked for. A test that asked for
 * a model and could not run says which model that was and that nothing stood in for it — it
 * never reports another engine's result in its place (#144).
 */

/** Why *Try again* does nothing yet. Starting a test is the platform's, through #110. */
const NOT_WIRED =
  'Not wired up yet: starting a test belongs to the platform and to the New test screen (#110).';

/**
 * What to check, in the prototype's own words. They are this screen's copy rather than the
 * artifact's: the detail above them is what the attempt captured, and these are the three
 * things a reader can do something about.
 */
const CHECKS = [
  'Is the page for the second version actually reachable at that address?',
  'If it needs a login, add a sign-in step to the test.',
  'Both versions have to be reachable: a comparison is only valid from one test.',
] as const;

export function RunFailedScreen({ run }: { run: Run }) {
  const { failure } = run;

  return (
    <div className="strip strip-sm" data-section="run-failure">
      <div className="wrap">
        <div className="pagehead">
          <h1>Test failed to start</h1>
        </div>

        <div className="card card-lg errorcard">
          {/* A failed run always records why (the contract holds it to that). A run handed
              here without one still says what is certain rather than showing a blank card. */}
          <h2>{failure === undefined ? 'This test did not start' : failure.reason}</h2>
          <p>Nobody was simulated and no result was saved.</p>

          {failure === undefined || failure.detail === '' ? (
            <p className="faint">Nothing was captured from the attempt.</p>
          ) : (
            <div className="detail">{failure.detail}</div>
          )}

          <ul>
            {CHECKS.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>

          <div className="erroractions">
            <Button aria-disabled="true" title={NOT_WIRED}>
              Try again
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.newTest}>Edit the test</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link to={paths.home}>Open the last good test</Link>
            </Button>
          </div>
        </div>

        <div className="notice info enginenotice">
          <span>{engineFailureNotice(run.engine)}</span>
        </div>
      </div>
    </div>
  );
}
