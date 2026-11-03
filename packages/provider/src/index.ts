/**
 * `@personavision/provider` — the model layer.
 *
 * **Two interfaces, side by side.** `DecisionProvider` is the session-scoped decider every
 * agent session decides through: an agent, a screen, a decision. `WonderProvider` is the
 * one-shot seam beside it — a document in, a typed object out, no session and no screen —
 * which is how the structured audience, the goal, the analysis and the one change are
 * written (#219). Neither extends the other, and
 * `docs/adr/0003-the-one-shot-wonder-seam.md` records why.
 *
 * Each has the same three parts: an offline deterministic implementation that is the
 * project's default, a model implementation behind it — the decision interface's is here,
 * the one-shot interface's beside it — and a contract suite any implementation
 * inherits. Both suites are published from the separate entry point
 * `@personavision/provider/testing`, so that nothing in a run imports a test framework.
 * Selection for both lives in one place and follows one set of rules: offline with no key, a
 * mode never upgraded implicitly, a model request that names no model refused, and a named
 * model never substituted.
 *
 * The trajectory file is here too: the append-only `trajectories/S-NN.jsonl` one session
 * writes, the replay that re-runs that session from it with no key and no network, and the
 * audit that reads its tokens and its cost back out (#139).
 *
 * `docs/FLOW.md` sections 1, 8, 12 and 16; steps #8 and #219; tickets #33, #138, #139 and
 * #251.
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
  ScreenElement,
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
  selectWonderProvider,
} from './select.js';
export type {
  ProviderModeRequest,
  RequestedProviderMode,
  RequestedWonderMode,
  SelectDecisionProviderOptions,
  SelectedDecisionProvider,
  SelectedWonderProvider,
  SelectWonderProviderOptions,
  WonderModeRequest,
} from './select.js';

export { parseWonderReply, WONDER_EFFORTS, WONDER_USES, WonderReplyError } from './wonder.js';
export type {
  WonderAsk,
  WonderEffort,
  WonderModel,
  WonderProvider,
  WonderReply,
  WonderUse,
} from './wonder.js';

export { createOfflineWonderProvider, OFFLINE_WONDER_PROVIDER_NAME } from './wonder-offline.js';

export {
  applyUnifiedPatch,
  CHANGE_EFFORT,
  CHANGE_REPLY_SCHEMA_NAME,
  changeAsk,
  decideChange,
  SIMULATED_LABEL,
} from './wonder-change.js';
export type { ChangeAskInput, ChangeFile } from './wonder-change.js';

export {
  createMetaWonderProvider,
  DEFAULT_WONDER_EFFORT,
  DEFAULT_WONDER_TIMEOUT_MS,
  WONDER_FAILURE_KINDS,
  WONDER_PROVIDER_MODE,
  WONDER_PROVIDER_NAME,
  WonderCallError,
} from './wonder-model.js';
export type {
  MetaWonderProviderOptions,
  WonderFailureKind,
  WonderHttpRequest,
  WonderReplyFormat,
  WonderRequestBody,
  WonderTransport,
} from './wonder-model.js';

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
  WONDER_MODEL_ID,
  WONDER_PRICES_READ_ON,
} from './meta-pricing.js';
export type {
  BilledTokens,
  ModelId,
  ModelMode,
  ModelSpec,
  PricedModelId,
  WonderModelId,
} from './meta-pricing.js';
