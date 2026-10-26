import type { Audience } from '@personavision/contract';
import type { Finding } from './findings/index.js';
import type { VariantScore } from './score.js';

/**
 * What the Verdict screen leads with, in words: the headline sentence and the one or two
 * reasons under it (`docs/FLOW.md` section 5).
 *
 * These are **written once, here**, and stored on the verdict. The screen formats them and
 * composes nothing of its own — which is what lets the same words appear on the Verdict
 * screen, in the CLI's summary and in anything the owner of the shop pastes into an email.
 *
 * The voice is section 6's: the thing on the page, what their audience did about it, and
 * the consequence. **No jargon** — a headline that said "fixation" or "friction score"
 * would be the product talking about itself instead of about their customers, and
 * `test/audience-verdict.test.ts` rejects those words.
 */

/** What a sentence says when the audience declares no goal of its own. */
const UNNAMED_GOAL = 'complete the task';

/**
 * The audience's goal, as a clause that reads inside a sentence.
 *
 * An audience's goals are written down as headings — "Buy a tent" — and the headline puts
 * one mid-sentence, so its first letter is lowered. An acronym keeps its capitals, because
 * there the capitals are the word and not a heading's styling.
 */
export const goalPhrase = (audience: Audience): string => {
  const goal = audience.goals[0]?.trim().replace(/[.!?]+$/, '') ?? '';
  if (goal.length === 0) return UNNAMED_GOAL;
  const [firstWord] = goal.split(' ');
  const isAcronym = firstWord === firstWord.toUpperCase() && /[A-Z]/.test(firstWord);
  return isAcronym ? goal : goal[0].toLowerCase() + goal.slice(1);
};

/** What the headline needs to know about the result it is stating. */
export interface AudienceSentenceInput {
  readonly audience: Audience;
  /** The variant the audience completes — what to ship. */
  readonly preferred: VariantScore;
  /** The variant it is being compared against, or `null` when only one was scored. */
  readonly other: VariantScore | null;
  /** Whether the ± 1σ bands came apart. A headline must never outrun this. */
  readonly separated: boolean;
}

/**
 * The headline: one sentence naming the variant the audience completes, and the audience.
 *
 * **A result that did not separate reads as one.** With overlapping bands the sentence says
 * so in its own words rather than leaving the caveat to a smaller line underneath, because
 * a headline that reads as a clean win is how a non-result ends up quoted as a result.
 *
 * The variants are named by the ids the run carries for them, which are the user's own
 * labels from the run request — `verdict()` is given the scores and the audience, and a
 * variant's display name belongs to `run.variants` rather than to a score.
 *
 * The audience is named as the group it is ("Outdoor-gear shoppers"), so the verb agrees
 * with it as a plural; an audience is a group of people and its name is written as one.
 */
export const audienceSentenceFor = ({
  audience,
  preferred,
  other,
  separated,
}: AudienceSentenceInput): string => {
  const goal = goalPhrase(audience);
  if (other === null) {
    return `${audience.name} ${goal} on ${preferred.variant}; there was no second version to compare it with.`;
  }
  if (separated) {
    return `${audience.name} ${goal} on ${preferred.variant}, not on ${other.variant}.`;
  }
  if (preferred.completionRate === other.completionRate) {
    return `${audience.name} ${goal} about as often on ${preferred.variant} as on ${other.variant}: this test did not separate the two versions.`;
  }
  return `${audience.name} ${goal} on ${preferred.variant} more often than on ${other.variant}, but this test did not separate the two versions.`;
};

/**
 * Where a claim sentence is cut to leave its leading clause.
 *
 * The reasons on the Verdict screen are the top findings' claims with the counts trimmed
 * off — "A $9.95 service fee only appears after the card is entered, and 4 of 9 people
 * left within 5 seconds of seeing it." leads with the thing that is wrong, and the
 * evidence under the finding is where the four and the nine belong.
 */
const CLAUSE_BREAKS = [
  ', and ',
  ', but ',
  ', so ',
  ', then ',
  ', which ',
  ', while ',
  ', although ',
  '; ',
  ' — ',
  ' – ',
];

/**
 * One reason, from one headline finding.
 *
 * The reason is **cut from the finding's own claim**, never written beside it: the
 * formatter that wrote the claim is therefore the formatter that wrote the reason, and the
 * two can never disagree about what happened (#28 owns the claim wording; this function
 * never adds a word of its own). What it does is take the claim's leading clause, which is
 * the part that names the thing on the page, and leave the counts to the evidence line.
 */
export const reasonFrom = (finding: Finding): string => {
  const claim = finding.claim.trim();
  const cuts = CLAUSE_BREAKS.map((mark) => claim.indexOf(mark)).filter((at) => at > 0);
  const head = cuts.length === 0 ? claim : claim.slice(0, Math.min(...cuts));
  return /[.!?]$/.test(head) ? head : `${head}.`;
};

/**
 * The reason a verdict falls back on when no headline finding can supply one — a run whose
 * findings list is empty, or whose headline findings are all attributed to our own
 * automation and so are not reasons to ship anything.
 *
 * `reasons` is never empty (the artifact contract refuses that: "none is not a verdict"),
 * so there has to be something to say, and the completion figures are the thing the
 * product leads with anyway. Stated in people rather than in rates, as section 5 asks.
 */
export const completionReason = (preferred: VariantScore, other: VariantScore | null): string => {
  const people = (score: VariantScore): string =>
    `${score.outcomeCounts.success} of ${score.scoredSessionCount}`;
  return other === null
    ? `${people(preferred)} people finished the task on ${preferred.variant}.`
    : `${people(preferred)} people finished the task on ${preferred.variant}, against ${people(other)} on ${other.variant}.`;
};
