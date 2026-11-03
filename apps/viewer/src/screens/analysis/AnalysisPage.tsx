import { Link, useParams } from 'react-router';
import { NothingRecorded } from '@/shell/NothingRecorded';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';

/**
 * `/runs/:runId/analysis` — *what does the model make of all of it.*
 *
 * `#screen-analysis` of `docs/design/prototype.html` and section 14.6 of `docs/FLOW.md`: the
 * full write-up, every claim carrying the evidence it came from. **This ticket owns the
 * breadcrumb, the title and the lede.** The write-up, its provenance line and its citations
 * are #277's, and mount under the header.
 *
 * Until then the screen reads the run and says that nothing was recorded for it: a run with
 * no `recommendations.json` produced no write-up, which is not an empty page somebody wrote.
 */

export function AnalysisPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  // A run that cannot be read is the shell's not-found state, not a state of this screen.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }

  return (
    <div className="strip strip-sm" data-screen="analysis">
      <div className="wrap-narrow">
        <PageHead runId={runId} />
        {state.status === 'loading' ? null : (
          <>
            <NothingRecorded heading="This test did not record an analysis." section="no-analysis">
              It ran before PersonaVision asked Muse Wonder to write one up, so there is no write-up
              and no recommendations for it &mdash; not an empty page, and no claim without the
              evidence behind it. Run the test again and it will be here.
            </NothingRecorded>
            <SimulatedDisclaimer />
          </>
        )}
      </div>
    </div>
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
