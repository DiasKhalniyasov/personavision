import type { Run, Score } from '@personavision/contract';
import { BeamField } from '@/shell/moments/Beam';
import { NumberTicker } from '@/shell/moments/NumberTicker';
import { Spotlight } from '@/shell/moments/Spotlight';
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
 *
 * **The Verdict reveal is mounted here** (#125): a number ticker on each form of each share,
 * the spotlight on the card `verdict.preferredVariant` names, and a beam from above the row
 * to each version. All three are decoration on a block that is already complete — the figures
 * and their populations are in the DOM at first paint, the one to ship is marked in words,
 * and under `prefers-reduced-motion` every one of them renders its finished state at once.
 */

/**
 * The two forms this screen says one share in: *8 in 10* and *82%*.
 *
 * The number ticker counts to the stored rate and writes each frame through the form it was
 * given, so the two forms of a figure are two readings of one count and agree at every frame
 * — including the last, which is the rate the scoring step wrote and the text React rendered.
 */
const tenths = (rate: number): string => String(inTen(rate));
const percentage = (rate: number): string => `${String(percent(rate))}%`;

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
    <figure className="figure" data-beam-target="">
      <span className={`figure-value num completion-${completionBand(rate)}`}>
        <NumberTicker value={rate} format={tenths} />
        <small> in 10</small>
      </span>
      <figcaption className="figure-caption">
        <span className="figure-label">{name}</span>
        <span className="figure-pop">
          <NumberTicker value={rate} format={percentage} /> &middot; {score.outcomeCounts.success}{' '}
          of {score.scoredSessionCount} people completed the task
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
    <figure className="figure figure-unavailable" data-beam-target="">
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

  // The beams of the Verdict reveal, one to each version, drawn from above the row — the
  // audience line is the sentence on the other side of that whitespace. Decoration over a
  // block that reads exactly the same without it (#125).
  return (
    <BeamField count={variants.length}>
      <div className="figures" data-section="completion-figures">
        {variants.map((variant) => {
          // The run's own order, and its own task: a score belongs to a version and a task,
          // and this screen is about the one task the run carries.
          const score = scores.find(
            (candidate) => candidate.variant === variant.id && candidate.taskId === task.id,
          );

          if (score === undefined) {
            return (
              <Unavailable
                key={variant.id}
                name={variant.name}
                why="This test recorded no score for this version, so the figures beside it are not a comparison."
              />
            );
          }

          const preferred = variant.id === verdict.preferredVariant;
          const figure = (
            <Figure key={variant.id} name={variant.name} score={score} preferred={preferred} />
          );

          // The spotlight lands on the card the stored field names, and only there. A run that
          // names no version mounts no spotlight, as a moment with no data does not mount.
          return preferred ? <Spotlight key={variant.id}>{figure}</Spotlight> : figure;
        })}

        {variants.length < COMPARISON ? (
          <p className="figures-alone">
            This test ran one version, so the figure above is a reading of that version and not a
            comparison.
          </p>
        ) : null}
      </div>
    </BeamField>
  );
}
