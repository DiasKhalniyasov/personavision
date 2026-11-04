import { Link, useParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { Toggle } from '@/components/ui/toggle';
import { paths, sessionsWithVariant } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { SideColumn, SidePanel } from './SidePanel';
import { StepFilmstrip } from './StepFilmstrip';
import { ThisStepPanel } from './ThisStepPanel';
import { AttentionStage, stageIsShown, useAttentionStage } from './stage/AttentionStage';
import type { AttentionStageView } from './stage/AttentionStage';
import { OverlayTogglesPanel } from './stage/OverlayTogglesPanel';
import { AoiMetricsTable } from './AoiMetricsTable';
import { HeatmapFilters } from './HeatmapFilters';
import { IsolatedAreaCaption } from './IsolatedAreaCaption';
import {
  clicksFootnote,
  noAggregate,
  noPeopleMatch,
  noneOfThemReached,
  unreadableAggregate,
} from './attentionWording';
import { clicksNowhere, clicksOnArea, totalClicks } from './screenSlices';
import { useAttentionAreas } from './useAttentionAreas';
import { useAttentionSelection } from './useAttentionSelection';
import type { AttentionSelection } from './useAttentionSelection';
import { useAttentionStepSessions } from './useAttentionStepSessions';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import { useScreenFigures } from './useScreenFigures';
import type { ScreenFiguresView } from './useScreenFigures';
import styles from './attentionPage.module.css';

/**
 * `/runs/:runId/attention/:variant/:step?aoi=&overlay=&segment=&outcome=` — the **Heatmaps**
 * section of the results page: where the audience looked, clicked and stopped scrolling on
 * one screen. `#screen-heatmaps` of `docs/design/prototype.html`, `docs/FLOW.md` section
 * 14.4.
 *
 * It is the Attention screen **extended, not replaced**. The stage, the filmstrip, the side
 * column and the areas table are the same components over the same route; what is new is
 * that an attention overlay cannot show clicks, so clicks and scroll depth are drawn beside
 * it, and that the question worth asking — *where did the people who failed click?* — is two
 * filters on this screen rather than a screen of its own.
 *
 * **Every figure on it is the aggregate's own slice for the composition chosen.** The
 * browser does not re-aggregate a hundred sessions (`docs/adr/0001`): `aggregate.json` is
 * stored pre-sliced, so composing an outcome and a segment is picking a row out of it, and
 * `useScreenFigures` is the one place this screen does that. The attention overlay is the
 * exception and stays what it was — dwell drawn from the sessions' own fixations, because
 * there are no per-pixel attention bins to slice — and it is mounted, not reimplemented.
 *
 * The whole selection is the URL: version, step, isolated area, **which overlays are drawn**
 * (decision 134) and the two filters. So the screen keeps nothing a reload would lose, every
 * view is a link, and a recommendation can cite *"heatmap · waiting · progress area"* and
 * land on exactly that overlay, step, area and filter.
 *
 * What is on this file is the screen's own frame — the heading and lede, the control row,
 * the side column, the footnote under the stage and the disclaimer. The filmstrip, the stage
 * and its overlays, the areas table and the isolate caption mount into it, each from its own
 * file, and read this screen's selection and its data hooks rather than publishing their own.
 */
export function AttentionPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  switch (state.status) {
    case 'loading':
      // The shell's convention: the chrome above is already in its loading state, and the
      // body stays empty rather than flashing a spinner the reader cannot act on.
      return null;
    case 'not-found':
      return <RunNotFound runId={state.runId} url={state.url} />;
    case 'unreadable':
      return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
    case 'ready':
      return <AttentionScreen run={state.run} />;
  }
}

/** The screen itself, over a run that has been read. Exported so a test can mount it alone. */
export function AttentionScreen({ run }: { run: Run }) {
  const selection = useAttentionSelection();
  const sessions = useAttentionStepSessions(selection.variant, selection.step);
  const areaRows = useAttentionAreas(selection.variant, selection.step);
  const { areas } = areaRows;
  const screen = useScreenFigures(
    selection.variant,
    selection.step,
    selection.segment,
    selection.outcome,
  );

  const step = run.steps.find((candidate) => candidate.id === selection.step);
  const isolated = areas.find((area) => area.aoi.id === selection.aoi) ?? null;
  const stage = useAttentionStage({
    run,
    variant: selection.variant,
    step: selection.step,
    aoi: selection.aoi,
    sessions,
    areas,
    screen,
    overlays: selection,
  });

  return (
    <div className="strip" data-section="heatmaps">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.run(run.runId)}>Results</Link> / Heatmaps
        </p>
        <div className="pagehead">
          <h1>Where they looked, clicked and stopped scrolling</h1>
        </div>
        <p className="lede">
          One screen at a time, three overlays, and the filter that answers the question worth
          asking: <b>where did the people who failed click?</b>
        </p>

        {selection.fallback === null ? null : (
          <p className="notice info" role="status" data-section="attention-fallback">
            {selection.fallback.sentence}
          </p>
        )}

        <AggregateNotice screen={screen} />

        <VariantSwitch run={run} selection={selection} />
        <HeatmapFilters selection={selection} screen={screen} />

        <StepFilmstrip run={run} selection={selection} sessions={sessions} screen={screen} />

        <div className={styles.stage}>
          <div>
            <StagePlace
              run={run}
              selection={selection}
              sessions={sessions}
              stage={stage}
              screen={screen}
            />
            <ClicksCaption areas={areas} screen={screen} />
            <IsolatedAreaCaption
              runId={run.runId}
              variant={selection.variant}
              isolated={isolated}
              sessions={sessions}
            />
          </div>
          <SideColumn>
            {/* Beside the stage, and only beside the stage: when the screen is showing a
                step nobody reached, or a session file it could not read, there is nothing
                for a layer to be drawn over and so nothing for a switch to do. */}
            {stageIsShown(sessions) ? (
              <SidePanel title="Overlays">
                <OverlayTogglesPanel layers={stage.layers} setShown={stage.setShown} />
              </SidePanel>
            ) : null}
            {step === undefined ? null : (
              <SidePanel title="This screen">
                <ThisStepPanel step={step} screen={screen} areas={areas} />
              </SidePanel>
            )}
            <SidePanel title="Reading this">
              <p className="lede">
                Filters compose: an overlay, an outcome and a segment. Every count is the
                people left after the filters, and automation failures are never among them.
              </p>
            </SidePanel>
          </SideColumn>
        </div>

        <AoiMetricsTable
          runId={run.runId}
          variant={selection.variant}
          areas={areaRows}
          screen={screen}
        />

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * The version switch — the prototype's `#variant-seg`.
 *
 * Each version is the shadcn `toggle` primitive, which is a button carrying `aria-pressed`:
 * the two versions are two states of one view rather than two places, so pressed is what
 * the control is saying. Pressing the version already shown changes nothing, and in
 * particular does not push a second entry a reader would have to go back through.
 *
 * It is above the three filter strips rather than among them, because it chooses **which
 * page** is on the stage while they choose **whose figures** are drawn over it. A run with
 * one version has nothing to switch and shows no strip: `#screen-heatmaps` draws none, and
 * the hundred-agent test section 14 is about runs one version at a time.
 */
function VariantSwitch({ run, selection }: { run: Run; selection: AttentionSelection }) {
  if (run.variants.length <= 1) return null;

  return (
    <div className={styles.controls}>
      <div className={styles.seg} role="group" aria-label="Version">
        {run.variants.map((variant) => (
          <Toggle
            key={variant.id}
            pressed={variant.id === selection.variant}
            onPressedChange={() => {
              selection.setVariant(variant.id);
            }}
          >
            {variant.id} &middot; {variant.name}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

/**
 * What is wrong with this run's figures, where there is something wrong with the file
 * itself rather than with what a reader asked of it.
 *
 * A run that computed no aggregate and a file that will not parse are both stated once, at
 * the top, because they are about the whole screen: the two bin overlays, the filters, the
 * *This screen* panel and the clicks column are all reading the same absent file, and five
 * places each saying so is five chances to say it differently. A composition nobody
 * satisfies is **not** here — that is a reading about the audience, and it belongs where the
 * figures would have been.
 */
function AggregateNotice({ screen }: { screen: ScreenFiguresView }) {
  if (screen.status === 'none') {
    return (
      <p className="notice info" role="status" data-section="no-aggregate">
        {noAggregate()}
      </p>
    );
  }
  if (screen.status === 'unreadable') {
    return (
      <p className="notice" role="status" data-section="unreadable-aggregate">
        {unreadableAggregate(screen.problem ?? 'the aggregate could not be read')}
      </p>
    );
  }
  return null;
}

/**
 * The footnote under the stage: what the clicks on this screen amount to, in words.
 *
 * `#screen-heatmaps` writes it as *"26 of the 41 clicks on this screen landed on Generate a
 * second time, and 9 landed on empty space where a progress indicator would be"*. It is read
 * from the slice's own `clicksByAoi` — the busiest area and the clicks that landed on
 * nothing — and it is the clicks overlay's text alternative as much as the key beside it is:
 * a filled rectangle says nothing to a reader who cannot see it.
 */
function ClicksCaption({
  areas,
  screen,
}: {
  areas: readonly { readonly aoi: { readonly id: string; readonly label: string } }[];
  screen: ScreenFiguresView;
}) {
  if (screen.status !== 'ready') return null;

  const counted = areas.flatMap(({ aoi }) => {
    const clicks = clicksOnArea(screen.figures, aoi.id);
    return clicks === null || clicks === 0 ? [] : [{ label: aoi.label, clicks }];
  });
  const busiest = counted.reduce<{ label: string; clicks: number } | null>(
    (most, one) => (most === null || one.clicks > most.clicks ? one : most),
    null,
  );
  const sentence = clicksFootnote({
    busiest,
    nowhere: clicksNowhere(screen.figures),
    total: totalClicks(screen.figures),
  });
  if (sentence === null) return null;

  return (
    <p className="footnote" data-section="clicks-footnote">
      {sentence}
    </p>
  );
}

/**
 * The page and its overlays — unless something truer than a page is the answer.
 *
 * Four things are stated *instead of* the stage, because all four are results rather than
 * gaps: a session file that could not be read, a step nobody in the audience ever reached, a
 * composition of filters no session satisfies, and a screen none of the *filtered* people
 * stood on. The last two are the ones this screen adds, and they are the reason a filter
 * strip never renders an empty frame: *nobody in mobile · price-sensitive failed* is a
 * reading about the audience and the screen says it.
 *
 * The order matters once. A step **nobody** reached is stated before a screen none of the
 * filtered people reached, because the first is true whatever the filters are and has the
 * plainer words for it; the second is only reached when somebody did get there and these
 * particular people did not, which is what makes widening the filters the way on.
 *
 * While the people are still being read the stage is shown anyway: the screenshot, the fold
 * and the area outlines all come from the run, which has already arrived, so there is
 * nothing to wait for and no reason to make the reader wait for it.
 */
function StagePlace({
  run,
  selection,
  sessions,
  stage,
  screen,
}: {
  run: Run;
  selection: AttentionSelection;
  sessions: AttentionStepSessions;
  stage: AttentionStageView;
  screen: ScreenFiguresView;
}) {
  if (sessions.status === 'error') {
    return (
      <p className="notice" role="status" data-section="attention-unreadable">
        This step&rsquo;s people could not be read: {sessions.error}
      </p>
    );
  }
  if (screen.status === 'no-people') {
    return (
      <div className="empty" data-section="no-people-match">
        <h2>No session matches both filters</h2>
        <p>{noPeopleMatch(selection.outcome, selection.segment)}</p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              selection.setOutcome(null);
              selection.setSegment(null);
            }}
          >
            Show every outcome and segment
          </button>
        </div>
      </div>
    );
  }
  // Before the filtered reading: a step **nobody** reached, filters or no filters, is the
  // finding this screen has always had words for, and they are the better words for it.
  if (!stageIsShown(sessions)) {
    return <NobodyReached runId={run.runId} variant={selection.variant} />;
  }
  if (screen.status === 'no-screen') {
    return (
      <div className="empty" data-section="none-of-them-reached">
        <h2>None of these people reached this screen</h2>
        <p>{noneOfThemReached(stage.stepLabel)}</p>
        <div className="actions">
          <Link to={sessionsWithVariant(run.runId, selection.variant)}>
            See where they ended
          </Link>
        </div>
      </div>
    );
  }
  return <AttentionStage stage={stage} />;
}

/**
 * A step no scored session ever stood on.
 *
 * The empty frame is the wrong answer here and the words are the right one: nobody got this
 * far, which is itself the finding, and the way on is the list of where they ended instead.
 */
function NobodyReached({ runId, variant }: { runId: string; variant: string }) {
  return (
    <div className="empty" data-section="nobody-reached">
      <h2>Nobody in your audience reached this step on variant {variant}</h2>
      <p>There is no attention to show here, and that is the result: everyone ended earlier.</p>
      <div className="actions">
        <Link to={sessionsWithVariant(runId, variant)}>See where they ended</Link>
      </div>
    </div>
  );
}
