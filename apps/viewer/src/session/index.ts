/**
 * The session module: how both Sessions screens read a run.
 *
 * It renders nothing. What it holds is the behaviour the Sessions list and the session
 * replay are written against, in one place so that two screens built in parallel cannot end
 * up with two clocks or two words for the same outcome:
 *
 * - **reading** — the manifest from `run.json`, each session fetched when it is asked for;
 * - **the timeline** — one clock per session, and stepping along it by fixation;
 * - **the vocabulary** — the words and tokens for an outcome and its attribution;
 * - **the list** — one row's worth of a session, the three filters, and the findings a
 *   session is evidence for.
 *
 * Everything it reads is addressed and parsed through `@personavision/contract`.
 */

export { openRun } from './reading.js';
export type { RunSessions, RunSource } from './reading.js';

export { sessionTimeline } from './timeline.js';
export type { SessionTimeline, TimelineMoment, TrackEntry, TrackEntryKind } from './timeline.js';

export { attributionWords, isOutcomeStatus, outcomeWords } from './vocabulary.js';
export type { Attribution, AttributionWords, OutcomeStatus, OutcomeWords } from './vocabulary.js';

export { findingsForSession, matchesSessionFilter, sessionRow } from './list.js';
export type { Finding, SessionFilter, SessionRow } from './list.js';
