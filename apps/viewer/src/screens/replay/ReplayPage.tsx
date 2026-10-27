import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { Run, Session } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { sessionTimeline } from '@/session/index.js';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { OutcomeCard } from './OutcomeCard';
import { ReplayFrame } from './ReplayFrame';
import { ReplayHeader } from './ReplayHeader';
import { ScreenTimeline } from './ScreenTimeline';
import { Scrubber } from './Scrubber';
import { SessionNotFound } from './SessionNotFound';
import { useReplaySession } from './useReplaySession';
import { clockLabel, fixationFromParam, fixationLabel, FIX_PARAM, timeLabel } from './position';
import styles from './replay.module.css';
import { captureFor, stepLabel, variantName } from './runWords';

/**
 * `/runs/:runId/sessions/:sessionId?fix=` — the half a designer watches: the page as this
 * person saw it, their gaze on top of it, and one scrubber that moves all of it together.
 *
 * **One clock.** The scrubber's position is a fixation number in the URL; the session's own
 * timeline (#20) turns it into a time, and the screen, the scroll offset, the gaze and the
 * clock are all read off that one moment. Nothing here keeps a second position, so the
 * three cannot drift apart, and `?fix=` is the whole of the screen's state — a colleague
 * handed the link sees the same moment.
 *
 * The right-hand column is the same session in words: **#24**'s screen cards carry the
 * intent the agent stated and the transcript of what it did, and **#25** closes the column
 * with the outcome card. The cards read the same moment the frame does, and clicking a row
 * of the log moves the scrubber, so reading and navigating are the same thing.
 */
export function ReplayPage() {
  const { runId = '', sessionId = '' } = useParams();
  const run = useRun(runId);
  const session = useReplaySession(runId, sessionId);

  if (run.status === 'not-found') return <RunNotFound runId={run.runId} url={run.url} />;
  if (run.status === 'unreadable') {
    return <RunNotFound runId={run.runId} url={run.url} problem={run.problem} />;
  }
  if (session.status === 'not-found') {
    return <SessionNotFound runId={runId} sessionId={session.sessionId} />;
  }
  if (session.status === 'unreadable') {
    return (
      <SessionNotFound runId={runId} sessionId={session.sessionId} problem={session.problem} />
    );
  }
  if (run.status === 'loading' || session.status === 'loading') {
    return <ReplayLoading runId={runId} sessionId={sessionId} />;
  }

  return <Replay run={run.run} session={session.session} screenshotUrl={session.screenshotUrl} />;
}

/**
 * While the session file is read.
 *
 * The header is what the run's manifest already knows, which is the breadcrumb and which
 * person this is: `run.json` lists the session ids and the personas, but nothing in it says
 * which persona, version or seed a given session was — those are the session file's own,
 * and are filled in when it arrives. The frame is held at its own size in the shell's
 * loading convention, so the screen does not jump underneath the reader.
 */
function ReplayLoading({ runId, sessionId }: { runId: string; sessionId: string }) {
  return (
    <div className="strip">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.run(runId)}>Verdict</Link> /{' '}
          <Link to={paths.sessions(runId)}>People</Link> / {sessionId}
        </p>
        <div className="pagehead">
          <h1>{sessionId}</h1>
        </div>
        <p className="lede">Reading this person&rsquo;s session.</p>
        <div className={styles.replay}>
          <div>
            <div className={`${styles.frame} ${styles.mobile}`} id="rp-frame">
              <Skeleton className="size-full rounded-none" />
            </div>
          </div>
          <div className={styles.timeline} id="rp-timeline" />
        </div>
      </div>
    </div>
  );
}

function Replay({
  run,
  session,
  screenshotUrl,
}: {
  run: Run;
  session: Session;
  screenshotUrl: (variant: string, step: string) => URL;
}) {
  const [params, setParams] = useSearchParams();
  const timeline = useMemo(() => sessionTimeline(session), [session]);

  const fixationNumber = fixationFromParam(params.get(FIX_PARAM), timeline.fixationCount);
  const tMs = timeline.timeAtFixation(fixationNumber);
  const moment = timeline.at(tMs);

  /**
   * The position is URL state, and it is **replaced** rather than pushed: a session walked
   * fixation by fixation would otherwise leave twenty-three entries between the reader and
   * the back button.
   */
  const goTo = (next: number): void => {
    const updated = new URLSearchParams(params);
    updated.set(FIX_PARAM, String(next));
    setParams(updated, { replace: true });
  };

  const stepBy = (direction: 1 | -1): void => {
    const moved = timeline.at(timeline.stepFixation(tMs, direction));
    goTo(moved.fixationNumber ?? fixationNumber);
  };

  const current = moment.screen;
  const capture = current === null ? null : captureFor(run, session.variant, current.step);
  // A session with no screens at all has no step to name; the frame then says it holds no
  // screenshot, and the words around it still read.
  const screenName = current === null ? 'first' : stepLabel(run, current.step);
  const version = variantName(run, session.variant);

  /**
   * The whole position in words, which the slider announces: a reader who cannot see the
   * frame is told which fixation, at what time, on which screen.
   */
  const position =
    timeline.fixationCount === 0
      ? 'no fixations were recorded'
      : `${fixationLabel(fixationNumber, timeline.fixationCount)}, ${timeLabel(moment.tMs)} of ${timeLabel(timeline.durationMs)}, on the ${screenName} screen`;

  return (
    <div className="strip">
      <div className="wrap">
        <ReplayHeader run={run} session={session} />

        <div className={styles.replay}>
          <div>
            <ReplayFrame
              session={session}
              moment={moment}
              capture={capture}
              screenshotUrl={
                current === null ? null : screenshotUrl(session.variant, current.step).toString()
              }
              screenLabel={screenName}
              variantName={version}
            />
            <Scrubber
              fixationNumber={fixationNumber}
              fixationCount={timeline.fixationCount}
              clock={clockLabel(moment.tMs, timeline.durationMs)}
              position={position}
              onGoTo={goTo}
              onStep={stepBy}
            />
          </div>

          <div className={styles.timeline} id="rp-timeline">
            <ScreenTimeline
              run={run}
              session={session}
              timeline={timeline}
              moment={moment}
              onGoTo={goTo}
            />
            {/* The card that closes the column: what this session means, and why it can be
                believed. It is about the session as a whole, so it does not move with the
                scrubber. */}
            <OutcomeCard run={run} session={session} />
          </div>
        </div>

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}
