import { Link } from 'react-router';
import { automationFailureNoticeIsDue } from '@personavision/contract';
import type { Aggregate, Run } from '@personavision/contract';
import { AudienceLine } from '@/screens/verdict/AudienceLine';
import doorStyles from '@/screens/verdict/doors.module.css';
import { VerdictPage } from '@/screens/verdict/VerdictPage';
import '@/screens/verdict/verdict.css';
import type { OutcomeStatus } from '@/session';
import { paths, sessionsWithOutcome } from '@/shell/paths';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useAggregate } from '@/shell/useRun';
import { HeadlineFigures, HeadlineFiguresLoading, wholeRun } from './HeadlineFigures';
import { Recommendations } from './Recommendations';

/**
 * `/runs/:runId` — *what should I change, and how did my audience do?*
 *
 * The lead of the results page, and the whole answer: somebody who reads only this screen
 * has it (`docs/FLOW.md` section 14.1, `#screen-results` of `docs/design/prototype.html`).
 *
 * **It branches on the run, not on a "path".** A run with **one** version is a path-1 test
 * and leads with Muse Wonder's top recommendations and the three headline figures. A run
 * with **two** is a path-2 test and leads with the before/after Verdict of sections 2 to 5,
 * unchanged — the sentence, the two completion figures, the reasons, the one heatmap — with
 * the recommendations under it. **One screen, one route, no path flag in the URL**, and the
 * Verdict's own components are *mounted* rather than rewritten: the two-variant lead is
 * `VerdictPage` itself, handed the recommendations to render under its findings.
 *
 * **Nothing else is on it.** The quietness rule of `docs/FLOW.md` section 8 holds: no
 * area-of-interest table, no scanpath, no component bars, no session list, no friction
 * score. The one-heatmap rule binds the lead too, and the one-variant shape embeds **no**
 * heatmap, as `#screen-results` draws it — the Heatmaps tab is where heatmaps belong.
 *
 * **No figure is computed here**, on either shape. The three headline figures are fields of
 * `aggregate.json` (`HeadlineFigures`), the two completion figures are `scores[]` as the
 * scoring step wrote them, and the recommendations are `recommendations.json`. A browser
 * does not re-aggregate a hundred sessions, which
 * `docs/adr/0001-run-data-over-http-as-static-files.md` forbids.
 */

/** The outcome that lists the excluded people on the Sessions screen. */
const AUTOMATION_FAILURE: OutcomeStatus = 'automation_failure';

/**
 * The line a run says above its own summary when **more than a fifth** of its sessions were
 * our own automation failing: at that point the aggregate is about our harness and not about
 * the site (`docs/FLOW.md` section 11).
 *
 * Whether it is due is `@personavision/contract`'s question, answered off the progress
 * counters the artifact already carries — the fraction is declared there once and is written
 * nowhere else in the product, and there is no stored boolean to disagree with the counts
 * printed beside it.
 */
function HarnessNotice({ run }: { run: Run }) {
  if (!automationFailureNoticeIsDue(run.progress)) return null;

  return (
    <div className="notice" data-section="harness-notice">
      <span>
        More than a fifth of this test&rsquo;s sessions were <b>our own automation failing</b>, so
        what is below is about our harness as much as about your site. Run the test again before
        acting on it.{' '}
        <Link to={sessionsWithOutcome(run.runId, AUTOMATION_FAILURE)}>See those sessions</Link>.
      </span>
    </div>
  );
}

/**
 * The people our own automation lost, named above the reader's own figures rather than in a
 * footnote: the `.notice` of `#screen-results`.
 *
 * The count is **read**, from the aggregate's `excludedAutomationFailures` beside the
 * `scoredSessionCount` every figure above is of — so the two numbers in the sentence are the
 * two the figures were computed from, and they add up to the run's own sessions. Nothing is
 * counted from the session files here: who was excluded was decided once, by the pipeline,
 * and re-deciding it in a browser is the aggregation `docs/adr/0001` keeps off a screen.
 *
 * A run that excluded nobody renders no banner at all, rather than an empty one.
 */
function ExcludedNotice({ aggregate, run }: { aggregate: Aggregate; run: Run }) {
  const excluded = aggregate.excludedAutomationFailures;
  if (excluded === 0) return null;

  const of = excluded + aggregate.scoredSessionCount;

  return (
    <div className="notice" data-section="excluded-banner">
      <span>
        <b>
          {excluded} of {of} sessions {excluded === 1 ? 'was' : 'were'} our own automation failing
        </b>
        , not your site. {excluded === 1 ? 'It is' : 'They are'} excluded from every figure on this
        page and from every recommendation.{' '}
        <Link to={sessionsWithOutcome(run.runId, AUTOMATION_FAILURE)}>
          {excluded === 1 ? 'See it' : 'See them'}
        </Link>
        .
      </span>
    </div>
  );
}

/**
 * The answer in one sentence, and what was tested under it: the `.hero` of `#screen-results`.
 *
 * The sentence is `verdict.audienceSentence` — the pipeline's, rendered verbatim, as the
 * Verdict renders it — so the words a reader meets here are the same words the product uses
 * everywhere else about this run. Under it the feature the test was about, in the user's own
 * words, and what counted as success: the two the reader asked for, so the figures below
 * have a verb attached.
 */
function Hero({ run }: { run: Run }) {
  const sentence = run.verdict.audienceSentence.trim();
  // A run started before the New test screen recorded a feature sentence carries none; the
  // task it ran is then the run's own words for what was attempted, and it is named as that
  // rather than left blank.
  const feature = run.feature ?? run.task.prompt;
  const success = run.goal?.successCriterion ?? null;

  return (
    <div className="hero" data-section="headline">
      <h1 className={sentence === '' ? 'hero-missing' : undefined}>
        {sentence === '' ? 'This test is missing its summary sentence.' : sentence}
      </h1>
      {sentence === '' ? (
        <p className="sub">
          The sentence is the pipeline&rsquo;s to write and this run carries none, so nothing has
          been written in its place. The figures below are still the run&rsquo;s own.
        </p>
      ) : null}
      <p className="sub">
        Feature tested: &ldquo;{feature}&rdquo;
        {success === null ? '' : ` Success: ${success}`}
      </p>
    </div>
  );
}

/** One door: what is behind it, in a sentence a non-technical reader understands. */
function Door({ name, blurb, to }: { name: string; blurb: string; to: string }) {
  return (
    <Link className={`door ${doorStyles.door}`} to={to}>
      <h3>{name}</h3>
      <p>{blurb}</p>
      <span className={doorStyles.more}>Open →</span>
    </Link>
  );
}

/**
 * The four doors to the evidence: the `.door` blocks of `#screen-results`.
 *
 * Everything taken off this screen is one click away, and each door says in a sentence what
 * is behind it. Every destination comes from `shell/paths`, and the Heatmaps door takes the
 * version and the step from `verdict.heroEvidence` — the moment the run's verdict turns on —
 * rather than from a choice made here, as the tab bar does.
 */
function SummaryDoors({ run }: { run: Run }) {
  const { runId } = run;
  const hero = run.verdict.heroEvidence;
  const videos = run.sessionIds.length;

  return (
    <div className={`doors ${doorStyles.doors}`} data-section="summary-doors">
      <Door
        blurb={`${String(videos)} ${videos === 1 ? 'video' : 'videos'}, filterable by outcome, segment and the step they stopped on`}
        name="Sessions"
        to={paths.sessions(runId)}
      />
      <Door
        blurb="Clicks, attention and scroll depth, per screen"
        name="Heatmaps"
        to={paths.attention(runId, hero.variant, hero.step)}
      />
      <Door
        blurb="Where they dropped, and what took so long"
        name="Funnel and timing"
        to={paths.funnel(runId)}
      />
      <Door
        blurb="Have the first change written as a pull request"
        name="Improve my site"
        to={paths.improve(runId)}
      />
    </div>
  );
}

/**
 * The one-version lead: the recommendations and the three headline figures.
 *
 * One strip, in the prototype's order — the audience the answer is true of, the sentence,
 * the three figures, the people our automation lost, what to change, the doors, and the
 * closing line that every figure on it is simulated.
 *
 * The figures hold their row's height while the aggregate is read, so the page does not jump
 * as the run resolves; a run that computed no aggregate shows **no** figure rather than
 * zeroes, and a run with neither an aggregate nor a recommendation is the nothing-recorded
 * card alone.
 */
function OneVersionSummary({ run }: { run: Run }) {
  const state = useAggregate(run.runId);
  // A readable aggregate with no slice in it is an aggregate of nothing scored: there is no
  // denominator, so there is no figure and none is invented.
  const aggregate =
    state.status === 'ready' && wholeRun(state.aggregate) !== undefined ? state.aggregate : null;

  return (
    <div className="strip strip-sm" data-screen="summary">
      <div className="wrap">
        <HarnessNotice run={run} />
        <AudienceLine run={run} />
        <Hero run={run} />
        {state.status === 'loading' ? <HeadlineFiguresLoading /> : null}
        {aggregate === null ? null : (
          <>
            <HeadlineFigures aggregate={aggregate} run={run} />
            <ExcludedNotice aggregate={aggregate} run={run} />
          </>
        )}
        <Recommendations run={run} />
        <SummaryDoors run={run} />
        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

export function SummaryPage({ run }: { run: Run }) {
  // The run decides the shape, and nothing else does: two versions is the before/after
  // Verdict with the recommendations under it, one is the summary above.
  if (run.variants.length > 1) {
    return (
      <VerdictPage
        above={<HarnessNotice run={run} />}
        run={run}
        under={<Recommendations run={run} />}
      />
    );
  }

  return <OneVersionSummary run={run} />;
}
