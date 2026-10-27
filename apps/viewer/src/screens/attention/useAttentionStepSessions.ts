import { useEffect, useMemo, useState } from 'react';
import type { Run, Session } from '@personavision/contract';
import { runSessions } from '@/session';
import { runDataBase, useCurrentRunId, useOptionalRun } from '@/shell/useRun';

/**
 * The people this step's aggregate is made of, for one version and one step.
 *
 * Everything the overlays draw comes from here: the scored sessions of this version, their
 * fixations and saccades on this step, how many of them got this far, and how many the run
 * scored in the first place. Nothing is recomputed that the artifact already states — the
 * scored total is the run's own `scores[].scoredSessionCount`, and whether a session was
 * scored is the `excludedFromScores` the pipeline decided once and stored.
 *
 * **Scored only.** A session our own automation broke is not evidence about anybody's
 * checkout, so it is excluded here exactly as it is excluded from every figure in the run
 * (`docs/FLOW.md` section 3). That is why the aggregate line beside the version switch can
 * say how many people it covers and how many it left out.
 *
 * **What is held, and what is read.** The gaze data of one version and one step is what
 * this hook puts in memory: switching step throws the last step's fixations away rather
 * than keeping every step of every version loaded. The *files*, though, cannot be narrowed
 * before they are opened — a session's version lives in the session file and `run.json`'s
 * manifest carries ids alone — so the run's sessions are read once, through `src/session/`
 * (#20), and the per-session cache there means a later version or step costs no request.
 * Each file settles on its own: the screen does not wait for the twenty-fourth to show the
 * first, and one unreadable file is said out loud with its path rather than quietly
 * shortening the aggregate.
 */

/** One fixation, as a session records it. The contract names the fields, not this app. */
export type Fixation = Session['fixations'][number];
/** One saccade: the move between two fixations of the same session. */
export type Saccade = Session['saccades'][number];

export interface AttentionStepSessions {
  readonly status: 'loading' | 'ready' | 'error';
  /** What went wrong, naming the file. `null` unless `status` is `error`. */
  readonly error: string | null;
  /** The scored sessions of this version: `outcome.excludedFromScores === false`. */
  readonly sessions: Session[];
  /** Of those sessions, the fixations recorded on this step, session by session. */
  readonly fixations: Fixation[];
  /** Of those fixations, the moves between two of them on this step. */
  readonly saccades: Saccade[];
  /** How many of the scored sessions reached this step at all. */
  readonly reachedCount: number;
  /** How many sessions this version's figures are an aggregate of. */
  readonly scoredSessionCount: number;
}

/** Whether a session ever stood on this step. `screens[].step` is the record of it. */
export const reachedStep = (session: Session, step: string): boolean =>
  session.screens.some((screen) => screen.step === step);

/** The fixations one session recorded while it was on this step. */
export function fixationsOnStep(session: Session, step: string): Fixation[] {
  const screens = new Set(
    session.screens.filter((screen) => screen.step === step).map((screen) => screen.index),
  );
  return session.fixations.filter((fixation) => screens.has(fixation.screenIndex));
}

/**
 * The saccades one session made on this step: the moves whose two ends are both fixations
 * of this step. A move out of this step's last fixation lands somewhere this view does not
 * draw, so it is not one of this step's.
 */
export function saccadesOnStep(session: Session, step: string): Saccade[] {
  const here = new Set(fixationsOnStep(session, step).map((fixation) => fixation.index));
  return session.saccades.filter(
    (saccade) => here.has(saccade.fromFixation) && here.has(saccade.toFixation),
  );
}

/** How many sessions this version's figures were worked out from, as the run stores it. */
const scoredSessionCountOf = (run: Run, variant: string): number =>
  run.scores.find((score) => score.variant === variant && score.taskId === run.task.id)
    ?.scoredSessionCount ?? 0;

type Read =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly problem: string };

const problemOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the state holds: the reads, and which run they are of. */
interface ReadState {
  readonly runId: string | null;
  readonly reads: ReadonlyMap<string, Read>;
}

/** The reads of a run that has not been read yet, so one instance serves every render. */
const EMPTY_READS: ReadonlyMap<string, Read> = new Map();

const EMPTY: AttentionStepSessions = {
  status: 'loading',
  error: null,
  sessions: [],
  fixations: [],
  saccades: [],
  reachedCount: 0,
  scoredSessionCount: 0,
};

export function useAttentionStepSessions(variant: string, step: string): AttentionStepSessions {
  const state = useOptionalRun(useCurrentRunId());
  const run = state?.status === 'ready' ? state.run : null;

  // One reader per run, so that moving between steps and versions re-projects what has
  // already been read instead of asking the server again.
  const reader = useMemo(
    () => (run === null ? null : runSessions(run, { baseUrl: runDataBase(run.runId) })),
    [run],
  );

  // The reads carry the run they are of. The effect that empties them runs *after* the
  // render that first saw a new run, so without the id one render of the new test would
  // project the previous one's people — and if the two have the same number of sessions it
  // would read as settled rather than as still loading.
  const [read, setRead] = useState<ReadState>(() => ({ runId: null, reads: new Map() }));
  const reads = read.runId === run?.runId ? read.reads : EMPTY_READS;

  useEffect(() => {
    if (run === null || reader === null) return;
    let live = true;
    const { runId } = run;
    setRead({ runId, reads: new Map() });

    const settle = (sessionId: string, one: Read): void => {
      if (!live) return;
      setRead((current) =>
        current.runId === runId
          ? { runId, reads: new Map(current.reads).set(sessionId, one) }
          : current,
      );
    };

    for (const sessionId of run.sessionIds) {
      void reader.session(sessionId).then(
        (session) => {
          settle(sessionId, { ok: true, session });
        },
        (error: unknown) => {
          settle(sessionId, { ok: false, problem: problemOf(error) });
        },
      );
    }

    return () => {
      live = false;
    };
  }, [run, reader]);

  return useMemo(() => {
    if (run === null) return EMPTY;

    const scoredSessionCount = scoredSessionCountOf(run, variant);
    // A file that could not be read is the whole answer: an aggregate quietly missing one
    // person is a different claim about the audience from the one the screen is making.
    const failed = [...reads.values()].find((one) => !one.ok);
    if (failed !== undefined && !failed.ok) {
      return { ...EMPTY, status: 'error', error: failed.problem, scoredSessionCount };
    }

    const sessions = [...reads.values()].flatMap((one) =>
      one.ok && one.session.variant === variant && !one.session.outcome.excludedFromScores
        ? [one.session]
        : [],
    );

    return {
      status: reads.size < run.sessionIds.length ? 'loading' : 'ready',
      error: null,
      sessions,
      fixations: sessions.flatMap((session) => fixationsOnStep(session, step)),
      saccades: sessions.flatMap((session) => saccadesOnStep(session, step)),
      reachedCount: sessions.filter((session) => reachedStep(session, step)).length,
      scoredSessionCount,
    };
  }, [run, reads, variant, step]);
}
