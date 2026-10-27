/**
 * `@personavision/provider` — the decision layer.
 *
 * One interface (`DecisionProvider`), the session-scoped decider every agent session
 * decides through, the offline deterministic policy that is the project's default, the
 * selection that decides which provider a run gets and records it, and the contract suite a
 * new provider inherits. The suite is a separate entry point,
 * `@personavision/provider/testing`, so that nothing in a run imports a test framework.
 *
 * The trajectory file is here too: the append-only `trajectories/S-NN.jsonl` one session
 * writes, the replay that re-runs that session from it with no key and no network, and the
 * audit that reads its tokens and its cost back out (#139).
 *
 * `docs/FLOW.md` sections 1 and 8; step #8; tickets #33, #138 and #139.
 */

export { DECISION_ACTION_KINDS } from './types.js';
export type {
  Decision,
  DecisionAction,
  DecisionActionKind,
  DecisionContext,
  DecisionModel,
  DecisionProvider,
  DecisionScreenshot,
  DecisionSession,
  DecisionSessionIdentity,
  DecisionSessionScope,
  DecisionStep,
  DecisionUsage,
  FixatedElement,
  Goal,
  PastAction,
  PersonaTraits,
  ProviderMode,
  RelevanceHints,
  TrajectoryEntry,
  TrajectorySink,
} from './types.js';

export { FREE_USAGE, totalUsage, validateDecision } from './decision.js';

export { createDecisionSession, DecisionSessionClosedError } from './session.js';
export type { DecisionSessionOptions } from './session.js';

export { createOfflineDeterministicProvider, OFFLINE_PROVIDER_NAME } from './offline.js';
export type { OfflineProviderOptions } from './offline.js';

export {
  DEFAULT_MODEL_MODE,
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectDecisionProvider,
} from './select.js';
export type {
  ProviderModeRequest,
  RequestedProviderMode,
  SelectDecisionProviderOptions,
  SelectedDecisionProvider,
} from './select.js';

export {
  createMetaModelApiProvider,
  DEFAULT_TIMEOUT_MS,
  META_MODEL_PROVIDER_NAME,
  META_RESPONSES_ENDPOINT,
  MODEL_FAILURE_KINDS,
  ModelDecisionError,
} from './meta-model.js';
export type {
  MetaModelApiProviderOptions,
  MetaTrajectorySink,
  ModelFailureKind,
  ModelHttpRequest,
  ModelHttpResponse,
  ModelTransport,
  TrajectoryCall,
  TrajectoryRecord,
} from './meta-model.js';

export {
  auditRunTrajectories,
  auditTrajectory,
  createTrajectoryReplayProvider,
  openTrajectoryFile,
  readTrajectory,
  REPLAY_API_KEY,
  replayTrajectory,
  sessionIdFromTrajectoryFileName,
  TrajectoryMismatchError,
  trajectoryPath,
  TrajectoryReadError,
} from './trajectory.js';
export type {
  TrajectoryAudit,
  TrajectoryFile,
  TrajectoryLine,
  TrajectoryTurn,
} from './trajectory.js';

export {
  estimateCostUsd,
  MODEL_ID_BY_MODE,
  MODEL_SPEC_BY_ID,
  PRICES_READ_ON,
} from './meta-pricing.js';
export type { BilledTokens, ModelId, ModelMode, ModelSpec } from './meta-pricing.js';
