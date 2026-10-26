import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { paths } from './paths';

/**
 * A test id that is not in this workspace, or a run directory that could not be read.
 *
 * It renders inside the chrome and **names what was looked for**: the id asked for and the
 * file the viewer read for it. Nothing throws — a bad link, a deleted run directory or a
 * run written for another schema version all land here, and the reader is given a way on.
 */
export function RunNotFound({
  runId,
  url,
  problem,
}: {
  runId: string;
  url: string;
  problem?: string;
}) {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h2>{problem === undefined ? 'No test with that id' : 'That test could not be read'}</h2>
          <p>
            PersonaVision looked for the test <strong>{runId}</strong> in this workspace and read{' '}
            <span className="mono">{url}</span>
            {problem === undefined ? ', which is not there.' : '.'}
          </p>
          {problem === undefined ? null : <p className="mono">{problem}</p>}
          <div className="actions">
            <Button asChild>
              <Link to={paths.home}>Open the most recent test</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={paths.newTest}>New test</Link>
            </Button>
          </div>
          <p className="faint">
            A test is a directory under <span className="mono">runs/</span>, and its name is its id.{' '}
            <span className="mono">personavision validate</span> says what is wrong with one.
          </p>
        </div>
      </div>
    </div>
  );
}
