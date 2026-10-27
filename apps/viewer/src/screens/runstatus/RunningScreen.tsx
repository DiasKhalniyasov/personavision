import { Fragment, useState } from 'react';
import type { Run, SessionProgress } from '@personavision/contract';
import { Button } from '@/components/ui/button';
// What a version is called on screen — `Current checkout`, not `A`. The lookup lives in
// one place (#22), so the two screens that name a version cannot disagree.
import { variantName } from '@/screens/replay/runWords';
import { VerdictPage } from '@/screens/verdict/VerdictPage';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { CONTRIBUTOR_NOTICE, enginePhrase, ranOnContributorModel, usageLine } from './engine';
import {
  elapsedPhrase,
  finishedPhrase,
  logLine,
  logStamp,
  remainingPhrase,
  sharePercent,
} from './progress';
import './RunningScreen.css';

/**
 * `/runs/:runId` while the test is still open — `#screen-running` of
 * `docs/design/prototype.html`: how many of how many people are finished, how long it has
 * been running, what is running it, the overall and per-version progress, and the log of
 * people as they finish, newest first.
 *
 * **Everything on it is read from the run artifact as the pipeline wrote it** (#32, #49).
 * The counts are `run.progress`'s, the log's lines are its `sessions[]` entries, the spend
 * is `run.usage`'s: no figure here is re-derived from the session files beside the run, and
 * a run that records no progress says so rather than showing a zero nobody measured.
 *
 * The figures are what the artifact said when the shell read it. Nothing in the viewer
 * watches an open test yet — `refreshRun` in `src/shell/useRun.ts` is the seam for the
 * ticket that does — so this screen is one honest reading of the run rather than a bar
 * moving against stale data.
 *
 * Starting and stopping a test belong to the New test screen and to the platform (#110), so
 * *Stop test* is present, inert, and says so in its title rather than pretending to work.
 */

/** Why the one button that would change the run does nothing yet. */
const NOT_WIRED =
  'Not wired up yet: stopping a test belongs to the platform and to the New test screen (#110).';

/** One variant's share of the swarm, as the progress block records it. */
type VariantProgress = NonNullable<Run['progress']>['perVariant'][number];

/**
 * One bar, and the one claim it draws: a progress bar carries its two counts, so a reader
 * who cannot see the fill is told the same thing in the same words as the line above.
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
 * The people who have finished, newest first.
 *
 * It is a region a reader scrolls, not something that announces itself: the progress
 * figures above are the live region, and a log that interrupted on every landing session
 * would make the screen unusable with a screen reader. It takes no focus of its own
 * either — the tab stop is there so that the scrolling it holds is reachable by keyboard,
 * which is what a named, focusable region is for.
 */
function SessionLog({ run, sessions }: { run: Run; sessions: readonly SessionProgress[] }) {
  // The artifact appends in the order they finished, so the newest is its last entry.
  const newestFirst = [...sessions].reverse();

  return (
    <div className="log" role="region" tabIndex={0} aria-label="Finished sessions, newest first">
      {newestFirst.length === 0 ? (
        <p>Nobody has finished yet. Each person is listed here as they finish.</p>
      ) : (
        <ul>
          {newestFirst.map((entry) => {
            const stamp = logStamp(run, entry);
            return (
              <li key={entry.sessionId}>
                {stamp === null ? null : (
                  <>
                    <b>{stamp}</b>{' '}
                  </>
                )}
                {logLine(run, entry)}
              </li>
            );
          })}
        </ul>
      )}
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
  const elapsed = elapsedPhrase(run, now);
  const left = remainingPhrase(run, now);
  const usage = usageLine(run);

  /** The line under the heading, after the counts: time, engine, and what it has spent. */
  const details: { key: string; text: string; title?: string }[] = [
    ...(elapsed === null ? [] : [{ key: 'elapsed', text: elapsed }]),
    ...(left === null ? [] : [{ key: 'left', text: left }]),
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
      <div className="wrap">
        <div className="pagehead">
          <h1>Running · {run.task.prompt}</h1>
        </div>

        <p className="lede">
          {/* The counts are announced as they change; the time and the engine beside them
              are not, so a reader is not read a clock every time it ticks over. */}
          <span role="status">
            {progress === undefined
              ? 'This test records no progress yet'
              : finishedPhrase(progress.finishedSessions, progress.totalSessions)}
          </span>
          {details.map((part) => (
            <Fragment key={part.key}>
              {' · '}
              <span title={part.title}>{part.text}</span>
            </Fragment>
          ))}
        </p>

        {ranOnContributorModel(run.engine) ? (
          <div className="notice info">
            <span>{CONTRIBUTOR_NOTICE}</span>
          </div>
        ) : null}

        <div className="card card-lg runcard">
          {progress === undefined ? (
            <p className="faint">
              This test was saved without a progress block, so there is nothing to show yet. It
              appears here as soon as the first person finishes.
            </p>
          ) : (
            <>
              <ProgressBar
                label="Overall progress"
                finished={progress.finishedSessions}
                total={progress.totalSessions}
              />
              <div className="segments">
                {progress.perVariant.map((variant) => (
                  <VariantRow key={variant.variant} run={run} variant={variant} />
                ))}
              </div>
              <SessionLog run={run} sessions={progress.sessions} />
            </>
          )}

          <div className="runfoot">
            <Button variant="outline" onClick={() => setShowingPartial(true)}>
              Show what we have so far
            </Button>
            <Button variant="ghost" aria-disabled="true" title={NOT_WIRED}>
              Stop test
            </Button>
            <span className="faint">
              Each person is saved as they finish; stopping keeps everyone who is already done.
            </span>
          </div>
        </div>

        <SimulatedDisclaimer />
      </div>
    </div>
  );
}

/**
 * The Verdict for the people who have finished so far, with what it is of stated above it.
 *
 * The same screen a finished test renders, over the same artifact — the pipeline writes the
 * verdict as it goes, so nothing is computed here — and the reader never leaves the test:
 * the way back to the progress sits beside the notice.
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
