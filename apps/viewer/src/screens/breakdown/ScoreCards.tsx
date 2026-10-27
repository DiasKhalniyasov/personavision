import type { Run } from '@personavision/contract';
import {
  atScale,
  bandLabel,
  bandOfScore,
  bandWord,
  componentRows,
  hasSpread,
  points,
  scaleThresholds,
  spanOfScale,
  spreadOf,
} from './scoreBand';
import type { ComponentRow, VariantScore } from './scoreBand';
import './ScoreCards.css';

/**
 * The two score cards: the friction score per version, with its spread, its band, the scale
 * it sits on and the four weighted components behind it.
 *
 * The `.score-grid` of `#screen-breakdown`. Every figure on it is **stored** — the median,
 * the deviation, each component, the per-outcome counts — and this file formats them and
 * draws them; it calculates no score, re-weights nothing and never rounds a spread away.
 *
 * Three honest states it has to carry, because the prototype draws only the ordinary one:
 *
 * - **A version with no score.** A run whose `scores` holds fewer than its versions renders
 *   what it has and names the version that is missing, rather than leaving one number on
 *   screen reading as a comparison.
 * - **A score with no spread.** The number is not shown at all: a friction score quoted
 *   without its uncertainty is the one thing `docs/FLOW.md` section 5 forbids outright.
 * - **A component nobody ever looked at.** `never`, not `0 s` and not a blank.
 */

const completed = (count: number): string => `${count} completed`;

/**
 * The outcome counts under a card, with the people **our own automation** broke on named
 * separately. The three outcome statuses stay three and the excluded are never folded into
 * failed or gave-up (`docs/FLOW.md` section 8) — they are our weakness, not a result.
 */
const outcomes = (counts: VariantScore['outcomeCounts']): string =>
  [
    completed(counts.success),
    `${counts.abandoned} gave up`,
    `${counts.failed} failed`,
    `${counts.automationFailure} excluded (our automation)`,
  ].join(' · ');

export function ScoreCards({ run }: { run: Run }) {
  // A score belongs to a version *and* a task, and this screen reads the run's own task.
  const scoreFor = (variant: string): VariantScore | null =>
    run.scores.find((score) => score.variant === variant && score.taskId === run.task.id) ?? null;

  return (
    <div className="score-grid" data-section="score-cards">
      {run.variants.map((variant) => (
        <ScoreCard key={variant.id} run={run} score={scoreFor(variant.id)} variant={variant} />
      ))}
    </div>
  );
}

function ScoreCard({
  run,
  score,
  variant,
}: {
  run: Run;
  score: VariantScore | null;
  variant: Run['variants'][number];
}) {
  const head = (
    <>
      {/* `Version A` is the version's own id, which is what the run calls it. */}
      <span className="microlabel">Version {variant.id}</span>
      <h2>{variant.name}</h2>
      <p className="url">{variant.url}</p>
    </>
  );
  const shell = `card score-card`;
  const attribute = variant.id.toLowerCase();

  if (score === null) {
    return (
      <figure
        aria-label={`${variant.name}: this test records no friction score`}
        className={shell}
        data-variant={attribute}
      >
        {head}
        <p className="lede">
          This test records no friction score for {variant.name}, so there is nothing here to
          compare the other version with.
        </p>
      </figure>
    );
  }

  const band = bandOfScore(score);
  const spread = hasSpread(score);

  return (
    <figure
      aria-label={
        spread
          ? `${variant.name}: friction score ${points(score.frictionScore.median)} plus or minus ${points(score.frictionScore.sd)} points, ${bandWord(band)}`
          : `${variant.name}: friction score withheld, this test recorded no spread for it`
      }
      className={shell}
      data-variant={attribute}
    >
      {head}
      {spread ? <Score band={band} score={score} /> : <NoSpread />}
      <ul className="components">
        {componentRows(run, score).map((row) => (
          <Component band={band} key={row.key} row={row} />
        ))}
      </ul>
      <p className="footnote">{outcomes(score.outcomeCounts)}</p>
    </figure>
  );
}

/** The number, its spread, its band, and the scale with the spread drawn on it. */
function Score({ band, score }: { band: ReturnType<typeof bandOfScore>; score: VariantScore }) {
  const { median, sd } = score.frictionScore;
  const { low, high } = spreadOf(score);
  const thresholds = scaleThresholds();

  return (
    <>
      <div className="score-row">
        <span className={`score-value num band-${band}`}>{points(median)}</span>
        <span className="score-spread num">± {points(sd)}</span>
        <span className={`score-band band-${band}`}>{bandLabel(band)}</span>
      </div>
      {/* The drawing is decoration: the card's accessible name carries the score and its
          spread, and the legend underneath carries the scale in text. */}
      <div aria-hidden="true" className={`scale band-${band}`}>
        <i className="spreadband" style={{ left: atScale(low), width: spanOfScale(low, high) }} />
        <i className="marker" style={{ left: atScale(median) }} />
      </div>
      <div className="scale-legend">
        <span>0 · no friction</span>
        {/* The two numbers between the ends are the tokens' thresholds, read at render. */}
        <span>{points(thresholds.good)}</span>
        <span>{points(thresholds.bad)}</span>
        <span>100 · unusable</span>
      </div>
    </>
  );
}

/** A score whose spread the run did not record: the number is withheld, and it says why. */
function NoSpread() {
  return (
    <p className="score-missing">
      This test did not record a spread for this version, so its friction score is not shown. A
      score is never shown without the ± 1σ band around it.
    </p>
  );
}

/** One component: what it is, its weight, its bar and its raw reading. */
function Component({ band, row }: { band: ReturnType<typeof bandOfScore>; row: ComponentRow }) {
  return (
    <li>
      <span className="what">
        {row.label}{' '}
        <i>
          {row.weight}
          {row.note === null ? '' : ` · ${row.note}`}
        </i>
      </span>
      {/* The bar is never the only carrier: the reading beside it is the same figure in text. */}
      <span aria-hidden="true" className={`bar band-${band}`}>
        <span style={{ width: `${row.fill * 100}%` }} />
      </span>
      <span className="val" data-never={row.never ? 'true' : undefined}>
        {row.reading}
      </span>
    </li>
  );
}
