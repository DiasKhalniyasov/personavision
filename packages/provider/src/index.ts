/**
 * `@personavision/provider` — the decision layer.
 *
 * One interface (`DecisionProvider`), the offline deterministic policy that is the
 * project's default, the selection that decides which provider a run gets and records it,
 * and the contract suite a new provider inherits. The suite is a separate entry point,
 * `@personavision/provider/testing`, so that nothing in a run imports a test framework.
 *
 * `docs/FLOW.md` sections 1 and 8; step #8; ticket #33.
 */

export { DECISION_ACTION_KINDS } from './types.js';
export type {
  Decision,
  DecisionAction,
  DecisionActionKind,
  DecisionContext,
  DecisionProvider,
  DecisionScreenshot,
  DecisionStep,
  DecisionUsage,
  FixatedElement,
  Goal,
  PastAction,
  PersonaTraits,
  ProviderMode,
  RelevanceHints,
} from './types.js';

export { FREE_USAGE, totalUsage, validateDecision } from './decision.js';

export { createOfflineDeterministicProvider, OFFLINE_PROVIDER_NAME } from './offline.js';
export type { OfflineProviderOptions } from './offline.js';

export { MODEL_API_KEY_ENV, ModelModeUnavailableError, selectDecisionProvider } from './select.js';
export type { SelectDecisionProviderOptions, SelectedDecisionProvider } from './select.js';
