import { MotionConfig } from 'motion/react';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/**
 * Motion, once, for the whole app.
 *
 * `docs/FLOW.md` section 10: the base transition is the only one most of the product has,
 * the one pulse is for live and loading states, and the animated moments — the Verdict
 * reveal, the heatmap warming up, the landing and demo pages — come on top with their
 * durations in the tokens file. A component never writes a duration of its own: it asks
 * `useMoment`.
 *
 * **Under `prefers-reduced-motion` a moment renders its finished state immediately** —
 * never a shortened animation and never a number mid-count. Three things see to that:
 * `MotionProvider` hands Motion `reducedMotion="user"`, which flattens every animation
 * Motion itself drives; `useMoment` returns `0`, which is what a component checks when it
 * decides whether to animate at all; and the tokens file zeroes the durations under that
 * query, so CSS transitions collapse without anything asking.
 *
 * The query is read where it is used rather than through Motion's own hook, which settles
 * its answer once per page: a component asking mid-session gets the current answer, and a
 * reader who changes the setting sees the product follow.
 *
 * #125 builds the three moments on top of this; the shell animates nothing itself.
 */

/** The moments of section 10, by the token that holds each one's duration. */
const MOMENT_TOKEN = {
  ticker: '--moment-ticker-duration',
  spotlight: '--moment-spotlight-duration',
  beam: '--moment-beam-duration',
  heat: '--moment-heat-duration',
  stagger: '--moment-stagger',
} as const;

export type Moment = keyof typeof MOMENT_TOKEN;

/**
 * `900ms`, `2s` and `.7s` all as milliseconds.
 *
 * The leading dot is not a curiosity: the production build minifies the tokens file, and
 * `700ms` comes out of it as `.7s`. A parser that insisted on a digit first read the app's
 * own stylesheet as unreadable — the one place it has to be able to read.
 */
const milliseconds = (raw: string): number | null => {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(ms|s)$/.exec(raw.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
};

/**
 * One moment's duration, in milliseconds, as the tokens currently resolve it — and `0`
 * when the reader has asked for reduced motion.
 *
 * Throws rather than falling back to a duration of its own: a token that cannot be read
 * means `docs/design/tokens.css` did not reach the page, which `assertTokensLoaded`
 * reports at boot, and a plausible-looking default would hide it here.
 */
export function useMoment(moment: Moment): number {
  const reduced = usePrefersReducedMotion();
  const property = MOMENT_TOKEN[moment];
  if (reduced) return 0;

  const raw = getComputedStyle(document.documentElement).getPropertyValue(property);
  const value = milliseconds(raw);
  if (value === null) {
    throw new Error(
      `${property} did not resolve to a duration (got ${JSON.stringify(raw.trim())}). ` +
        'docs/design/tokens.css is the only place it is declared; check that it loaded.',
    );
  }
  return value;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const subscribeToReducedMotion = (changed: () => void): (() => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
};

const readReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION).matches;

/** `true` when the reader has asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false);
}

/** Mounted above the router, so that reduced motion is honoured everywhere at once. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
