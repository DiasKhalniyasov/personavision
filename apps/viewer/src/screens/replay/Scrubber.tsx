import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { fixationLabel } from './position';
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
