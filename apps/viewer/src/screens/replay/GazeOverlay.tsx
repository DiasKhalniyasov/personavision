import type { GazeTrail } from './position';

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
 * It is `aria-hidden`: a drawing of where somebody looked cannot be read out. What carries
 * the same content in words is the scrubber's own label and position, and — when #24 and
 * #25 land — the event log and the outcome card beside it.
 */

/**
 * A fixation's radius in `viewBox` units, from its dwell: the prototype's own figures. The
 * vertical radius is the larger one because the `viewBox` is square and the frame is not,
 * which stretches the dot back towards a circle.
 */
const radius = (durationMs: number): number => 1.6 + (durationMs / 1000) * 1.9;

/** The number sits inside its dot, so it is sized in `viewBox` units too. */
const NUMBER_SIZE = 3;

export function GazeOverlay({ trail }: { trail: GazeTrail }) {
  return (
    <div className="layer" id="rp-vec">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {trail.hops.map((hop) => (
          <line
            key={`${hop.fromNumber}-${hop.toNumber}`}
            className="saccade"
            x1={hop.fromXPct}
            y1={hop.fromYPct}
            x2={hop.toXPct}
            y2={hop.toYPct}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {trail.marks.map((mark) => (
          <g key={mark.number}>
            <ellipse
              className="fixation"
              data-fixation={mark.number}
              data-current={mark.current ? '' : undefined}
              cx={mark.xPct}
              cy={mark.yPct}
              rx={radius(mark.durationMs)}
              ry={radius(mark.durationMs) * 1.6}
            />
            <text x={mark.xPct} y={mark.yPct + 1.1} textAnchor="middle" fontSize={NUMBER_SIZE}>
              {mark.number}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
