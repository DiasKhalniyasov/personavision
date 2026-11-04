import { Link, useParams } from 'react-router';
import type { Aggregate, Recommendations, Run, WriteUpClaim } from '@personavision/contract';
import { NothingRecorded } from '@/shell/NothingRecorded';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useAggregate, useExcluded, useRecommendations, useRun } from '@/shell/useRun';
import { Claim, publishable } from './Claim';
import { excludedFootnote, provenanceLine } from './provenance';
import styles from './analysis.module.css';

/**
 * `/runs/:runId/analysis` — *what does the model make of all of it.*
 *
 * `#screen-analysis` of `docs/design/prototype.html` and section 14.6 of `docs/FLOW.md`: the
 * whole write-up in prose, every claim carrying the evidence it came from, so that somebody
 * who doubts a sentence can check it in one click. #234 owns the breadcrumb, the title and
 * the lede; everything below them is here.
 *
 * **The write-up is rendered, not composed.** The claims are the ordered block
 * `recommendations.json` carries, generated from the recommendation objects by
 * `@personavision/scoring`'s `writeUp` — each claim's heading, its paragraph and its
 * citations are that generator's, in the rank the pipeline stored. This screen writes no
 * sentence, ranks nothing, and states no figure of its own.
 *
 * **It renders citations; it never parses a sentence to find one.** Every link on the screen
 * is built from a citation's structured fields through the builders in `shell/paths.ts`
 * (`CiteRow.tsx`), so a session id a paragraph happens to mention is prose and not a link,
 * and a renamed route is one edit in one file.
 *
 * **A claim a reader could not check is not published**, which this screen asserts rather
 * than assumes: a claim with nothing to cite, and a claim whose every cited person is one
 * our own automation broke (`docs/FLOW.md` sections 14 and 11), are both held back —
 * `Claim.tsx`'s `publishable`. The pipeline already refuses to write such a file; this is the
 * same rule over a file on disk, which is where a run written before a rule existed arrives.
 *
 * Its states, as the screen contract of #277 fixes them: a run with **no recommendations
 * file** keeps the stated card #234 put here rather than rendering an empty write-up; a run
 * whose file carries no publishable claim states that instead, with the way on to what it
 * does carry; while the three files are read the card **holds its height** so the column
 * does not jump; and a file that cannot be read falls to the existing run-not-found screen
 * rather than to a state of this screen's own.
 */
export function AnalysisPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);
  const written = useRecommendations(runId);
  // The figures the claims argue from: this screen states none of them, and reads the file
  // for the provenance line and the excluded count the closing footnote carries. Absent or
  // unreadable, those are the two things the screen goes without.
  const aggregate = useAggregate(runId);

  // A run that cannot be read is the shell's not-found state, not a state of this screen —
  // and a file that is there and will not parse is a broken run, which falls the same way.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }
  if (written.status === 'unreadable') {
    return <RunNotFound runId={written.runId} url={written.url} problem={written.problem} />;
  }
  // An `aggregate.json` that will not parse is **not** this screen's not-found state: the
  // write-up is the screen, and a claim is published or held back on its own citations. Such
  // a run loses the two clauses of the provenance line that come from the aggregate and the
  // excluded count the footnote states, and the prose a reader came for still renders. The
  // file is reported where it is the subject — the Summary, the Funnel and the Score
  // breakdown all read it — rather than twice.

  const reading =
    state.status === 'loading' || written.status === 'loading' || aggregate.status === 'loading';

  return (
    <div className="strip strip-sm" data-screen="analysis">
      <div className="wrap-narrow">
        <PageHead runId={runId} />
        {reading ? (
          <Reserve />
        ) : (
          <>
            {written.status === 'none' ? (
              <NoAnalysis />
            ) : written.recommendations.writeUp === undefined ? (
              // No write-up block at all: a test still running, whose write-up is generated
              // when it finishes. Said before the claims are checked, because there are none
              // to check and no reason to read the run's sessions to find that out.
              <NoWriteUp run={state.run} written={written.recommendations} />
            ) : (
              <WriteUp
                run={state.run}
                written={written.recommendations}
                claims={written.recommendations.writeUp}
                aggregate={aggregate.status === 'ready' ? aggregate.aggregate : null}
              />
            )}
            <SimulatedDisclaimer />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The card's height, held while a file is read: the provenance line, a claim and its chips.
 *
 * It animates nothing. A pulse on the one block this screen is made of would be the loudest
 * thing on a page of prose, and the column is still either way (section 10).
 */
function Reserve() {
  return (
    <div className={`card card-lg ${styles.card}`} data-analysis="loading" aria-busy="true">
      <div className={styles.reserve} />
    </div>
  );
}

/**
 * The write-up itself, over the file the run carries.
 *
 * Who the run excluded is read here rather than assumed, through the shell's one read of it
 * — the same `useExcluded` the Verdict screen's banner counts from, cached per run, so a
 * reader arriving from that screen has already paid for it. The claims wait for that read:
 * a claim shown and then taken away is worse than a claim that arrives a moment later, and
 * the card holds its height in the meantime.
 */
function WriteUp({
  run,
  written,
  claims: generated,
  aggregate,
}: {
  run: Run;
  written: Recommendations;
  /** The claims the file carries, which is why this component is rendered at all. */
  claims: readonly WriteUpClaim[];
  /** The aggregate, or `null` for a run that computed none: an absence, not a failure. */
  aggregate: Aggregate | null;
}) {
  const excluded = useExcluded(run);
  if (excluded.status === 'loading') return <Reserve />;

  /**
   * The sessions our own automation broke, by id.
   *
   * A run whose sessions cannot be read leaves this empty rather than holding the whole
   * write-up back: the pipeline held every claim in the file to the rule when it wrote it,
   * so an unreadable session file costs the second check and not the page. The missing file
   * is already reported where a reader meets it, on the People screen.
   */
  const ourBreakage = new Set(
    excluded.status === 'ready' ? excluded.people.map((person) => person.sessionId) : [],
  );
  const claims = generated.filter((claim) => publishable(claim, ourBreakage));

  if (claims.length === 0) return <NoWriteUp run={run} written={written} />;

  const footnote = excludedFootnote(aggregate);

  return (
    <>
      <div className={`card card-lg ${styles.card}`} data-section="write-up">
        <span className="microlabel" data-part="provenance">
          {provenanceLine({ sample: written.sample, aggregate })}
        </span>
        {/* A finished run that recommended nothing states the stored reason in place of the
            claims, beside the closing claim that is its whole write-up (the owner's
            decision 147). */}
        {written.recommendations.length === 0 && written.nothingToRecommend !== undefined ? (
          <p className={`lede ${styles.reason}`} data-part="nothing-to-recommend">
            {written.nothingToRecommend}
          </p>
        ) : null}
        {claims.map((claim, position) => (
          // Keyed by position: a heading is not an id, and the write-up is rendered in the
          // one order the generator stored it in.
          <Claim key={position} run={run} claim={claim} />
        ))}
      </div>
      {footnote === null ? null : (
        <p className="footnote" data-part="excluded-footnote">
          {footnote}
        </p>
      )}
    </>
  );
}

/**
 * The run recorded no analysis at all: the stated card of the owner's decision 110, which
 * #234 put here and this ticket keeps rather than rendering an empty write-up.
 */
function NoAnalysis() {
  return (
    <NothingRecorded heading="This test did not record an analysis." section="no-analysis">
      It ran before PersonaVision asked Muse Wonder to write one up, so there is no write-up and no
      recommendations for it &mdash; not an empty page, and no claim without the evidence behind it.
      Run the test again and it will be here.
    </NothingRecorded>
  );
}

/**
 * The run has a recommendations file and no claim this screen may publish: a test still
 * running, whose write-up is generated when it finishes, or one whose every claim was held
 * back. A different fact from the card above, and it reads as one.
 *
 * Where the file recommends nothing and stored why, that sentence is the card's: the
 * pipeline's own words, which the product states rather than inventing a reason of its own.
 */
function NoWriteUp({ run, written }: { run: Run; written: Recommendations }) {
  const reason = written.recommendations.length === 0 ? (written.nothingToRecommend ?? null) : null;

  return (
    <NothingRecorded heading="This test records no write-up." section="no-write-up">
      {reason ??
        'A write-up is generated when a test finishes, from the recommendations it cites and the evidence behind each claim — and a claim with nothing to cite is not published.'}{' '}
      What this test recommends is on <Link to={paths.run(run.runId)}>the summary</Link>, and every
      attempt is in <Link to={paths.sessions(run.runId)}>the recordings</Link>.
    </NothingRecorded>
  );
}

/** The breadcrumb, the title and the lede: the same three on every state of this screen. */
function PageHead({ runId }: { runId: string }) {
  return (
    <>
      <p className="breadcrumb">
        <Link to={paths.run(runId)}>Results</Link> / Analysis
      </p>
      <div className="pagehead">
        <h1>What Muse Wonder makes of it</h1>
      </div>
      <p className="lede">
        The whole write-up. Every claim in it carries the evidence it came from &mdash; the people,
        the second of their recording, the heatmap region and the funnel step. A claim with nothing
        to cite is not published.
      </p>
    </>
  );
}
