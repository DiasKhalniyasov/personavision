import { useEffect, useState } from 'react';
import type { Run, Session } from '@personavision/contract';
import { runSessions, sessionRow } from '@/session';
import type { SessionRow } from '@/session';
import { runDataBase } from '@/shell/useRun';

/**
 * The run's people, manifest first.
 *
 * `run.json` carries `sessionIds`, so the list and its order are known before any session
 * file is read: every row is on screen, in the run's order, from the first render, and
 * each one fills when its own file arrives. The screen never waits for all twenty-four.
 *
 * A row whose file cannot be read **stays on the screen** and says so where its numbers
 * would be. A session dropped from the list would quietly change what the test measured,
 * which is the one thing this screen exists not to do.
 *
 * The reading itself is `src/session/`'s (#20), through `@personavision/contract`; the run
 * comes from `useRun`, the viewer's one reader of a run, so `run.json` is read once.
 */

export type SessionRowState =
  | { readonly status: 'pending'; readonly sessionId: string }
  | {
      readonly status: 'ready';
      readonly sessionId: string;
      readonly row: SessionRow;
      /**
       * The session as it was read. The row is what the table prints; the three filters
       * (#23) are evaluated over the session itself, through `matchesSessionFilter`, so
       * "fixated this area of interest" asks `fixations[].aoiId` rather than a second
       * projection of it kept in step by hand.
       */
      readonly session: Session;
    }
  | { readonly status: 'failed'; readonly sessionId: string; readonly problem: string };

const pending = (sessionId: string): SessionRowState => ({ status: 'pending', sessionId });

const problem = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useSessionRows(run: Run): readonly SessionRowState[] {
  const [rows, setRows] = useState<readonly SessionRowState[]>(() => run.sessionIds.map(pending));

  useEffect(() => {
    let live = true;
    setRows(run.sessionIds.map(pending));

    const sessions = runSessions(run, { baseUrl: runDataBase(run.runId) });
    const settle = (next: SessionRowState): void => {
      if (!live) return;
      setRows((current) =>
        current.map((state) => (state.sessionId === next.sessionId ? next : state)),
      );
    };

    for (const sessionId of run.sessionIds) {
      void sessions.session(sessionId).then(
        (session) => {
          settle({ status: 'ready', sessionId, row: sessionRow(run, session), session });
        },
        (error: unknown) => {
          settle({ status: 'failed', sessionId, problem: problem(error) });
        },
      );
    }

    return () => {
      live = false;
    };
  }, [run]);

  return rows;
}
