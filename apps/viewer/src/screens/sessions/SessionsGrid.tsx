import { Link, useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';
import { search, withView } from './filters';
import styles from './sessionsGrid.module.css';
import { VideoTile } from './VideoTile';
import type { SessionRowState } from './useSessionRows';

/**
 * The grid of `#screen-grid`: one tile per person, paged, with the way to the rows of the
 * same people under it.
 *
 * **Paged, not infinite.** A tile asks the run mount for a frame of its own recording, so a
 * hundred tiles rendered at once is a hundred video requests the reader did not ask for.
 * The prototype's answer is a button — *Show the next 8* — and this holds to it: only the
 * pages a reader has asked to see are mounted, so at most one page's worth of video is ever
 * newly requested, and the tiles already on screen stay where they are rather than being
 * swapped out from under a reader who was looking at them.
 *
 * **Newest first.** `run.sessionIds` is the order the test ran them, so read backwards it
 * is the order they finished in: the person recorded most recently is the first tile
 * (`SessionsPage`). That is what the showing line claims, and it is a fact about the
 * manifest rather than something read out of a hundred session files — so the grid is in
 * its final order from the first render and no tile ever moves.
 *
 * **The link out carries the filters.** The rows are the same people under the same
 * narrowing, so the link is this screen's whole query with `view=rows` added to it and
 * nothing dropped (`filters.ts`).
 */

/** The page `#screen-grid`'s own button names: `Show the next 8`. */
export const PAGE = 8;

export function SessionsGrid({
  run,
  page,
  more,
  onMore,
}: {
  run: Run;
  /** The tiles on screen: the filtered people, newest first, up to the page asked for. */
  page: readonly SessionRowState[];
  /** How many the filter leaves beyond them. */
  more: number;
  onMore: () => void;
}) {
  const [query] = useSearchParams();

  return (
    <>
      <div className={styles.vidgrid}>
        {page.map((state) => (
          <VideoTile key={state.sessionId} run={run} state={state} />
        ))}
      </div>
      <div className={styles.formfoot}>
        {more <= 0 ? null : (
          // The number is the number there are, which on a test of a hundred is the
          // prototype's own eight on every press but the last.
          <Button type="button" onClick={onMore}>
            Show the next {Math.min(more, PAGE)}
          </Button>
        )}
        <Link to={{ pathname: paths.sessions(run.runId), search: search(withView(query, true)) }}>
          Show these as rows instead
        </Link>
      </div>
    </>
  );
}
