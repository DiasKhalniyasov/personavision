import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';

/**
 * `#screen-no-audience` of `docs/design/prototype.html`: the workspace has no audience yet.
 *
 * It is what `/audiences` renders when there is nothing to list, and what a test offered
 * without an audience lands on — a test cannot be run on nobody (`docs/FLOW.md` section 1),
 * so the product asks who the customers are before it offers the form.
 *
 * Its second action is the example test, which exists in every install and needs no
 * account: a reader can see what a result looks like before describing their own people.
 */
export function NoAudienceScreen() {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h2>First, who are your customers?</h2>
          <p>
            A test needs an audience: PersonaVision generates the people it tests with from the
            audience you describe. It takes about a minute — age, role, device, region, goals, and
            how much price matters.
          </p>
          <div className="actions">
            <Button asChild size="lg">
              <Link to={paths.newAudience}>Describe my audience</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to={paths.demo}>Look at the example test first</Link>
            </Button>
          </div>
          <p className="faint">
            The example test uses a ready-made audience, so you can see what a result looks like
            before describing your own.
          </p>
        </div>
      </div>
    </div>
  );
}
