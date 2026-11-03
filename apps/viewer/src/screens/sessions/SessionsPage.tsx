import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { matchesSessionFilter } from '@/session';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { isRowsView, readFilter, search, withView, without } from './filters';
import type { ScreenFilter } from './filters';
import { NoMatch } from './NoMatch';
import { PAGE, SessionsGrid } from './SessionsGrid';
import { SessionsFilters } from './SessionsFilters';
import styles from './sessionsGrid.module.css';
import { SessionsTable } from './SessionsTable';
import { useSessionRows } from './useSessionRows';
import type { SessionRowState } from './useSessionRows';

/**
 * `/runs/:runId/sessions` — the hundred people of one test, as **a grid of video
 * thumbnails** by default and as rows of figures one link away. `#screen-grid` and
 * `#screen-sessions` of `docs/design/prototype.html`.
 *
 * **Two views, one screen, one set of people.** A table of a hundred rows is not a way to
 * find a video, so the grid leads (`docs/FLOW.md` section 14.2); but rows are still how
 * somebody reads numbers, so they stay, as a view of the same data under the same filters.
 * Which view is on screen is one more parameter of the same query string, which is what
 * makes the switch between them carry every filter across without a word of special
 * handling.
 *
 * The screen recomputes nothing. The outcome, the attribution, the duration, the fixation
 * count and `excludedFromScores` come from the session module exactly as the pipeline wrote
 * them; the counts on the outcome filter are `scores[].outcomeCounts`, the slice the
 * scoring step stored; and a tile's frame is a frame of the recording at an offset the
 * session's own video block records (`docs/adr/0001`).
 *
 * Its filters are **the query string** (`filters.ts`): the screen holds no selection a
 * reload would lose, a narrowed grid is a link, and a reader arriving from an area of
 * interest on the Attention screen or from a recommendation's citation lands with the
 * people already narrowed to the ones the claim was about.
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
  const { filter, aoi, endedOn, unknown } = readFilter(run, query);
  const grid = !isRowsView(query);

  // A `?aoi=` naming no area of this run, or a version, outcome, segment or step the run
  // never had, is a bad link rather than a filter: it leaves the URL, and the reader gets
  // the people. The parameters are the effect's own dependency as one string, so a URL that
  // cannot be cleaned any further is a settled screen rather than a render that navigates
  // again.
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

  // The grid is newest first: `sessionIds` is the order the test ran them, so its reverse
  // is the order they finished in, known from the manifest before a session file arrives.
  // The rows keep the run's own order, which is what their caption says they are in.
  const newestFirst = useMemo(() => [...shown].reverse(), [shown]);

  const [pages, setPages] = useState(1);
  // A filter narrows the grid back to its first page: the tiles a reader was looking at are
  // not the tiles they have just asked for, and page four of a list that now holds six
  // people would open on nothing.
  const narrowing = search(query);
  useEffect(() => {
    setPages(1);
  }, [narrowing]);
  const upTo = Math.min(pages * PAGE, newestFirst.length);

  const recorded = read
    ? rows.filter((state) => state.status === 'ready' && state.session.video?.state === 'recorded')
        .length
    : null;

  return (
    <div className="strip">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.run(run.runId)}>Verdict</Link> / People
        </p>
        <div className="pagehead">
          <h1>{grid ? headline(run, recorded) : 'What happened to each person'}</h1>
        </div>
        <p className="lede">
          {grid
            ? 'Each tile is one person’s whole attempt, recorded. Filter down to the ones you want to watch.'
            : 'One row per generated person × version × seed. Open one to watch it back.'}
        </p>

        {empty ? null : (
          <div className="my-5 flex flex-wrap items-center gap-2">
            <SessionsFilters
              run={run}
              rows={rows}
              filter={filter}
              aoi={aoi}
              endedOn={endedOn}
              grid={grid}
              shown={read ? shown.length : null}
              onPage={upTo}
              read={read}
            />
          </div>
        )}

        {empty ? (
          <NoSessions />
        ) : shown.length === 0 ? (
          <NoMatch
            run={run}
            filter={filter}
            aoi={aoi}
            clearTo={`${paths.sessions(run.runId)}${grid ? '' : search(withView(new URLSearchParams(), true))}`}
          />
        ) : grid && recorded === 0 ? (
          <NothingRecorded run={run} query={query} />
        ) : grid ? (
          <SessionsGrid
            run={run}
            page={newestFirst.slice(0, upTo)}
            more={newestFirst.length - upTo}
            onMore={() => {
              setPages((current) => current + 1);
            }}
          />
        ) : (
          <>
            <SessionsTable run={run} rows={shown} />
            <div className={styles.formfoot}>
              <Link
                to={{ pathname: paths.sessions(run.runId), search: search(withView(query, false)) }}
              >
                Show these as a grid of videos instead
              </Link>
            </div>
          </>
        )}

        {/* Each view closes with its own: the grid's is the sentence `#screen-grid` ends on,
            and the rows keep the longer one `#screen-sessions` has always printed. */}
        {grid ? (
          <p className="footnote">
            Automation failures are shown and marked, never dropped: a video you cannot see is a
            figure you cannot check.
          </p>
        ) : (
          <p className="footnote">
            When our own browser automation breaks, that is our fault and never your checkout's:
            those people are excluded from every figure, including the friction score and each
            area's numbers. Somebody giving up, somebody ending without the task done, and our
            automation breaking are three different things and are never merged.
          </p>
        )}
        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * `100 people, 100 videos`, as `#screen-grid` heads itself.
 *
 * How many people is `run.json`'s own manifest and is known at once. How many of them were
 * recorded is not a figure the pipeline stores, so the clause is stated once every session
 * has been read and is simply absent before then: a heading that said "100 videos" over a
 * run that recorded eighty would be the one claim this screen exists to make checkable.
 */
function headline(run: Run, recorded: number | null): string {
  const people = `${run.sessionIds.length} ${run.sessionIds.length === 1 ? 'person' : 'people'}`;
  if (recorded === null) return people;
  return `${people}, ${recorded} ${recorded === 1 ? 'video' : 'videos'}`;
}

/**
 * Whether one row belongs in the filtered list.
 *
 * A row whose session has not been read yet, or whose file could not be read, is **kept**:
 * nothing is known about it, and a filter that hid it would be claiming it does not match.
 * That is also what keeps the no-match screen honest — an empty list can only mean every
 * session was read and none of them matched, so the screen cannot say "no session matches"
 * while the sessions the filter needs are still arriving.
 *
 * The version, the outcome and the area of interest are the session module's predicate
 * (`matchesSessionFilter`). The segment and the step are asked of the **row**, because both
 * are looked up out of `run.json` — a persona's segment and a step's label — and the row is
 * where that lookup already happened.
 */
const matches = (state: SessionRowState, filter: ScreenFilter): boolean => {
  if (state.status !== 'ready') return true;
  if (!matchesSessionFilter(state.session, filter)) return false;
  if (filter.segment !== null && state.row.segment !== filter.segment) return false;
  if (filter.step !== null && state.row.endedOn.step !== filter.step) return false;
  return true;
};

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

/**
 * A test with people but no recordings at all — one run before session video existed, or
 * one whose recorder never managed a file.
 *
 * It says so in words and offers the rows, which hold everything about those people that
 * does not need a video. A wall of tiles each stating its own absence would be the same
 * sentence a hundred times, and an empty grid would read as a test with nobody in it.
 */
function NothingRecorded({ run, query }: { run: Run; query: URLSearchParams }) {
  return (
    <div className="empty">
      <h2>This test recorded no videos</h2>
      <p>
        Its people are all here and every figure about them stands; there is just nothing to watch
        back. A test run before we recorded video, or one whose recorder never wrote a file, says so
        here rather than drawing a wall of blank tiles.
      </p>
      <div className="actions">
        <Button asChild size="lg">
          <Link to={{ pathname: paths.sessions(run.runId), search: search(withView(query, true)) }}>
            Show these as rows instead
          </Link>
        </Button>
      </div>
    </div>
  );
}
