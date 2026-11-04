import type { Run, SessionProgress } from '@personavision/contract';
import { stepLabel } from '@/screens/replay/runWords';
import { outcomeWords } from '@/session/index.js';

/**
 * How far along a test is, in words and in squares: the figures of the Running screen's
 * heading and lede, the state of each square of its grid, and the cells of its *Just
 * finished* rows.
 *
 * Everything here is a **format of something the run artifact already records**. The counts
 * are `run.progress`'s own, a duration is the stored `durationMs`, the start is
 * `run.startedAt` and the concurrency is `run.runner.concurrency`. Two things are derived,
 * both from stored fields and both stated on the screen so a reader can see what they came
 * from: the remaining-time estimate, offered only once the run has finished somebody to
 * estimate from, and how many sessions are in flight — the concurrency the run was started
 * with, or fewer when fewer are left. The artifact stores neither, and an invented figure
 * would be a number with nothing behind it.
 *
 * The words for an outcome come from the session vocabulary (#20) and a step's label from
 * `runWords` (#22), so this screen, the Sessions screens and the replay cannot end up
 * saying different things about one session. *Abandoned*, *failed* and *automation failure*
 * stay three (`docs/FLOW.md` section 8), and the grid gives our own breakage a square of
 * its own rather than colouring it as somebody who gave up.
 */

const MINUTE = 60_000;

/** How many of the finished sessions *Just finished* shows: the prototype's handful. */
export const JUST_FINISHED = 5;

/**
 * `63 of 100 people have finished` — `#screen-running-swarm`'s own heading, and the one
 * claim the whole screen is a rendering of.
 */
export const headingPhrase = (finished: number, total: number): string =>
  `${finished} of ${total} ${total === 1 ? 'person' : 'people'} have finished`;

/**
 * `10 of 12 people finished`: the same two counts as a sentence rather than as a heading,
 * for the text a progress bar is read out as.
 */
export const finishedPhrase = (finished: number, total: number): string =>
  `${finished} of ${total} ${total === 1 ? 'person' : 'people'} finished`;

/** How wide a bar is drawn. A run planning nobody draws an empty bar rather than a NaN. */
export const sharePercent = (finished: number, total: number): number =>
  total <= 0 ? 0 : Math.min(Math.round((finished / total) * 100), 100);

/** `09:12`, in the reader's own time zone, as the prototype's lede writes a start. */
const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * `3 Nov`, day then month as the prototype prints a date — the two are formatted apart
 * because `en-US` writes the pair the other way round in one format.
 */
const dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
const month = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** Whether two instants fall on the same day in the reader's own time zone. */
const sameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

/**
 * `started 09:12, about 9 minutes left` — the time part of the lede.
 *
 * The day is printed only when the test did **not** start today: a test that has been open
 * since yesterday morning and one that started ten minutes ago would otherwise read
 * identically, and a stalled test is exactly the one whose clock a reader is looking for.
 *
 * `null` for a run that records no start, which is a run whose clock is unknown rather than
 * one that started a moment ago; the estimate is dropped on its own when there is nothing
 * to estimate from, leaving `started 09:12`.
 */
export function timePhrase(run: Run, now: number): string | null {
  const since = startedAt(run);
  if (since === null) return null;
  const at = new Date(since);
  const day = sameDay(at, new Date(now)) ? '' : `${dayOfMonth.format(at)} ${month.format(at)} `;
  const started = `started ${day}${clock.format(at)}`;
  const left = remainingPhrase(run, now);
  return left === null ? started : `${started}, ${left}`;
}

/**
 * `about 9 minutes left`, from how long the finished people took. `null` until there is
 * something to estimate from: no start recorded, nobody finished yet, or nobody left.
 */
export function remainingPhrase(run: Run, now: number): string | null {
  const since = startedAt(run);
  const { progress } = run;
  if (since === null || progress === undefined) return null;

  const { finishedSessions, totalSessions } = progress;
  const outstanding = totalSessions - finishedSessions;
  if (finishedSessions <= 0 || outstanding <= 0) return null;

  const elapsed = Math.max(now - since, 0);
  const remaining = (elapsed / finishedSessions) * outstanding;
  if (remaining < MINUTE) return 'less than a minute left';
  const minutes = Math.round(remaining / MINUTE);
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}

/**
 * `2:41`: how long one person took, as the *Just finished* table's Time column reads it.
 *
 * Minutes and seconds, which is how the prototype writes a session's duration — not the
 * `22.4 s` the Sessions table uses, because that table compares short attempts against each
 * other and this one reads a wall clock beside a time of day.
 */
export function clockDuration(durationMs: number): string {
  const total = Math.max(Math.round(durationMs / 1000), 0);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours === 0
    ? `${minutes}:${seconds}`
    : `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

/**
 * One square of the grid: the three outcomes of the product under test, our own automation
 * failing, a session in flight, and `null` for one nobody has started.
 *
 * Our breakage is its own state and borrows the attribution colour, as every other screen
 * gives it (`src/session/vocabulary.ts`): colouring it as a person who gave up would say
 * the site lost somebody it did not lose, and leaving it blank would say a person who ran
 * never started (the owner's decision 151).
 */
export type SwarmState = 'success' | 'abandoned' | 'failed' | 'automation' | 'running' | null;

/** How many squares each state holds — the counts the words above the grid state. */
export interface SwarmCounts {
  readonly success: number;
  readonly abandoned: number;
  readonly failed: number;
  readonly automation: number;
  /** Derived from the concurrency the run records; `null` when it records none. */
  readonly running: number | null;
  /** Nobody has started them yet, or — with no concurrency recorded — nobody has finished them. */
  readonly pending: number;
}

export interface Swarm {
  /** One entry a session, in the order the run plans and finishes them. */
  readonly squares: readonly SwarmState[];
  readonly counts: SwarmCounts;
}

const STATE: Readonly<Record<SessionProgress['status'], SwarmState>> = {
  success: 'success',
  abandoned: 'abandoned',
  failed: 'failed',
  automation_failure: 'automation',
};

/**
 * The grid, and the counts it draws: a square per planned session, the finished ones in the
 * order the artifact appended them, then the ones in flight, then the ones nobody has
 * started.
 *
 * `concurrency` is `run.runner.concurrency` — how many sessions this run was willing to
 * have in flight — and `null` for a run that recorded none. Without it no square is drawn
 * as running: how many are in flight is then simply not known, and a guess drawn in colour
 * would be a figure nobody measured.
 *
 * `planned` is how many squares to draw for a run whose progress block is not written yet —
 * the length of the run's own `sessionIds`, which is its manifest of the sessions it plans.
 * A total is therefore never invented: it is the progress block's own, or the manifest's, or
 * there is no grid.
 */
export function swarm(progress: Run['progress'], concurrency: number | null, planned = 0): Swarm {
  const sessions = progress?.sessions ?? [];
  const finished = progress?.finishedSessions ?? 0;
  // The contract holds the two to each other; `max` is so a grid is never shorter than the
  // sessions it has to draw, whatever a hand-written artifact claims.
  const total = Math.max(progress?.totalSessions ?? planned, sessions.length);
  const outstanding = Math.max(total - finished, 0);
  const running = concurrency === null ? null : Math.min(Math.max(concurrency, 0), outstanding);
  const pending = outstanding - (running ?? 0);

  return {
    squares: [
      ...sessions.map((entry) => STATE[entry.status]),
      ...Array.from<unknown, SwarmState>({ length: running ?? 0 }, () => 'running'),
      ...Array.from<unknown, SwarmState>({ length: pending }, () => null),
    ],
    counts: {
      success: sessions.filter((entry) => entry.status === 'success').length,
      abandoned: sessions.filter((entry) => entry.status === 'abandoned').length,
      failed: sessions.filter((entry) => entry.status === 'failed').length,
      automation: sessions.filter((entry) => entry.status === 'automation_failure').length,
      running,
      pending,
    },
  };
}

/**
 * The counts in words, above the grid: the same figures the squares are coloured by, so
 * nothing on this screen is readable only as colour.
 *
 * The five words are the legend's own — *succeeded*, *gave up*, *failed*, *still going*,
 * *not started* — so the line and the key under the grid name the same things.
 *
 * *Succeeded* rather than the prototype's *finished*, which is the one word changed from its
 * footnote: the heading above counts **everybody who is done** — *63 of 100 people have
 * finished* — and that sixty-three includes the people who gave up. One screen cannot use
 * *finished* for two different counts, so the one that means *got the task done* takes the
 * outcome's own word from the vocabulary of `docs/FLOW.md` section 8.
 *
 * Our own automation failing is counted apart and said to be excluded, and is named only by
 * a run that has one: a run with none makes no claim about it. With no concurrency recorded
 * there is no *still going* to state, and what is left reads as not yet finished rather than
 * as a split nobody measured.
 */
export function countsPhrase(counts: SwarmCounts): string {
  const parts = [
    `${counts.success} succeeded`,
    `${counts.abandoned} gave up`,
    `${counts.failed} failed`,
    ...(counts.automation === 0
      ? []
      : [`${counts.automation} our own automation failing, excluded from the results`]),
    ...(counts.running === null
      ? [`${counts.pending} not yet finished`]
      : [`${counts.running} still going`, `${counts.pending} not started`]),
  ];
  return parts.join(' · ');
}

/**
 * `One square a person: …` — the key to the colours, and what this run ran at.
 *
 * What our own breakage is excluded from is **the results** — every figure and every
 * recommendation on the results page (`docs/FLOW.md` section 11). It is not excluded from
 * the count of people who are done, which is what the heading above states and what this
 * grid draws a square for: those sessions ran, and a screen that drew them as nothing while
 * counting them as finished would be two claims about one person.
 */
export function footnotePhrase(counts: SwarmCounts, concurrency: number | null): string {
  const sentences = [
    'One square a person: succeeded, gave up, failed, still going, not started.',
    ...(counts.automation === 0
      ? []
      : [
          'Our own automation failing is a sixth colour: those people are counted as done here and are in none of the results.',
        ]),
    ...(concurrency === null
      ? []
      : [
          // Never "the cap this site is set to", which the prototype's footnote guesses at:
          // `runner.concurrency` is our own ceiling on sessions in flight and the per-site
          // caps are `packages/platform`'s separate numbers. The two are different things.
          `${concurrency} ${concurrency === 1 ? 'runs' : 'run'} at once, which is the concurrency this run was started with.`,
        ]),
  ];
  return sentences.join(' ');
}

/**
 * Who one row is about: `Rushed buyer, 29 · iPhone 14`, as `#screen-running-swarm`'s Person
 * column prints it.
 *
 * The progress entry carries the person's **name**, so the age and the device are looked up
 * among the run's own personas by it. Both are optional in the contract — a person generated
 * before profiles existed has no stated age — and an absent one leaves its clause out rather
 * than printing a person aged nothing. Two personas sharing a name read as the first of
 * them, which is the only thing a name can address.
 */
export function personLine(run: Run, entry: SessionProgress): string {
  const persona = run.personas.find((candidate) => candidate.name === entry.personaName);
  const age = persona?.profile?.age;
  const named = age === undefined ? entry.personaName : `${entry.personaName}, ${age}`;
  return persona === undefined ? named : `${named} · ${persona.device.name}`;
}

/**
 * Where one person ended, as the table's Ended-on column reads it: the step the run labels
 * it, and — on a session our own automation broke — that it is excluded from every figure
 * (`docs/FLOW.md` section 11). A step the run never planned has no label, and then its id is
 * the best name there is.
 */
export function endedOnPhrase(run: Run, entry: SessionProgress): string {
  const where = stepLabel(run, entry.step);
  return entry.status === 'automation_failure' ? `${where} · excluded` : where;
}

/** The chip class carrying this outcome's colour: `tag-success`, `tag-automation`. */
export const outcomeTagClass = (entry: SessionProgress): string =>
  `tag-${outcomeWords(entry.status).token.replace(/^--(?:outcome|attr)-/, '')}`;

/** What the outcome chip says: `Success`, `Abandoned`, `Failed`, `Automation failure`. */
export const outcomeLabel = (entry: SessionProgress): string => outcomeWords(entry.status).label;

/** When the swarm started, in milliseconds, or `null` when the run does not record it. */
function startedAt(run: Run): number | null {
  if (run.startedAt === undefined) return null;
  const at = Date.parse(run.startedAt);
  return Number.isFinite(at) ? at : null;
}
