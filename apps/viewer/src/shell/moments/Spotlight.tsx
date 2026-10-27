import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useMoment } from '../motion';
import styles from './moments.module.css';

/**
 * A spotlight: a soft lime-edged glow that settles over `--moment-spotlight-duration` around
 * the thing that won.
 *
 * The second of the three Aceternity moments of `docs/FLOW.md` section 10. On the Verdict
 * screen it lands on the card `verdict.preferredVariant` names — the field, never the larger
 * figure — and the landing and demo pages mount this same one.
 *
 * **It says nothing.** The words beside it already name the version to ship, and the glow
 * takes no space, catches no pointer and is hidden from the accessibility tree. It is also
 * the only lime on the block: lime is the action colour of the direction and carries no
 * meaning, which is exactly why it can be used for a flourish here.
 *
 * **It runs once.** Motion animates `initial` to `animate` as the glow mounts and not again,
 * so a re-render of the screen leaves a settled spotlight settled. Under
 * `prefers-reduced-motion` `useMoment` answers `0` and no animation is mounted at all: the
 * ring is simply there, which is what the static prototype draws.
 */

/** Milliseconds to the seconds Motion writes a transition in. */
const A_SECOND = 1000;

export interface SpotlightProps {
  /** What is lit. The glow is drawn around it, inset by one spacing step. */
  children: ReactNode;
}

export function Spotlight({ children }: SpotlightProps) {
  const duration = useMoment('spotlight');

  return (
    <div className={styles.spotlit} data-moment="spotlight" data-duration-ms={duration}>
      {children}
      {duration === 0 ? (
        <span className={styles.glow} aria-hidden="true" />
      ) : (
        <motion.span
          className={styles.glow}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: duration / A_SECOND }}
        />
      )}
    </div>
  );
}
