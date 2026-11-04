import { Link } from 'react-router';
import type { FunnelSlice, Run } from '@personavision/contract';
import { heatmapLink } from '@/shell/paths';
import { biggestDropSentence, outcomeNote, reachedNote, stepLabel } from './funnelWords';
import styles from './funnel.module.css';

/**
 * The funnel of `#screen-funnel`: one row per step of the slice, and the stored reason
 * beside the biggest drop.
 *
 * Every figure is a field of the slice the screen picked. The bar's width is the stored
 * `reachedShare` and nothing else, so the drawing and the note beside it can never disagree;
 * the bar itself is `aria-hidden`, because the note carries the same numbers in words and a
 * reader of either gets the whole row.
 *
 * **The drop is the pipeline's, and so is its reason.** `biggestDrop` names the step, how
 * many were lost there, of how many reached it, and the commonest `outcome.reason` among
 * them — this screen marks that row and prints that sentence, and infers neither. A slice
 * with no drop stored prints no notice at all.
 *
 * The notice links to that step's heatmap. A heatmap is of **one** version
 * (`/runs/:runId/attention/:variant/:step`), and a funnel slice of every version names none,
 * so the link opens the first version the run declares and carries the segment filter the
 * screen is showing; a slice filtered to one version opens that one.
 */

export function FunnelChart({
  run,
  slice,
  markedStep,
}: {
  run: Run;
  slice: FunnelSlice;
  /** The step `?step=` opened on, marked in the funnel. `null` when the URL named none. */
  markedStep: string | null;
}) {
  const drop = slice.biggestDrop;

  return (
    <div className="card card-lg" data-funnel="card">
      <div className={styles.funnel} data-funnel="rows">
        {slice.funnel.map((row) => (
          <div
            key={row.step}
            className={styles.funnelRow}
            data-step={row.step}
            aria-current={row.step === markedStep ? 'step' : undefined}
          >
            <span>
              <strong>{stepLabel(run, row.step)}</strong>
            </span>
            {/* Decorative: its width is the share printed in the note beside it. */}
            <div className={styles.funnelBar} aria-hidden="true">
              <i
                data-drop={drop !== null && drop.step === row.step ? '' : undefined}
                style={{ width: `${row.reachedShare * 100}%` }}
              />
            </div>
            <span className={`${styles.funnelNote} faint num`}>
              {reachedNote(row)}
              <span className={styles.outcomes}>{outcomeNote(row)}</span>
            </span>
          </div>
        ))}
      </div>
      {drop === null ? null : (
        <div className={`notice info ${styles.reason}`} data-funnel="drop-reason">
          <span>
            <b>{biggestDropSentence(drop, stepLabel(run, drop.step))}</b> {drop.reason}{' '}
            <Link
              to={heatmapLink(run.runId, slice.variant ?? run.variants[0]?.id ?? '', drop.step, {
                segment: slice.segment ?? undefined,
              })}
            >
              See where they clicked
            </Link>
            .
          </span>
        </div>
      )}
    </div>
  );
}
