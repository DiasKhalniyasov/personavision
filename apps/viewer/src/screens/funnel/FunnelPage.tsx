import { Link, useParams } from 'react-router';
import { NothingRecorded } from '@/shell/NothingRecorded';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';

/**
 * `/runs/:runId/funnel` — *where did they drop out, and what took them so long.*
 *
 * `#screen-funnel` of `docs/design/prototype.html` and section 14.5 of `docs/FLOW.md`: the
 * funnel by screen and step, and then the time-per-step distribution. **This ticket owns the
 * breadcrumb, the title and the lede.** The funnel itself, the distribution and the segment
 * filter are #274's, and mount under the header.
 *
 * Until then the screen reads the run and says that nothing was recorded for it. The lede is
 * the owner's wording for that state rather than the prototype's — the prototype's names a
 * number of scored sessions, and this screen has no figure to name.
 */

export function FunnelPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  // A run that cannot be read is the shell's not-found state, not a state of this screen.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }

  return (
    <div className="strip strip-sm" data-screen="funnel">
      <div className="wrap">
        <PageHead runId={runId} />
        {/* The header holds its height while the run is read, as the chrome above it does;
            there is no figure under it yet to reserve room for. */}
        {state.status === 'loading' ? null : (
          <>
            <NothingRecorded heading="This test did not record a funnel." section="no-funnel">
              It ran before PersonaVision measured where people dropped out, so there is no funnel
              and no timing distribution for it &mdash; not a zero, and not an empty chart. Run the
              test again and both will be here.
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
        <Link to={paths.run(runId)}>Results</Link> / Funnel and timing
      </p>
      <div className="pagehead">
        <h1>Where the hundred of them went</h1>
      </div>
      <p className="lede">Screen by screen, with the reason beside the biggest drop.</p>
    </>
  );
}
