import type { Session } from '@personavision/contract';

/**
 * One session, one clock.
 *
 * A session carries three lists — fixations, saccades and actions — and a replay has to
 * show them as one thing moving. So this module merges them into a single time-ordered
 * track keyed on `tMs`, and answers one question for a scrubber: at this time, which screen
 * was this person on, how far down it, which fixation were they on, and which row of the
 * event log is current. The scrubber, the keyboard and a `?fix=` deep link all do their
 * arithmetic here, so they cannot disagree.
 *
 * Fixations are numbered **continuously across the session**: `fixations[].index` runs
 * 0, 1, 2 … across every screen (the contract holds it to that), and the number a screen
 * prints is that index plus one. Nothing restarts at 1 on a new screen.
 */

type Screen = Session['screens'][number];
type Fixation = Session['fixations'][number];
type Action = Session['actions'][number];

export type TrackEntryKind = 'fixation' | 'saccade' | 'action';

/** One thing that happened, on the session's clock, with its place in the list it came from. */
export interface TrackEntry {
  readonly kind: TrackEntryKind;
  readonly tMs: number;
  /** Its index in the session's own `fixations`, `saccades` or `actions`. */
  readonly index: number;
}

/** What a session looked like at one time. */
export interface TimelineMoment {
  /** The time asked for, clamped into the session. */
  readonly tMs: number;
  /** `null` only for a session that records no screens at all. */
  readonly screenIndex: number | null;
  readonly screen: Screen | null;
  /** The current screen's scroll offset, from that same entry. */
  readonly scrollY: number | null;
  /** 1-based and continuous across the session; `null` before the first fixation. */
  readonly fixationNumber: number | null;
  readonly fixation: Fixation | null;
  /** The current row of the event log: an index into `session.actions`. */
  readonly eventLogIndex: number | null;
  readonly eventLogRow: Action | null;
}

export interface SessionTimeline {
  readonly durationMs: number;
  readonly fixationCount: number;
  /** Fixations, saccades and actions on one clock, in time order. */
  readonly track: readonly TrackEntry[];
  at(tMs: number): TimelineMoment;
  /** The time of fixation `fixationNumber` (1-based), clamped to the fixations there are. */
  timeAtFixation(fixationNumber: number): number;
  /** The time of the next or previous fixation, clamped at both ends of the session. */
  stepFixation(tMs: number, direction: 1 | -1): number;
}

/**
 * The entry of `entries` with the greatest `tMs` at or before `tMs`, or `null` if none is.
 *
 * ponytail: a linear scan, because a session is tens of fixations; binary search if one
 * ever carries thousands. It does not assume the list is sorted.
 */
function latestAtOrBefore(entries: ReadonlyArray<{ tMs: number }>, tMs: number): number | null {
  let found: number | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (candidate.tMs > tMs) continue;
    if (found === null || candidate.tMs >= entries[found].tMs) found = index;
  }
  return found;
}

/**
 * When each screen came up, from the fixations recorded on it.
 *
 * A screen carries no timestamp of its own, so its boundary is the first fixation that
 * happened on it; the session starts on its first screen, so that one starts at 0. The
 * starts are kept non-decreasing, which leaves a screen nobody looked at covering no time
 * at all rather than swallowing its neighbour.
 */
function screenStarts(session: Session): number[] {
  const starts: number[] = [];
  session.screens.forEach((_screen, index) => {
    const first = session.fixations.find((fixation) => fixation.screenIndex === index);
    const previous = starts[index - 1] ?? 0;
    starts.push(index === 0 ? 0 : Math.max(first?.tMs ?? previous, previous));
  });
  return starts;
}

/**
 * A saccade is stored as the hop between two fixations and carries no timestamp, so it is
 * placed on the clock where it begins: the moment its from-fixation ends.
 */
function saccadeStart(session: Session, saccade: Session['saccades'][number]): number {
  const from = session.fixations[saccade.fromFixation];
  return from === undefined ? 0 : from.tMs + from.durationMs;
}

function mergedTrack(session: Session): TrackEntry[] {
  return [
    ...session.fixations.map((fixation): TrackEntry => ({
      kind: 'fixation',
      tMs: fixation.tMs,
      index: fixation.index,
    })),
    ...session.saccades.map((saccade, index): TrackEntry => ({
      kind: 'saccade',
      tMs: saccadeStart(session, saccade),
      index,
    })),
    ...session.actions.map((action, index): TrackEntry => ({
      kind: 'action',
      tMs: action.tMs,
      index,
    })),
  ].sort((left, right) => left.tMs - right.tMs);
}

/** The one clock for one session. */
export function sessionTimeline(session: Session): SessionTimeline {
  const starts = screenStarts(session);
  const fixations = session.fixations;
  const clamp = (tMs: number): number => Math.min(Math.max(tMs, 0), session.durationMs);

  const timeAtFixation = (fixationNumber: number): number => {
    if (fixations.length === 0) return 0;
    const index = Math.min(Math.max(Math.trunc(fixationNumber), 1), fixations.length) - 1;
    return fixations[index].tMs;
  };

  return {
    durationMs: session.durationMs,
    fixationCount: fixations.length,
    track: mergedTrack(session),

    at(tMs) {
      const at = clamp(tMs);
      // The starts are non-decreasing, so the screen on at this time is the last one that
      // had come up by then.
      let screenIndex: number | null = null;
      for (let index = 0; index < starts.length; index += 1) {
        if (starts[index] <= at) screenIndex = index;
      }
      const screen = screenIndex === null ? null : session.screens[screenIndex];
      const fixationIndex = latestAtOrBefore(fixations, at);
      const eventLogIndex = latestAtOrBefore(session.actions, at);

      return {
        tMs: at,
        screenIndex,
        screen,
        scrollY: screen === null ? null : screen.scrollY,
        fixationNumber: fixationIndex === null ? null : fixationIndex + 1,
        fixation: fixationIndex === null ? null : fixations[fixationIndex],
        eventLogIndex,
        eventLogRow: eventLogIndex === null ? null : session.actions[eventLogIndex],
      };
    },

    timeAtFixation,

    stepFixation(tMs, direction) {
      const at = clamp(tMs);
      if (fixations.length === 0) return at;
      const current = latestAtOrBefore(fixations, at);
      // Before the first fixation there is nothing behind to step back to, so stepping back
      // stays put; stepping forward arrives at the first one.
      if (current === null) return direction === 1 ? fixations[0].tMs : at;
      return timeAtFixation(current + 1 + direction);
    },
  };
}
