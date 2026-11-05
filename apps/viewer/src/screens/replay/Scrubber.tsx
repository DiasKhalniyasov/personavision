import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { clockLabel, fixationLabel, waitLabel } from './position';
import type { Wait } from './position';
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
 * `.vidbar`: the one control over the replay.
 *
 * It is the same idea as the `Scrubber` above and a different unit. Over a screenshot the
 * position a reader talks in is a **fixation**; over a recording it is a **second** — but a
 * second of the **session**, not of the tape. A recording runs in wall-clock time and
 * includes every second the agent spent being told what to do next, so a track that ran
 * over the file's own length would be four fifths a page that is not moving and a reader
 * who dragged would land in a pause (#414). The track is therefore the session's own clock,
 * from zero to the length the session reports, and the recording is seeked to follow it.
 *
 * **A wait is drawn rather than played.** Each stretch the two clocks disagree about is
 * marked where it falls on this track, carrying the real seconds it took, and the line
 * under the bar says what the marks are. Dragging across one costs the reader nothing,
 * because there is nothing in it to see.
 *
 * The range is the registry's slider, so the arrow keys step it a second at a time and it
 * announces where it is; Play is a labelled button that says which of the two it will do.
 * Whole seconds are the step because a link carries whole seconds: a frame a reader can
 * reach is a frame a reader can cite.
 */
export function VideoBar({
  playing,
  sessionMs,
  durationMs,
  waits,
  fixation,
  position,
  onPlayPause,
  onSeek,
}: {
  playing: boolean;
  /** Where the playhead is, in milliseconds into the **session**. */
  sessionMs: number;
  /** The session's own length, which is what the track runs over. */
  durationMs: number;
  /** The stretches the recording ran on through and the session did not. */
  waits: readonly Wait[];
  /** `fixation 21 of 29`, as the prototype's faint half reads it. */
  fixation: string;
  /** The whole position in words, for a reader who cannot see the stage. */
  position: string;
  onPlayPause: () => void;
  /** Seconds into the session. */
  onSeek: (seconds: number) => void;
}) {
  // Floored, not rounded: the last second a reader can drag to has to be a second the
  // session has, or dragging to the right-hand end would ask for a moment past its end.
  const seconds = Math.floor(durationMs / 1000);

  return (
    <>
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
        <span className={styles.track}>
          <Slider
            id="rp-range"
            min={0}
            max={Math.max(seconds, 1)}
            step={1}
            value={[Math.min(Math.round(sessionMs / 1000), Math.max(seconds, 1))]}
            aria-label="Scrub the recording"
            aria-valuetext={position}
            onValueChange={([next]) => {
              if (next !== undefined) onSeek(next);
            }}
          />
          {waits.map((wait) => (
            <span
              key={wait.fromSessionMs}
              className={styles.wait}
              data-wait={Math.round(wait.waitedMs / 1000)}
              title={waitLabel(wait.waitedMs)}
              style={{ left: `${wait.fromPct}%`, width: `${wait.widthPct}%` }}
            />
          ))}
        </span>
        <span className={`${styles.clock} num`} id="rp-clock">
          {clockLabel(sessionMs, durationMs)}
        </span>
        <span className="faint" id="rp-fixlabel">
          {fixation}
        </span>
      </div>

      {waits.length === 0 ? null : (
        <p className="footnote" data-waits={waits.length}>
          {waitWords(waits)}
        </p>
      )}
    </>
  );
}

/**
 * The marks on the track, in words: how many, how long each really was, and why the replay
 * does not play them.
 *
 * The mark says *where*; this says *what*, which is the half a reader who cannot see the
 * track needs and the half that makes the track readable at a phone's width, where a label
 * on a two-pixel band would have nowhere to go.
 */
function waitWords(waits: readonly Wait[]): string {
  const held = waits.map((wait) => `${String(Math.round(wait.waitedMs / 1000))} s`);
  const last = held[held.length - 1] as string;
  const listed = held.length === 1 ? last : `${held.slice(0, -1).join(', ')} and ${last}`;
  const many = held.length === 1 ? 'one stretch' : `${String(held.length)} stretches`;

  return `Marked on the track: ${many} the recording ran on through while nothing happened on the page — ${listed} — which the replay crosses rather than plays.`;
}
