import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { Run, Session } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { frameAspect } from '@/screens/sessions/rows';
import { sessionTimeline } from '@/session/index.js';
import type { SessionTimeline, TimelineMoment } from '@/session/index.js';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { runDataBase, useRecordingSize, useRun } from '@/shell/useRun';
import { OutcomeCard } from './OutcomeCard';
import type { RecordingFacts } from './OutcomeCard';
import { ReplayFrame } from './ReplayFrame';
import { ReplayHeader } from './ReplayHeader';
import { ScreenTimeline } from './ScreenTimeline';
import { Scrubber, VideoBar } from './Scrubber';
import { SessionNotFound } from './SessionNotFound';
import { useReplaySession } from './useReplaySession';
import { VideoStage } from './VideoStage';
import {
  clickMarks,
  clockLabel,
  fixationFromParam,
  fixationLabel,
  FIX_PARAM,
  gazeTrail,
  recordingOf,
  T_PARAM,
  timeLabel,
  videoClock,
  videoTimeFromParam,
} from './position';
import type { Recording } from './position';
import styles from './replay.module.css';
import { captureFor, stepLabel, variantName } from './runWords';

/**
 * `/runs/:runId/sessions/:sessionId?t=&fix=` — one person's whole attempt, over the
 * recording of it.
 *
 * **The video is the stage** (`docs/FLOW.md` section 14.3): the recording is played from
 * the run directory over the read-only run mount, with the gaze, the clicks and the
 * scanpath drawn over the frame it is showing.
 *
 * **One clock.** The playhead is a moment of the recording and it is the screen's whole
 * position: the video's time, the highlighted screen in the timeline, the active row of the
 * event log and the fixation counter are every one of them read off it, through the
 * session's own timeline (#20) and the offsets the recording stores (#253). Nothing here
 * keeps a second position, so dragging the scrubber and letting the video play move the
 * same four things, and they cannot drift apart.
 *
 * **The moment is in the URL**, as `?t=` in seconds — which is what a recommendation cites,
 * so a citation from the Summary or the Analysis opens paused on exactly the frame it
 * claims. The overlay switches are **not** URL state: what a link carries is the timestamp,
 * not how the reader had their layers set.
 *
 * **A session with no recording keeps its replay.** The screenshot stage below is the
 * fallback — the page as that person saw it, scrubbed by fixation with `?fix=` — so the
 * intent, the event log and the outcome card are readable for a session whose recording was
 * never made.
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
 * and are filled in when it arrives. The stage is held at its own size and the side panel
 * keeps its height in the shell's loading convention, so the screen does not jump
 * underneath the reader when either arrives.
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
            <div className={styles.vidstage} id="rp-frame">
              <Skeleton className="size-full rounded-none" />
            </div>
          </div>
          {/* The panel holds its own height while the session is read, so the words
              arriving in it do not push the page down under the reader: one card's worth
              of transcript, and the outcome card under it. */}
          <div className={styles.timeline} id="rp-timeline">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Which of the two stages this session gets: the recording it made, or the pages it saw. */
function Replay({
  run,
  session,
  screenshotUrl,
}: {
  run: Run;
  session: Session;
  screenshotUrl: (variant: string, step: string) => URL;
}) {
  const recording = recordingOf(session);

  if (recording === null) {
    return <ScreenshotReplay run={run} session={session} screenshotUrl={screenshotUrl} />;
  }
  return <RecordedReplay run={run} session={session} recording={recording} />;
}

/**
 * The screen around either stage: the header, the two columns, and the column of words.
 *
 * Both stages hand it the same two things — the moment the screen is at, and the way to
 * move it — so the timeline, the event log and the outcome card are written once and read
 * the same moment whichever stage is above them.
 */
function ReplayLayout({
  run,
  session,
  timeline,
  moment,
  onGoTo,
  recording,
  children,
}: {
  run: Run;
  session: Session;
  timeline: SessionTimeline;
  moment: TimelineMoment;
  onGoTo: (fixationNumber: number) => void;
  recording?: RecordingFacts;
  children: ReactNode;
}) {
  return (
    <div className="strip">
      <div className="wrap">
        <ReplayHeader run={run} session={session} />

        <div className={styles.replay}>
          <div>{children}</div>

          <div className={styles.timeline} id="rp-timeline">
            <ScreenTimeline
              run={run}
              session={session}
              timeline={timeline}
              moment={moment}
              onGoTo={onGoTo}
            />
            {/* The card that closes the column: what this session means, why it can be
                believed, and which file to check. It is about the session as a whole, so it
                does not move with the scrubber. */}
            <OutcomeCard run={run} session={session} recording={recording} />
          </div>
        </div>

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * The stage this ticket is about: the recording, with one clock over all of it.
 *
 * The playhead lives in the URL and nowhere else. `?t=` is **seconds into the recording**,
 * so every reader of the same link sees the same frame; the video element's own time is the
 * finer thing it paints, reported back while it plays and followed by everything else.
 *
 * **`?t=` wins over `?fix=`.** Both open a moment, and over a recording the recording is
 * what is being addressed: `t` is the unit a citation carries and the unit the frame has,
 * while `fix` is the unit of a session with no video — so a link carrying both opens on the
 * second it names, and `fix` still opens the fixation it names when `t` is absent.
 */
function RecordedReplay({
  run,
  session,
  recording,
}: {
  run: Run;
  session: Session;
  recording: Recording;
}) {
  const [params, setParams] = useSearchParams();
  const timeline = useMemo(() => sessionTimeline(session), [session]);
  const clock = useMemo(() => videoClock(session, recording), [session, recording]);

  const [playing, setPlaying] = useState(false);
  const [layers, setLayers] = useState<Layers>(SHOWN_AT_FIRST);
  const [resolution, setResolution] = useState<RecordingFacts['resolution']>(null);

  const src = `${runDataBase(session.runId)}${recording.path}`;
  const sizeBytes = useRecordingSize(session.runId, recording.path);

  /**
   * Where the playhead is. `?t=` is the recording's own second; `?fix=` is a fixation, and
   * a link carrying neither opens on the **first fixation** — the moment the screenshot
   * stage opens on, so the same person opened from the Sessions grid lands on the same
   * moment of their attempt whether or not their session was recorded.
   */
  const asked = videoTimeFromParam(params.get(T_PARAM), recording.durationMs);
  const videoMs =
    asked !== null
      ? asked.videoMs
      : clock.videoMsAt(
          timeline.timeAtFixation(fixationFromParam(params.get(FIX_PARAM), timeline.fixationCount)),
        );

  const moment = timeline.at(clock.sessionMsAt(videoMs));

  /**
   * The playhead, written as whole seconds and **replaced** rather than pushed: a session
   * played through would otherwise leave a history entry per second between the reader and
   * the back button. `?fix=` goes when the reader moves, because the moment is now `t`'s to
   * carry and two parameters saying different things is the one state this screen refuses.
   */
  const goToMs = useCallback(
    (nextMs: number): void => {
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          updated.set(T_PARAM, String(Math.max(Math.floor(nextMs / 1000), 0)));
          updated.delete(FIX_PARAM);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The element paints four frames a second and the URL carries whole seconds, so it is
  // written when the second changes and not on every frame.
  const onTime = useCallback(
    (elementMs: number): void => {
      if (Math.floor(elementMs / 1000) !== Math.floor(videoMs / 1000)) goToMs(elementMs);
    },
    [goToMs, videoMs],
  );

  const onStopped = useCallback((): void => {
    setPlaying(false);
  }, []);

  const current = moment.screen;
  const screenName = current === null ? 'first' : stepLabel(run, current.step);
  const capture = current === null ? null : captureFor(run, session.variant, current.step);
  // The box every mark is placed in: the device this person used, which is the shape the
  // recording was made at. A session imported from a real participant carries no persona,
  // and then the captured page's own viewport is the next best box.
  const box = session.persona?.device ?? (capture === null ? null : capture);
  const trail = box === null ? EMPTY_TRAIL : gazeTrail(session, moment, box);
  const marks = box === null ? [] : clickMarks({ run, session, timeline, moment, box });

  const position = `${clockLabel(videoMs, recording.durationMs)}, ${fixationWords(moment, timeline)}, on the ${screenName} screen`;

  return (
    <ReplayLayout
      run={run}
      session={session}
      timeline={timeline}
      moment={moment}
      onGoTo={(fixationNumber) => goToMs(clock.videoMsAt(timeline.timeAtFixation(fixationNumber)))}
      recording={{ sizeBytes, resolution }}
    >
      <VideoStage
        src={src}
        path={recording.path}
        // The stage is the recording's own shape as soon as the file says what it is, and
        // the device's until then: the overlay is placed in percentages of this box, so a
        // box of another shape would put every mark slightly off its element.
        aspect={
          resolution === null ? frameAspect(session) : `${resolution.width} / ${resolution.height}`
        }
        videoMs={videoMs}
        durationMs={recording.durationMs}
        playing={playing}
        gaze={layers.gaze}
        clicks={layers.clicks}
        scanpath={layers.scanpath}
        trail={trail}
        clickMarks={marks}
        alternative={attentionWords({ run, session, moment, marks, videoMs })}
        onTime={onTime}
        onStopped={onStopped}
        onResolution={setResolution}
      />

      <VideoBar
        playing={playing}
        videoMs={videoMs}
        durationMs={recording.durationMs}
        fixation={fixationWords(moment, timeline)}
        position={position}
        onPlayPause={() => setPlaying((was) => !was)}
        onSeek={(seconds) => {
          setPlaying(false);
          goToMs(seconds * 1000);
        }}
      />

      {asked?.pastEnd === true ? (
        <p className="footnote" data-past-end>
          This link asks for {timeLabel(asked.askedMs)}, which is past the end of a{' '}
          {timeLabel(recording.durationMs)} recording
          {recording.truncated === null ? '' : ` — one the ${recording.truncated} cap cut short`},
          so the replay opens on its last frame.
        </p>
      ) : null}

      <OverlaySwitches layers={layers} onChange={setLayers} />
    </ReplayLayout>
  );
}

/** The gaze when there is no box to place it in: nothing drawn, and the words still read. */
const EMPTY_TRAIL = { marks: [], hops: [] } as const;

/** Which overlays are drawn. The reader's own, and never in the URL. */
interface Layers {
  readonly gaze: boolean;
  readonly clicks: boolean;
  readonly scanpath: boolean;
}

/** As `#screen-replay-video` draws them: the gaze and the clicks on, the scanpath off. */
const SHOWN_AT_FIRST: Layers = { gaze: true, clicks: true, scanpath: false };

const SWITCHES: readonly { readonly id: keyof Layers; readonly label: string }[] = [
  { id: 'gaze', label: 'Gaze' },
  { id: 'clicks', label: 'Clicks' },
  { id: 'scanpath', label: 'Scanpath' },
];

/**
 * The `.toggles` under the bar: three independent layers, and the line that says what the
 * one scrubber above them does.
 *
 * Each switch is the registry's `toggle` primitive carrying `aria-pressed`, which is what
 * this product's on/off controls say — the prototype draws a checkbox, and the Heatmaps
 * screen's own overlay switches are the same primitive. They are state of the reader's
 * session and not of the link: a colleague handed this URL opens on the same frame, with
 * their own layers.
 */
function OverlaySwitches({
  layers,
  onChange,
}: {
  layers: Layers;
  onChange: (next: Layers) => void;
}) {
  return (
    <div className={styles.toggles}>
      {SWITCHES.map(({ id, label }) => (
        <Toggle
          key={id}
          data-overlay-toggle={id}
          variant="outline"
          size="sm"
          pressed={layers[id]}
          onPressedChange={(next) => onChange({ ...layers, [id]: next })}
        >
          {label}
        </Toggle>
      ))}
      <span className="faint">
        The scrubber moves the video, the gaze, the timeline and the log together.
      </span>
    </div>
  );
}

/** `fixation 21 of 29`, or the honest absence of one. */
function fixationWords(moment: TimelineMoment, timeline: SessionTimeline): string {
  if (timeline.fixationCount === 0) return 'no fixations were recorded';
  if (moment.fixationNumber === null) return `before the first of ${timeline.fixationCount}`;
  return fixationLabel(moment.fixationNumber, timeline.fixationCount);
}

/**
 * The overlay's text alternative: where this person's attention was at the frame on screen.
 *
 * A drawing of a gaze cannot be read out, so the box it is drawn in is named in words
 * instead — the second, which fixation of how many, the area the run says it landed on, how
 * long it was held, and how many clicks are marked on this screen. It is the same facts the
 * event log beside it carries row by row, said about the one frame being shown, so a reader
 * who cannot see the stage is told what the stage is showing rather than that there is one.
 */
function attentionWords(input: {
  run: Run;
  session: Session;
  moment: TimelineMoment;
  marks: readonly { readonly label: string }[];
  videoMs: number;
}): string {
  const { run, session, moment, marks, videoMs } = input;
  const at = `Where this person was looking at ${timeLabel(videoMs)}`;
  const fixation = moment.fixation;

  if (fixation === null) {
    return `${at}: nothing was recorded yet at this moment of the recording.`;
  }
  const area = run.aois.find((aoi) => aoi.id === fixation.aoiId);
  const held = `held ${(fixation.durationMs / 1000).toFixed(1)} seconds`;
  const where = area === undefined ? 'away from any area this test names' : `on ${area.label}`;
  const clicks =
    marks.length === 0
      ? 'no clicks are marked on this screen'
      : `${marks.length} click${marks.length === 1 ? '' : 's'} marked on this screen: ${marks.map((mark) => mark.label).join(', ')}`;

  return `${at}: fixation ${fixation.index + 1} of ${session.fixations.length}, ${where}, ${held}. And ${clicks}.`;
}

/**
 * The fallback stage: the page as this person saw it, for a session with no recording.
 *
 * This is the replay as it was before the recording became the stage, and it is kept for
 * the one case the ticket keeps it for: a session whose recorder wrote no file still has an
 * intent, an event log and an outcome, and all three are readable here. The position is a
 * fixation number in `?fix=`, which is the unit a screenshot has — a page capture carries no
 * timestamp to cite.
 */
function ScreenshotReplay({
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
    <ReplayLayout
      run={run}
      session={session}
      timeline={timeline}
      moment={moment}
      onGoTo={goTo}
      recording={undefined}
    >
      <p className="footnote" data-no-recording>
        This session has no recording, so the stage is the page as this person saw it. Their stated
        intent, the event log and the outcome below are their own.
      </p>
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
    </ReplayLayout>
  );
}
