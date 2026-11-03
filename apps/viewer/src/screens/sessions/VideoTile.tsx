import { useState } from 'react';
import { Link } from 'react-router';
import type { CSSProperties, ReactNode } from 'react';
import type { Run, Session } from '@personavision/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { timeLabel } from '@/screens/replay/position';
import type { SessionRow } from '@/session';
import { paths } from '@/shell/paths';
import { runDataBase } from '@/shell/useRun';
import {
  deviceAndSegment,
  frameAspect,
  personLine,
  posterFrame,
  posterSrc,
  tagClass,
  whereItEnded,
} from './rows';
import styles from './sessionsGrid.module.css';
import type { SessionRowState } from './useSessionRows';

/**
 * One tile of `#screen-grid`: a frame of one person's recording, the gaze mark on it, how
 * long the recording runs, and who they were and how it went underneath.
 *
 * **The tile is one control.** A grid of a hundred of these is a grid of a hundred tab
 * stops at most, not of four hundred: the thumbnail, the duration and the tag are all
 * inside one link whose accessible name is the person and the outcome, so a reader who
 * cannot see the picture is told what the picture is of and where the link goes. The
 * prototype draws a `<button>`; this is a link, because it goes somewhere — which is also
 * what lets a reader open a replay in a new tab, as the row of `#screen-sessions` already
 * does from its Session column.
 *
 * **The thumbnail is the recording, never a page screenshot.** A `<video>` asked for one
 * frame by a media fragment (`rows.ts`), with `preload="metadata"` so the browser fetches
 * that frame over a byte range rather than the whole file. It carries no controls and is
 * never played, so there is nothing here to stop under `prefers-reduced-motion` — the one
 * thing on the tile that moves is the pulse of a thumb still waiting for its session, which
 * the tokens flatten.
 *
 * **A session with no recording says so.** Two different facts, and the tile tells them
 * apart: a session whose recorder wrote `state: "absent"` recorded none and prints the
 * reason it gave, and a recording the browser cannot read names the path it looked for.
 * Neither is a blank tile and neither is a broken one — a video you cannot see is a figure
 * you cannot check, so the tile has to state which of the two happened.
 */
export function VideoTile({ run, state }: { run: Run; state: SessionRowState }) {
  if (state.status === 'pending') return <PendingTile sessionId={state.sessionId} />;
  if (state.status === 'failed') {
    return <UnreadableTile sessionId={state.sessionId} problem={state.problem} />;
  }
  return <ReadTile run={run} row={state.row} session={state.session} />;
}

/**
 * The aspect ratio a tile reserves. A tile whose session has been read takes the device's
 * own shape (`frameAspect`); every other tile keeps the prototype's `16 / 10`, which is
 * what `.thumb` declares, so the grid is laid out before anything has arrived and the
 * poster landing in it later does not move a single tile.
 */
const reserve = (aspect: string | null): CSSProperties | undefined =>
  aspect === null ? undefined : ({ '--thumb-aspect': aspect } as CSSProperties);

function ReadTile({ run, row, session }: { run: Run; row: SessionRow; session: Session }) {
  const person = personLine(run, row);
  const ended = whereItEnded(row.endedOn, row.reason);

  return (
    <Link
      to={paths.session(session.runId, row.sessionId)}
      className={styles.vidtile}
      style={reserve(frameAspect(session))}
      aria-label={`${row.sessionId} · ${person} — ${row.outcome.label}. ${ended}`}
    >
      <Thumb session={session} />
      <span className={styles.meta}>
        <strong>
          {row.sessionId} · {person}
        </strong>
        <span className="faint">{deviceAndSegment(row)}</span>
        <span>
          <Badge variant="ghost" className={`tag ${tagClass(row.outcome.token)}`}>
            {outcomeTag(row)}
          </Badge>
        </span>
      </span>
    </Link>
  );
}

/**
 * The tag as `#screen-grid` draws it: the outcome, and after it the one word that says
 * which outcome of that kind this was — the step it ended on, or `excluded` for a session
 * our own automation broke, which is not a step but the reason the person is out of every
 * figure.
 *
 * The outcome's own word is the vocabulary module's (`src/session/`), shared with the rows
 * of this screen, the Verdict and the replay, so one outcome has one name everywhere in the
 * product rather than a second set of words on this one screen.
 */
function outcomeTag(row: SessionRow): string {
  if (row.excludedFromScores) return `${row.outcome.label} · excluded`;
  if (row.outcome.status === 'success') return row.outcome.label;
  return `${row.outcome.label} · ${row.endedOn.label ?? row.endedOn.step}`;
}

function Thumb({ session }: { session: Session }) {
  const [unreadable, setUnreadable] = useState(false);
  const video = session.video;
  const poster = posterFrame(session);

  if (video === undefined) {
    return (
      <NoThumb>
        <strong>No recording</strong>
        This test did not record video, so there is nothing to watch back for this person.
      </NoThumb>
    );
  }
  if (video.state === 'absent') {
    return (
      <NoThumb>
        <strong>No recording</strong>
        {video.reason}
      </NoThumb>
    );
  }
  if (unreadable) {
    return (
      <NoThumb>
        <strong>This recording could not be read</strong>
        <span className="mono">{video.path}</span>
      </NoThumb>
    );
  }

  return (
    <span className={styles.thumb}>
      <video
        className={styles.frame}
        src={posterSrc(runDataBase(session.runId), video.path, poster?.offsetMs ?? 0)}
        preload="metadata"
        muted
        playsInline
        // The picture is decoration: the tile's own label already names the person and how
        // it went, and a screen reader reading a video element it cannot play adds nothing.
        aria-hidden="true"
        tabIndex={-1}
        onError={() => {
          setUnreadable(true);
        }}
      />
      {poster?.gaze === undefined || poster.gaze === null ? null : (
        <i
          className={styles.gaze}
          style={{ left: `${poster.gaze.xPct}%`, top: `${poster.gaze.yPct}%` }}
        />
      )}
      <span className={styles.play}>{timeLabel(video.durationMs)}</span>
    </span>
  );
}

/** A thumb with words in it instead of a frame, at the shape the tile has reserved. */
function NoThumb({ children }: { children: ReactNode }) {
  return (
    <span className={`${styles.thumb} ${styles.nothumb}`}>
      <span className={styles.nothumbWords}>{children}</span>
    </span>
  );
}

/**
 * A tile whose session file has not arrived. It reserves the prototype's own shape and
 * pulses, which is the one moving thing `docs/FLOW.md` section 10 allows on this screen,
 * and it names the person it is for so the grid is not eight identical grey boxes.
 */
function PendingTile({ sessionId }: { sessionId: string }) {
  return (
    <span className={styles.vidtile} aria-busy="true">
      <span className={styles.thumb}>
        <Skeleton className="h-full w-full rounded-none" />
      </span>
      <span className={styles.meta}>
        <strong>{sessionId}</strong>
        <Skeleton className="h-3 w-24" />
      </span>
    </span>
  );
}

/**
 * A tile whose session file could not be read at all. The person **stays on the screen**
 * and says so where their picture would be: a session dropped from the grid would quietly
 * change what the test measured, which is the one thing these screens exist not to do.
 */
function UnreadableTile({ sessionId, problem }: { sessionId: string; problem: string }) {
  return (
    <span className={styles.vidtile}>
      <NoThumb>
        <strong>This person&rsquo;s session could not be read</strong>
        {problem}
      </NoThumb>
      <span className={styles.meta}>
        <strong>{sessionId}</strong>
      </span>
    </span>
  );
}
