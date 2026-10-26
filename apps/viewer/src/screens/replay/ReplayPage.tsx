import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { Run, Session } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { sessionTimeline } from '@/session/index.js';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { ReplayFrame } from './ReplayFrame';
import { ReplayHeader } from './ReplayHeader';
import { Scrubber } from './Scrubber';
import { SessionNotFound } from './SessionNotFound';
import { useReplaySession } from './useReplaySession';
import {
  captureFor,
  clockLabel,
  fixationFromParam,
  fixationLabel,
  FIX_PARAM,
  timeLabel,
} from './position';
import './replay.css';

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
 * The right-hand column is mounted empty on purpose: **#24** fills it with the screen
 * intent and the event log, and **#25** with the outcome card.
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
    return <ReplayLoading sessionId={sessionId} />;
  }

  return <Replay run={run.run} session={session.session} screenshotUrl={session.screenshotUrl} />;
}

/**
 * While the session file is read. The heading is what the manifest already knows — which
 * person this is — and the frame is held at its own size in the shell's loading convention,
 * so the screen does not jump when the gaze arrives.
 */
function ReplayLoading({ sessionId }: { sessionId: string }) {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="pagehead">
          <h1>{sessionId}</h1>
        </div>
        <p className="lede">Reading this person&rsquo;s session.</p>
        <div className="replay">
          <div>
            <div className="frame is-mobile" id="rp-frame">
              <Skeleton className="size-full rounded-none" />
            </div>
          </div>
          <div className="timeline" id="rp-timeline" />
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
  const stepLabel =
    run.steps.find((candidate) => candidate.id === current?.step)?.label ??
    current?.step ??
    'first';
  const variantName =
    run.variants.find((variant) => variant.id === session.variant)?.name ?? session.variant;

  /**
   * The whole position in words, which the slider announces: a reader who cannot see the
   * frame is told which fixation, at what time, on which screen.
   */
  const position =
    timeline.fixationCount === 0
      ? 'no fixations were recorded'
      : `${fixationLabel(fixationNumber, timeline.fixationCount)}, ${timeLabel(moment.tMs)} of ${timeLabel(timeline.durationMs)}, on the ${stepLabel} screen`;

  return (
    <div className="strip">
      <div className="wrap">
        <ReplayHeader run={run} session={session} />

        <div className="replay">
          <div>
            <ReplayFrame
              session={session}
              moment={moment}
              capture={capture}
              screenshotUrl={
                current === null ? null : screenshotUrl(session.variant, current.step).toString()
              }
              screenLabel={stepLabel}
              variantName={variantName}
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

          {/* #24 fills this with the screen intent and the event log, #25 with the outcome card. */}
          <div className="timeline" id="rp-timeline" />
        </div>

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}
