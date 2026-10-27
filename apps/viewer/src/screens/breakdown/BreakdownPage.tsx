import { Link, useParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useFindings, useRun } from '@/shell/useRun';
import { audienceSummary } from '@/screens/verdict/AudienceLine';
import { Finding } from '@/screens/verdict/Finding';
import { evidenceUrl } from '@/screens/verdict/evidenceLink';
import type { FindingItem } from '@/screens/verdict/evidenceLink';
import findingStyles from '@/screens/verdict/finding.module.css';
import { ScoreCards } from './ScoreCards';
import { SegmentsSection } from './SegmentsSection';
import { Verdict } from './Verdict';
import './BreakdownPage.css';

/**
 * `/runs/:runId/breakdown` — *how sure is this, and what drove it.*
 *
 * The screen the friction score moved to. The owner's direction took the 0–100 index, its
 * four weighted components, the spread band and the gap line off the lead screen because
 * they are noise for a business decision-maker — but they were not removed from the
 * product. They live here, one click away from the Verdict, for whoever wants to know how
 * sure the answer is and what drove it (`docs/FLOW.md` sections 3 and 5).
 *
 * This file owns the composition and the page's two rows of context — the lede that frames
 * the index honestly, and the metadata row that says who the test ran on, on what, and what
 * it cost. The score cards, the verdict line and the full findings list are its sections;
 * the *"Which part of your audience this came from"* section is **#17's** and mounts below
 * the findings.
 *
 * Nothing here is recalculated. The screen reads the run and the findings file through the
 * shell's single read of each and formats what it is given.
 */

export function BreakdownPage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  // A run that cannot be read is the shell's not-found state, not a state of this screen.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }
  if (state.status === 'loading') return <BreakdownLoading runId={runId} />;

  return <Breakdown run={state.run} />;
}

/** The breadcrumb, the title and the lede: the same three on every state of this screen. */
function PageHead({ runId }: { runId: string }) {
  return (
    <>
      <p className="breadcrumb">
        <Link to={paths.run(runId)}>Verdict</Link> / Score breakdown
      </p>
      <div className="pagehead">
        <h1>How sure is this, and what drove it</h1>
      </div>
      <p className="lede">
        The friction score ranks the two versions from 0 to 100, higher being worse. It is not the
        headline &mdash; your audience&rsquo;s completion rate is &mdash; but it is the number the
        result is ranked and regression-tested on.
      </p>
    </>
  );
}

/**
 * While the run is read.
 *
 * The cards reserve their height, so the verdict line underneath does not jump into place
 * once the run arrives and the reader does not lose their position on the page.
 */
function BreakdownLoading({ runId }: { runId: string }) {
  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <PageHead runId={runId} />
        <div
          aria-busy="true"
          aria-label="Reading this test"
          className="score-grid"
          role="status"
          data-section="score-cards-loading"
        >
          <Skeleton className="score-card-reserve" />
          <Skeleton className="score-card-reserve" />
        </div>
      </div>
    </div>
  );
}

/**
 * The screen itself, over a run that has been read. Exported so a test can render one
 * state of it — a contributor test, a run with no usage block — without serving a run
 * directory shaped like that one first.
 */
export function Breakdown({ run }: { run: Run }) {
  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <PageHead runId={run.runId} />
        <RunMeta run={run} />
        <TrainingNotice engine={run.engine} />
        <ScoreCards run={run} />
        <Verdict run={run} />
        <AllFindings run={run} />
        <SegmentsSection run={run} />
        <SimulatedDisclaimer />
        <p className="footnote">
          People whose session ended because our own automation broke are excluded from every figure
          on this screen &mdash; that is our weakness, never evidence against your checkout.
        </p>
      </div>
    </div>
  );
}

/** The product's one model family. #18's engine line names it the same way. */
const MODEL_NAME = 'Muse Spark 1.3';

/**
 * The engine, as the artifact recorded it: `Muse Spark 1.3 · contributor mode`,
 * `· standard mode`, or `offline deterministic`.
 *
 * It reads `engine.mode` and `engine.modelMode` and **parses no model id** to get there, so
 * a new model id cannot quietly change what this line says (owner decision 2026-10-27,
 * recorded decision 11). A run on a model that recorded no mode says so rather than being
 * guessed at.
 */
const engineLine = (engine: Run['engine']): string => {
  if (engine.mode === 'offline') return 'offline deterministic';
  if (engine.modelMode === undefined) return `${MODEL_NAME} · mode not recorded`;
  return `${MODEL_NAME} · ${engine.modelMode} mode`;
};

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/**
 * What the test cost: the calls and the estimated cost from the run's **usage block**, read
 * and never recomputed. A run that records no usage says so — a zero there would claim a
 * figure nobody measured.
 */
const costLine = (usage: Run['usage']): string => {
  if (usage === undefined) return 'not recorded';
  const calls = usage.calls === 1 ? '1 model call' : `${usage.calls} model calls`;
  return `${calls} · ${money.format(usage.estimatedCostUsd)} estimated`;
};

/** `4 generated personas × 3 seeds = 12 per version`, from the run's own two lists. */
const peopleLine = (run: Run): string => {
  const personas = run.personas.length;
  const seeds = run.seedGroups.length;
  const generated = personas === 1 ? '1 generated persona' : `${personas} generated personas`;
  if (seeds === 0) return `${generated} · this test records no seed groups`;
  return `${generated} × ${seeds} seed${seeds === 1 ? '' : 's'} = ${personas * seeds} per version`;
};

/**
 * The devices the people were simulated on, counted by the device each generated person
 * carries. The audience's own lean (`mostly mobile`) is already in the audience cell; this
 * is what actually ran.
 */
const deviceLine = (personas: Run['personas']): string => {
  const counted = new Map<string, number>();
  for (const persona of personas) {
    counted.set(persona.device.name, (counted.get(persona.device.name) ?? 0) + 1);
  }
  if (counted.size === 0) return 'none — this test simulated nobody';
  return [...counted].map(([device, count]) => `${count} ${device}`).join(' · ');
};

/**
 * The test metadata row — the `.runmeta` of `#screen-breakdown`: who it ran on, how many
 * people and seeds, the device mix, the engine, what it cost, and the run directory.
 *
 * It is on this screen and not on the Verdict because it is the provenance of the figures
 * above, and this is the screen for a reader asking how sure the answer is.
 */
function RunMeta({ run }: { run: Run }) {
  return (
    <div className="runmeta" data-section="run-meta">
      <span>
        <b>Audience</b> {run.audience.name} · {audienceSummary(run.audience)}
      </span>
      <span>
        <b>People</b> {peopleLine(run)}
      </span>
      <span>
        <b>Devices</b> {deviceLine(run.personas)}
      </span>
      <span>
        <b>Engine</b> {engineLine(run.engine)}
      </span>
      <span>
        <b>Cost</b> {costLine(run.usage)}
      </span>
      <span>
        <b>Test</b> <code>runs/{run.runId}</code>
      </span>
    </div>
  );
}

/**
 * The one sentence a **contributor** test carries, in the product's own words: the cheaper
 * model, what Meta may do with the content, and that a paying workspace's test always runs
 * on the standard model (owner decision 2026-10-27, recorded decision 11).
 *
 * A standard test and an offline test carry none: they simply name their mode in the row
 * above, so a customer can see which model ran their test.
 */
function TrainingNotice({ engine }: { engine: Run['engine'] }) {
  if (engine.mode === 'offline' || engine.modelMode !== 'contributor') return null;

  return (
    <p className="notice info" data-section="training-notice">
      This test ran on the cheaper contributor model. Meta may use its content to train its models.
      A paying workspace&rsquo;s test always runs on the standard model.
    </p>
  );
}

/**
 * **Every** finding, in the pipeline's rank order: this screen is where the cap of three
 * does not apply.
 *
 * The order is the findings file's own. Nothing here sorts, re-ranks or filters — the
 * pipeline ranked once, by severity and then by how many people are behind each finding
 * (`docs/FLOW.md` section 6), and a second opinion in the viewer would put a different list
 * on this screen than the one the Verdict screen's three were taken from.
 */
function AllFindings({ run }: { run: Run }) {
  const state = useFindings(run.runId);

  return (
    <div className="section" data-section="all-findings">
      <h2>All findings</h2>
      <p className="lede">
        Ranked by severity, then by how many people are behind each. The top three are the ones on
        the Verdict screen.
      </p>
      {state.status === 'loading' && (
        <div
          aria-busy="true"
          aria-label="Loading the findings"
          className={findingStyles.findings}
          role="status"
        >
          {[0, 1, 2].map((slot) => (
            <Skeleton className={findingStyles.loading} key={slot} />
          ))}
        </div>
      )}
      {state.status === 'unreadable' && (
        <p className="lede">The findings for this test could not be read: {state.problem}.</p>
      )}
      {state.status === 'ready' && <FindingsList findings={state.findings.findings} run={run} />}
    </div>
  );
}

function FindingsList({ findings, run }: { findings: readonly FindingItem[]; run: Run }) {
  if (findings.length === 0) {
    return (
      <p className="lede">This test turned up nothing to fix on either version of your checkout.</p>
    );
  }

  const variantNames = new Map(run.variants.map((variant) => [variant.id, variant.name]));

  return (
    <div className={findingStyles.findings}>
      {findings.map((finding, position) => (
        <Finding
          finding={finding}
          href={evidenceUrl(run.runId, finding.evidence_link)}
          key={finding.id}
          rank={position + 1}
          variantName={finding.variant === null ? null : variantNames.get(finding.variant)}
        />
      ))}
    </div>
  );
}
