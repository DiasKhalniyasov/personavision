import type { GazeTrail } from './position';
import styles from './replay.module.css';

/**
 * `#rp-vec`: the gaze drawn over the frame — the fixations up to the scrubber's position,
 * numbered as the session numbers them, with the saccades between them and the current
 * fixation in its own colour.
 *
 * The geometry is the prototype's own: one square `viewBox` stretched over the frame, so a
 * percentage of the frame is a unit here, and a dot's radius grows with how long the eye
 * rested. The colours are the four gaze tokens and live in `replay.css`; nothing visual is
 * set here.
 *
 * The dots and the hops between them are **two layers**, because over the recording they
 * toggle independently as the prototype draws them: the dots on their own read better on a
 * moving frame, and the scanpath on its own is the order of attention without the dwell
 * rings over the picture. Both toggles are the reader's, so they are props and not URL
 * state.
 *
 * It is `aria-hidden`: a drawing of where somebody looked cannot be read out. What carries
 * the same content in words is the stage's own text alternative, the scrubber's position
 * and the event log beside it.
 */

/**
 * A fixation's radius in `viewBox` units, from its dwell: the prototype's own figures. The
 * vertical radius is the larger one because the `viewBox` is square and the frame is not,
 * which stretches the dot back towards a circle.
 */
const radius = (durationMs: number): number => 1.6 + (durationMs / 1000) * 1.9;

/**
 * The number sits inside its dot, so it is sized in `viewBox` units too — and as an inline
 * style, which is the only way a length in those units survives: the stylesheet gives the
 * label its family, weight and colour, and a stylesheet's `font-size` would otherwise win
 * over a presentation attribute and draw the number the size of the whole dot.
 */
const NUMBER_SIZE = 3;

export function GazeOverlay({
  trail,
  marks = true,
  scanpath = true,
}: {
  trail: GazeTrail;
  /** Whether the fixations themselves are drawn. */
  marks?: boolean;
  /** Whether the hops between the fixations are drawn. */
  scanpath?: boolean;
}) {
  return (
    <div className={styles.layer} id="rp-vec">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {(scanpath ? trail.hops : []).map((hop) => (
          <line
            key={`${hop.fromNumber}-${hop.toNumber}`}
            className={styles.saccade}
            x1={hop.fromXPct}
            y1={hop.fromYPct}
            x2={hop.toXPct}
            y2={hop.toYPct}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {(marks ? trail.marks : []).map((mark) => (
          <g key={mark.number}>
            <ellipse
              className={styles.fixation}
              data-fixation={mark.number}
              data-current={mark.current ? '' : undefined}
              cx={mark.xPct}
              cy={mark.yPct}
              rx={radius(mark.durationMs)}
              ry={radius(mark.durationMs) * 1.6}
            />
            <text
              x={mark.xPct}
              y={mark.yPct + 1.1}
              textAnchor="middle"
              style={{ fontSize: NUMBER_SIZE }}
            >
              {mark.number}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
