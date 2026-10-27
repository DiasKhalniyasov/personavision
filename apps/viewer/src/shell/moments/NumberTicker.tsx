import { useLayoutEffect, useRef } from 'react';
import { useMoment } from '../motion';
import styles from './moments.module.css';

/**
 * A number ticker: a figure counting up to its final value over `--moment-ticker-duration`.
 *
 * The first of the three Aceternity moments of `docs/FLOW.md` section 10, published here so
 * that the Verdict screen (#125), the landing page (#123) and the demo page (#124) mount the
 * same one.
 *
 * **The answer never counts.** `format(value)` — the figure as the artifact stores it — is
 * rendered by React and is in the DOM from the first paint; the loop below writes to an
 * attribute that CSS draws over the top of it, and never to a text node. So a screen reader
 * announces the answer, a test reads the answer, and the digits a reader watches are
 * decoration that is hidden from the accessibility tree. Nothing re-renders while they run
 * either: the count is an attribute, so React is not asked to do a thing for 900ms.
 *
 * **No layout shifts.** The answer keeps its box the whole time (`opacity`, never `display`),
 * so the width reserved is the width the final figure needs, and the count is drawn over it
 * out of flow. Tabular numerals come from the figure this is mounted in — `.num` in the app's
 * base stylesheet — so every frame is the same width as the answer under it.
 *
 * **Two forms of one number agree at every frame.** The Verdict screen says the same share
 * twice, as *8 in 10* and as *82%*, and mounts a ticker on each. Both are driven by the
 * timestamp their frame was handed, which is one timestamp for every callback of that frame,
 * and both compute their text from `value * progress` through their own `format` — so the two
 * forms are two readings of one count rather than two counts.
 *
 * **It runs once.** The loop is started on mount and never again: a filter resolving or a
 * query settling re-renders the screen, and a number a reader is reading must not start
 * moving again. Under `prefers-reduced-motion` `useMoment` answers `0` and the loop does not
 * start at all — the finished state, immediately, which is the only state there has been.
 */

/** Marks the ticker while the count is on top of the answer. */
const TICKING = 'data-ticking';

/** What the count is written to, and what the stylesheet draws from. */
const COUNT = 'data-count';

export interface NumberTickerProps {
  /** The figure's final value, as the artifact stores it. */
  value: number;
  /**
   * How the product writes a value of this kind. Called for the answer and for every frame
   * of the count, so that a frame is written in the same words as the answer it arrives at.
   */
  format: (value: number) => string;
}

export function NumberTicker({ value, format }: NumberTickerProps) {
  const duration = useMoment('ticker');
  const field = useRef<HTMLSpanElement>(null);
  const counting = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const ticker = field.current;
    const count = counting.current;
    // `0` is what `useMoment` answers under `prefers-reduced-motion`: the answer is already
    // rendered and there is nothing for a moment to do but leave it alone.
    if (duration === 0 || ticker === null || count === null) return;

    let frame = 0;
    let started: number | null = null;

    const draw = (now: number): void => {
      started ??= now;
      const progress = Math.min(1, (now - started) / duration);
      count.setAttribute(COUNT, format(value * progress));
      if (progress < 1) {
        frame = requestAnimationFrame(draw);
        return;
      }
      // The figure a reader keeps is the one React rendered and not a value this loop
      // arrived at: the count is uncovered from over it and never drawn again.
      ticker.removeAttribute(TICKING);
    };

    // Before the first paint, so the count starts at nothing rather than flashing the
    // answer and then counting up to it. What is in the *document* is still the answer.
    ticker.setAttribute(TICKING, '');
    count.setAttribute(COUNT, format(0));
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      ticker.removeAttribute(TICKING);
    };
    // Once, on mount, whatever re-renders afterwards. `value`, `format` and `duration` are
    // deliberately not dependencies: a change to any of them changes the answer, which
    // React has already re-rendered, and a moment of section 10 does not replay.
  }, []);

  return (
    <span ref={field} className={styles.ticker} data-moment="ticker" data-duration-ms={duration}>
      <span className={styles.answer}>{format(value)}</span>
      <span ref={counting} className={styles.counting} aria-hidden="true" />
    </span>
  );
}
