import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMoment } from '../motion';
import styles from './moments.module.css';

/**
 * An animated beam: a line drawn from above a block down to each of the things lined up in
 * it, over `--moment-beam-duration`, with `--moment-stagger` between one line and the next.
 *
 * The third of the three Aceternity moments of `docs/FLOW.md` section 10. On the Verdict
 * screen the beams run from the audience line to the two completion figures — *these people,
 * these two numbers* — and the landing and demo pages mount the same one.
 *
 * **It is decoration over structure that is already readable.** The sentence above says whose
 * result this is and the figures below say what it was; take the beams away and nothing is
 * missing. They carry no text, catch no pointer and are hidden from the accessibility tree.
 *
 * **It leaves nothing behind.** The line fades as it lands, so the screen settles into
 * exactly the one `docs/design/prototype.html` draws — a lime mark that stayed would be a
 * permanent flourish on a screen the direction keeps deliberately quiet, and lime is the
 * action colour and carries no meaning. Under `prefers-reduced-motion` that settled state is
 * all there is: `docs/design/tokens.css` zeroes the duration, `useMoment` answers `0`, and no
 * beam is mounted at all.
 */

/** Milliseconds to the seconds Motion writes a transition in. */
const A_SECOND = 1000;

/** The beam's own coordinate space: a square the field stretches it over. */
const SPAN = 100;

/** When the line starts fading, as a fraction of its own drawing. */
const FADES_FROM = 0.7;

/** The two accents the direction gives the beams, in the order they are drawn. */
const ACCENTS = ['lime', 'grass'] as const;

/** What a beam lands on: the block marks each of its targets with this attribute. */
export const BEAM_TARGET = 'data-beam-target';

export interface BeamProps {
  /** Which target this beam reaches, counted from the left, and what delays it. */
  index: number;
  /** Where across the field it lands, as a fraction of the field's width. */
  at: number;
}

export function Beam({ index, at }: BeamProps) {
  const duration = useMoment('beam');
  const stagger = useMoment('stagger');
  if (duration === 0) return null;

  const delay = stagger * index;
  const lands = at * SPAN;

  return (
    <svg
      className={styles.beam}
      viewBox={`0 0 ${String(SPAN)} ${String(SPAN)}`}
      // The square is stretched over the field, so a beam starts at the field's top edge and
      // ends on its target whatever shape the block is at this window width.
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-moment="beam"
      data-duration-ms={duration}
      data-delay-ms={delay}
      data-beam-to={index}
    >
      <motion.path
        d={`M 0 0 C 0 ${String(SPAN / 2)} ${String(lands)} ${String(SPAN / 2)} ${String(lands)} ${String(SPAN)}`}
        data-accent={ACCENTS[index % ACCENTS.length]}
        // A hairline at every window width, rather than a line that thickens with the block.
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0, opacity: 1 }}
        animate={{ pathLength: 1, opacity: [1, 1, 0] }}
        transition={{
          duration: duration / A_SECOND,
          delay: delay / A_SECOND,
          opacity: {
            duration: duration / A_SECOND,
            delay: delay / A_SECOND,
            times: [0, FADES_FROM, 1],
          },
        }}
      />
    </svg>
  );
}

/** The targets split evenly across the field: one beam's share each. */
const evenly = (count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => (index + 0.5) / count);

/**
 * Where each target sits across the field, as a fraction of its width.
 *
 * Measured once, because a beam has to end on a figure and a row of figures is laid out by
 * the browser: their widths are their own words' widths. A document that lays nothing out —
 * jsdom, a server render — answers nothing, and the beams are then spread evenly instead;
 * what that costs is a decoration pointing a little to one side.
 */
const landings = (field: HTMLElement | null, count: number): number[] => {
  if (field === null) return evenly(count);
  const box = field.getBoundingClientRect();
  const targets = [...(field.parentElement?.querySelectorAll(`[${BEAM_TARGET}]`) ?? [])];
  if (box.width === 0 || targets.length !== count) return evenly(count);

  return targets.map((target) => {
    const landing = target.getBoundingClientRect();
    return (landing.x + landing.width / 2 - box.x) / box.width;
  });
};

export interface BeamFieldProps {
  /** The block the beams are drawn over: the row of things they land on. */
  children: ReactNode;
  /** How many of them there are, one beam each. */
  count: number;
}

/**
 * The block, with a beam drawn over it to each of the things lined up in it.
 *
 * The field is out of flow and reaches up by one spacing step above the block, into the
 * whitespace on the other side of which the audience line sits — so a beam cannot move the
 * block, cannot take a click from it, and comes down from above rather than beginning at the
 * row's own top edge.
 */
export function BeamField({ children, count }: BeamFieldProps) {
  const field = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<readonly number[]>(() => evenly(count));

  // Before the first paint, and once: the beams are drawn over a block that is laid out by
  // then, and a moment of section 10 does not replay.
  useLayoutEffect(() => {
    setAt(landings(field.current, count));
  }, [count]);

  return (
    <div className={styles.reveal}>
      {children}
      <div className={styles.beams} ref={field}>
        {at.map((fraction, index) => (
          <Beam key={index} index={index} at={fraction} />
        ))}
      </div>
    </div>
  );
}
