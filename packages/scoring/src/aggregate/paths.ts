import type { FunnelSlice } from '@personavision/contract';
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
 * The routes more than one person walked, commonest first and then by the route itself, so
 * two aggregations of the same sessions produce the same list in the same order.
 */
export const pathsOfSlice: PathsBuilder = ({ slice }) => {
  const routes = new Map<string, readonly string[]>();
  const counts = new Map<string, number>();

  for (const session of slice.sessions) {
    const steps = stepWalk(session).map((span) => span.step);
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
