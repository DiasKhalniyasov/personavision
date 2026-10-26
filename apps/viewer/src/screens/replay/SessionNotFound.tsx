import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';

/**
 * A session id this test does not hold, or a session file that could not be read.
 *
 * It names what was looked for and gives the reader a way on, inside the chrome: a stale
 * link, a session removed from the run directory or a session written for another schema
 * version all land here and nothing throws.
 */
export function SessionNotFound({
  runId,
  sessionId,
  problem,
}: {
  runId: string;
  sessionId: string;
  /** Absent when the test simply holds no such person. */
  problem?: string;
}) {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h2>
            {problem === undefined
              ? 'No person with that id'
              : 'That person’s session could not be read'}
          </h2>
          <p>
            PersonaVision looked for <strong>{sessionId}</strong> in this test
            {problem === undefined ? ', which lists no such person.' : '.'}
          </p>
          {problem === undefined ? null : <p className="mono">{problem}</p>}
          <div className="actions">
            <Button asChild>
              <Link to={paths.sessions(runId)}>See everyone in this test</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.run(runId)}>Back to the verdict</Link>
            </Button>
          </div>
          <p className="faint">
            A person is a file under <span className="mono">sessions/</span> in this test&rsquo;s
            directory, and <span className="mono">run.json</span> lists the ones there are.
          </p>
        </div>
      </div>
    </div>
  );
}
