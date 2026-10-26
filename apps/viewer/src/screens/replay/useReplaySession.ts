import { useEffect, useState } from 'react';
import type { Session } from '@personavision/contract';
import { openRun } from '@/session/index.js';
import type { RunSessions } from '@/session/index.js';
import { runDataBase } from '@/shell/useRun';

/**
 * One person's session, read once.
 *
 * It reads through the session module (#20), which parses what comes back with the
 * contract's own schema and fetches a session file only when something asks for that
 * session: the replay reads one file, not twenty-four. The run's manifest is what says
 * whether a session id exists at all, so a link to somebody who is not in this test is
 * answered as not-found rather than as a failed request.
 *
 * The opened run is kept per run id while the app is open, so walking from one person to
 * the next reads one file each. A read that failed is forgotten, so a reload can retry it.
 *
 * The URLs are the read-only run-data interface of
 * `docs/adr/0001-run-data-over-http-as-static-files.md` — the same mount `personavision
 * open` serves and `src/shell/useRun.ts` reads `run.json` from.
 */

const opened = new Map<string, Promise<RunSessions>>();

const openOnce = (runId: string): Promise<RunSessions> => {
  const pending =
    opened.get(runId) ??
    openRun({ baseUrl: runDataBase(runId) }).catch((error: unknown) => {
      opened.delete(runId);
      throw error;
    });
  opened.set(runId, pending);
  return pending;
};

export type ReplaySessionState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly session: Session;
      /** Where a captured page sits, spelled by the contract and not by this screen. */
      readonly screenshotUrl: RunSessions['screenshotUrl'];
    }
  /** This test lists no such person. */
  | { readonly status: 'not-found'; readonly sessionId: string }
  /** The person is listed but their session could not be read: `problem` says why. */
  | { readonly status: 'unreadable'; readonly sessionId: string; readonly problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every session read so far is forgotten. For tests, and for signing out. */
export const clearSessionCache = (): void => {
  opened.clear();
};

export function useReplaySession(runId: string, sessionId: string): ReplaySessionState {
  const [state, setState] = useState<ReplaySessionState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    void openOnce(runId)
      .then(async (run): Promise<ReplaySessionState> => {
        if (!run.sessionIds.includes(sessionId)) return { status: 'not-found', sessionId };
        return {
          status: 'ready',
          session: await run.session(sessionId),
          screenshotUrl: run.screenshotUrl,
        };
      })
      .catch((error: unknown): ReplaySessionState => ({
        status: 'unreadable',
        sessionId,
        problem: reason(error),
      }))
      .then((next) => {
        if (live) setState(next);
      });

    return () => {
      live = false;
    };
  }, [runId, sessionId]);

  return state;
}
