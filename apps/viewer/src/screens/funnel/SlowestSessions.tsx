import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { FunnelSlice, Run } from '@personavision/contract';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { runSessions, sessionRow } from '@/session';
import { paths } from '@/shell/paths';
import { runDataBase } from '@/shell/useRun';
import { clock, noSlowestSessions, stepLabel, whereTheTimeWent } from './funnelWords';
import styles from './funnel.module.css';

/**
 * *The slowest sessions* — the people this slice's time went on, with a link to each replay.
 *
 * The rows are the aggregate's own `timing.slowest`, **in the stored order**: the pipeline
 * stored them slowest first, and the table renders that order rather than sorting anything.
 * The total and where the time went are stored fields too.
 *
 * Who each one was is not in the aggregate, and deliberately: the file keeps figures, and a
 * person's name and segment are already recorded against their session. So those two cells
 * are read from the sessions this table names — at most a handful of files, through
 * `src/session/`, which is this app's one reader of a session — and a row whose file has not
 * arrived yet keeps its figures and says the name is still being read. A row is never
 * dropped for want of a name: it is a session the test measured either way.
 */

/** Who one slow session was, as the session file records them. */
interface Person {
  readonly name: string | null;
  readonly segment: string | null;
}

type PersonState =
  | { readonly status: 'reading' }
  | { readonly status: 'ready'; readonly person: Person }
  | { readonly status: 'unreadable' };

/**
 * The people of the named sessions, each as its file arrives.
 *
 * Only the sessions on the table are read, not the run's hundred: this screen needs five
 * names, and the list of five is what the aggregate stored.
 */
function usePeople(run: Run, sessionIds: readonly string[]): ReadonlyMap<string, PersonState> {
  const [people, setPeople] = useState<ReadonlyMap<string, PersonState>>(new Map());
  // The ids, as one value, so the effect re-runs when the list changes and not when the
  // array is merely rebuilt by a render.
  const named = sessionIds.join('\u0000');

  useEffect(() => {
    let live = true;
    const ids = named === '' ? [] : named.split('\u0000');
    setPeople(new Map(ids.map((id) => [id, { status: 'reading' } as PersonState])));

    const sessions = runSessions(run, { baseUrl: runDataBase(run.runId) });
    const settle = (sessionId: string, state: PersonState): void => {
      if (!live) return;
      setPeople((current) => new Map(current).set(sessionId, state));
    };

    for (const sessionId of ids) {
      void sessions.session(sessionId).then(
        (session) => {
          const row = sessionRow(run, session);
          settle(sessionId, {
            status: 'ready',
            person: { name: row.personaName, segment: row.segment },
          });
        },
        () => {
          settle(sessionId, { status: 'unreadable' });
        },
      );
    }

    return () => {
      live = false;
    };
  }, [run, named]);

  return people;
}

const COLUMNS = ['Session', 'Person', 'Segment', 'Total', 'Where the time went'] as const;

export function SlowestSessions({ run, slice }: { run: Run; slice: FunnelSlice }) {
  const slowest = slice.timing.slowest;
  const people = usePeople(
    run,
    slowest.map((session) => session.sessionId),
  );

  return (
    <div className="section" data-funnel="slowest">
      <h2>The slowest sessions</h2>
      {slowest.length === 0 ? (
        <p className="lede" data-funnel="no-slowest">
          {noSlowestSessions()}
        </p>
      ) : (
        <div
          className={styles.tablewrap}
          tabIndex={0}
          role="region"
          aria-label="The slowest sessions"
        >
          <Table>
            <TableCaption className="sr-only">
              The slowest sessions of this slice, slowest first, with where each one&rsquo;s time
              went and a link to its replay.
            </TableCaption>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => (
                  <TableHead
                    key={column}
                    className={column === 'Total' ? styles.figure : undefined}
                  >
                    {column}
                  </TableHead>
                ))}
                <TableHead>
                  <span className="sr-only">The replay</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slowest.map((session) => {
                const state = people.get(session.sessionId) ?? { status: 'reading' };
                const to = paths.session(run.runId, session.sessionId);
                return (
                  <TableRow
                    key={session.sessionId}
                    data-session={session.sessionId}
                    aria-busy={state.status === 'reading' ? true : undefined}
                  >
                    <TableCell>
                      <Link className="mono" to={to}>
                        {session.sessionId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Who state={state} of="name" />
                    </TableCell>
                    <TableCell className="faint">
                      <Who state={state} of="segment" />
                    </TableCell>
                    <TableCell className={styles.figure}>{clock(session.totalMs)}</TableCell>
                    <TableCell className="muted">
                      {whereTheTimeWent(session, stepLabel(run, session.dominantStep))}
                    </TableCell>
                    <TableCell>
                      <Link to={to}>Watch</Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/**
 * One half of who a session was: the name or the segment, or a word for not knowing it yet.
 *
 * A cell that cannot be filled says so. It never prints a blank, which would read as a
 * person with no segment rather than a file this screen has not read.
 */
function Who({ state, of }: { state: PersonState; of: 'name' | 'segment' }) {
  if (state.status === 'reading') return <span className="faint">reading&hellip;</span>;
  const value = state.status === 'ready' ? state.person[of] : null;
  return value === null ? <span className="faint">not recorded</span> : <>{value}</>;
}
