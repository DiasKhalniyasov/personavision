import { Link, useNavigate } from 'react-router';
import type { MouseEvent } from 'react';
import type { Run } from '@personavision/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SessionRow } from '@/session';
import { paths } from '@/shell/paths';
import { durationSeconds, tagClass, variantTagClass, whereItEnded } from './rows';
import styles from './sessionsTable.module.css';
import type { SessionRowState } from './useSessionRows';

/**
 * The table of `#screen-sessions`: one row per person, in the run's own order, each row a
 * door to that person's replay.
 *
 * The drill-down is a **link** in the Session column, so the row is reachable and
 * activatable with a keyboard and nothing non-semantic carries a tab stop; the row itself
 * is clickable as well, because that is how the prototype behaves and where a pointer
 * expects to click. The two never fire together — a click the link already handled, or one
 * carrying a modifier that asks for a new tab, is left to the anchor.
 *
 * Nothing here decides anything about a session. Every value is the projection the session
 * module hands over, and `excludedFromScores` is printed as stored.
 */

/** The nine columns, in the order the prototype's `thead` draws them. */
const COLUMNS = [
  'Session',
  'Persona',
  'Variant',
  'Device',
  'Outcome',
  'Time',
  'Fixations',
  'Attributed to',
  'Where it ended',
] as const;

/** The two figures a reader compares down the column. */
const FIGURES = new Set<string>(['Time', 'Fixations']);

export function SessionsTable({ run, rows }: { run: Run; rows: readonly SessionRowState[] }) {
  return (
    // The one scroll region of this screen, and a reader with no pointer has to be able to
    // reach it: nine columns do not fit a phone, and the column that goes off the edge is
    // the reason a session ended.
    <div
      className={styles.tablewrap}
      tabIndex={0}
      role="region"
      aria-label="The people in this test"
    >
      <Table>
        <TableCaption className="sr-only">
          The people in this test: one row each, in the order the test ran them.
        </TableCaption>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <TableHead key={column} className={FIGURES.has(column) ? styles.figure : undefined}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((state) => (
            <SessionTableRow key={state.sessionId} runId={run.runId} state={state} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SessionTableRow({ runId, state }: { runId: string; state: SessionRowState }) {
  const navigate = useNavigate();
  const to = paths.session(runId, state.sessionId);

  // The whole row is a pointer target, and the link inside it is the keyboard's. What the
  // row must not do is take over a click the anchor would have served better: one that
  // landed on the link, or one asking for a new tab, a new window or a background open.
  const open = (event: MouseEvent<HTMLTableRowElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('a') !== null) return;
    void navigate(to);
  };

  return (
    <TableRow
      className={styles.row}
      onClick={open}
      aria-busy={state.status === 'pending' ? true : undefined}
    >
      <TableCell className={styles.tight}>
        <Link className="mono" to={to}>
          {state.sessionId}
        </Link>
      </TableCell>
      {state.status === 'ready' ? (
        <ReadCells row={state.row} />
      ) : state.status === 'failed' ? (
        <TableCell colSpan={COLUMNS.length - 1}>
          This person's session could not be read, so the test's own figures are the only record of
          them: {state.problem}
        </TableCell>
      ) : (
        COLUMNS.slice(1).map((column) => (
          <TableCell key={column}>
            <Skeleton className="h-4 w-full" />
          </TableCell>
        ))
      )}
    </TableRow>
  );
}

function ReadCells({ row }: { row: SessionRow }) {
  return (
    <>
      <TableCell>
        {row.personaName ?? row.participantId ?? 'Unnamed'}{' '}
        {row.seed === null ? null : <span className="faint">seed {row.seed}</span>}
      </TableCell>
      <TableCell className={styles.tight}>
        <Badge variant="ghost" className={`tag ${variantTagClass(row.variant)}`}>
          {row.variant}
        </Badge>
      </TableCell>
      <TableCell className="faint">{row.deviceName ?? '—'}</TableCell>
      <TableCell>
        <Badge variant="ghost" className={`tag ${tagClass(row.outcome.token)}`}>
          {row.outcome.label}
        </Badge>{' '}
        {row.excludedFromScores ? <span className="microlabel">excluded</span> : null}
      </TableCell>
      <TableCell className={styles.figure}>{durationSeconds(row.durationMs)}</TableCell>
      <TableCell className={styles.figure}>{row.fixationCount}</TableCell>
      <TableCell>
        {row.outcome.status === 'success' ? (
          // Nothing is at fault when the task was done, so the column stays empty rather
          // than printing the attribution a successful session still carries.
          <span className="faint">—</span>
        ) : (
          <Badge variant="ghost" className={`tag ${tagClass(row.attribution.token)}`}>
            {row.attribution.label}
          </Badge>
        )}
      </TableCell>
      <TableCell className={styles.where}>{whereItEnded(row.endedOn, row.reason)}</TableCell>
    </>
  );
}
