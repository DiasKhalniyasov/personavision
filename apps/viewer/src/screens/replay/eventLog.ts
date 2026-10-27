import type { Run, Session } from '@personavision/contract';
import type { SessionTimeline, TimelineMoment } from '@/session/index.js';
import { timeLabel } from './position';
import { stepLabel } from './runWords';

/**
 * The right-hand column of the replay, worked out in words: one card per screen the agent
 * was on, carrying the intent it stated for that screen and the transcript of what happened
 * there.
 *
 * It is pure, so the column is a rendering of these answers and a test can check the
 * answers themselves. Everything about **time** is asked of the session's own clock
 * (`src/session/timeline.ts`, #20) rather than worked out again here: which screen was on,
 * which fixation is current and which action is the current row all come from the moment
 * the frame and the scrubber are drawn from, so the column cannot say a different thing
 * than the picture beside it.
 *
 * The log carries the gaze as well as the actions, because this column is the replay's
 * accessible representation: a reader who cannot see the frame reads the session here and
 * should lose the pictures and nothing else. So a fixation is an event of kind `read`,
 * naming the area of interest it landed on and how long it was held — which is exactly what
 * the frame draws as a numbered circle of that size.
 */

type Action = Session['actions'][number];
type Fixation = Session['fixations'][number];

/** The kinds an event row can be: the session's own action types, and a fixation. */
export type EventKind = 'read' | Action['type'];

/** One row of the log. */
export interface LogEvent {
  /** Stable across renders, and what a test names a row by. */
  readonly key: string;
  readonly tMs: number;
  /** What the `.t` column reads. */
  readonly time: string;
  readonly kind: EventKind;
  /** What it was aimed at, as the session records it; `null` when it records none. */
  readonly target: string | null;
  /** The figure behind the row — a dwell, a scroll offset, what was typed. */
  readonly detail: string | null;
  /**
   * Where clicking this row sends the scrubber: `null` in a session that recorded no
   * fixations, where the scrubber is disabled and the log is read rather than walked.
   */
  readonly fixationNumber: number | null;
  /** The row the session model reports for the scrubber's moment. */
  readonly current: boolean;
  /**
   * Said out loud rather than dropped: an event that disagrees with the session it is in
   * is still a fact about the session, and hiding it would hide the bug.
   */
  readonly inconsistency: string | null;
}

/** One screen the agent was on. */
export interface ScreenCard {
  readonly index: number;
  /** `Screen 2 of 3 · Payment`, as the prototype's microlabel reads it. */
  readonly title: string;
  /** `fixations 8–19 · 0:10–0:29`, the faint half of the same header. */
  readonly meta: string;
  /** The agent's own sentence, as it stated it. Never paraphrased, never cut. */
  readonly intent: string;
  /** The screen the scrubber is on. */
  readonly active: boolean;
  readonly events: readonly LogEvent[];
}

export interface EventLog {
  readonly cards: readonly ScreenCard[];
  /**
   * Why there is no log. A session with no screens at all cannot happen under the
   * contract, so the column says so where a reader will see it rather than rendering blank.
   */
  readonly problem: string | null;
}

/** What `no actions recorded on this screen` replaces: a card whose screen records nothing. */
export const NOTHING_RECORDED = 'no actions recorded on this screen';

/**
 * When each screen came up and when it gave way to the next.
 *
 * A screen carries no timestamp of its own, so the boundaries are **asked of the clock**
 * rather than worked out again here: a screen came up at the first fixation the model
 * answers with that screen, and the session starts on its first screen. The card that
 * reads `0:10–0:29` is therefore exactly the card the clock marks active over that
 * stretch, however the model resolves a tie.
 *
 * A stretch can outlast its own fixations: when the next screen was never looked at, the
 * clock has nothing to move on to and keeps this one on. That is what the clock says, so
 * it is what the header says.
 */
function screenSpans(
  session: Session,
  timeline: SessionTimeline,
): ReadonlyArray<{ startMs: number; endMs: number }> {
  const starts: number[] = [];
  session.screens.forEach((_screen, index) => {
    const previous = starts[index - 1] ?? 0;
    const first = session.fixations.find(
      (fixation) => timeline.at(fixation.tMs).screenIndex === index,
    );
    starts.push(index === 0 ? 0 : Math.max(first?.tMs ?? previous, previous));
  });
  return starts.map((startMs, index) => ({
    startMs,
    // The end is the next start that is actually later: a screen nobody looked at shares
    // the start of the one before it, and must not cut that screen's stretch to an instant.
    endMs: starts.slice(index + 1).find((start) => start > startMs) ?? session.durationMs,
  }));
}

/** What the run calls the area a fixation or an action landed on, and which step it is on. */
function aoiWords(run: Run): Map<string, { label: string; step: string }> {
  return new Map(run.aois.map((aoi) => [aoi.id, { label: aoi.label, step: aoi.step }]));
}

/**
 * Which card an action belongs under.
 *
 * An action carries no screen of its own, so the clock is the general answer: the screen
 * the model says was on at that time. But the clock's boundaries come from the gaze, so a
 * screen nobody looked at is never the clock's answer and its actions would be filed under
 * the screen before it — this column would then say the person typed their card number on
 * the cart. Where the run names the area an action resolved to, that area names the step
 * it belongs to, which settles it; the nearest screen on that step to the clock's answer
 * is the one, so a session that walks the same step twice still files each visit's actions
 * under the visit they happened on.
 */
function cardForAction(session: Session, step: string | null, byClock: number): number {
  if (step === null || session.screens[byClock]?.step === step) return byClock;
  let best: number | null = null;
  session.screens.forEach((screen, index) => {
    if (screen.step !== step) return;
    if (best === null || Math.abs(index - byClock) <= Math.abs(best - byClock)) best = index;
  });
  return best ?? byClock;
}

/** The fixation nearest in time among a card's own, so a row click never leaves its card. */
function nearestOnCard(own: readonly Fixation[], tMs: number): Fixation | null {
  let best: Fixation | null = null;
  own.forEach((fixation) => {
    if (best === null || Math.abs(fixation.tMs - tMs) < Math.abs(best.tMs - tMs)) best = fixation;
  });
  return best;
}

/** The figure behind an action, in the words the session records it in. */
function actionDetail(action: Action): string | null {
  if (action.value === null) return action.type === 'hesitate' ? 'no action' : null;
  if (action.type === 'hesitate') {
    const ms = Number(action.value);
    return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s with no action` : action.value;
  }
  if (action.type === 'scroll') return `to ${action.value} px`;
  return action.value;
}

/** How long the eye was held there: the size the frame draws the same fixation at. */
const fixationDetail = (fixation: Fixation): string => `${fixation.durationMs} ms held`;

/**
 * The row the scrubber is on: whichever of the two things the session model reports for
 * this moment — the current fixation and the current row of the event log — happened last.
 * A transcript's cursor is on the latest thing that happened, and both candidates are the
 * model's own answer, so the highlight cannot drift from the frame.
 */
function currentKey(moment: TimelineMoment): string | null {
  const fixationAt = moment.fixation?.tMs ?? -1;
  const actionAt = moment.eventLogRow?.tMs ?? -1;
  if (moment.eventLogIndex !== null && actionAt >= fixationAt)
    return `action:${moment.eventLogIndex}`;
  if (moment.fixation !== null) return `read:${moment.fixation.index}`;
  return null;
}

/** One row and the card it belongs under, before the scrubber's moment is applied. */
interface Placed {
  readonly screenIndex: number;
  readonly event: Omit<LogEvent, 'current'>;
}

/**
 * One session's log, grouped into its screens.
 *
 * A fixation is placed on the screen it **records** — the same field the frame filters the
 * gaze by — and a fixation recording a screen this session does not have is put under the
 * last card with the inconsistency stated on the row. An action carries no screen of its
 * own, so it is placed by the clock: the screen the model says was on at that time.
 */
export function eventLog({
  session,
  run,
  timeline,
  moment,
}: {
  session: Session;
  run: Run;
  timeline: SessionTimeline;
  moment: TimelineMoment;
}): EventLog {
  if (session.screens.length === 0) {
    return {
      cards: [],
      problem:
        'This session records no screens, so there is no intent and no event log to read. A session always walks at least one screen, so the file is wrong rather than the person idle.',
    };
  }

  const spans = screenSpans(session, timeline);
  const areas = aoiWords(run);
  const lastCard = session.screens.length - 1;
  const ownFixations = session.screens.map((_screen, index) =>
    session.fixations.filter((fixation) => fixation.screenIndex === index),
  );
  const placed: Placed[] = [];

  session.fixations.forEach((fixation) => {
    const known = fixation.screenIndex >= 0 && fixation.screenIndex < session.screens.length;
    placed.push({
      screenIndex: known ? fixation.screenIndex : lastCard,
      event: {
        key: `read:${fixation.index}`,
        tMs: fixation.tMs,
        time: timeLabel(fixation.tMs),
        kind: 'read',
        target:
          fixation.aoiId === null ? null : (areas.get(fixation.aoiId)?.label ?? fixation.aoiId),
        detail: fixationDetail(fixation),
        fixationNumber: fixation.index + 1,
        inconsistency: known
          ? null
          : `recorded on screen ${fixation.screenIndex + 1}, which this session does not have`,
      },
    });
  });

  session.actions.forEach((action, index) => {
    const at = timeline.at(action.tMs);
    const area = action.aoiId === null ? null : (areas.get(action.aoiId) ?? null);
    // An aoi id the run does not declare is still what the session says this action hit,
    // so the id itself is printed rather than the row losing its object.
    const label = action.aoiId === null ? null : (area?.label ?? action.aoiId);
    const screenIndex = cardForAction(session, area?.step ?? null, at.screenIndex ?? lastCard);
    const nearest = nearestOnCard(ownFixations[screenIndex] ?? [], action.tMs);
    placed.push({
      screenIndex,
      event: {
        key: `action:${index}`,
        tMs: action.tMs,
        time: timeLabel(action.tMs),
        kind: action.type,
        target: action.target ?? label,
        detail:
          [actionDetail(action), action.ok ? null : 'this action did not resolve']
            .filter((part) => part !== null)
            .join(' · ') || null,
        // The scrubber's unit is a fixation, so an action — which has none of its own —
        // moves it to the nearest fixation on its own card. That is the closest position
        // the scrubber has to the moment, and it keeps the frame on the screen the row
        // sits under rather than stepping off it.
        fixationNumber:
          timeline.fixationCount === 0
            ? null
            : nearest === null
              ? (at.fixationNumber ?? 1)
              : nearest.index + 1,
        inconsistency: null,
      },
    });
  });

  const current = currentKey(moment);

  const cards = session.screens.map((screen, index): ScreenCard => {
    const own = ownFixations[index] ?? [];
    const span = spans[index] as { startMs: number; endMs: number };
    // A screen nobody looked at is not placed on the clock at all: a screen carries no
    // timestamp of its own, so with no fixation on it nothing says when the person was
    // there, and printing a neighbour's stretch would be a guess.
    const meta =
      own.length === 0
        ? 'no fixations · no time on the clock'
        : `fixations ${(own[0] as Fixation).index + 1}–${(own[own.length - 1] as Fixation).index + 1} · ${timeLabel(span.startMs)}–${timeLabel(span.endMs)}`;

    return {
      index,
      title: `Screen ${index + 1} of ${session.screens.length} · ${stepLabel(run, screen.step)}`,
      meta,
      intent: screen.intent,
      active: moment.screenIndex === index,
      events: placed
        .filter((row) => row.screenIndex === index)
        .sort((left, right) => left.event.tMs - right.event.tMs)
        .map(({ event }) => ({ ...event, current: event.key === current })),
    };
  });

  return { cards, problem: null };
}
