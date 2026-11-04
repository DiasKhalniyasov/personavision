import { useMemo } from 'react';
import type { Run } from '@personavision/contract';
import { Toggle } from '@/components/ui/toggle';
import { reachCounts } from './reachCounts';
import { reachedOf } from './screenSlices';
import type { AttentionSelection } from './useAttentionSelection';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import type { ScreenFiguresView } from './useScreenFigures';
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
 * **The counts are the aggregate's, and they obey the filters.** Narrowing to the people who
 * gave up re-reads the strip from that slice, so the thinning a reader sees is the thinning
 * of the people they asked about — which is the whole point of putting the filters on this
 * screen. `reachedOf` picks the row; nothing is counted here.
 *
 * A run that computed **no aggregate** keeps the count the Attention screen always showed:
 * `reachCounts` over the scored sessions, with the run's own `scores[].scoredSessionCount`
 * as the denominator. The two can never disagree, because a run with no aggregate has no
 * filters either — the strips are not rendered — so both are the same population counted
 * once. Without the fallback an older run would lose a figure it used to show.
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
  /** The aggregate's figures for these filters, which every count here is read from. */
  readonly screen: ScreenFiguresView;
}

export function StepFilmstrip({ run, selection, sessions, screen }: StepFilmstripProps) {
  const fromSessions = useMemo(
    () => reachCounts(run.steps, sessions.sessions, selection.variant),
    [run.steps, sessions.sessions, selection.variant],
  );

  return (
    <div className={styles.filmstrip} role="group" aria-label="Step" data-section="step-filmstrip">
      {run.steps.map((step) => (
        <Toggle
          key={step.id}
          data-step={step.id}
          pressed={step.id === selection.step}
          onPressedChange={() => {
            selection.setStep(step.id);
          }}
        >
          <span className="microlabel">{step.label}</span>
          <ReachCount
            step={step.id}
            screen={screen}
            selection={selection}
            sessions={sessions}
            fromSessions={fromSessions.find((row) => row.step.id === step.id)?.reached ?? 0}
          />
        </Toggle>
      ))}
    </div>
  );
}

/**
 * How many people reached this step, out of the people the filters leave.
 *
 * Several readings, and every one that is not a count is said in words. A count the screen
 * does not have yet is not zero, a count it could not read is not zero, and a composition
 * nobody satisfies is not zero either; the stage states what went wrong, and the frame's job
 * is only to never print a figure the run does not support.
 */
function ReachCount({
  step,
  screen,
  selection,
  sessions,
  fromSessions,
}: {
  step: string;
  screen: ScreenFiguresView;
  selection: AttentionSelection;
  sessions: AttentionStepSessions;
  fromSessions: number;
}) {
  const unsettled = (state: string, words: string) => (
    <span className={`${styles.reach} ${styles.unsettled}`} data-reach={state}>
      {words}
    </span>
  );

  switch (screen.status) {
    case 'loading':
      return unsettled('reading', 'reading this test’s figures…');
    case 'unreadable':
      return unsettled('unreadable', 'no count: the figures are unreadable');
    case 'no-people':
      return unsettled('no-people', 'nobody matches both filters');
    case 'none':
      // No aggregate at all: the count the Attention screen always showed, over the scored
      // sessions, with the three readings that are not a count still said in words.
      if (sessions.status === 'error') {
        return unsettled('unreadable', 'no count: the sessions are unreadable');
      }
      if (sessions.status === 'loading') {
        return unsettled('reading', 'reading the sessions…');
      }
      return <Counted reached={fromSessions} of={sessions.scoredSessionCount} />;
    case 'no-screen':
    case 'ready':
      break;
  }

  // The slice's own row for this step of this version. `null` is nobody of these people
  // standing on it, which is a count of nought and a finding rather than a gap: the slice
  // exists, so there is a denominator to say it out of.
  const reached = reachedOf(screen.slice, selection.variant, step) ?? 0;
  return <Counted reached={reached} of={screen.sessionCount ?? 0} />;
}

/** The count itself. A nought is the prototype's zero marker, and the frame stays pressable. */
function Counted({ reached, of }: { reached: number; of: number }) {
  return (
    <span
      className={reached === 0 ? `${styles.reach} ${styles.zero}` : styles.reach}
      data-reach={reached === 0 ? 'zero' : 'counted'}
    >
      {reached} of {of} reached it
    </span>
  );
}
