import { useMemo } from 'react';
import type { Run } from '@personavision/contract';
import { Toggle } from '@/components/ui/toggle';
import { reachCounts } from './reachCounts';
import type { AttentionSelection } from './useAttentionSelection';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import styles from './stepFilmstrip.module.css';

/**
 * The step filmstrip of `#screen-attention`: one frame per step of the run, each saying how
 * many of this version's audience got that far.
 *
 * It is above the page rather than beside it because it is the first thing the screen says.
 * Four numbers thinning out — eleven at the cart, ten at payment, nine at review, two
 * confirming — are the shape of the problem, and a reader who has seen them knows which
 * heatmap to open before reading one. The frames are also how the step is moved, so the
 * strip is the navigation and the summary at once, exactly as the prototype draws it.
 *
 * Each frame is the shadcn `toggle` primitive: pressing the step already shown changes
 * nothing, because the four steps are four states of one view rather than four places, and
 * `aria-pressed` is what the control says about itself. The step lives in the URL alone —
 * pressing a frame goes through `useAttentionSelection().setStep`, which drops `?aoi=`,
 * since an area of interest belongs to the step it was marked on.
 *
 * Nothing is counted here. `reachCounts` is the one derivation, over the scored sessions
 * `useAttentionStepSessions` has read, and the denominator is the run's own
 * `scores[].scoredSessionCount` — the population the version's figures were worked out
 * from, which this screen states beside the version switch and must not restate differently
 * here.
 *
 * What a frame will not print is a zero it does not mean. A count of nobody reads `0` in the
 * prototype's zero marker and the frame stays pressable, because a step nobody reached is
 * the finding and the screen has words for it. While the sessions are still being read, and
 * if one of them could not be read at all, the frame says so in words instead: a `0` that
 * silently becomes a `9` once the last file lands is the one thing a strip of counts must
 * never do.
 */

export interface StepFilmstripProps {
  readonly run: Run;
  readonly selection: AttentionSelection;
  readonly sessions: AttentionStepSessions;
}

export function StepFilmstrip({ run, selection, sessions }: StepFilmstripProps) {
  const rows = useMemo(
    () => reachCounts(run.steps, sessions.sessions, selection.variant),
    [run.steps, sessions.sessions, selection.variant],
  );

  return (
    <div className={styles.filmstrip} role="group" aria-label="Step" data-section="step-filmstrip">
      {rows.map(({ step, reached }) => (
        <Toggle
          key={step.id}
          data-step={step.id}
          pressed={step.id === selection.step}
          onPressedChange={() => {
            selection.setStep(step.id);
          }}
        >
          <span className="microlabel">{step.label}</span>
          <ReachCount reached={reached} sessions={sessions} />
        </Toggle>
      ))}
    </div>
  );
}

/**
 * How many people reached this step, out of the people this version's figures cover.
 *
 * Three readings, and the two that are not a count are said in words. A count the screen
 * does not have yet is not zero, and a count it could not read is not zero either; the
 * stage states what went wrong with the file, and the frame's job is only to not print a
 * figure the run does not support.
 */
function ReachCount({ reached, sessions }: { reached: number; sessions: AttentionStepSessions }) {
  if (sessions.status === 'error') {
    return (
      <span className={`${styles.reach} ${styles.unsettled}`} data-reach="unreadable">
        no count: the sessions are unreadable
      </span>
    );
  }
  if (sessions.status === 'loading') {
    return (
      <span className={`${styles.reach} ${styles.unsettled}`} data-reach="reading">
        reading the sessions&hellip;
      </span>
    );
  }

  return (
    <span
      className={reached === 0 ? `${styles.reach} ${styles.zero}` : styles.reach}
      data-reach={reached === 0 ? 'zero' : 'counted'}
    >
      {reached} of {sessions.scoredSessionCount} reached it
    </span>
  );
}
