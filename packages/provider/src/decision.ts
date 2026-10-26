import { DECISION_ACTION_KINDS } from './types.js';
import type { Decision, DecisionContext, DecisionUsage } from './types.js';

/**
 * What a decision costs when it costs nothing, and how the swarm adds up what it does cost
 * — plus the one check every provider's output is held to.
 *
 * The check lives here rather than in each provider because the thing it guards is the
 * interface's promise, not an implementation detail: a decision targets an element the
 * agent actually looked at. The offline policy cannot break it by construction; a model
 * can, by naming an element that was never on the screen, and the swarm finds that out
 * here instead of in the browser.
 *
 * **It reports, it never throws.** What a model provider hands it is parsed from a reply
 * and may be missing a field or carry the wrong kind of value altogether, which is the
 * case this check exists for: every malformed shape comes back as a violation in words,
 * so a run logs the reply it could not use and carries on.
 */

/** A free call: five zeroes. Frozen, so a caller cannot make the offline provider cost money. */
export const FREE_USAGE: DecisionUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  estimatedPriceUsd: 0,
});

/** The run-level total of a session's or a run's calls, field by field (#32). */
export const sumUsage = (usages: Iterable<DecisionUsage>): DecisionUsage => {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let estimatedPriceUsd = 0;
  for (const usage of usages) {
    inputTokens += usage.inputTokens;
    cachedInputTokens += usage.cachedInputTokens;
    outputTokens += usage.outputTokens;
    reasoningOutputTokens += usage.reasoningOutputTokens;
    estimatedPriceUsd += usage.estimatedPriceUsd;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, estimatedPriceUsd };
};

const USAGE_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'estimatedPriceUsd',
] as const satisfies readonly (keyof DecisionUsage)[];

/** The action kinds that are aimed at an element the agent looked at. */
const ELEMENT_TARGETED_KINDS = new Set(['click', 'read']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Every way a decision can fail the interface, in words a run log can print. An empty
 * array means the decision is well formed for this context.
 *
 * The parameter is typed as a `Decision` because that is what a provider promises, and the
 * body trusts none of it: a reply parsed into the wrong shape is reported, not thrown.
 */
export const validateDecision = (
  context: DecisionContext,
  decision: Decision,
): readonly string[] => {
  if (!isObject(decision)) {
    return [
      `a decision is an object carrying an intent, one action and its usage: found ${JSON.stringify(decision)}`,
    ];
  }

  const violations: string[] = [];
  const { action, intent, usage, relevanceHints } = decision as Partial<Decision>;
  const fixatedIds = new Set(context.fixatedElements.map((element) => element.id));

  if (typeof intent !== 'string' || intent.trim() === '') {
    violations.push(
      `a decision states the agent’s intent in its own words, and this intent is ${JSON.stringify(intent)}`,
    );
  }

  if (!isObject(action)) {
    violations.push(
      `a decision carries exactly one action with its target: found ${JSON.stringify(action)}`,
    );
  } else {
    const { kind, targetElementId } = action;
    if (typeof kind !== 'string' || !DECISION_ACTION_KINDS.includes(kind)) {
      violations.push(
        `the action set is ${DECISION_ACTION_KINDS.join(', ')}: found ${JSON.stringify(kind)}`,
      );
    }
    if (targetElementId !== null && typeof targetElementId !== 'string') {
      violations.push(
        `an action targets an element by id, or nothing at all: found ${JSON.stringify(targetElementId)}`,
      );
    } else if (targetElementId !== null && !fixatedIds.has(targetElementId)) {
      violations.push(
        `a decision targets an element the agent fixated on this screen: ${JSON.stringify(
          targetElementId,
        )} is not one of ${[...fixatedIds].join(', ') || '(none)'}`,
      );
    }
    if (targetElementId === null && ELEMENT_TARGETED_KINDS.has(kind as string)) {
      violations.push(`a ${kind} needs the element it is aimed at, and this one has no target`);
    }
    if (
      targetElementId !== null &&
      typeof kind === 'string' &&
      DECISION_ACTION_KINDS.includes(kind) &&
      !ELEMENT_TARGETED_KINDS.has(kind)
    ) {
      // A model that puts an id on every action would have the run act on an element the
      // agent has just decided to walk away from.
      violations.push(
        `a ${kind} is not aimed at an element, so its target is null: found ${JSON.stringify(targetElementId)}`,
      );
    }
  }

  if (!isObject(usage)) {
    violations.push(
      `a decision reports what the call cost, in all five figures: found ${JSON.stringify(usage)}`,
    );
  } else {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        violations.push(`usage.${field} is a non-negative number: found ${JSON.stringify(value)}`);
      }
    }
    if (usage.cachedInputTokens > usage.inputTokens) {
      violations.push(
        `cached input tokens are part of the input tokens: ${usage.cachedInputTokens} of ${usage.inputTokens}`,
      );
    }
    if (usage.reasoningOutputTokens > usage.outputTokens) {
      violations.push(
        `reasoning tokens are part of the output tokens: ${usage.reasoningOutputTokens} of ${usage.outputTokens}`,
      );
    }
  }

  if (relevanceHints !== undefined && !isObject(relevanceHints)) {
    violations.push(
      `relevance hints are a value per element id: found ${JSON.stringify(relevanceHints)}`,
    );
  } else {
    for (const [elementId, hint] of Object.entries(relevanceHints ?? {})) {
      if (!fixatedIds.has(elementId)) {
        violations.push(
          `a relevance hint names an element the agent fixated on this screen: ${JSON.stringify(elementId)} is not one of them`,
        );
      }
      if (typeof hint !== 'number' || !Number.isFinite(hint) || hint < 0 || hint > 1) {
        violations.push(`a relevance hint is on [0, 1]: ${elementId} is ${JSON.stringify(hint)}`);
      }
    }
  }

  return violations;
};
