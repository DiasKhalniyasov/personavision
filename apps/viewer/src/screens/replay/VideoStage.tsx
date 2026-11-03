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
 * **One clock, and the element is not it.** The position this stage draws is handed to it;
 * what the element owns is the frame it is painting. While the video plays, its own
 * `timeupdate` reports the moment and the page moves everything to it; while it is paused,
 * the page's position is authoritative and the element is seeked to it. That is why the
 * seek below is conditional: a seek on every frame of playback would fight the player.
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
  gaze,
  clicks,
  scanpath,
  trail,
  clickMarks,
  alternative,
  onTime,
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
  gaze: boolean;
  clicks: boolean;
  scanpath: boolean;
  trail: GazeTrail;
  clickMarks: readonly ClickMark[];
  /** Where attention went at this frame, in words: the overlay's text alternative. */
  alternative: string;
  /** The element's own moment, reported while it plays. */
  onTime: (videoMs: number) => void;
  /** The element stopped playing — paused, ended, or refused to start. */
  onStopped: () => void;
  /** The recording's own frame size, once the file says what it is. */
  onResolution: (size: { width: number; height: number }) => void;
}) {
  const element = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unreadable'>('loading');

  /**
   * The element is seeked when it is not already **inside the second the page names**.
   *
   * The page's position is whole seconds, because that is what a link carries, and a playing
   * element runs through the whole of each one — so an element at 7.85 while the page says 7
   * is where it should be, and snapping it to 7.0 would rewind the frame the reader is
   * watching. That is what pausing and ending do: both leave the element part-way through
   * the page's current second, and a seek there would jump the picture backwards, or off the
   * end of a recording that had just finished.
   *
   * Anything else — a dragged scrubber, a link opened on a frame, the element behind the
   * page — is a real divergence and is followed at once.
   */
  useEffect(() => {
    const video = element.current;
    if (video === null) return;
    const ahead = video.currentTime * 1000 - videoMs;
    if (ahead < 0 || ahead >= A_SECOND) video.currentTime = videoMs / 1000;
  }, [videoMs]);

  useEffect(() => {
    const video = element.current;
    if (video === null) return;
    if (!playing) {
      video.pause();
      return;
    }
    // A browser may refuse to start — a file it cannot decode, a gesture it wanted. The
    // refusal is reported rather than swallowed, so the button does not read as playing
    // while the frame sits still.
    void Promise.resolve(video.play()).catch(() => {
      onStopped();
    });
  }, [playing, onStopped]);

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
          const ahead = video.currentTime * 1000 - videoMs;
          if (ahead < 0 || ahead >= A_SECOND) video.currentTime = videoMs / 1000;
        }}
        onTimeUpdate={(event) => {
          if (playing) onTime(event.currentTarget.currentTime * 1000);
        }}
        onEnded={onStopped}
        onPause={onStopped}
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

/** The page's position is whole seconds, and this is one of them. */
const A_SECOND = 1000;
