import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { variantName } from '@/screens/replay/runWords';
import type { SessionFilter } from '@/session';
import { paths } from '@/shell/paths';
import type { Aoi } from './filters';
import { noMatchWords } from './noMatchWords';

/**
 * `#screen-sessions-empty` of `docs/design/prototype.html`: the filters match nobody.
 *
 * It is deliberately **not** an error and not the screen a test with no sessions gets
 * (`SessionsPage`'s own). On the redesign, no session both fixated "Confirm purchase" and
 * finished the task — that is the finding, and this screen states it with the run's own
 * figures and then offers the two ways on: widen the list, or go and look at the heatmap
 * for the area that was asked for.
 */
export function NoMatch({
  run,
  filter,
  aoi,
}: {
  run: Run;
  filter: SessionFilter;
  aoi: Aoi | null;
}) {
  const words = noMatchWords(run, filter, aoi);

  return (
    <div className="empty">
      <h2>No session matches</h2>
      <p>
        {words.before}
        {words.area === null ? null : <b>{words.area}</b>}
        {words.after}
        {words.detail === null ? null : ` ${words.detail}`}
      </p>
      <div className="actions">
        <Button asChild size="lg">
          <Link to={paths.sessions(run.runId)}>Clear filters</Link>
        </Button>
        {/* An area belongs to one version and one step, which is the heatmap to open. With
            no area asked for there is no step to open one on, and the action is not drawn
            rather than guessing a step the reader never named. */}
        {aoi === null ? null : (
          <Button asChild variant="outline" size="lg">
            <Link to={paths.attention(run.runId, aoi.variant, aoi.step)}>
              See the heatmap for {variantName(run, aoi.variant)}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
