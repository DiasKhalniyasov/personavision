import { Link, useParams, useSearchParams } from 'react-router';
import type { Aggregate, FunnelSlice, Run } from '@personavision/contract';
import { NothingRecorded } from '@/shell/NothingRecorded';
import { RESULT_LINK_PARAMS, paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useAggregate, useRun } from '@/shell/useRun';
import { FunnelChart } from './FunnelChart';
import { SegmentFilter } from './SegmentFilter';
import { SlowestSessions } from './SlowestSessions';
import { TimingTable } from './TimingTable';
import { noSuchSegment, showingLine } from './funnelWords';
import styles from './funnel.module.css';

/**
 * `/runs/:runId/funnel` — *where did they drop out, and what took them so long.*
 *
 * `#screen-funnel` of `docs/design/prototype.html` and section 14.5 of `docs/FLOW.md`: the
 * funnel by screen and step, the time-per-step distribution, and the slowest sessions by
 * name. #234 owns the breadcrumb, the title and the lede; everything below them is here.
 *
 * **Nothing on this screen is computed.** Every count, share, percentile and bin is a field
 * of `aggregate.json`, which the pipeline pre-sliced per segment (`docs/adr/0001`), and the
 * only thing this screen decides is *which slice* — the one the URL's `?segment=` names.
 * The browser does not aggregate, does not divide and works out no percentile, so a figure
 * here can never disagree with the same figure on the Summary.
 *
 * Its two filters are both URL state, read here and written by `shell/paths.ts`:
 *
 * - `?segment=` narrows every figure on the screen to that segment's stored slice. Opening
 *   such a URL directly renders the narrowed screen and says which segment it is showing; a
 *   segment no session is in has no stored slice, and the screen states that rather than
 *   drawing a funnel of zeroes.
 * - `?step=` opens with one step marked, so a recommendation citing a funnel step lands on
 *   it. With none named, the marked step is the stored biggest drop, which is the step the
 *   prototype draws this screen about.
 *
 * Its states: a run with no aggregate, or one that scored nobody, keeps the stated card
 * #234 put here rather than showing a zeroed funnel; an aggregate that cannot be read falls
 * to the existing run-not-found screen; and while either file is being read the card holds
 * the funnel's height so the page does not jump.
 */

/**
 * The two parameters this screen honours, taken from the builder that writes them, so the
 * screen reads exactly what a link can carry and neither side restates a string.
 */
const [SEGMENT_PARAM, STEP_PARAM] = RESULT_LINK_PARAMS.funnel;

/** A parameter nobody asked for: absent, or the empty string a cleared filter leaves. */
const asked = (value: string | null): string | null =>
  value === null || value === '' ? null : value;

export function FunnelPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);
  const aggregate = useAggregate(runId);
  const [query] = useSearchParams();
  const segment = asked(query.get(SEGMENT_PARAM));
  const step = asked(query.get(STEP_PARAM));

  // A run that cannot be read is the shell's not-found state, not a state of this screen.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }
  // An aggregate that is there and will not parse is a broken run, and falls the same way.
  if (aggregate.status === 'unreadable') {
    return <RunNotFound runId={aggregate.runId} url={aggregate.url} problem={aggregate.problem} />;
  }

  const reading = state.status === 'loading' || aggregate.status === 'loading';

  return (
    <div className="strip strip-sm" data-screen="funnel">
      <div className="wrap">
        <PageHead runId={runId} />
        {/* The header holds its height while the run is read, as the chrome above it does,
            and the card below reserves the funnel's so the page does not jump when it
            arrives. */}
        {reading ? (
          <div className="card card-lg" data-funnel="loading" aria-busy="true">
            <div className={styles.reserve} />
          </div>
        ) : (
          <>
            <Body
              run={state.run}
              aggregate={aggregate.status === 'ready' ? aggregate.aggregate : null}
              segment={segment}
              step={step}
            />
            <SimulatedDisclaimer />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The screen under its header: the funnel of one slice, or the stated absence of one.
 *
 * Three absences, three different sentences, because they are three different facts: the run
 * computed no aggregate at all, it scored nobody, or it scored people and none of them are
 * in the segment the URL asks for.
 */
function Body({
  run,
  aggregate,
  segment,
  step,
}: {
  run: Run;
  /** `null` for a run that computed no aggregate: there is no file, which is an absence. */
  aggregate: Aggregate | null;
  segment: string | null;
  step: string | null;
}) {
  // This screen's own slices: every version together, by segment (the owner's decision 80).
  const slices: readonly FunnelSlice[] =
    aggregate === null ? [] : aggregate.funnelSlices.filter((slice) => slice.variant === null);

  if (aggregate === null || slices.length === 0) {
    return (
      <NothingRecorded heading="This test did not record a funnel." section="no-funnel">
        It ran before PersonaVision measured where people dropped out, so there is no funnel and no
        timing distribution for it &mdash; not a zero, and not an empty chart. Run the test again
        and both will be here.
      </NothingRecorded>
    );
  }

  const slice = slices.find((candidate) => candidate.segment === segment) ?? null;

  return (
    <>
      <SegmentFilter
        runId={run.runId}
        aggregate={aggregate}
        slices={slices}
        current={segment}
        step={step}
      />
      {slice === null ? (
        <div className="card card-lg">
          <p data-funnel="no-segment">{noSuchSegment(segment ?? '')}</p>
          <p className="footnote">
            <Link to={paths.funnel(run.runId)}>Show every segment</Link>
          </p>
        </div>
      ) : (
        <>
          <p className="microlabel" data-funnel="showing">
            {showingLine(slice, aggregate)}
          </p>
          <FunnelChart
            run={run}
            slice={slice}
            markedStep={step ?? slice.biggestDrop?.step ?? null}
          />
          <TimingTable
            run={run}
            slice={slice}
            markedStep={step ?? slice.biggestDrop?.step ?? null}
          />
          <SlowestSessions run={run} slice={slice} />
        </>
      )}
    </>
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
