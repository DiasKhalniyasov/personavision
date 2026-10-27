/**
 * `@personavision/swarm` — the run loop, and how a session ended.
 *
 * `runSwarm` is a whole run — every generated person on every seed group against every
 * variant, bounded, resilient and written as each session lands (#49) — and `runSession` is
 * one of its sessions (#44).
 *
 * `decideOutcome` is the one place a session's status, step, reason and attribution are
 * decided (#35): `runSession` stores what it returns unmodified, `runSwarm` reports it per
 * session, the friction score (#26) reads `excludedFromScores` off the stored session, and
 * the screens read the outcome. Nothing re-derives it.
 *
 * `docs/FLOW.md` sections 5 and 8; step #8.
 */

export { AUTOMATION_FAILURE_KINDS, decideOutcome, OUTCOME_POLICY } from './outcome.js';
export { runSession } from './run-session.js';
export type { RunSessionInput, SessionProviders, SessionScreen } from './run-session.js';
export { DEFAULT_CONCURRENCY, planSwarm, runSwarm } from './run-swarm.js';
export type {
  RunSwarmInput,
  SwarmPlanInput,
  SwarmProgress,
  SwarmResult,
  SwarmSession,
  SwarmSessionFinished,
  SwarmSessionStarted,
} from './run-swarm.js';
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
