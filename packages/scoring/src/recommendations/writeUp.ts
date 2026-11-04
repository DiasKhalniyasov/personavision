import type {
  Aggregate,
  Citation,
  Recommendation,
  Run,
  SampleProvenance,
  WriteUpClaim,
} from '@personavision/contract';
import type { Finding } from '../findings/index.js';
import { percentSaid, stepSaid } from '../findings/wording.js';

/**
 * The write-up: Wonder's full reading of the run, as the ordered claims the Analysis screen
 * renders (`docs/FLOW.md` section 14, item 6).
 *
 * One claim per thing worth saying — a heading, a body, and the citations it rests on,
 * because a claim with nothing to cite is not published — closing with the *"What I did
 * not find"* claim, whose wording and whose position are #260's and are deliberately not
 * frozen in the schema (the decision on #249). It is a block inside
 * `recommendations.json` rather than a file of its own, so the Analysis screen fetches one
 * thing.
 *
 * **It is generated and never written.** Every claim above the closing one is one published
 * recommendation, in the rank the pipeline stored: its heading is that recommendation's own
 * *why* sentence, its body argues it with figures read off `aggregate.json`, and **its
 * citations are the recommendation's own**. Nothing here composes a citation, and nothing
 * here states a figure the aggregate does not carry — which is the whole reason the screen
 * can render citations rather than hoping a model wrote them.
 *
 * Three rules hold it to that, and each is asserted in `test/recommendations/writeUp.test.ts`:
 *
 * 1. **A claim with no resolving citation is not published.** A citation naming a session,
 *    a version, an area or a funnel step this run does not hold is dropped; a claim left
 *    with nothing to cite is dropped whole and reported in words, because a claim that
 *    disappears in silence is the other way this promise fails.
 * 2. **Every figure carries the `simulated` label**, in the body it is stated in, so that a
 *    paragraph can be read on its own and still be read as what it is (`docs/FLOW.md`
 *    section 14, and `@personavision/improve`'s own rule for the pull request comment).
 * 3. **Nothing in it reads as a conversion lift.** The write-up ranks what to fix for these
 *    simulated people; the no-conversion-lift line itself belongs to the screen's footnote
 *    and is deliberately not a sentence in here, which is why the vocabulary check can be
 *    run over this prose at all.
 *
 * Pure, like the rest of the package: contract-typed data in, plain objects out. The same
 * recommendations and the same aggregate always give the same write-up, byte for byte.
 */

/**
 * What the generator is given. #260 settles the rest of this shape in this file; the
 * barrel re-exports it by name, so adding to it costs that file no edit.
 */
export interface WriteUpInput {
  /** The run the write-up is about: what a citation may name, and whose audience it names. */
  readonly run: Run;
  /** Every figure of the run: where each claim's numbers are read from, and nowhere else. */
  readonly aggregate: Aggregate;
  /** The ranked recommendations the write-up is generated from, never from prose. */
  readonly recommendations: readonly Recommendation[];
  /** Every finding of the run, so the closing claim can say what produced no advice. */
  readonly findings: readonly Finding[];
  /** How much of the run was read: the provenance the Analysis screen prints above this. */
  readonly sample: SampleProvenance;
  /**
   * Where a dropped claim is reported, one line each. Absent swallows them, which is for a
   * caller that has nowhere to put a line and never the default of a pipeline.
   */
  readonly report?: (line: string) => void;
}

/** The signature #260 implements. */
export type WriteUpGenerator = (input: WriteUpInput) => WriteUpClaim[];

/**
 * The heading of the closing claim, in the prototype's own words (`#screen-analysis`). It is
 * the one heading of the write-up that is not a sentence about the run, so it carries no
 * terminator.
 */
export const WHAT_I_DID_NOT_FIND = 'What I did not find';

/** The word every figure in the write-up is labelled with (`docs/FLOW.md` section 14). */
const SIMULATED = 'simulated';

/**
 * "54 simulated people", "33 of 54 simulated people" — a count of people with the label it
 * may never be printed without. `wording.ts`'s `people` and `outOf` are the same figures for
 * a finding, where the screen carries the label beside the sentence; here the sentence is the
 * only thing a reader has, so the label is in it.
 */
const simulatedCount = (n: number): string => `${n} ${SIMULATED} ${n === 1 ? 'person' : 'people'}`;
const simulatedPeople = (k: number, n: number): string => `${k} of ${simulatedCount(n)}`;

/** A sentence, however the run worded it: trimmed, and terminated so two can be joined. */
const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * The same, opened with a capital: a model's own sentence and a finding's are joined into one
 * paragraph here, and neither schema requires one to start with a capital, so a paragraph
 * that read `… reached the generate step. one person waited 41 s.` would show the seam to the
 * one reader this prose is for. Only where the generator *starts* a sentence with somebody
 * else's words — never mid-sentence, where the words keep the case they were written in.
 */
const opening = (text: string): string => {
  const said = sentence(text);
  return said.charAt(0).toUpperCase() + said.slice(1);
};

/** "the landing step, the generate step and the preview step". */
const andList = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * The chip order of `#screen-analysis`, which is **not** the results page's: the funnel step
 * first, then the people with the second of their recording, then the heatmap region. The
 * `simulated` marker that closes the row is the screen's own and is no citation.
 */
const CITATION_ORDER: Readonly<Record<Citation['kind'], number>> = {
  funnel: 0,
  session: 1,
  heatmap: 2,
};

/** The names this run holds, which is all a citation of it may name. */
interface Declared {
  readonly sessions: ReadonlySet<string>;
  readonly variants: ReadonlySet<string>;
  readonly steps: ReadonlySet<string>;
  readonly aois: ReadonlySet<string>;
  /**
   * The steps the funnel a reader is looking at carries, or `undefined` where the run has no
   * funnel to anchor in and the declared steps are the most a citation can be held to — the
   * same two cases `@personavision/contract`'s own run-level check reads them in, spelt the
   * same way so a citation this generator keeps is one that validator accepts.
   */
  readonly funnelSteps: ReadonlySet<string> | undefined;
}

/** Whether a citation names only things this run holds: what "resolving" means, here. */
const resolves = (citation: Citation, declared: Declared): boolean => {
  switch (citation.kind) {
    case 'session':
      return declared.sessions.has(citation.sessionId);
    case 'heatmap':
      return (
        declared.variants.has(citation.variant) &&
        declared.steps.has(citation.step) &&
        (citation.aoiId === null || declared.aois.has(citation.aoiId))
      );
    case 'funnel':
      return (declared.funnelSteps ?? declared.steps).has(citation.stepId);
  }
};

/** The slice the Funnel screen opens on: every version and every segment, which is the run. */
const wholeRunSlice = (aggregate: Aggregate): Aggregate['funnelSlices'][number] | undefined =>
  aggregate.funnelSlices.find((slice) => slice.variant === null && slice.segment === null);

/**
 * The claims of one run's write-up, in the order the Analysis screen renders them: one per
 * published recommendation, worst first, and the *"What I did not find"* claim last.
 *
 * **A run with no published recommendation makes no claim of its own**, and its write-up is
 * the closing claim alone. There is nothing to generate a claim from — a claim is one
 * recommendation read as prose — so the stored `nothingToRecommend` sentence stands in place
 * of the claims on the screen, beside the *"What I did not find"* claim, which is the one
 * claim of a run that recommends nothing and is the reason silence does not read as a
 * verdict (`#screen-analysis` draws that state, and #260 settled it that way). An **open**
 * run generates nothing at all: its aggregate is the figures so far, and half a write-up
 * read as a finished one is worse than none.
 */
export const writeUp: WriteUpGenerator = ({
  run,
  aggregate,
  recommendations,
  findings,
  sample,
  report,
}) => {
  const say = report ?? ((): void => {});

  if (aggregate.runStatus !== 'finished') {
    say(
      `No write-up: this run is ${aggregate.runStatus}, and the figures a claim would argue from are the ones so far rather than the run's.`,
    );
    return [];
  }
  const declared: Declared = {
    sessions: new Set(run.sessionIds),
    variants: new Set(run.variants.map((variant) => variant.id)),
    steps: new Set(run.steps.map((step) => step.id)),
    aois: new Set(run.aois.map((aoi) => aoi.id)),
    funnelSteps: (() => {
      const steps = aggregate.funnelSlices.flatMap((slice) => slice.funnel.map((row) => row.step));
      return steps.length === 0 ? undefined : new Set(steps);
    })(),
  };

  const slice = wholeRunSlice(aggregate);
  const rowOf = (step: string): Aggregate['funnelSlices'][number]['funnel'][number] | undefined =>
    slice?.funnel.find((row) => row.step === step);
  const findingById = new Map(findings.map((finding) => [finding.id, finding] as const));

  /**
   * One claim, cited and ordered — or `null` where nothing it cites is of this run, with the
   * reason reported. Dropped, not refused: a claim resting on a name the run does not hold is
   * one claim the screen cannot link, and no reason to throw away the ones beside it.
   */
  const claimFor = (recommendation: Recommendation): WriteUpClaim | null => {
    const heading = opening(recommendation.evidence);
    const citations = recommendation.citations
      .filter((citation) => resolves(citation, declared))
      .sort((left, right) => CITATION_ORDER[left.kind] - CITATION_ORDER[right.kind]);
    if (citations.length === 0) {
      say(
        `The claim "${heading}" is not published: every citation recommendation ${recommendation.id} carries names something this run does not hold, so the claim has nothing to cite.`,
      );
      return null;
    }

    const row = rowOf(recommendation.step);
    /**
     * How many people the claim is about. The funnel row of the whole run is the figure a
     * reader can check on the Funnel screen, so it is used wherever there is one: the people
     * who reached the step, and the share of the run they are.
     *
     * Where there is none — a run whose aggregate carries no whole-run slice, or a step its
     * funnel does not count — the only number in hand is the recommendation's own
     * `peopleAffected`, which is *how many people a change would reach* and is **not** how
     * many reached the step. It is said as what it is, because a reach figure the aggregate
     * does not carry is the one thing this generator may not state.
     */
    const reach =
      row === undefined
        ? `A change on ${stepSaid(recommendation.step)} would reach ${simulatedPeople(recommendation.peopleAffected, aggregate.scoredSessionCount)}.`
        : `${simulatedPeople(row.reached, aggregate.scoredSessionCount)} — ${percentSaid(row.reachedShare)} of them — reached ${stepSaid(recommendation.step)}.`;
    const left = row === undefined ? 0 : row.abandoned + row.failed;
    const drop = slice?.biggestDrop;
    const body = [
      reach,
      ...(left > 0 ? [`${left} of them left it there.`] : []),
      ...(drop !== undefined && drop !== null && drop.step === recommendation.step
        ? [
            `It is where this run lost the most people, and most of them left for one reason: ${sentence(drop.reason)}`,
          ]
        : []),
      ...recommendation.findingIds
        .map((findingId) => findingById.get(findingId))
        .filter((finding): finding is Finding => finding !== undefined)
        .map((finding) => opening(finding.evidence)),
      opening(recommendation.sentence),
    ].join(' ');

    return { heading, body, citations };
  };

  const claims = recommendations
    .map(claimFor)
    .filter((claim): claim is WriteUpClaim => claim !== null);
  if (recommendations.length === 0) {
    say(
      'No claim of its own: this run published no recommendation, so its write-up is the closing claim alone and the stored nothing-to-recommend reason stands in place of the claims.',
    );
  } else if (claims.length === 0) {
    say('No write-up: every claim this run would have made cites something the run does not hold.');
    return [];
  }

  /**
   * The closing claim, in the shape of the others and always the last of them: what was
   * looked at and found nothing wrong with, what the run stated and no claim rests on, how
   * much of it was read, the automation failures excluded from every figure above, and the
   * standing reminder that the people are generated and are not customers.
   */
  const recommended = new Set(recommendations.map((recommendation) => recommendation.step));
  const looked = slice?.funnel.map((row) => row.step) ?? run.steps.map((step) => step.id);
  const quiet = looked.filter((step) => !recommended.has(step));
  const restedOn = new Set(recommendations.flatMap((recommendation) => recommendation.findingIds));
  const unused = findings.filter((finding) => !restedOn.has(finding.id)).length;
  const excluded = aggregate.excludedAutomationFailures;
  const total = aggregate.scoredSessionCount + excluded;

  const closing: WriteUpClaim = {
    heading: WHAT_I_DID_NOT_FIND,
    body: [
      quiet.length === 0
        ? 'Every step of this run has a change recommended on it, so there is no step this write-up passed over in silence.'
        : `Nothing in what these people did pointed at a change on ${andList(quiet.map(stepSaid))}, and this write-up claims none.`,
      ...(unused > 0
        ? [
            `${unused === 1 ? 'One finding' : `${unused} findings`} this run stated ${unused === 1 ? 'is' : 'are'} behind no claim above: no recommendation rests on ${unused === 1 ? 'it' : 'them'}.`,
          ]
        : []),
      `This write-up rests on the aggregate of all ${sample.of} ${SIMULATED} sessions, with ${sample.read} of them read whole.`,
      ...(excluded > 0
        ? [
            `Automation failures — ${excluded} of the ${total} — are excluded from every number above, and no claim rests on one.`,
          ]
        : []),
      `These are ${simulatedCount(run.audience.size)} generated from the audience you described, ${run.audience.name}, and not your customers: nothing here says what real customers would do.`,
    ].join(' '),
    citations: (quiet.length > 0 ? quiet : looked.slice(0, 1))
      .map((stepId): Citation => ({ kind: 'funnel', stepId }))
      .filter((citation) => resolves(citation, declared)),
  };

  // The closing claim is held to the rule it closes with: a step the run's own funnel carries
  // resolves by construction, so this is the one case where losing it means the run's steps
  // and its funnel disagree — and a write-up without it would read silence as a verdict.
  if (closing.citations.length === 0) {
    say(
      `The closing "${WHAT_I_DID_NOT_FIND}" claim is not published: this run declares no funnel step a citation could name.`,
    );
    return claims;
  }
  return [...claims, closing];
};
