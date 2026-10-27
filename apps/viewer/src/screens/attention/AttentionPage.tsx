import { Link, useParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { Toggle } from '@/components/ui/toggle';
import { paths, sessionsWithVariant } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import { SideColumn, SidePanel } from './SidePanel';
import { ThisStepPanel } from './ThisStepPanel';
import { useAttentionAreas } from './useAttentionAreas';
import { useAttentionSelection } from './useAttentionSelection';
import type { AttentionSelection } from './useAttentionSelection';
import { useAttentionStepSessions } from './useAttentionStepSessions';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import styles from './attentionPage.module.css';

/**
 * `/runs/:runId/attention/:variant/:step?aoi=` — where the audience looked on this version
 * of this step. `#screen-attention` of `docs/design/prototype.html`.
 *
 * The reader arrives here having already been given the answer: from a finding, or from the
 * caption under the Verdict screen's one heatmap. So this screen's job is **proof**, not
 * discovery — it shows all of the evidence the verdict showed one frame of, for the exact
 * version, step and area that was named (`docs/FLOW.md` section 3).
 *
 * The whole selection is the URL (`useAttentionSelection`): the screen keeps nothing a
 * reload would lose, every view is a link, and switching version keeps the step and the
 * isolated area so that the same moment can be read on A and on B.
 *
 * What is on this file is the screen's own frame — the heading and lede, the version
 * switch, the line stating what the aggregate covers, the side column, the "This step"
 * readings and the footnotes. The filmstrip (#60), the stage and its overlays (#58), the
 * areas table (#59) and the isolate caption (#73) mount into it, each from its own file,
 * and read this screen's selection and its two data hooks rather than publishing their own.
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
  const { areas } = useAttentionAreas(selection.variant, selection.step);

  const step = run.steps.find((candidate) => candidate.id === selection.step);
  const isolated = areas.find((area) => area.aoi.id === selection.aoi) ?? null;

  return (
    <div className="strip" data-section="attention">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.run(run.runId)}>Verdict</Link> / Attention
        </p>
        <div className="pagehead">
          <h1>Where your audience looked</h1>
        </div>
        <p className="lede">
          Every look your audience took on this version, over the page as they saw it. Fixation,
          dwell and scanpath are the technical words for it; the table under the page is the same
          thing in numbers.
        </p>

        {selection.fallback === null ? null : (
          <p className="notice info" role="status" data-section="attention-fallback">
            {selection.fallback.sentence}
          </p>
        )}

        <div className={styles.controls}>
          <VariantSwitch run={run} selection={selection} />
          <span className="grow" />
          <AggregateLine run={run} variant={selection.variant} />
        </div>

        {/* #60 mounts the step filmstrip here. */}

        <div className={styles.stage}>
          <div>
            <StagePlace run={run} selection={selection} sessions={sessions} />
            {/* #73 mounts the isolated-area caption here. */}
          </div>
          <SideColumn>
            {/* #58 mounts the Overlays panel here. */}
            {step === undefined ? null : (
              <SidePanel title="This step">
                <ThisStepPanel step={step} sessions={sessions} areas={areas} isolated={isolated} />
              </SidePanel>
            )}
            <SidePanel title="Reading this">
              <p className="lede">
                Numbers are fixation order, median across sessions. Fixation size is dwell time.
                Click a row in the table to isolate one area of interest.
              </p>
            </SidePanel>
          </SideColumn>
        </div>

        {/* #59 mounts the areas-of-interest table here. */}

        <p className="footnote">
          Medians across the people whose session was scored, never one person&rsquo;s own numbers.
          &ldquo;Looked at it&rdquo; is the share of those people who looked inside the area at
          least once.
        </p>
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
 */
function VariantSwitch({ run, selection }: { run: Run; selection: AttentionSelection }) {
  return (
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
  );
}

/**
 * What the aggregate covers, and what it leaves out.
 *
 * Both figures are the run's own, from this version's score: how many people were scored,
 * and how many our own automation broke. Neither is counted here from the sessions — the
 * pipeline decided who was excluded and stored it, and a heatmap that silently averaged a
 * different population from the one named would be the one dishonest thing this screen
 * could do.
 */
function AggregateLine({ run, variant }: { run: Run; variant: string }) {
  const score = run.scores.find(
    (candidate) => candidate.variant === variant && candidate.taskId === run.task.id,
  );
  if (score === undefined) {
    return (
      <span className="microlabel">
        This test scored nobody on this version &middot; there is no aggregate to show
      </span>
    );
  }

  const broken = score.outcomeCounts.automationFailure;
  return (
    <span className="microlabel">
      Aggregate of {score.scoredSessionCount} people &middot;{' '}
      {broken === 0
        ? 'our automation broke on nobody'
        : `the ${broken} our automation broke ${broken === 1 ? 'is' : 'are'} excluded`}
    </span>
  );
}

/**
 * Where the page and its overlays go (#58).
 *
 * Until that ticket lands the slot is empty, and it is empty on purpose: this screen states
 * the three things that are true *instead of* a page — a session file that could not be
 * read, and a step nobody in the audience ever reached — because both are answers, and a
 * ticket that had not been built yet is not.
 */
function StagePlace({
  run,
  selection,
  sessions,
}: {
  run: Run;
  selection: AttentionSelection;
  sessions: AttentionStepSessions;
}) {
  if (sessions.status === 'error') {
    return (
      <p className="notice" role="status" data-section="attention-unreadable">
        This step&rsquo;s people could not be read: {sessions.error}
      </p>
    );
  }
  if (sessions.status === 'loading' || sessions.reachedCount > 0) return null;

  return <NobodyReached runId={run.runId} variant={selection.variant} />;
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
