import { Link, useParams, useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { countsLine, isScored, sessionCounts } from './counts';
import { SessionsTable } from './SessionsTable';
import { useSessionRows } from './useSessionRows';

/**
 * `/runs/:runId/sessions` — one row per simulated person: what happened, how long it took
 * and where it ended. `#screen-sessions` of `docs/design/prototype.html`.
 *
 * It is one click behind the Verdict screen's **People** door, and on screen a session is
 * one person. The screen recomputes nothing: the outcome, the attribution, the duration,
 * the fixation count and `excludedFromScores` come from the session module exactly as the
 * pipeline wrote them, and the counts line sums the totals the run already holds.
 *
 * The filter controls on the left of the control row are **#23's** — this screen leaves
 * their side of the row as a slot, and renders the unfiltered list.
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
  const counts = sessionCounts(run);
  const empty = rows.length === 0;
  const [query] = useSearchParams();
  const asked = FILTERS.filter((filter) => (query.get(filter) ?? '') !== '');

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

        {/* The left of this row is where #23's two version and outcome groups and its area
            chip go; until they exist it is empty and the counts sit on the right of it. */}
        <div className="my-5 flex flex-wrap items-center gap-2">
          <span className="grow" />
          {empty ? null : <span className="microlabel">{countsLine(counts, isScored(run))}</span>}
        </div>

        {asked.length === 0 ? null : <FilterNotRead asked={asked} />}

        {empty ? <NoSessions /> : <SessionsTable run={run} rows={rows} />}

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

/** The three filters `docs/FLOW.md` section 3 puts in this screen's URL, all #23's. */
const FILTERS = ['variant', 'outcome', 'aoi'] as const;

/**
 * A link that asked for a filtered list, on a screen that cannot filter yet.
 *
 * The Verdict's excluded banner and every outcome finding already link here with
 * `?variant=`, `?outcome=` or `?aoi=` set, and #23 builds the controls that read them.
 * Until it lands, a reader who clicked "See those 2" would be shown all twenty-four people
 * with nothing to say they are not the two — and would conclude the test excluded everybody.
 * Saying so is the smallest honest thing; #23 deletes this with the slot above.
 */
function FilterNotRead({ asked }: { asked: readonly string[] }) {
  return (
    <p className="notice info">
      This link asked for a narrower list ({asked.join(', ')}). Narrowing is not built yet, so every
      person in the test is listed below.
    </p>
  );
}

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
