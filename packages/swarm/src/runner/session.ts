/**
 * A session that never produced one, written as the session it would have been — shared by
 * both runners, because a session that broke reads the same whether it broke in this process
 * or in a container.
 *
 * It carries no screen, no fixation and no action, because none happened, and `decideOutcome`
 * reads it as an automation failure — excluded from every score, so a weakness of the
 * simulation is never reported as a weakness of the product, and counted in the run's own
 * automation-failure total so that a run whose failures are more than a fifth of its sessions
 * says so above its summary.
 */

import { SCHEMA_VERSION } from '@personavision/contract';
import { decideOutcome } from '../outcome.js';
import type { Session } from '@personavision/contract';
import type { Capture } from '@personavision/browser';
import type { AutomationFailure } from '../outcome.js';
import type { SessionRunRequest } from './types.js';

/** What a session that broke before it reached a screen says it broke on. */
export const FAILED_BEFORE_A_STEP = 'start';

/** The step the session had reached when it broke, for a failure that names one. */
export const stepNamed = (captures: readonly Capture[]): string =>
  captures.at(-1)?.step ?? FAILED_BEFORE_A_STEP;

export const brokenSession = (request: SessionRunRequest, failure: AutomationFailure): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: request.sessionId,
  runId: request.runId,
  variant: request.variant.id,
  taskId: request.task.id,
  kind: 'simulated',
  persona: {
    id: request.persona.id,
    traits: request.persona.traits,
    device: request.persona.device,
  },
  participant: null,
  seed: request.seed,
  startedAt: request.startedAt,
  durationMs: 0,
  screens: [],
  fixations: [],
  saccades: [],
  actions: [],
  outcome: decideOutcome(
    {
      screens: [],
      fixations: [],
      actions: [],
      durationMs: 0,
      taskCompleted: false,
      primaryActionAoiId: null,
      automationFailure: failure,
      wallClockBudgetMs: null,
    },
    request.persona,
    request.outcomePolicy,
  ),
  integrity: { selectorFailures: 0, retries: 0 },
});
