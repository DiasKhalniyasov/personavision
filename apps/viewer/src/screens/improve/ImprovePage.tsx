import { Link, useParams } from 'react-router';
import type { Improve, Run, Score } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { useGithubConnection } from '@/screens/settings/connection';
import type { GithubConnectionState } from '@/screens/settings/connection';
import {
  APP_NOT_REGISTERED,
  APP_NOT_REGISTERED_NEXT,
  CONNECTION_UNREADABLE,
} from '@/screens/settings/words';
import { paths } from '@/shell/paths';
import { RunNotFound } from '@/shell/RunNotFound';
import { useRun } from '@/shell/useRun';
import { BeforeAfter } from './BeforeAfter';
import type { ComparedFigure, Comparison } from './BeforeAfter';
import { PullRequestBox } from './PullRequestBox';
import type { WrittenChange } from './PullRequestBox';
import styles from './improve.module.css';

/**
 * `/runs/:runId/improve` — **have the first change written for you.**
 *
 * `#screen-improve` of `docs/design/prototype.html` and `docs/FLOW.md` sections 11 and 15:
 * the screen path 2 ends on, and the screen a user who has connected nothing still sees.
 *
 * It has **two faces, and they are states rather than neighbours** (decision 82). With no
 * repository connected it is **locked**, with the reason in the owner's words, the one
 * control that leads to connecting, and the prototype's illustration of what connecting
 * gives — that is the state nearly every user meets first, and it is not an error, an empty
 * state or a redirect. With a repository connected and a change tested, the pull request
 * that was written and the before/after stand on their own, under no *what it looks like*
 * label: a connected user reading their own result under that label would read it as a
 * mock-up of somebody else's.
 *
 * **Locked is also the safe answer.** Every state but a connection renders it — the App not
 * registered, no repository, and a connection that could not be checked — because the one
 * mistake this screen must not make is an unlocked path that cannot open a pull request.
 * The connection is read once, by `screens/settings/connection.ts`, which both this screen
 * and `/settings/github` render; this screen decides nothing about it and carries no flag of
 * its own.
 *
 * **It never merges, and the screen says so** — in the lede, in bold, in the prototype's
 * words, and it is not softened. Every figure below is read from the run as the pipeline
 * wrote it and is labelled simulated by the footnote, which also says that merging is the
 * user's.
 */

/** The prototype's own lede, whose middle sentence is the promise this product keeps. */
function PageHead({ runId }: { runId: string }) {
  return (
    <>
      <p className="breadcrumb">
        <Link to={paths.run(runId)}>Results</Link> / Improve my site
      </p>
      <div className="pagehead">
        <h1>Have the first change written for you</h1>
      </div>
      <p className="lede">
        One targeted change, picked from the recommendations above, written as a pull request on
        your repository. <b>PersonaVision never merges it.</b> You do.
      </p>
    </>
  );
}

/**
 * The site the one repository would have to deploy, named from the run where it is readable.
 *
 * The prototype names a host in the lock's sentence. A run carries the versions it drove, so
 * the host is the baseline's own; a run that has not arrived yet, or a URL the browser
 * cannot parse, names the site in words rather than guessing at a hostname.
 */
const SITE_UNKNOWN = 'the site this test ran on';

const siteOf = (run: Run | null): string => {
  const url = run?.variants[0]?.url;
  if (url === undefined) return SITE_UNKNOWN;
  try {
    return new URL(url).host;
  } catch {
    return SITE_UNKNOWN;
  }
};

/**
 * The lock: the reason, what connecting would allow, and the one control.
 *
 * The permissions are stated here because this is where a user decides to connect — read
 * access to the code, write access to pull requests, **nothing else and no merge
 * permission**. The control goes to `/settings/github` in every state: that screen is where
 * the connection lives, and while the GitHub App is not registered it is the screen that
 * says so, which is why this one does not need to know (#271, #231).
 */
function Lock({ connection, site }: { connection: GithubConnectionState; site: string }) {
  return (
    <div className={styles.lockbar} data-section="lock">
      <span>
        <b>Not connected yet.</b>{' '}
        {connection.status === 'unregistered' ? (
          <>
            {APP_NOT_REGISTERED} {APP_NOT_REGISTERED_NEXT}
          </>
        ) : connection.status === 'unreadable' ? (
          <>
            {CONNECTION_UNREADABLE} {connection.problem}
          </>
        ) : (
          <>
            Install the PersonaVision GitHub App on the one repository that deploys {site}, and this
            screen fills in. It needs read access to the code and write access to pull requests
            &mdash; nothing else, and no merge permission.
          </>
        )}
        <Button className={styles.connect} size="sm" asChild>
          <Link to={paths.githubSettings}>Connect GitHub</Link>
        </Button>
      </span>
    </div>
  );
}

/** One version's score for this run's own task, which is the figure the screen prints. */
const scoreOf = (run: Run, variant: string): Score | undefined =>
  run.scores.find((score) => score.variant === variant && score.taskId === run.task.id);

/** A stored rate and the people behind it, as both a score and a holdout figure carry them. */
const figureOf = (stored: {
  completionRate: number;
  outcomeCounts: { success: number };
  scoredSessionCount: number;
}): ComparedFigure => ({
  rate: stored.completionRate,
  success: stored.outcomeCounts.success,
  scored: stored.scoredSessionCount,
});

/** What the pull request box prints, taken field for field from the run's `improve` block. */
const changeOf = (run: Run, improve: Improve): WrittenChange => {
  const holdout = improve.holdout.personaIds.length;

  return {
    title: improve.pullRequest.title,
    repository: improve.pullRequest.repository,
    number: improve.pullRequest.number,
    url: improve.pullRequest.url,
    state: improve.pullRequest.state ?? null,
    recommendationId: improve.recommendationId,
    recommendationSentence: improve.recommendationSentence ?? null,
    changedFile: improve.changedFile,
    patch: improve.patch ?? null,
    preview: { url: improve.preview.url, reason: improve.preview.reason ?? null },
    testedWith: {
      audience: run.audience.name,
      // The holdout's people are the run's own, so the people the change was chosen on are
      // the rest of them: three figures about three sets, never pooled (decision 92).
      participants: run.personas.length - holdout,
      seeds: run.seedGroups.length,
      holdout,
    },
  };
};

/**
 * The before/after, read from the stored scores and the stored verdict.
 *
 * `null` when the run named two versions it carries no score for: a figure invented for a
 * version nobody scored would read as a comparison, so the screen says so in one sentence
 * instead.
 */
const comparisonOf = (run: Run, improve: Improve): Comparison | null => {
  const baseline = scoreOf(run, improve.baselineVariant);
  const change = scoreOf(run, improve.changeVariant);
  if (baseline === undefined || change === undefined) return null;

  return {
    baseline: figureOf(baseline),
    change: figureOf(change),
    // The holdout figure beside the two is the holdout's own on the **change**: what the
    // people the change was never chosen against did on it (`#screen-improve`).
    holdout: change.holdout === undefined ? null : figureOf(change.holdout),
    reasons: run.verdict.reasons,
    verdict: run.verdict.holdout ?? 'none',
    sentence: run.verdict.audienceSentence,
    ranAHoldout: improve.holdout.personaIds.length > 0,
    audience: run.audience.name,
  };
};

/**
 * The prototype's own illustration, under *What it looks like once connected*.
 *
 * It is the prototype's example and nobody's result — the repository, the numbers and the
 * diff are `#screen-improve`'s own — drawn through the same two components the connected
 * face uses, so what a locked user is promised and what a connected user gets cannot drift
 * apart. Its pull request links nowhere, because an example pull request has nowhere to go.
 */
const EXAMPLE_CHANGE: WrittenChange = {
  title: 'Show the expected wait before Generate',
  repository: 'clipforge/web',
  number: 482,
  url: null,
  state: 'open',
  recommendationId: '1',
  recommendationSentence: 'tell people how long the video will take before they press Generate',
  changedFile: 'app/views/waiting.html',
  patch: [
    '- <section class="waiting"><h3>Making your video</h3></section>',
    '+ <section class="waiting">',
    '+   <h3>Making your video</h3>',
    '+   <p role="status">Usually ready in about 40 seconds.</p>',
    '+   <progress aria-label="Video progress"></progress>',
    '+ </section>',
  ].join('\n'),
  preview: { url: 'clipforge-web-git-pv-wait.preview.example', reason: null },
  testedWith: { audience: null, participants: 100, seeds: 3, holdout: 40 },
};

const EXAMPLE_COMPARISON: Comparison = {
  baseline: { rate: 0.41, success: 38, scored: 93 },
  change: { rate: 0.58, success: 55, scored: 95 },
  holdout: { rate: 0.55, success: 22, scored: 40 },
  reasons: [
    '17 of the 33 people who used to leave on the waiting screen now stay to the preview.',
    'The holdout moved with them, so the gain is the change and not the swarm agreeing with itself.',
  ],
  verdict: 'confirmed',
  sentence:
    'A change that wins on the original seeds but not on the holdout is reported as not confirmed, and says so in this sentence rather than in a footnote.',
  ranAHoldout: true,
  audience: null,
};

export function ImprovePage() {
  const { runId = '' } = useParams();
  const state = useRun(runId);
  const connection = useGithubConnection();

  // A run that cannot be read is the shell's own answer, as it is on every other run
  // screen: one sentence naming what was looked for, never a blank screen.
  if (state.status === 'not-found') return <RunNotFound runId={state.runId} url={state.url} />;
  if (state.status === 'unreadable') {
    return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
  }

  const run = state.status === 'ready' ? state.run : null;

  return (
    <div className="strip strip-sm" data-screen="improve">
      <div className="wrap">
        <PageHead runId={runId} />
        {connection.status === 'connected' ? (
          <Connected run={run} />
        ) : (
          <Locked connection={connection} run={run} />
        )}
      </div>
    </div>
  );
}

/**
 * The locked face: the lock, and the illustration exactly as the prototype draws it.
 *
 * This is what the loading state renders too — the heading, the lede and the lock are on
 * the page before the connection has been read, so nothing jumps when the answer arrives.
 */
function Locked({ connection, run }: { connection: GithubConnectionState; run: Run | null }) {
  return (
    <>
      <Lock connection={connection} site={siteOf(run)} />
      <div className="section" data-section="illustration">
        <span className="microlabel">What it looks like once connected</span>
        <PullRequestBox change={EXAMPLE_CHANGE} />
      </div>
      <BeforeAfter comparison={EXAMPLE_COMPARISON} />
    </>
  );
}

/**
 * The connected face: the change this run tested, or one sentence saying it tested none.
 *
 * While the run is being read nothing is drawn under the lede: a connected workspace is not
 * told that its test tested no change until the run has actually been read.
 */
function Connected({ run }: { run: Run | null }) {
  if (run === null) return null;

  const { improve } = run;
  if (improve === undefined) {
    return (
      <p className={styles.stated} data-section="no-change">
        This test tested no change, so there is no pull request and no before and after for it. Path
        2 writes one from the recommendations of a finished test.
      </p>
    );
  }

  const comparison = comparisonOf(run, improve);

  return (
    <>
      <div className="section">
        <PullRequestBox change={changeOf(run, improve)} />
      </div>
      {/* A change that was never reached has nothing to compare: the pull request box has
          already said so, with the reason, in place of a preview URL. */}
      {improve.preview.url === null ? null : comparison === null ? (
        <p className={styles.stated} data-section="no-comparison">
          This test recorded no score for the baseline or for the change, so there is no before and
          after to draw.
        </p>
      ) : (
        <BeforeAfter comparison={comparison} />
      )}
    </>
  );
}
