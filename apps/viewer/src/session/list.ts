import type { Findings, Run, Session } from '@personavision/contract';
import { attributionWords, outcomeWords } from './vocabulary.js';
import type { AttributionWords, OutcomeStatus, OutcomeWords } from './vocabulary.js';

/**
 * One row of the Sessions screen, and the predicate behind its three filters.
 *
 * The row is a projection and nothing more: every value on it is read as stored, including
 * `excludedFromScores`, which the pipeline derived once and no screen re-derives. What the
 * run holds and the session does not — the persona's name and segment, the label of the
 * step it ended on — is looked up by id rather than copied into the session.
 */

export type Finding = Findings['findings'][number];

export interface SessionRow {
  readonly sessionId: string;
  readonly variant: string;
  /** `null` for an imported real session, which was not seeded. */
  readonly seed: number | null;
  /** `null` for a real session, which carries a participant instead of a persona. */
  readonly personaId: string | null;
  /** The persona's own name and segment, from `run.personas`. */
  readonly personaName: string | null;
  readonly segment: string | null;
  readonly participantId: string | null;
  readonly deviceName: string | null;
  readonly outcome: OutcomeWords;
  readonly attribution: AttributionWords;
  /** As stored. An automation failure is listed and marked, never dropped. */
  readonly excludedFromScores: boolean;
  readonly durationMs: number;
  readonly fixationCount: number;
  /**
   * The step the session ended on. `label` is `null` when the run never planned that step:
   * a session may legitimately end somewhere the task did not go.
   */
  readonly endedOn: { readonly step: string; readonly label: string | null };
  /** Why it ended, in the pipeline's words. */
  readonly reason: string;
}

/** One session as the Sessions screen shows it. */
export function sessionRow(run: Run, session: Session): SessionRow {
  const persona = run.personas.find((candidate) => candidate.id === session.persona?.id);
  const step = run.steps.find((candidate) => candidate.id === session.outcome.step);

  return {
    sessionId: session.sessionId,
    variant: session.variant,
    seed: session.seed,
    personaId: session.persona?.id ?? null,
    personaName: persona?.name ?? null,
    segment: persona?.segment ?? null,
    participantId: session.participant?.id ?? null,
    // The session carries the device it ran on, which is what makes it reproducible.
    deviceName: session.persona?.device.name ?? null,
    outcome: outcomeWords(session.outcome.status),
    attribution: attributionWords(session.outcome.attribution),
    excludedFromScores: session.outcome.excludedFromScores,
    durationMs: session.durationMs,
    fixationCount: session.fixations.length,
    endedOn: { step: session.outcome.step, label: step?.label ?? null },
    reason: session.outcome.reason,
  };
}

/**
 * The three filters of the Sessions screen, each of them URL state. An unset filter — left
 * out, or `null` because the URL carries no value for it — constrains nothing.
 */
export interface SessionFilter {
  readonly variant?: string | null;
  readonly outcome?: OutcomeStatus | null;
  /** "Fixated this area of interest", evaluated from `fixations[].aoiId`. */
  readonly aoiId?: string | null;
}

const unset = (value: string | null | undefined): boolean => value === null || value === undefined;

/** Whether one session belongs in a filtered list. Combined filters narrow further. */
export function matchesSessionFilter(session: Session, filter: SessionFilter): boolean {
  if (!unset(filter.variant) && session.variant !== filter.variant) return false;
  if (!unset(filter.outcome) && session.outcome.status !== filter.outcome) return false;
  if (
    !unset(filter.aoiId) &&
    !session.fixations.some((fixation) => fixation.aoiId === filter.aoiId)
  ) {
    return false;
  }
  return true;
}

/**
 * The findings this session is evidence for, best-ranked first, by looking its id up in
 * `findings[].sessionIds`. No text matching on claims, and no second copy of the link.
 *
 * A session no finding names is evidence for nothing, which is an empty list rather than an
 * error: most sessions in a run support no finding at all.
 */
export function findingsForSession(findings: Findings, sessionId: string): readonly Finding[] {
  return findings.findings
    .filter((finding) => finding.sessionIds.includes(sessionId))
    .sort((left, right) => left.rank - right.rank);
}
