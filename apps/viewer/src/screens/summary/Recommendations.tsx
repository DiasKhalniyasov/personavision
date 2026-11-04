import { Link } from 'react-router';
import type { Recommendation, Run, SampleProvenance } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { NothingRecorded } from '@/shell/NothingRecorded';
import { paths } from '@/shell/paths';
import { useRecommendations } from '@/shell/useRun';
import { Citations } from './Citations';
import styles from './summary.module.css';

/**
 * *What to change, in order* — the ranked recommendations and the evidence under each one:
 * the `.recs` of `#screen-results`.
 *
 * The lead of a hundred-agent test (`docs/FLOW.md` section 14.1). Each recommendation is
 * **one plain sentence** a site owner could act on, with its rank, the one-sentence
 * explanation the object carries, and its citations as links. Nothing is ranked, worded or
 * summarised here: `rank`, `sentence` and `evidence` are the pipeline's, and the screen
 * renders the order it finds.
 *
 * **A recommendation with nothing to cite is not rendered.** A claim is published with the
 * evidence it rests on or not at all (`docs/FLOW.md` section 14), and the contract holds the
 * file to it — but this screen renders over a file on disk, so it drops such an entry rather
 * than printing a sentence a reader has no way to check. The sentence under the list is what
 * says where the whole write-up is.
 *
 * **Which sessions a recommendation may rest on is not re-decided here either.** No
 * recommendation may rest on an excluded session (`docs/FLOW.md` section 11) and the
 * pipeline is what holds that: deciding it again in the browser would mean reading every
 * session to re-derive who was excluded, which is the aggregation `docs/adr/0001` keeps out
 * of a screen.
 *
 * The block keeps **one slot in every state** — `data-section="recommendations"` — so the
 * page does not shift as the file arrives: a held height while it is read, the list when it
 * is there, and the stated nothing-recorded card when the run produced none.
 */

/** One recommendation: its rank, its sentence, why, and the evidence as links. */
function Rec({ recommendation, run }: { recommendation: Recommendation; run: Run }) {
  return (
    <div className={`rec ${styles.rec}`} data-part="rec" data-rank={recommendation.rank}>
      <span className={`rank num ${styles.rank}`}>{recommendation.rank}</span>
      <div>
        <h3>{recommendation.sentence}</h3>
        <p className={`lede ${styles.why}`}>{recommendation.evidence}</p>
        <Citations citations={recommendation.citations} run={run} />
      </div>
    </div>
  );
}

/**
 * The run produced no recommendation: the stated card, never a zero and never an empty list.
 *
 * The owner's decision 75 on the Results page: **the section stays where it leads and says
 * so** — silence is a measured result, not a missing feature — with why, how much of the run
 * was read, and the way on to the evidence a reader can judge for themselves. So the
 * nothing-recorded card of decision 74 carries three things beside its heading:
 *
 * - **why**, in `nothingToRecommend` — the pipeline's own stored sentence, when it wrote
 *   one. A run with no file at all produced none before the product asked for them, and the
 *   card says that rather than inventing a reason.
 * - **the provenance**, where there is a file: how many of the run's sessions were read, so
 *   the reader can tell a model that found nothing from one that barely looked.
 * - **the funnel and the recordings**, which are where somebody who wanted advice goes next.
 */
function NoRecommendations({
  run,
  sample,
  why,
}: {
  run: Run;
  /** How much of the run was read, where a file says; `null` for a run with no file. */
  sample: SampleProvenance | null;
  why: string | null;
}) {
  return (
    <NothingRecorded heading="This test recommends nothing to change." section="recommendations">
      {why ??
        'It produced no recommendations — not an empty list, and not a claim without the evidence behind it.'}
      {sample === null
        ? ''
        : ` Muse Wonder read ${String(sample.read)} of its ${String(sample.of)} sessions.`}{' '}
      Where people dropped out is on <Link to={paths.funnel(run.runId)}>the funnel</Link>, and every
      attempt is in <Link to={paths.sessions(run.runId)}>the recordings</Link>.
    </NothingRecorded>
  );
}

export function Recommendations({ run }: { run: Run }) {
  const state = useRecommendations(run.runId);

  if (state.status === 'loading') {
    return (
      <div className="section" data-section="recommendations" data-state="loading">
        <Skeleton className={styles.recsLoading} />
      </div>
    );
  }

  // A file that is there and will not parse is a broken run, not a run without
  // recommendations: it says which file and what is wrong with it rather than reading as an
  // absence somebody measured.
  if (state.status === 'unreadable') {
    return (
      <div className="section" data-section="recommendations" data-state="unreadable">
        <p className="notice">
          <span>
            This test&rsquo;s recommendations could not be read: {state.problem} ({state.url})
          </span>
        </p>
      </div>
    );
  }

  if (state.status === 'none') return <NoRecommendations run={run} sample={null} why={null} />;

  const { recommendations, sample, nothingToRecommend } = state.recommendations;
  const shown = recommendations.filter((recommendation) => recommendation.citations.length > 0);

  if (shown.length === 0) {
    return <NoRecommendations run={run} sample={sample} why={nothingToRecommend ?? null} />;
  }

  return (
    <div className="section" data-section="recommendations">
      <div className="pagehead">
        <h2>What to change, in order</h2>
      </div>
      <p className="lede">
        Written by Muse Wonder from the aggregate and {sample.read} of the sessions. Each one cites
        the people it comes from, the second it happens, and the step it happens on.
      </p>

      <div className={`recs ${styles.recs}`}>
        {shown.map((recommendation) => (
          <Rec key={recommendation.id} recommendation={recommendation} run={run} />
        ))}
      </div>

      <p className="footnote">
        <Link to={paths.analysis(run.runId)}>Read the full analysis</Link> &mdash; the same claims,
        with every number and every citation behind them.
      </p>
    </div>
  );
}
