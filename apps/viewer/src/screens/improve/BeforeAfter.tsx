import { completionBand, percent } from '@/screens/verdict/completionBand';
import '@/screens/verdict/verdict.css';

/**
 * Before and after, with the holdout beside them: the second `.section` of
 * `#screen-improve` in `docs/design/prototype.html`.
 *
 * **Nothing about the comparison is rebuilt here.** It is the comparison the product
 * already makes (`docs/FLOW.md` section 15, point 5) — the baseline and the change as the
 * two versions — so this block takes the Verdict's own figures, its own *Why* and its own
 * stylesheet, and adds the third figure the holdout gives. Every number is **stored**: the
 * shares are `scores[].completionRate` and `scores[].holdout.completionRate`, the
 * populations are the outcome counts beside them, and the sentence under them is the one
 * `@personavision/scoring` wrote into `verdict`. The screen computes no verdict, no gain
 * and no difference of its own.
 *
 * The three figures are about **three sets of people and are never pooled** (decision 92):
 * *Baseline* and *With the change* are the people the change was chosen on, and *Holdout*
 * is the people it was never chosen against — which is the whole point of a holdout, and
 * why adding the first two session counts together does not give the run's total.
 *
 * **No win framing.** There is no *the one to ship* mark, no arrow and no computed lift
 * here, whatever the holdout said: a change that wins on the original seeds and not on the
 * holdout is *not confirmed*, and the notice says so in the sentence rather than in a
 * footnote (decision 96, and `docs/FLOW.md` section 15, point 4). The colour of a figure is
 * its band from `docs/design/tokens.css`, as every completion figure in this product is
 * banded — the prototype hand-sets two of its three illustration figures to colours those
 * thresholds do not give, and the tokens win over the hand-set class.
 */

/** One figure: the stored share, and the people behind it. */
export interface ComparedFigure {
  readonly rate: number;
  readonly success: number;
  readonly scored: number;
}

/** The whole before/after, as the run recorded it. */
export interface Comparison {
  readonly baseline: ComparedFigure;
  readonly change: ComparedFigure;
  /** The holdout's own figures on the change, or `null` when it measured none. */
  readonly holdout: ComparedFigure | null;
  /** `verdict.reasons`, which already carries the holdout line in its second slot. */
  readonly reasons: readonly string[];
  /** `verdict.holdout`: confirmed, not confirmed, or none. */
  readonly verdict: 'confirmed' | 'not_confirmed' | 'none';
  /** `verdict.audienceSentence` — the sentence the scoring step wrote, holdout and all. */
  readonly sentence: string;
  /** Whether a holdout ran at all: `none` is both *no holdout* and *could not judge*. */
  readonly ranAHoldout: boolean;
  /** The audience the figures are simulated for, named in the footnote. */
  readonly audience: string | null;
}

/** The lede of the section, in the prototype's words. */
const LEDE =
  'The same comparison the product has always made, with the baseline and the change as the two versions, and the holdout beside them.';

/** What the holdout figure's population line says, which is what makes it a holdout. */
const HOLDOUT_POPULATION = 'seeds never used to choose the change';

/** How the footnote names the audience when the run does not name one. */
const THE_AUDIENCE = 'the audience named on the results page';

/**
 * The bold lead of the notice, by what the holdout said.
 *
 * `none` is two answers in one spelling — a run that measured no holdout, and a holdout
 * that ran and could not separate the two versions, which at twenty people is a main path
 * and not a rarity. The lead claims neither of them for the other — it says that the
 * holdout did not judge — and the sentence beside it, which is the run's own, says which it
 * was and why.
 */
const leadOf = (comparison: Comparison): string => {
  if (comparison.verdict === 'confirmed') return 'Confirmed on the holdout.';
  if (comparison.verdict === 'not_confirmed') return 'Not confirmed on the holdout.';
  return comparison.ranAHoldout
    ? 'The holdout could not judge.'
    : 'The holdout did not judge this change.';
};

function Figure({
  label,
  figure,
  population,
}: {
  label: string;
  figure: ComparedFigure;
  population: string;
}) {
  return (
    <figure className="figure">
      <span className={`figure-value num completion-${completionBand(figure.rate)}`}>
        {percent(figure.rate)}%
      </span>
      <figcaption className="figure-caption">
        <span className="figure-label">{label}</span>
        <span className="figure-pop">
          {figure.success} of {figure.scored} people{population === '' ? '' : `, ${population}`}
        </span>
      </figcaption>
    </figure>
  );
}

export function BeforeAfter({ comparison }: { comparison: Comparison }) {
  const { holdout } = comparison;

  return (
    <div className="section" data-section="before-after">
      <h2>Before and after</h2>
      <p className="lede">{LEDE}</p>

      <div className="figures">
        <Figure label="Baseline" figure={comparison.baseline} population="" />
        <Figure label="With the change" figure={comparison.change} population="" />
        {holdout === null ? null : (
          <Figure label="Holdout" figure={holdout} population={HOLDOUT_POPULATION} />
        )}
      </div>

      {comparison.reasons.length === 0 ? null : (
        <div className="reasons" data-section="reasons">
          <span className="microlabel">Why</span>
          <div className="reason-list">
            {comparison.reasons.map((reason, position) => (
              // Keyed by position, as the Verdict's own reasons are: the contract caps
              // them at two and does not hold two reasons to being different.
              <p className="reason" key={position}>
                <i aria-hidden="true" />
                <span>{reason}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      <div
        className={comparison.verdict === 'not_confirmed' ? 'notice' : 'notice info'}
        data-section="holdout-verdict"
        role="status"
      >
        <span>
          <b>{leadOf(comparison)}</b> {comparison.sentence}
        </span>
      </div>

      <p className="footnote">
        Simulated for{' '}
        {comparison.audience === null ? THE_AUDIENCE : `${comparison.audience}, ${THE_AUDIENCE}`}.
        It says this change helps these people; it does not estimate what it will do to your
        conversion rate. Merging is yours.
      </p>
    </div>
  );
}
