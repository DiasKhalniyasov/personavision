/**
 * `@personavision/swarm` — the run loop, and how a session ended.
 *
 * `decideOutcome` is the one place a session's status, step, reason and attribution are
 * decided (#35): `runSession` (#44) stores what it returns unmodified, `runSwarm` (#49)
 * reports it per session, the friction score (#26) reads `excludedFromScores` off the
 * stored session, and the screens read the outcome. Nothing re-derives it.
 *
 * `docs/FLOW.md` sections 5 and 8; step #8.
 */

export { AUTOMATION_FAILURE_KINDS, decideOutcome, OUTCOME_POLICY } from './outcome.js';
export { runSession } from './run-session.js';
export type { RunSessionInput, SessionProviders, SessionScreen } from './run-session.js';
export type {
  Attribution,
  AutomationFailure,
  AutomationFailureKind,
  DecidingPersona,
  OutcomePolicy,
  OutcomeStatus,
  SessionOutcome,
  SessionTrace,
  TraceAction,
  TraceActionType,
  TraceFixation,
  TraceScreen,
} from './outcome.js';
