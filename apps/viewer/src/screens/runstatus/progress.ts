import type { Run, SessionProgress } from '@personavision/contract';
import { stepLabel } from '@/screens/replay/runWords';
import { attributionWords, outcomeWords } from '@/session/index.js';

/**
 * How far along a test is, in words: the figures of the Running screen's line, the stamps
 * down the left of its log, and the sentence at the end of each log line.
 *
 * Everything here is a **format of something the run artifact already records**. The counts
 * are `run.progress`'s own, the stamps are the offsets between two stored timestamps, and a
 * duration is the stored `durationMs`. The one thing computed is the remaining-time
 * estimate, and it is offered only when the run has finished somebody to estimate from: the
 * artifact stores no estimate, and an invented one would be a number with nothing behind it.
 *
 * The words for an outcome and its attribution come from the session vocabulary (#20), and
 * a step's label from `runWords` (#22), so this log, the Sessions screens and the replay
 * cannot end up saying different things about one session. *Abandoned*, *failed* and
 * *automation failure* stay three (`docs/FLOW.md` section 8).
 */

const MINUTE = 60_000;

/** `17 of 24 people finished` — the claim the whole screen is one rendering of. */
export const finishedPhrase = (finished: number, total: number): string =>
  `${finished} of ${total} ${total === 1 ? 'person' : 'people'} finished`;

/** How wide a bar is drawn. A run planning nobody draws an empty bar rather than a NaN. */
export const sharePercent = (finished: number, total: number): number =>
  total <= 0 ? 0 : Math.min(Math.round((finished / total) * 100), 100);

/**
 * `3 min elapsed`, or `null` for a run that records no start — which is a run whose elapsed
 * time is unknown, not one that started a moment ago.
 */
export function elapsedPhrase(run: Run, now: number): string | null {
  const since = startedAt(run);
  if (since === null) return null;
  const elapsed = Math.max(now - since, 0);
  return elapsed < MINUTE
    ? 'under a minute elapsed'
    : `${Math.floor(elapsed / MINUTE)} min elapsed`;
}

/**
 * `about 2 min left`, from how long the finished people took. `null` until there is
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
  return remaining < MINUTE
    ? 'less than a minute left'
    : `about ${Math.round(remaining / MINUTE)} min left`;
}

/**
 * `00:03:11`: how far into the run this session landed, which is what the prototype's log
 * stamps. `null` when the run records no start, because then the offset is from nothing.
 */
export function logStamp(run: Run, entry: SessionProgress): string | null {
  const since = startedAt(run);
  if (since === null) return null;
  const landed = Date.parse(entry.finishedAt);
  if (!Number.isFinite(landed)) return null;

  const seconds = Math.floor(Math.max(landed - since, 0) / 1000);
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * What happened to one person, as the prototype's log words it — `success in 58.4 s`,
 * `abandoned at the Review step (product: service fee revealed late)`.
 *
 * The artifact carries structured fields and **no pre-composed sentence**, so the sentence
 * is rendered here: the outcome's own word, the step the session ended on as the run labels
 * it, and — on anything but a success — who it is attributed to, beside what was captured.
 * A success is timed instead, because what is worth knowing about a success is how long it
 * took.
 */
export function outcomeSentence(run: Run, entry: SessionProgress): string {
  const word = outcomeWords(entry.status).label.toLowerCase();
  const captured = entry.reason.trim();

  if (entry.status === 'success') {
    const seconds = (entry.durationMs / 1000).toFixed(1);
    return captured === '' ? `success in ${seconds} s` : `success in ${seconds} s (${captured})`;
  }

  const where = `${word} at the ${stepLabel(run, entry.step)} step`;
  const who = attributionWords(entry.attribution).label;
  return captured === '' ? `${where} (${who})` : `${where} (${who}: ${captured})`;
}

/**
 * One log line, as the prototype writes it: `S-24 Price-sensitive scanner · B · seed 3 —
 * abandoned at the Review step (product: service fee revealed late)`.
 *
 * It is one string rather than a row of markup, so that the line reads the same whatever
 * sits around it; the stamp stays the screen's own element, because the prototype sets it
 * apart. A real session carries a participant and no seed, and such a line names no seed
 * rather than naming nothing.
 */
export function logLine(run: Run, entry: SessionProgress): string {
  const who = [
    `${entry.sessionId} ${entry.personaName}`,
    entry.variant,
    ...(entry.seed === null ? [] : [`seed ${entry.seed}`]),
  ];
  return `${who.join(' · ')} — ${outcomeSentence(run, entry)}`;
}

/** When the swarm started, in milliseconds, or `null` when the run does not record it. */
function startedAt(run: Run): number | null {
  if (run.startedAt === undefined) return null;
  const at = Date.parse(run.startedAt);
  return Number.isFinite(at) ? at : null;
}
