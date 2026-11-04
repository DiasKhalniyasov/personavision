import { Fragment, useState } from 'react';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
// What a version is called on screen — `Current checkout`, not `A`. The lookup lives in
// one place (#22), so the two screens that name a version cannot disagree.
import { variantName } from '@/screens/replay/runWords';
import { VerdictPage } from '@/screens/verdict/VerdictPage';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { CONTRIBUTOR_NOTICE, enginePhrase, ranOnContributorModel, usageLine } from './engine';
import { JustFinished } from './JustFinished';
import {
  countsPhrase,
  finishedPhrase,
  footnotePhrase,
  headingPhrase,
  sharePercent,
  swarm,
  timePhrase,
} from './progress';
import type { SwarmState } from './progress';
import './RunningScreen.css';

/**
 * `/runs/:runId` while the test is still open — `#screen-running-swarm` of
 * `docs/design/prototype.html`: how many of a hundred people have finished, what is being
 * tested and for whom, a square for every person in the five states they can be in, and the
 * last handful of them as rows you can open straight away.
 *
 * It is **one screen for a run of any size** (#281, the owner's decision 150). A path-1 test
 * of a hundred people and the committed two-version example run of twenty-four read here the
 * same way; the one thing a comparison adds is its per-version bars, because while two
 * versions are still landing their two counts are what a reader of a comparison wants and
 * one overall bar does not carry them.
 *
 * **Everything on it is read from the run artifact as the pipeline wrote it** (#32, #49).
 * The counts are `run.progress`'s, the squares and the rows are its `sessions[]` entries,
 * the concurrency is `run.runner`'s and the spend is `run.usage`'s: no figure here is
 * re-derived from the session files beside the run, nothing is computed on the server, and a
 * run that records no progress says it is starting rather than showing a zero nobody
 * measured. Two figures are derived in the browser from stored fields — the time left and
 * how many sessions are in flight — and the screen states what each came from.
 *
 * **The grid is decoration over figures that are also in words.** It carries `aria-hidden`,
 * and the counts above it are what a screen reader is given, so nothing on the screen is
 * readable only as colour.
 *
 * The figures move as the artifact does: `useRun` re-reads an open run over the read-only
 * mount while this screen is on, at an interval slower than the file changes, and this
 * screen is a rendering of whatever the latest reading said.
 *
 * Starting and stopping a test belong to the New test screen and to the platform (#110), so
 * *Stop the test* is present, inert, and says so in its title rather than pretending to
 * work. What stopping would do is stated beside it (the owner's decision 50): the people who
 * have already finished are kept, and the test then reads as a finished test of those
 * people — which is the reading *Open the results so far* shows early, labelled with how
 * many of how many it covers.
 */

/** Why the one button that would change the run does nothing yet. */
const NOT_WIRED =
  'Not wired up yet: stopping a test belongs to the platform and to the New test screen (#110).';

/** What a run whose progress block is not written yet reads as. */
const STARTING = 'This test is starting';

/** One variant's share of the swarm, as the progress block records it. */
type VariantProgress = NonNullable<Run['progress']>['perVariant'][number];

/**
 * One bar, and the one claim it draws: a progress bar carries its two counts, so a reader
 * who cannot see the fill is told the same thing in the same words as the heading above.
 */
function ProgressBar({
  label,
  finished,
  total,
}: {
  label: string;
  finished: number;
  total: number;
}) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={finished}
      aria-valuetext={finishedPhrase(finished, total)}
    >
      <span style={{ width: `${sharePercent(finished, total)}%` }} />
    </div>
  );
}

/** One `.segbar` row: which version, how far along it is, and its own two counts. */
function VariantRow({ run, variant }: { run: Run; variant: VariantProgress }) {
  const name = variantName(run, variant.variant);

  return (
    <div className="segbar">
      <span>
        <span className={`tag tag-${variant.variant.toLowerCase()}`}>{variant.variant}</span> {name}
      </span>
      <ProgressBar
        label={`${name} progress`}
        finished={variant.finishedSessions}
        total={variant.totalSessions}
      />
      <span className="num">
        {variant.finishedSessions} / {variant.totalSessions}
      </span>
    </div>
  );
}

/**
 * A hundred people as a hundred squares.
 *
 * It is `aria-hidden` on purpose: it says nothing the counts above it do not say, and a
 * screen reader read a hundred list items — changing every few seconds — would be given a
 * wall of noise instead of a figure. A square carries no title and no tooltip either; the
 * people who are worth opening are the rows under it, which are links.
 */
function SwarmGrid({ squares }: { squares: readonly SwarmState[] }) {
  return (
    <div className="swarmgrid" aria-hidden="true" data-section="swarm">
      {squares.map((state, index) => (
        // The index is the identity: a square is the nth session of the run and nothing
        // else, and the nth square keeps its place as the ones before it finish.
        <i key={index} data-done={state ?? undefined} />
      ))}
    </div>
  );
}

export function RunningScreen({ run }: { run: Run }) {
  // What there is so far, on the Verdict: the reader stays on this test rather than being
  // navigated to a result that is still moving.
  const [showingPartial, setShowingPartial] = useState(false);
  const { progress } = run;

  if (showingPartial) {
    return <PartialVerdict run={run} onBack={() => setShowingPartial(false)} />;
  }

  const now = Date.now();
  const usage = usageLine(run);
  const concurrency = run.runner?.concurrency ?? null;
  // A run with no progress block has nothing in flight that it has told us about, so no
  // square is drawn as running: every planned session is one nobody has started yet, and
  // how many are planned is the run's own manifest of them.
  const flock = swarm(progress, progress === undefined ? null : concurrency, run.sessionIds.length);
  const time = timePhrase(run, now);

  /**
   * The lede: what was tested, for whom, when it started and how long is left — then what
   * ran it and what it has spent, which is where this product names a model (decision 11).
   * A run that carries no feature sentence is named by the task it was asked for.
   */
  const details: { key: string; text: string; title?: string }[] = [
    { key: 'feature', text: run.feature ?? run.task.prompt },
    { key: 'audience', text: run.audience.name },
    ...(time === null ? [] : [{ key: 'time', text: time }]),
    { key: 'engine', text: enginePhrase(run.engine) },
    ...(usage === null
      ? []
      : [
          { key: 'calls', text: usage.calls, title: usage.tokens },
          { key: 'cost', text: usage.cost, title: usage.tokens },
        ]),
  ];

  return (
    <div className="strip strip-sm" data-section="run-progress">
      <div className="wrap-narrow">
        <div className="pagehead">
          <h1>
            {progress === undefined
              ? STARTING
              : headingPhrase(progress.finishedSessions, progress.totalSessions)}
          </h1>
        </div>

        <p className="lede">
          {details.map((part, index) => (
            <Fragment key={part.key}>
              {index === 0 ? null : ' · '}
              <span title={part.title}>{part.text}</span>
            </Fragment>
          ))}
          . You can open a session the moment it lands.
        </p>

        {ranOnContributorModel(run.engine) ? (
          <div className="notice info">
            <span>{CONTRIBUTOR_NOTICE}</span>
          </div>
        ) : null}

        {progress === undefined ? (
          <p className="faint starting">
            This test records no progress yet, so there is nothing measured to show. The people
            appear below as they finish, and the figures with them.
          </p>
        ) : (
          <>
            <ProgressBar
              label="Overall progress"
              finished={progress.finishedSessions}
              total={progress.totalSessions}
            />
            {/* The counts are announced as they change, and they are the whole of what the
                grid below says: the time, the engine and the spend beside the heading are
                not announced, so a reader is not read a clock every time it ticks over. */}
            <p className="swarmcounts" role="status">
              {countsPhrase(flock.counts)}
            </p>
          </>
        )}

        {/* A run that plans nobody — no progress block and an empty manifest — has no
            squares to draw, and an empty grid under a key to colours nobody can see would
            be a frame around nothing. */}
        {flock.squares.length === 0 ? null : (
          <>
            <SwarmGrid squares={flock.squares} />
            <p className="footnote swarmkey">
              {footnotePhrase(flock.counts, progress === undefined ? null : concurrency)}
            </p>
          </>
        )}

        {progress !== undefined && progress.perVariant.length > 1 ? (
          <div className="segments" data-section="per-version">
            {progress.perVariant.map((variant) => (
              <VariantRow key={variant.variant} run={run} variant={variant} />
            ))}
          </div>
        ) : null}

        <JustFinished run={run} sessions={progress?.sessions ?? []} />

        <div className="runfoot">
          <Button variant="outline" onClick={() => setShowingPartial(true)}>
            Open the results so far
          </Button>
          <Button variant="ghost" aria-disabled="true" title={NOT_WIRED}>
            Stop the test
          </Button>
          <span className="faint">
            Each person is saved as they finish; stopping keeps everyone who is already done.
          </span>
        </div>

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * The Verdict for the people who have finished so far, with what it is of stated above it.
 *
 * It is also what a **stopped** test reads as (the owner's decision 50): stopping keeps
 * everyone who has already finished, and the reading of those people is this one — the same
 * screen a finished test renders, over the same artifact, labelled with how many of how many
 * it covers. Nothing is computed here; the pipeline writes the verdict as it goes. And the
 * reader never leaves the test: the way back to the progress sits beside the notice.
 */
function PartialVerdict({ run, onBack }: { run: Run; onBack: () => void }) {
  const { progress } = run;
  const covered =
    progress === undefined
      ? 'the people who have finished so far'
      : `the ${progress.finishedSessions} of ${progress.totalSessions} people who have finished so far`;

  return (
    <>
      <div className="strip strip-sm partialhead">
        <div className="wrap">
          <div className="notice info partialnotice">
            <span>{`This test is still running, so the verdict below covers only ${covered}. It changes as more of them finish.`}</span>
            <Button variant="outline" onClick={onBack}>
              Back to progress
            </Button>
          </div>
        </div>
      </div>
      <VerdictPage run={run} />
    </>
  );
}
