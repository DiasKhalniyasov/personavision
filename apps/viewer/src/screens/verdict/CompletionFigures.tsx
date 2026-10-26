import type { Run, Score } from '@personavision/contract';
import { completionBand, inTen, percent } from './completionBand';
import './verdict.css';

/**
 * The two completion figures side by side, each with the number of people behind it, banded by the `--completion-threshold-*` tokens: the `.figures` of `#screen-verdict`.
 *
 * The share of the audience that finished the task, per version, as ***N* in 10** with the
 * percentage and the population beneath it — *82% · 9 of 11 people completed the task* —
 * and the version `verdict.preferredVariant` names marked as the one to ship.
 *
 * Every number is **stored**: the share is `scores[].completionRate` and the population is
 * `outcomeCounts.success` over `scoredSessionCount`, both as the scoring step wrote them
 * (`docs/FLOW.md` section 5). Nothing is counted from the sessions here, and the marking
 * follows the field rather than the larger figure, so a pipeline that prefers the lower
 * rate for a reason of its own is rendered as it decided.
 *
 * A figure is never shown without its population, and never over nothing: a version with
 * no score, or with no scored session, is named as unavailable with the reason, because one
 * figure presented alone would read as a comparison. A test that ran a single version says
 * so for the same reason — there the missing figure has no name to be named by.
 */

/** One version's figure, or the reason there is none. */
function Figure({ name, score, preferred }: { name: string; score: Score; preferred: boolean }) {
  if (score.scoredSessionCount === 0) {
    return (
      <Unavailable
        name={name}
        why="No completion figure: no session on this version was scored, so there is no share to report."
      />
    );
  }

  const rate = score.completionRate;

  return (
    <figure className="figure">
      <span className={`figure-value num completion-${completionBand(rate)}`}>
        {inTen(rate)}
        <small> in 10</small>
      </span>
      <figcaption className="figure-caption">
        <span className="figure-label">{name}</span>
        <span className="figure-pop">
          {percent(rate)}% &middot; {score.outcomeCounts.success} of {score.scoredSessionCount}{' '}
          people completed the task
          {preferred ? (
            <>
              {' '}
              &middot; <b>the one to ship</b>
            </>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * A version that has no figure. The em dash is decorative — the caption carries the reason,
 * so the figure is announced as unavailable and not as a dash.
 */
function Unavailable({ name, why }: { name: string; why: string }) {
  return (
    <figure className="figure figure-unavailable">
      <span className="figure-value num" aria-hidden="true">
        &mdash;
      </span>
      <figcaption className="figure-caption">
        <span className="figure-label">{name}</span>
        <span className="figure-pop">{why}</span>
      </figcaption>
    </figure>
  );
}

/** The two versions a test compares. One is a reading; it is not a comparison. */
const COMPARISON = 2;

export function CompletionFigures({ run }: { run: Run }) {
  const { scores, task, variants, verdict } = run;

  return (
    <div className="figures" data-section="completion-figures">
      {variants.map((variant) => {
        // The run's own order, and its own task: a score belongs to a version and a task,
        // and this screen is about the one task the run carries.
        const score = scores.find(
          (candidate) => candidate.variant === variant.id && candidate.taskId === task.id,
        );

        return score === undefined ? (
          <Unavailable
            key={variant.id}
            name={variant.name}
            why="This test recorded no score for this version, so the figures beside it are not a comparison."
          />
        ) : (
          <Figure
            key={variant.id}
            name={variant.name}
            score={score}
            preferred={variant.id === verdict.preferredVariant}
          />
        );
      })}

      {variants.length < COMPARISON ? (
        <p className="figures-alone">
          This test ran one version, so the figure above is a reading of that version and not a
          comparison.
        </p>
      ) : null}
    </div>
  );
}
