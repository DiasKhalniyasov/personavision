import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { paths } from './paths';

/**
 * A results tab over a run that recorded nothing for it: **the tab stays and the screen says
 * what the test recorded.**
 *
 * The owner's decision on the absent blocks of the results page. A tab bar that changes
 * shape from test to test hides from the user what the product can do, so the screen is
 * reached, and then it states the absence in words — never a zero, and never an empty
 * chart, which would both read as a measurement somebody took.
 *
 * It is the `.empty` card of `docs/design/tokens.css` with an overline that names the state,
 * the sentence, what it means, and one way on. *Run this test again* goes to the New test
 * screen, which is where a test is started (`docs/FLOW.md` section 13): the figure arrives
 * with the next run and not from this screen.
 */
export function NothingRecorded({
  heading,
  children,
  section,
}: {
  heading: string;
  children: ReactNode;
  /** What the screen calls this block, for a test that asks for it by name. */
  section: string;
}) {
  return (
    <div className="empty" data-section={section}>
      <span className="microlabel">nothing recorded</span>
      <h2>{heading}</h2>
      <p>{children}</p>
      <div className="actions">
        <Button asChild size="lg">
          <Link to={paths.newTest}>Run this test again</Link>
        </Button>
      </div>
    </div>
  );
}
