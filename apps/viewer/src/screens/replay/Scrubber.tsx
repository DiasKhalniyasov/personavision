import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { clockLabel, fixationLabel } from './position';
import styles from './replay.module.css';

/**
 * `.scrub`: one control over one clock.
 *
 * Moving it moves the gaze, the scroll offset and the screen together, because all three
 * are derived from the position it reports and nothing here holds a second copy of the
 * session's state. The position is a **fixation number** — the unit a designer talks in —
 * and the session's own timeline turns it into a time.
 *
 * It is operable without a pointer: the slider is a shadcn/Radix primitive, so the arrow
 * keys step it by one fixation and it announces where it is; the two buttons do the same
 * thing for a reader who would rather click, and both ends stop rather than wrap.
 */
export function Scrubber({
  fixationNumber,
  fixationCount,
  clock,
  position,
  onGoTo,
  onStep,
}: {
  /** 1-based; `0` in a session that recorded no fixations. */
  fixationNumber: number;
  fixationCount: number;
  /** What the clock reads: elapsed against total. */
  clock: string;
  /** The whole position in words, for a reader who cannot see the frame. */
  position: string;
  onGoTo: (fixationNumber: number) => void;
  onStep: (direction: 1 | -1) => void;
}) {
  const empty = fixationCount === 0;

  return (
    <div className={styles.scrub}>
      <div className={styles.row}>
        <Button
          id="rp-prev"
          variant="outline"
          size="sm"
          aria-label="Previous fixation"
          disabled={empty || fixationNumber <= 1}
          onClick={() => onStep(-1)}
        >
          &larr; Fixation
        </Button>
        <Button
          id="rp-next"
          variant="outline"
          size="sm"
          aria-label="Next fixation"
          disabled={empty || fixationNumber >= fixationCount}
          onClick={() => onStep(1)}
        >
          Fixation &rarr;
        </Button>
        <span className={`${styles.clock} num`} id="rp-clock">
          {clock}
        </span>
      </div>

      <div className={styles.row}>
        <Slider
          id="rp-range"
          min={1}
          max={Math.max(fixationCount, 1)}
          step={1}
          value={[Math.max(fixationNumber, 1)]}
          disabled={empty}
          aria-label="Fixation"
          aria-valuetext={position}
          onValueChange={([next]) => {
            if (next !== undefined) onGoTo(next);
          }}
        />
        <span className="microlabel" id="rp-fixlabel">
          {empty ? 'no fixations' : fixationLabel(fixationNumber, fixationCount)}
        </span>
      </div>

      <p className="footnote">
        Scrubbing moves gaze, scrolling, clicks and typing together. The screen shown is the one
        this person was on at that moment.
      </p>

      {empty ? (
        <p className="footnote">
          No fixations were recorded for this person, so there is nothing to scrub through. The
          screen above is the one they started on.
        </p>
      ) : null}
    </div>
  );
}

/**
 * `.vidbar`: the one control over the recording.
 *
 * It is the same idea as the `Scrubber` above and a different unit. Over a screenshot the
 * position a reader talks in is a **fixation**; over a recording it is a **second**, which
 * is what a citation carries (`?t=`), what the clock reads and what the range runs over —
 * so dragging it moves the video, the gaze, the highlighted screen, the active row of the
 * log and the fixation counter, because all of them are read off the second it reports.
 *
 * The range is the registry's slider, so the arrow keys step it a second at a time and it
 * announces where it is; Play is a labelled button that says which of the two it will do.
 * Whole seconds are the step because a link carries whole seconds: a frame a reader can
 * reach is a frame a reader can cite.
 */
export function VideoBar({
  playing,
  videoMs,
  durationMs,
  fixation,
  position,
  onPlayPause,
  onSeek,
}: {
  playing: boolean;
  /** Where the playhead is, in milliseconds into the recording. */
  videoMs: number;
  durationMs: number;
  /** `fixation 21 of 29`, as the prototype's faint half reads it. */
  fixation: string;
  /** The whole position in words, for a reader who cannot see the stage. */
  position: string;
  onPlayPause: () => void;
  /** Seconds into the recording. */
  onSeek: (seconds: number) => void;
}) {
  // Floored, not rounded: the last second a reader can drag to has to be a second the
  // recording has, or dragging to the right-hand end would ask for a moment past its end
  // and the screen would say the link overshot when nobody had followed a link.
  const seconds = Math.floor(durationMs / 1000);

  return (
    <div className={styles.vidbar}>
      <Button
        id="rp-play"
        variant="outline"
        size="sm"
        aria-label={playing ? 'Pause the recording' : 'Play the recording'}
        onClick={onPlayPause}
      >
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Slider
        id="rp-range"
        min={0}
        max={Math.max(seconds, 1)}
        step={1}
        value={[Math.min(Math.round(videoMs / 1000), Math.max(seconds, 1))]}
        aria-label="Scrub the recording"
        aria-valuetext={position}
        onValueChange={([next]) => {
          if (next !== undefined) onSeek(next);
        }}
      />
      <span className={`${styles.clock} num`} id="rp-clock">
        {clockLabel(videoMs, durationMs)}
      </span>
      <span className="faint" id="rp-fixlabel">
        {fixation}
      </span>
    </div>
  );
}
