import { Link } from 'react-router';
import { sessionsWithArea } from '@/shell/paths';
import { stageIsShown } from './stage/AttentionStage';
import {
  isNeverFixated,
  neverFixatedProblem,
  neverFixatedSentence,
  noFiguresRecorded,
} from './attentionWording';
import type { AttentionArea } from './useAttentionAreas';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import styles from './isolatedArea.module.css';

/**
 * `#att-caption` — what isolating one area of interest says, and the sentence that makes
 * an absence a result.
 *
 * Isolating is the move this screen exists for: a finding names an area, the URL carries
 * it, and everything above narrows to it. The caption is the words for what the overlays
 * then show — and, when the area is one nobody ever fixated, the words are the whole
 * finding, because there is nothing left on the page to look at (`docs/FLOW.md` section 7,
 * beat 5). *The thing the team shipped was never seen*, said plainly, rather than left as a
 * `never` in a table for the reader to notice.
 *
 * Three rules hold it together:
 *
 * - **The never-fixated sentence is not written here.** It is `attentionWording`'s, the
 *   same formatter the table's `never` comes from, so the caption and the row can never
 *   disagree about the same area.
 * - **A half sentence is not printed.** The count of people who reached this step comes
 *   from the session files, so while those are still arriving the caption is withheld
 *   rather than rendered with a number that is about to change. It is withheld on a step
 *   nobody reached too: the stage is then the words *nobody got this far*, and "0 of 0
 *   people who reached this step looked at it" under them would report a step the audience
 *   never saw as an area they never looked at — two different findings, and only one of
 *   them true.
 * - **The region is always mounted, empty or not.** A live region that appears with its
 *   text is a region a screen reader never announces, and isolating an area would then be
 *   a result only a pointer and a pair of eyes could have.
 *
 * **Departure from the prototype, with reason.** The prototype wraps only the sentence's
 * first clause in `.nofix` and leaves the rest in the footnote's own colour. Here the
 * emphasis covers the whole sentence, because the sentence arrives as one string from the
 * formatter: splitting it would mean writing its words a second time in this file, which is
 * exactly the disagreement `attentionWording` exists to prevent.
 *
 * An `?aoi=` that names no area of this version's step never reaches this component —
 * `useAttentionSelection` drops it and `AttentionPage` prints the fallback's own sentence
 * above the stage, saying what was asked for and what is shown instead. Repeating it down
 * here would state one fact twice in one screen.
 */

export interface IsolatedAreaCaptionProps {
  readonly runId: string;
  /** The version, as the URL names it — the word the sentence uses for it. */
  readonly variant: string;
  /** The area the screen is isolated to, or `null` for all of them. */
  readonly isolated: AttentionArea | null;
  /** This version's step's people: the fixations to count, and whether they have arrived. */
  readonly sessions: AttentionStepSessions;
}

/** The prototype's isolate caption, word for word, for an area the audience did look at. */
const isolatedSentence = (aoiLabel: string, inArea: number, onStep: number): string =>
  `Isolated to “${aoiLabel}”: ${inArea} fixations of the ${onStep} on this step.`;

export function IsolatedAreaCaption({
  runId,
  variant,
  isolated,
  sessions,
}: IsolatedAreaCaptionProps) {
  return (
    <p className="footnote" id="att-caption" role="status" data-section="isolated-area">
      {isolated === null || sessions.status !== 'ready' || !stageIsShown(sessions) ? null : (
        <Said runId={runId} variant={variant} isolated={isolated} sessions={sessions} />
      )}
    </p>
  );
}

/** What the caption says about one isolated area, over people who have all arrived. */
function Said({ runId, variant, isolated, sessions }: IsolatedAreaCaptionProps) {
  if (isolated === null) return null;
  const { aoi, metric } = isolated;

  // The two faults the table states in the row's own cells, stated here too: isolating an
  // area the run is wrong about must not print a figure the run did not support.
  if (metric === null) return noFiguresRecorded(aoi.id);
  const problem = neverFixatedProblem(metric);
  if (problem !== null) return problem;

  if (isNeverFixated(metric)) {
    return (
      <span className={styles.nofix}>
        {neverFixatedSentence({
          aoiLabel: aoi.label,
          variantName: variant,
          reachedCount: sessions.reachedCount,
        })}
      </span>
    );
  }

  const inArea = sessions.fixations.filter((fixation) => fixation.aoiId === aoi.id).length;
  return (
    <>
      {isolatedSentence(aoi.label, inArea, sessions.fixations.length)}{' '}
      {/* Offered only here: there is no list of the people who fixated an area nobody ever
          fixated, and a link to an empty list would undo the sentence above it. */}
      <Link to={sessionsWithArea(runId, aoi.variant, aoi.id)}>
        Open the sessions that fixated it
      </Link>
    </>
  );
}
