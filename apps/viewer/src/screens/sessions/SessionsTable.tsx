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
import type { SessionRowState } from './useSessionRows';

/**
 * The table of `#screen-sessions`: one row per person, in the run's own order, each row a
 * door to that person's replay.
 *
 * The drill-down is a **link** in the Session column, so the row is reachable and
 * activatable with a keyboard and nothing non-semantic carries a tab stop; the row itself
 * is clickable as well, because that is how the prototype behaves and where a pointer
 * expects to click. The two never fire together — a click that landed on the link is the
 * link's.
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

/** The two figures a reader compares down the column, so they are right-aligned. */
const FIGURES = new Set<string>(['Time', 'Fixations']);

export function SessionsTable({ run, rows }: { run: Run; rows: readonly SessionRowState[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableCaption className="sr-only">
          The people in this test: one row each, in the order the test ran them.
        </TableCaption>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <TableHead
                key={column}
                className={`microlabel px-4 py-3${FIGURES.has(column) ? ' text-right' : ''}`}
              >
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

  // The whole row is a pointer target, and the link inside it is the keyboard's. A click
  // that the link already handled must not navigate twice.
  const open = (event: MouseEvent<HTMLTableRowElement>): void => {
    if (event.target instanceof Element && event.target.closest('a') !== null) return;
    void navigate(to);
  };

  return (
    <TableRow
      className="cursor-pointer hover:bg-secondary"
      onClick={open}
      aria-busy={state.status === 'pending' ? true : undefined}
    >
      <TableCell className="p-4">
        <Link className="mono" to={to}>
          {state.sessionId}
        </Link>
      </TableCell>
      {state.status === 'ready' ? (
        <ReadCells row={state.row} />
      ) : state.status === 'failed' ? (
        <TableCell className="p-4 whitespace-normal" colSpan={COLUMNS.length - 1}>
          This person's session could not be read, so the test's own figures are the only record of
          them: {state.problem}
        </TableCell>
      ) : (
        COLUMNS.slice(1).map((column) => (
          <TableCell key={column} className="p-4">
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
      <TableCell className="p-4">
        {row.personaName ?? row.participantId ?? 'Unnamed'}{' '}
        {row.seed === null ? null : <span className="faint">seed {row.seed}</span>}
      </TableCell>
      <TableCell className="p-4">
        <Badge variant="ghost" className={variantTagClass(row.variant)}>
          {row.variant}
        </Badge>
      </TableCell>
      <TableCell className="faint p-4">{row.deviceName ?? '—'}</TableCell>
      <TableCell className="p-4">
        <Badge variant="ghost" className={tagClass(row.outcome.token)}>
          {row.outcome.label}
        </Badge>{' '}
        {row.excludedFromScores ? <span className="microlabel">excluded</span> : null}
      </TableCell>
      <TableCell className="num p-4 text-right">{durationSeconds(row.durationMs)}</TableCell>
      <TableCell className="num p-4 text-right">{row.fixationCount}</TableCell>
      <TableCell className="p-4">
        {row.outcome.status === 'success' ? (
          // Nothing is at fault when the task was done, so the column stays empty rather
          // than printing the attribution a successful session still carries.
          <span className="faint">—</span>
        ) : (
          <Badge variant="ghost" className={tagClass(row.attribution.token)}>
            {row.attribution.label}
          </Badge>
        )}
      </TableCell>
      <TableCell className="p-4 whitespace-normal text-muted-foreground">
        {whereItEnded(row.endedOn, row.reason)}
      </TableCell>
    </>
  );
}
