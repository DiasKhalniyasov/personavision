import type { Audience, Verdict } from '@personavision/contract';
import { audienceSentenceFor, completionReason, reasonFrom } from './audienceSentence.js';
import { bandOf, bandsDisjoint, type Band } from './bands.js';
import type { Finding } from './findings/index.js';
import type { VariantScore } from './score.js';

/**
 * The verdict: what the product leads with, produced once by the pipeline and stored.
 *
 * Which variant is harder and by how many points, whether the ± 1σ bands overlap and how
 * many seed groups agreed; and for the Verdict screen, the variant the audience completes,
 * the headline sentence in the audience's words, one or two reasons, at most three
 * headline findings and the one heatmap the screen embeds (`docs/FLOW.md` section 5).
 *
 * It takes the findings and the audience because the reasons are drawn from the findings
 * and the headline sentence names the audience.
 *
 * **A result that did not separate says so.** Both sentences carry it, not a footnote
 * underneath: with overlapping bands the verdict line says the gap did not hold and the
 * headline says this test did not separate the two versions. The screen formats what it is
 * given, so a verdict that read as a clean win would be shown as one.
 *
 * Pure: contract types only, no disk, no network, no browser. The thresholds the acceptance
 * table measures against are presentation and live in `bands.ts`, mirroring
 * `docs/design/tokens.css`; nothing here reads them, because nothing here decides whether
 * a score is good — it decides whether two scores came apart.
 */

/** The signature #27 implements. */
export type VerdictWriter = (
  scores: readonly VariantScore[],
  findings: readonly Finding[],
  audience: Audience,
) => Verdict;

/** The Verdict screen shows at most three findings; the cap is the artifact contract's. */
const HEADLINE_FINDINGS = 3;
/** One or two reasons under the headline. Never three (`docs/FLOW.md` section 5). */
const MAX_REASONS = 2;

/**
 * Points as the verdict line prints them: whole where they are whole, one decimal where
 * they are not. The prototype's `+45` is a whole gap and reads as one; a gap of 42.5 is
 * not rounded to 43, because the number printed beside the sentence is the same field.
 */
const points = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/** A band as the prototype prints it: `A 19–25`, in whole points. */
const bandText = (variant: string, band: Band): string =>
  `${variant} ${Math.round(band.low)}–${Math.round(band.high)}`;

/**
 * The harder of the variants: the higher median.
 *
 * Ties break to the lower completion rate — of two variants that score the same, the one
 * fewer people finish on is the harder one — and then to the **last** variant by id, which
 * is the mirror of `preferredOf`'s first. Two variants nothing separates would otherwise
 * be named as both the harder and the preferred one, and the pair of fields would
 * contradict each other on a run where neither name means anything. The sentence says they
 * did not separate, so neither is read as a result.
 */
const harderOf = (scores: readonly VariantScore[]): VariantScore =>
  scores.reduce((harder, score) => {
    if (score.frictionScore.median !== harder.frictionScore.median) {
      return score.frictionScore.median > harder.frictionScore.median ? score : harder;
    }
    if (score.completionRate !== harder.completionRate) {
      return score.completionRate < harder.completionRate ? score : harder;
    }
    return score.variant > harder.variant ? score : harder;
  });

/**
 * The variant the verdict is compared against: the **lowest** median.
 *
 * With the two variants a comparison run has, this is simply the other one. A run with
 * more than two is compared end to end — the hardest against the easiest — because the gap
 * and the bands are a statement about whether this test separated anything at all, and the
 * widest pair is the most favourable reading of that. Ties mirror `harderOf`.
 */
const easiestOf = (scores: readonly VariantScore[]): VariantScore =>
  scores.reduce((easiest, score) => {
    if (score.frictionScore.median !== easiest.frictionScore.median) {
      return score.frictionScore.median < easiest.frictionScore.median ? score : easiest;
    }
    if (score.completionRate !== easiest.completionRate) {
      return score.completionRate > easiest.completionRate ? score : easiest;
    }
    return score.variant < easiest.variant ? score : easiest;
  });

/**
 * The variant to ship: the higher completion rate, ties breaking to the lower friction
 * score (#9's implementation decision). It is stated even when the result did not
 * separate — the headline then carries that, rather than the field being left out.
 */
const preferredOf = (scores: readonly VariantScore[]): VariantScore =>
  scores.reduce((preferred, score) => {
    if (score.completionRate !== preferred.completionRate) {
      return score.completionRate > preferred.completionRate ? score : preferred;
    }
    if (score.frictionScore.median !== preferred.frictionScore.median) {
      return score.frictionScore.median < preferred.frictionScore.median ? score : preferred;
    }
    return score.variant < preferred.variant ? score : preferred;
  });

/** How the two variants' seed groups compared, group by group. */
interface SeedGroupAgreement {
  /** Seed groups both variants were scored in: the ones that could be compared at all. */
  readonly comparable: number;
  /** Of those, the ones in which the harder variant scored higher. */
  readonly agreeing: number;
}

/**
 * How many seed groups agreed that the harder variant is harder.
 *
 * It counts the groups **in which the harder variant scored higher**, not the groups in the
 * run: a run of three groups where one of them scored the other variant worse agreed twice,
 * and reporting three there would turn a wobble into a unanimous result. A group the two
 * variants tie in has not agreed — "higher" is the claim, and equal is not higher.
 *
 * Only seeds both variants were run under can be compared. A run of real sessions carries
 * no seed at all, so there is nothing to pair and nothing agreed; the sentence says that
 * rather than reporting a zero that reads like a disagreement.
 */
const seedGroupAgreement = (harder: VariantScore, easiest: VariantScore): SeedGroupAgreement => {
  const easiestBySeed = new Map(
    easiest.perSeedGroup.map((group) => [group.seed, group.frictionScore]),
  );
  let comparable = 0;
  let agreeing = 0;
  for (const group of harder.perSeedGroup) {
    const against = easiestBySeed.get(group.seed);
    if (against === undefined) continue;
    comparable += 1;
    if (group.frictionScore > against) agreeing += 1;
  }
  return { comparable, agreeing };
};

/**
 * The headline findings: the first three by the **existing** rank order, as ids.
 *
 * `rank` is the findings generator's own ordering key (severity, then how many sessions are
 * behind the finding), so this reads it rather than re-ranking anything — the pipeline
 * ranks once, and neither this function nor the screen gets a second opinion. Findings that
 * share a rank keep the order the generator listed them in.
 */
const headlineOf = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => a.rank - b.rank).slice(0, HEADLINE_FINDINGS);

/**
 * One or two reasons, each cut from a headline finding's own claim.
 *
 * Only findings attributed to the **product** can be a reason: "our browser automation
 * timed out on the card field" is a weakness of our simulation, and offering it as a reason
 * to ship one version over another would be the product blaming their checkout for our own
 * failure. A duplicate clause is dropped, because the same words twice under "Why" is one
 * reason printed twice.
 *
 * When nothing is left — an empty findings list, or headline findings that are all ours —
 * the completion figures are the reason. The contract refuses an empty `reasons`, and the
 * figures are what the screen leads with anyway.
 */
const reasonsOf = (
  headline: readonly Finding[],
  preferred: VariantScore,
  other: VariantScore | null,
): string[] => {
  const fromFindings = [
    ...new Set(
      headline
        .filter((finding) => finding.attribution === 'product')
        .map((finding) => reasonFrom(finding)),
    ),
  ].slice(0, MAX_REASONS);
  return fromFindings.length > 0 ? fromFindings : [completionReason(preferred, other)];
};

/**
 * The one heatmap the Verdict screen embeds: the variant, step and area the verdict turns
 * on.
 *
 * It is the area of the highest-severity finding that has one, and the findings are already
 * in severity order, so it is the first finding by rank that carries an area. Findings **on
 * the harder variant come first**, because that is the variant the verdict turns on: a
 * minor note about the version that won is not the evidence for the verdict against the
 * other one. A finding about the run itself carries no variant and so cannot be hero
 * evidence; there is no heatmap of a run.
 *
 * With no such finding anywhere, the fallback is the step where the time to the primary
 * action reads worst on the harder variant — the step the friction score itself turns on —
 * with no area named, because none was found rather than one being guessed at.
 */
const heroEvidenceOf = (
  findings: readonly Finding[],
  harder: VariantScore,
): Verdict['heroEvidence'] => {
  const withArea = [...findings]
    .sort((a, b) => a.rank - b.rank)
    .filter((finding) => finding.variant !== null && finding.aoiId !== null);
  const hero = withArea.find((finding) => finding.variant === harder.variant) ?? withArea[0];
  if (hero !== undefined && hero.variant !== null) {
    return { variant: hero.variant, step: hero.step, aoiId: hero.aoiId };
  }
  return {
    variant: harder.variant,
    step: harder.components.timeToFirstFixationPrimary.worstStep,
    aoiId: null,
  };
};

/** What the verdict line is composed from, once the comparison has been made. */
interface SentenceInput {
  readonly harder: VariantScore;
  /** `null` when only one variant was scored: there is no gap and no second band. */
  readonly easiest: VariantScore | null;
  readonly gapPoints: number;
  readonly disjoint: boolean;
  readonly agreement: SeedGroupAgreement;
}

/**
 * How many seed groups agreed, as a clause that opens a sentence.
 *
 * "all 1 seed group" is not English, and a run with no seed groups to pair has not
 * disagreed about anything, so both are written out instead of being counted.
 */
const agreementClause = ({ comparable, agreeing }: SeedGroupAgreement): string => {
  if (comparable === 0) return 'This run has no seed groups to agree';
  if (agreeing === comparable) {
    return comparable === 1
      ? 'The gap held in the single seed group this run has'
      : `The gap held in all ${comparable} seed groups`;
  }
  return `The gap held in ${agreeing} of ${comparable} seed group${comparable === 1 ? '' : 's'}`;
};

/**
 * The verdict line, in the voice of the prototype's: *"Variant B is harder by 45 points.
 * The gap held in all 3 seed groups (A 19–25, B 63–71 — the bands do not overlap)."*
 *
 * It names the harder variant, the gap in points, how many seed groups agreed and whether
 * the bands overlap, in every case. The three the prototype does not show — bands that
 * overlap, two variants that scored the same, and a run of one variant — are written here
 * in the same shape, because leaving them to the viewer is how a non-result ends up reading
 * like a result.
 */
const sentenceOf = ({ harder, easiest, gapPoints, disjoint, agreement }: SentenceInput): string => {
  if (easiest === null) {
    return `Only variant ${harder.variant} was scored, so there was no gap to measure: it scored ${points(harder.frictionScore.median)} points and has no second band to be compared with.`;
  }

  const held = agreementClause(agreement);
  const bands = `${bandText(easiest.variant, bandOf(easiest))}, ${bandText(harder.variant, bandOf(harder))}`;

  if (gapPoints === 0) {
    return `Neither variant is harder: ${easiest.variant} and ${harder.variant} both scored ${points(harder.frictionScore.median)} points. ${held} and the bands overlap (${bands}), so the gap did not hold.`;
  }
  if (!disjoint) {
    const lowered = held.charAt(0).toLowerCase() + held.slice(1);
    return `Variant ${harder.variant} is harder by ${points(gapPoints)} points, but the gap did not hold: ${lowered} and the bands overlap (${bands}).`;
  }
  return `Variant ${harder.variant} is harder by ${points(gapPoints)} points. ${held} (${bands} — the bands do not overlap).`;
};

/**
 * The sentence a run closes on, and the fields the Verdict screen formats.
 *
 * `scores` is one row per variant × task, as `score()` returns it. A verdict over no scores
 * is refused rather than invented: there is no variant to name, and a `verdict` naming one
 * would be the only part of the artifact nobody measured.
 */
export const verdict: VerdictWriter = (scores, findings, audience) => {
  if (scores.length === 0) {
    throw new Error(
      'a verdict needs at least one scored variant: there is no variant to name and no gap to measure',
    );
  }

  const harder = harderOf(scores);
  const against = scores.filter((score) => score.variant !== harder.variant);
  const easiest = against.length === 0 ? null : easiestOf(against);
  const preferred = preferredOf(scores);
  // The variant the headline contrasts the preferred one with. It is the preferred one's
  // opposite number in the same comparison the verdict line makes, so a run of one variant
  // has none and the headline says as much instead of naming the only variant twice.
  const other = easiest === null ? null : preferred.variant === harder.variant ? easiest : harder;

  const gapPoints =
    easiest === null ? 0 : Math.max(0, harder.frictionScore.median - easiest.frictionScore.median);
  const disjoint = easiest === null ? false : bandsDisjoint(bandOf(harder), bandOf(easiest));
  const agreement =
    easiest === null ? { comparable: 0, agreeing: 0 } : seedGroupAgreement(harder, easiest);

  const headline = headlineOf(findings);

  return {
    harderVariant: harder.variant,
    gapPoints,
    bandsDisjoint: disjoint,
    seedGroupsAgreeing: agreement.agreeing,
    sentence: sentenceOf({ harder, easiest, gapPoints, disjoint, agreement }),
    preferredVariant: preferred.variant,
    audienceSentence: audienceSentenceFor({ audience, preferred, other, separated: disjoint }),
    reasons: reasonsOf(headline, preferred, other),
    headlineFindingIds: headline.map((finding) => finding.id),
    heroEvidence: heroEvidenceOf(findings, harder),
  };
};
