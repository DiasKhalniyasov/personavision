import type { ClickMark } from './position';
import styles from './replay.module.css';

/**
 * The `.click` marks of `#screen-replay-video`: a ring where each click landed, over the
 * frame the video is showing.
 *
 * It is placed as a percentage of the same box the gaze is placed in, so the ring sits on
 * its element at any player width — the stage is the device's own aspect ratio and the
 * marks are percentages of it, which is what keeps a mark registered to the video's frame
 * rather than to the window.
 *
 * It is `aria-hidden`: a ring drawn on a picture cannot be read out. What carries the same
 * content in words is the stage's own text alternative and the event log beside it, which
 * names every click, what it was aimed at and when.
 */
export function ClickOverlay({ marks }: { marks: readonly ClickMark[] }) {
  return (
    <div className={styles.layer} id="rp-clicks" aria-hidden="true">
      {marks.map((mark) => (
        <i
          key={mark.index}
          className={styles.click}
          data-click={mark.index}
          data-current={mark.current ? '' : undefined}
          style={{ left: `${mark.xPct}%`, top: `${mark.yPct}%` }}
        />
      ))}
    </div>
  );
}
