import type { Aggregate, FunnelSlice, Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { timeLabel } from '@/screens/replay/position';
import { stepLabel } from '@/screens/replay/runWords';
import { completionBand, percent } from '@/screens/verdict/completionBand';
import '@/screens/verdict/verdict.css';
import styles from './summary.module.css';

/**
 * The three headline numbers of a hundred-agent test: the `.figures` of `#screen-results`.
 *
 * *How did my audience do*, in the three figures `docs/FLOW.md` section 14.1 names —
 * **completion rate**, **median time to complete**, and **the top failure point**.
 *
 * **Not one of them is computed here.** Every figure is a field of `aggregate.json`, which
 * the pipeline wrote once over the sessions: a browser does not re-aggregate a hundred
 * sessions, which `docs/adr/0001-run-data-over-http-as-static-files.md` forbids, and a
 * screen that recounted them could disagree with the summary beside it. What this file does
 * is read the aggregate's own *whole run* slice and word it.
 *
 * Automation failures are already out of every one of these figures: the aggregate counts
 * them once, in `excludedAutomationFailures`, and every slice in the file is of the scored
 * sessions only (`docs/FLOW.md` section 11). The notice under the figures states that count,
 * so the reader sees the denominator and the exclusion together.
 *
 * The three readings, each named where it is stored:
 *
 * 1. **Completed** — the sessions whose stored outcome was a success, over the scored
 *    sessions: the aggregate's `outcome: 'success'` slice count over `scoredSessionCount`.
 *    Both are counts the pipeline stored; the percentage is the two of them said as one
 *    number, in the band the `--completion-threshold-*` tokens declare.
 * 2. **Median time to complete** — `timing.total.p50Ms` of the whole-run slice, which the
 *    contract declares to be exactly this figure's source, with the slowest session beside
 *    it off the same block's `slowest` row.
 * 3. **The top failure point** — `biggestDrop`, which is the step that lost the most people
 *    and how many of the people who reached it it lost.
 */

/**
 * The slice every figure here is read off: the whole run, which the aggregate stores as the
 * slice that filters by neither a version nor a segment.
 *
 * `undefined` only for an aggregate of no scored session — a run that has produced nothing
 * yet stores no slice at all, by the contract's rule that a slice has a denominator. There
 * is then no figure to show and none is invented.
 */
export const wholeRun = (aggregate: Aggregate): FunnelSlice | undefined =>
  aggregate.funnelSlices.find((slice) => slice.variant === null && slice.segment === null);

/**
 * How many of the scored sessions completed the task: the aggregate's own count of the
 * sessions whose outcome was a success, across every segment.
 *
 * `0` when no such slice is stored, which is a run nobody succeeded in — the aggregate
 * leaves out a slice no session falls in, and against a denominator it does carry that
 * absence is a result and not a gap.
 */
export const completedCount = (aggregate: Aggregate): number =>
  aggregate.screenSlices.find((slice) => slice.segment === null && slice.outcome === 'success')
    ?.sessionCount ?? 0;

/** One figure: the number, what it is, and the population or the spread behind it. */
function Figure({
  value,
  label,
  pop,
  band,
}: {
  value: string;
  label: string;
  pop: string;
  band?: string;
}) {
  return (
    <figure className="figure">
      <span className={`figure-value num${band === undefined ? '' : ` completion-${band}`}`}>
        {value}
      </span>
      <figcaption className="figure-caption">
        <span className="figure-label">{label}</span>
        <span className="figure-pop">{pop}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The row's height, held while the aggregate is read, so the page does not jump when the
 * figures arrive. Three placeholders, because three figures land at once.
 */
export function HeadlineFiguresLoading() {
  return (
    <div className="figures" data-section="headline-figures" data-state="loading">
      {[0, 1, 2].map((position) => (
        <div className={styles.figureLoading} key={position} aria-hidden="true">
          <Skeleton className={styles.figureLoadingValue} />
          <Skeleton className={styles.figureLoadingLabel} />
        </div>
      ))}
    </div>
  );
}

export function HeadlineFigures({ aggregate, run }: { aggregate: Aggregate; run: Run }) {
  const slice = wholeRun(aggregate);
  // No slice is no measurement: an aggregate of nothing carries no denominator, so there is
  // no share, no spread and no drop to report, and the screen shows no figure rather than
  // three zeroes. The page above decides what to say instead.
  if (slice === undefined) return null;

  const scored = aggregate.scoredSessionCount;
  const completed = completedCount(aggregate);
  const rate = completed / scored;
  const { total, slowest } = slice.timing;
  const drop = slice.biggestDrop;
  const slowestSession = slowest[0];

  return (
    <div className="figures" data-section="headline-figures">
      <Figure
        band={completionBand(rate)}
        label="Completed"
        pop={`${String(completed)} of ${String(scored)} ${scored === 1 ? 'person' : 'people'}`}
        value={`${String(percent(rate))}%`}
      />
      <Figure
        label="Median time to complete"
        // The slowest *session*, not the slowest finisher: the stored row is the longest of
        // the scored sessions, whatever became of it, and naming it a finisher would claim
        // something the aggregate does not record.
        pop={
          slowestSession === undefined
            ? `over ${String(total.sampleCount)} ${total.sampleCount === 1 ? 'session' : 'sessions'}`
            : `slowest session ${timeLabel(slowestSession.totalMs)}`
        }
        value={timeLabel(total.p50Ms)}
      />
      {drop === null ? (
        <Figure
          label="Where they dropped out"
          pop="Nobody dropped out: every person who reached a step went on from it."
          value="—"
        />
      ) : (
        <Figure
          label={`Dropped out on the ${stepLabel(run, drop.step)} step`}
          pop={`of the ${String(drop.ofReached)} who got there`}
          value={String(drop.left)}
        />
      )}
    </div>
  );
}
