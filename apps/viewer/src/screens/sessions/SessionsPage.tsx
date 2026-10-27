import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { matchesSessionFilter } from '@/session';
import type { SessionFilter } from '@/session';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { readFilter, without } from './filters';
import { NoMatch } from './NoMatch';
import { SessionsFilters } from './SessionsFilters';
import { SessionsTable } from './SessionsTable';
import { useSessionRows } from './useSessionRows';
import type { SessionRowState } from './useSessionRows';

/**
 * `/runs/:runId/sessions` — one row per simulated person: what happened, how long it took
 * and where it ended. `#screen-sessions` of `docs/design/prototype.html`.
 *
 * It is one click behind the Verdict screen's **People** door, and on screen a session is
 * one person. The screen recomputes nothing: the outcome, the attribution, the duration,
 * the fixation count and `excludedFromScores` come from the session module exactly as the
 * pipeline wrote them, and the counts line sums the totals the run already holds.
 *
 * Its three filters are **the query string** (`filters.ts`): the screen holds no selection
 * a reload would lose, a narrowed list is a link, and a reader arriving from an area of
 * interest on the Attention screen lands with the list already narrowed to the people who
 * fixated it.
 */
export function SessionsPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  switch (state.status) {
    case 'loading':
      // The shell's convention: the chrome above is already in its loading state, and the
      // body stays empty rather than flashing a spinner the reader cannot act on.
      return null;
    case 'not-found':
      return <RunNotFound runId={state.runId} url={state.url} />;
    case 'unreadable':
      return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
    case 'ready':
      return <SessionsScreen run={state.run} />;
  }
}

/** The screen itself, over a run that has been read. Exported so a test can mount it alone. */
export function SessionsScreen({ run }: { run: Run }) {
  const rows = useSessionRows(run);
  const [query, setQuery] = useSearchParams();
  const { filter, aoi, unknown } = readFilter(run, query);

  // A `?aoi=` naming no area of this run, or a version or outcome the run never had, is a
  // bad link rather than a filter: it leaves the URL, and the reader gets the list. The
  // parameters are the effect's own dependency as one string, so a URL that cannot be
  // cleaned any further is a settled screen rather than a render that navigates again.
  const stale = unknown.join(',');
  useEffect(() => {
    if (stale !== '') setQuery(without(query, stale.split(',')), { replace: true });
  }, [stale, query, setQuery]);

  const shown = rows.filter((state) => matches(state, filter));
  const empty = rows.length === 0;
  // Every session the filter needs has been read, which is what lets the counts line state
  // a filtered reading at all: until then the rows the filter cannot judge are on screen,
  // and "24 of 24 sessions" over twenty-four still-loading rows would pass every person in
  // the test off as the few the reader asked for.
  const read = rows.every((state) => state.status !== 'pending');

  return (
    <div className="strip">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.run(run.runId)}>Verdict</Link> / People
        </p>
        <div className="pagehead">
          <h1>What happened to each person</h1>
        </div>
        <p className="lede">
          One row per generated person × version × seed. Open one to watch it back.
        </p>

        {empty ? null : (
          <div className="my-5 flex flex-wrap items-center gap-2">
            <SessionsFilters
              run={run}
              filter={filter}
              aoi={aoi}
              shown={read ? shown.length : null}
            />
          </div>
        )}

        {empty ? (
          <NoSessions />
        ) : shown.length === 0 ? (
          <NoMatch run={run} filter={filter} aoi={aoi} />
        ) : (
          <SessionsTable run={run} rows={shown} />
        )}

        <p className="footnote">
          When our own browser automation breaks, that is our fault and never your checkout's: those
          people are excluded from every figure, including the friction score and each area's
          numbers. Somebody giving up, somebody ending without the task done, and our automation
          breaking are three different things and are never merged.
        </p>
        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * Whether one row belongs in the filtered list.
 *
 * A row whose session has not been read yet, or whose file could not be read, is **kept**:
 * nothing is known about it, and a filter that hid it would be claiming it does not match.
 * That is also what keeps the no-match screen honest — an empty list can only mean every
 * session was read and none of them matched, so the screen cannot say "no session matches"
 * while the sessions the filter needs are still arriving.
 */
const matches = (state: SessionRowState, filter: SessionFilter): boolean =>
  state.status !== 'ready' || matchesSessionFilter(state.session, filter);

/**
 * A test that recorded nobody.
 *
 * Deliberately **not** the prototype's only empty sessions state, which is the no-match
 * one (#23's): a test with no people and a filter that matches none of them are different
 * facts, and a reader who read one as the other would draw the wrong conclusion about
 * their checkout.
 */
function NoSessions() {
  return (
    <div className="empty">
      <h2>This test recorded no people</h2>
      <p>
        Its run lists no sessions, so there is nothing to watch back. A finished test holds one
        person per generated person × version × seed.
      </p>
    </div>
  );
}
