import type { FunnelSlice, Session } from '@personavision/contract';
import { stepWalk, type FunnelSliceSpec } from './sessions.js';

/**
 * The common paths of one slice: the sequence of step ids each session actually walked, in
 * screen order and with its repeats — a revisit is part of the route, which is the point of
 * the figure — counted, and kept only where more than one session walked it, so *common
 * paths* is common paths and not a hundred unique ones.
 *
 * It reads the same projection of a session as the funnel beside it: `stepWalk`, whose
 * order is the screens' own. A slice of one person therefore keeps **no** path at all —
 * nothing one session did is common — and says so with an empty list rather than a route
 * that only looks like a pattern.
 *
 * The repeat the figure is about is a **revisit**: leaving a step and coming back to it. A
 * step captured twice in a row is not one of those, and `routeOf` says why.
 */

/**
 * What the paths figure is given. **#289 settles the rest of this shape in this file**; the
 * barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface PathsInput {
  /** The slice and its sessions, as `funnelSliceSpecs` enumerated them. */
  readonly slice: FunnelSliceSpec;
}

/** The signature #289 implements: the routes of a stored slice, ordered as they are stored. */
export type PathsBuilder = (input: PathsInput) => FunnelSlice['paths'];

/** What addresses one route: its steps, joined by a character no step id can hold. */
const routeKey = (steps: readonly string[]): string => steps.join('\u0000');

/**
 * The route one session walked: the steps of its screens in order, with a run of screens on
 * one step read as **one** visit to it.
 *
 * A step is captured again whenever the agent saw something new on it — *a screen captured
 * twice — scroll, then click — is two screens of the session*
 * (`packages/swarm/src/run-session.ts`) — so a route taken screen by screen would read
 * `landing, prompt, prompt, generate` for a person who scrolled once, match nobody else who
 * walked the same four screens, and leave a slice of people who took one route reporting no
 * common route at all. A **revisit** — leaving a step and coming back to it — is a repeat
 * this does keep, because that is the repeat the figure exists to show.
 */
const routeOf = (session: Session): readonly string[] =>
  stepWalk(session).reduce<string[]>(
    (steps, span) => (steps[steps.length - 1] === span.step ? steps : [...steps, span.step]),
    [],
  );

/**
 * The routes more than one person walked, commonest first and then by the route itself, so
 * two aggregations of the same sessions produce the same list in the same order.
 */
export const pathsOfSlice: PathsBuilder = ({ slice }) => {
  const routes = new Map<string, readonly string[]>();
  const counts = new Map<string, number>();

  for (const session of slice.sessions) {
    const steps = routeOf(session);
    if (steps.length === 0) continue;
    const key = routeKey(steps);
    routes.set(key, steps);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, sessionCount]) => sessionCount > 1)
    .sort(
      ([aKey, aCount], [bKey, bCount]) =>
        bCount - aCount || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0),
    )
    .map(([key, sessionCount]) => ({ steps: [...(routes.get(key) ?? [])], sessionCount }));
};
