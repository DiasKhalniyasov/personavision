import { useEffect, useRef, useState } from 'react';
import { ClickOverlay } from './ClickOverlay';
import { GazeOverlay } from './GazeOverlay';
import { timeLabel } from './position';
import type { ClickMark, GazeTrail } from './position';
import styles from './replay.module.css';

/**
 * `.vidstage`: the recording, with the gaze and the clicks drawn over it.
 *
 * **The video is the stage.** It is played from the run directory over the read-only run
 * mount (`docs/adr/0001-run-data-over-http-as-static-files.md`), which serves a byte range,
 * so seeking fetches the part of the file it needs and nothing is computed on a server.
 *
 * **The overlay is registered to the video's own frame.** The stage is the device's aspect
 * ratio, the video fills it, and every mark is a percentage of that same box — so a mark
 * sits on its element at any player width, and nothing drifts when the window changes.
 *
 * **One clock, and the element is not it.** The clock the replay runs on is the session's
 * own and the page owns it (`ReplayPage.tsx`); what this stage is handed is the moment of
 * the **recording** that moment of the session falls at, and the element is seeked to
 * follow. That is why the seek below is conditional: a seek on every tick of playback would
 * fight the player, so it is left alone while it is painting the moment the page is at.
 *
 * **A wait is crossed, not played.** Between two actions the recording ran on through and
 * the session did not, nothing happened on the page: the page holds its position on the
 * frame the wait ends on, this stage holds the element still there, and the badge says how
 * many real seconds the agent spent deciding. Playing those seconds back is the defect this
 * screen was built to stop, and it is what made a 9 s session a 2 minute replay (#414).
 *
 * **Nothing here autoplays.** A replay opens paused, at the frame the link asks for, which
 * is also what `prefers-reduced-motion: reduce` asks of a video that carries meaning: it
 * moves when the reader presses Play, and not before.
 */
export function VideoStage({
  src,
  path,
  aspect,
  videoMs,
  durationMs,
  playing,
  held,
  waiting,
  gaze,
  clicks,
  scanpath,
  trail,
  clickMarks,
  alternative,
  onStopped,
  onResolution,
}: {
  /** The recording's URL under the run mount. */
  src: string;
  /** Its run-directory-relative path, which an error states. */
  path: string;
  /** The device's own shape, as a CSS `aspect-ratio`, or `null` to keep the stage's own. */
  aspect: string | null;
  /** Where the page says the playhead is, in milliseconds into the recording. */
  videoMs: number;
  durationMs: number;
  playing: boolean;
  /** The session's clock is crossing a wait, so the recording is held on this frame. */
  held: boolean;
  /** `deciding… 14 s`, over the stage, or `null` when the recording is being played. */
  waiting: string | null;
  gaze: boolean;
  clicks: boolean;
  scanpath: boolean;
  trail: GazeTrail;
  clickMarks: readonly ClickMark[];
  /** Where attention went at this frame, in words: the overlay's text alternative. */
  alternative: string;
  /** The element will not play at all: a file it cannot decode, or a refused start. */
  onStopped: () => void;
  /** The recording's own frame size, once the file says what it is. */
  onResolution: (size: { width: number; height: number }) => void;
}) {
  const element = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unreadable'>('loading');

  /**
   * The element is seeked when it is **more than a second from where the page is**.
   *
   * The page's clock ticks several times a second and a playing element runs on by itself,
   * so the two are never on the same millisecond and snapping on every tick would stutter
   * the picture for nothing. A second of slack is the tolerance: inside it the element is
   * painting the moment the page is at and is left alone.
   *
   * Everything that really moves the playhead is outside it — a dragged scrubber, a link
   * opened on a frame, and above all a wait, where the page's position jumps by every second
   * the agent spent deciding and the element has to arrive there at once.
   */
  useEffect(() => {
    const video = element.current;
    if (video === null) return;
    if (Math.abs(video.currentTime * 1000 - videoMs) >= A_SECOND) {
      video.currentTime = videoMs / 1000;
    }
  }, [videoMs]);

  useEffect(() => {
    const video = element.current;
    if (video === null) return;
    // Held still while the session's clock crosses a wait: there is nothing in the stretch
    // to play, and the frame the page is holding is the one the wait ends on.
    if (!playing || held) {
      video.pause();
      return;
    }
    // A browser may refuse to start — a file it cannot decode, a gesture it wanted. The
    // refusal is reported rather than swallowed, so the button does not read as playing
    // while the frame sits still.
    void Promise.resolve(video.play()).catch(() => {
      onStopped();
    });
  }, [playing, held, onStopped]);

  return (
    <div
      className={styles.vidstage}
      style={aspect === null ? undefined : { aspectRatio: aspect }}
      data-stage="video"
    >
      <video
        ref={element}
        className={styles.video}
        src={src}
        // The recording carries no sound, and the player's own controls are the `.vidbar`
        // below it, labelled and keyboard-operable. The picture itself cannot be read out,
        // so it is not in the accessibility tree: the overlay's text alternative and the
        // event log are what carry this session in words.
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        tabIndex={-1}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setState('ready');
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onResolution({ width: video.videoWidth, height: video.videoHeight });
          }
          // A seek before the metadata arrived may not have taken: the element did not yet
          // know how long the file was. The frame the link asked for is asked for again.
          if (Math.abs(video.currentTime * 1000 - videoMs) >= A_SECOND) {
            video.currentTime = videoMs / 1000;
          }
        }}
        // Neither `pause` nor `ended` is reported: the replay's clock is the session's and
        // the element is not it. The element is paused on purpose at every wait, and a
        // recording that runs out before the session's last figure has ended without the
        // replay having.
        onError={() => {
          setState('unreadable');
          onStopped();
        }}
      />

      {/* One box over the video, named in words, holding whichever layers are on. The name
          is on the box and not on a layer, so turning the gaze off does not take the
          reading of this frame away with it. */}
      <div className={styles.overlay} role="img" aria-label={alternative}>
        {gaze || scanpath ? <GazeOverlay trail={trail} marks={gaze} scanpath={scanpath} /> : null}
        {clicks ? <ClickOverlay marks={clickMarks} /> : null}
      </div>

      {/* Over the stage and over the overlay: the seconds this stretch of the recording
          really took, which the replay has crossed rather than played. */}
      {waiting === null ? null : (
        <span className={styles.waiting} data-waiting="true">
          {waiting}
        </span>
      )}

      {state === 'loading' ? (
        <span className={styles.scrim} data-stage-state="loading">
          the recorded session &middot; {timeLabel(videoMs)} of {timeLabel(durationMs)}
        </span>
      ) : null}
      {state === 'unreadable' ? (
        <span className={styles.scrim} data-stage-state="unreadable">
          This recording could not be loaded. It should be at <span className="mono">{path}</span>{' '}
          in this test&rsquo;s directory. The timeline, the event log and the outcome card beside it
          are this person&rsquo;s own and still read.
        </span>
      ) : null}
    </div>
  );
}

/** The slack between the page's clock and the element's, in milliseconds. */
const A_SECOND = 1000;
