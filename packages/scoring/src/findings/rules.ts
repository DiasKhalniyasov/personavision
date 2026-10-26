import { scoringConfig, type FindingRuleId } from '../config.js';
import { controlOf, type AreaReading, type RunReading, type VariantReading } from './readings.js';
import {
  millisecondsSaid,
  onVariant,
  outOf,
  people,
  percentSaid,
  perVariantSaid,
  primaryActionSaid,
  quoted,
  secondsSaid,
  stepSaid,
  timesSaid,
} from './wording.js';

/**
 * The rules: one per situation worth saying out loud, each with a stable id, its own
 * formatter and a link to the screen that proves it.
 *
 * **The ids are the published surface**, not an internal detail: `FINDING_RULE_IDS` fixes
 * them, the planted-defect evaluation (#29) matches on them, and the demo shop declares
 * the defects it was built with by them. A finding's own `id` is built from the rule id so
 * that the rule behind a claim is recoverable from the artifact, which carries no field of
 * its own for it.
 *
 * **A rule fires at most once per variant**, on the worst instance it finds, with a
 * documented tie-break. Two findings of the same rule on one variant would carry the same
 * severity and usually the same number of sessions, so the order between them would be
 * arbitrary — and the reader asked for the things to fix, not every place a rule matched.
 * The cap of three on the Verdict screen is a different thing and is not applied here:
 * this returns every finding, and `verdict.headlineFindingIds` (#27) names the three.
 *
 * Every rule reads `scoringConfig.thresholds` and none of them writes a number down.
 */

export interface RuleHit {
  readonly ruleId: FindingRuleId;
  /** `null` when the finding is about the run itself rather than one version. */
  readonly variant: string | null;
  readonly step: string;
  readonly aoiId: string | null;
  readonly sessionIds: readonly string[];
  readonly claim: string;
  readonly evidence: string;
  readonly attribution: 'product' | 'automation';
  readonly evidenceLink: {
    readonly screen: 'attention' | 'sessions';
    readonly params: Readonly<Record<string, string>>;
  };
}

/** A rule over one version. `undefined` when the situation is not there to be stated. */
type VariantRule = (reading: VariantReading, run: RunReading) => RuleHit | undefined;

const { thresholds } = scoringConfig;

/**
 * The roles the task needs somebody to use. A heading nobody read is a fact about a page;
 * a field or a button nobody looked at is a fact about whether the task could be done, and
 * only the second is worth a finding of its own.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

const capitalised = (sentence: string): string =>
  sentence.charAt(0).toUpperCase() + sentence.slice(1);

/** Sentences joined into one evidence paragraph, with the ones that had nothing to say dropped. */
const said = (...sentences: readonly (string | undefined)[]): string =>
  sentences.filter((sentence): sentence is string => sentence !== undefined).join(' ');

/**
 * The worst instance, by the comparators in the order they are given.
 *
 * Every rule ends on a comparator over an id, so the choice is total and the same run
 * always produces the same finding — a tie decided by array order would make the claim a
 * fact about how the areas were listed.
 */
const worst = <T>(
  candidates: readonly T[],
  ...by: readonly ((a: T, b: T) => number)[]
): T | undefined => {
  const ordered = [...candidates].sort((a, b) => {
    for (const comparator of by) {
      const decided = comparator(a, b);
      if (decided !== 0) return decided;
    }
    return 0;
  });
  return ordered[0];
};

const descending =
  <T>(of: (candidate: T) => number) =>
  (a: T, b: T): number =>
    of(b) - of(a);
const ascending =
  <T>(of: (candidate: T) => number) =>
  (a: T, b: T): number =>
    of(a) - of(b);
const byAoiId = (a: AreaReading, b: AreaReading): number => a.aoi.id.localeCompare(b.aoi.id);

const attentionLink = (
  variant: string,
  step: string,
  aoiId: string | null,
): RuleHit['evidenceLink'] => ({
  screen: 'attention',
  params: aoiId === null ? { variant, step } : { variant, step, aoi: aoiId },
});

const sessionsLink = (params: Readonly<Record<string, string>>): RuleHit['evidenceLink'] => ({
  screen: 'sessions',
  params,
});

const primaryActions = (reading: VariantReading): AreaReading[] =>
  reading.areas.filter((area) => area.aoi.isPrimaryAction);

const theOtherVariant = (reading: VariantReading, run: RunReading): VariantReading | undefined =>
  run.variants.find((other) => other.variant !== reading.variant);

/** "On variant A the same control was seen by 11 of 11, after 2.4 s." — the comparison a claim earns. */
const counterpartSentence = (
  reading: VariantReading,
  run: RunReading,
  step: string,
): string | undefined => {
  const other = theOtherVariant(reading, run);
  if (other === undefined) return undefined;
  const control = controlOf(other, step);
  if (control === undefined || control.neverLookedAt || control.secondsToFirstLook === null)
    return undefined;
  return `On variant ${other.variant} the same control was seen by ${control.lookedBy.length} of ${control.reachedBy.length}, after ${secondsSaid(control.secondsToFirstLook)}.`;
};

/** The reason the sessions themselves recorded, where they agree on one and it says something. */
const recordedReason = (
  reading: VariantReading,
  sessionIds: readonly string[],
): string | undefined => {
  const reasons = new Set(
    reading.sessions
      .filter((session) => sessionIds.includes(session.sessionId))
      .map((session) => session.outcome.reason.trim())
      .filter((reason) => reason.length > 0),
  );
  const only = [...reasons];
  return only.length === 1 ? `Each of them recorded the same reason: ${only[0]}.` : undefined;
};

/**
 * A control that advances the task and that nobody ever looked at — the worst thing a run
 * can find, and the one the demo turns on.
 *
 * The control named is the one on the **deepest** step that has one: the further into the
 * journey a control nobody saw sits, the more of the task was finished before it stopped
 * being possible. The claim is worded as an **absence**, in the sentence the Screen
 * contract on #28 fixes, because "0% looked at it" reads as a missing measurement and this
 * is a result.
 */
const neverFixatedPrimaryAction: VariantRule = (reading, run) => {
  const candidates = primaryActions(reading).filter(
    (area) => area.neverLookedAt && area.reachedBy.length > 0,
  );
  const found = worst(
    candidates,
    descending((area) => reading.steps.indexOf(area.aoi.step)),
    byAoiId,
  );
  if (found === undefined) return undefined;

  const { aoi } = found;
  const completes = aoi.step === reading.completingStep;
  return {
    ruleId: 'never-fixated-primary-action',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: found.reachedBy,
    claim: `Nobody ever looked at ${primaryActionSaid(aoi.step, completes)} ${onVariant(reading.variant)}.`,
    evidence: said(
      aoi.belowFold
        ? `On ${stepSaid(aoi.step)}, ${quoted(aoi.label)} sits below the fold.`
        : `On ${stepSaid(aoi.step)}, ${quoted(aoi.label)} was on the page the whole time.`,
      `Of the ${people(found.reachedBy.length)} who got that far, ${found.lookedBy.length} looked at it.`,
      counterpartSentence(reading, run, aoi.step),
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * A control that advances the task, below the fold, that few people ever found.
 *
 * The share is above zero: a control nobody saw at all is the rule above, which is
 * critical, and reporting both would say the same thing twice at two severities.
 */
const primaryActionBelowFold: VariantRule = (reading) => {
  const candidates = primaryActions(reading).filter(
    (area) =>
      area.aoi.belowFold &&
      !area.neverLookedAt &&
      area.lookedAtShare > 0 &&
      area.lookedAtShare <= thresholds.lowLookedAtShare,
  );
  const found = worst(
    candidates,
    ascending((area) => area.lookedAtShare),
    byAoiId,
  );
  if (found === undefined) return undefined;

  const { aoi } = found;
  const completes = aoi.step === reading.completingStep;
  return {
    ruleId: 'primary-action-below-fold',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: found.reachedBy,
    claim: `${capitalised(primaryActionSaid(aoi.step, completes))} ${onVariant(reading.variant)} starts below the fold, and only ${outOf(found.lookedBy.length, found.reachedBy.length)} who got that far ever looked at it.`,
    evidence: said(
      `On ${stepSaid(aoi.step)}, ${quoted(aoi.label)} is off the first screen until the page is scrolled.`,
      `${percentSaid(found.lookedAtShare)} of the ${people(found.reachedBy.length)} who reached the step found it${found.secondsToFirstLook === null ? '' : `, first after ${secondsSaid(found.secondsToFirstLook)}`}.`,
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * Something that does not advance the task takes the first look on a step and then keeps
 * it — the competing banner.
 *
 * Taking the first look is not on its own a fault: a heading at the top of a page takes it
 * and costs nothing. What makes it a finding is that the area then holds a large share of
 * the step's attention **and more of it than the control that advances the task** — it is
 * not merely first, it is where the time went.
 */
const competingFirstFixation: VariantRule = (reading) => {
  const candidates = reading.areas.filter((area) => {
    if (area.aoi.isPrimaryAction || area.reachedBy.length === 0) return false;
    const control = controlOf(reading, area.aoi.step);
    return (
      area.firstLookOfStepBy.length * 2 > area.reachedBy.length &&
      area.shareOfStepAttention > thresholds.competingDwellShare &&
      area.totalLookMs > (control?.totalLookMs ?? 0)
    );
  });
  const found = worst(
    candidates,
    descending((area) => area.firstLookOfStepBy.length),
    descending((area) => area.shareOfStepAttention),
    byAoiId,
  );
  if (found === undefined) return undefined;

  const { aoi } = found;
  const control = controlOf(reading, aoi.step);
  // The head start it had: the gap between when the step's control was first looked at and
  // when this area was. `null` when the control was never looked at at all — that session
  // has no gap, it has the critical rule above — and the clause is then left off rather
  // than printed as a zero.
  const lead =
    control === undefined ||
    control.secondsToFirstLook === null ||
    found.secondsToFirstLook === null
      ? null
      : control.secondsToFirstLook - found.secondsToFirstLook;

  return {
    ruleId: 'competing-first-fixation',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: found.firstLookOfStepBy,
    claim:
      lead !== null && lead > 0
        ? `${quoted(aoi.label)} takes the first look in ${outOf(found.firstLookOfStepBy.length, found.reachedBy.length)} ${onVariant(reading.variant)}, about ${secondsSaid(lead)} before they look at anything that moves the task on.`
        : `${quoted(aoi.label)} takes the first look in ${outOf(found.firstLookOfStepBy.length, found.reachedBy.length)} ${onVariant(reading.variant)}, before they look at anything that moves the task on.`,
    evidence: said(
      control === undefined
        ? `It holds ${secondsSaid(found.totalLookMs / 1000)} of attention on ${stepSaid(aoi.step)}.`
        : control.totalLookMs === 0
          ? `It holds ${secondsSaid(found.totalLookMs / 1000)} of attention, against none at all on the control beneath it.`
          : `It holds ${secondsSaid(found.totalLookMs / 1000)} of attention against ${secondsSaid(control.totalLookMs / 1000)} on the control beneath it.`,
      `That is ${percentSaid(found.shareOfStepAttention)} of everything looked at on ${stepSaid(aoi.step)} — attention it costs without earning anything.`,
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * Something appears for the first time late in the journey and people keep going back to
 * it — the hidden fee.
 *
 * "Changes between steps" is read as **new on this step**: nothing with the same label
 * appeared on any earlier step this version's sessions passed through, so the first time
 * anybody saw it they had already committed to the earlier ones. An area the other version
 * does not have on the same step is preferred, because that is the difference the test was
 * run to find; returns then decide, and the area's id breaks a remaining tie.
 *
 * The limitation, stated rather than hidden: with **one** version in the run there is no
 * other version to compare against, and a block that legitimately belongs to a late step —
 * an order summary — looks the same to this rule as a charge that was not disclosed
 * earlier. It then reports the most re-read new area on the step, which is a weaker claim
 * than the two-version case. Telling the two apart needs the money a step showed, which
 * the run artifact does not carry (decision 16).
 */
const valueChangedBetweenSteps: VariantRule = (reading, run) => {
  const [firstStep] = reading.steps;
  // Every other version in the run, not only the one `counterpartSentence` compares
  // against: an area that version C also has on this step is not the difference the test
  // was run to find, however A and B read.
  const elsewhere = new Set(
    run.variants
      .filter((other) => other.variant !== reading.variant)
      .flatMap((other) => other.areas.map((area) => `${area.aoi.step}/${area.aoi.label}`)),
  );
  const labelsBefore = (step: string): Set<string> =>
    new Set(
      reading.areas
        .filter((area) => reading.steps.indexOf(area.aoi.step) < reading.steps.indexOf(step))
        .map((area) => area.aoi.label),
    );

  const candidates = reading.areas.filter(
    (area) =>
      !area.aoi.isPrimaryAction &&
      area.aoi.step !== firstStep &&
      // Somebody has to have looked at it. The returns are read from the aggregate's row
      // and the people behind the claim from the sessions, so a row reporting returns the
      // handed-in sessions do not support would otherwise ship "the 0 people who saw it"
      // with no sessions behind the finding at all.
      !area.neverLookedAt &&
      area.returns > thresholds.repeatedRevisitsPerSession &&
      !labelsBefore(area.aoi.step).has(area.aoi.label),
  );
  const found = worst(
    candidates,
    descending((area) => (elsewhere.has(`${area.aoi.step}/${area.aoi.label}`) ? 0 : 1)),
    descending((area) => area.returns),
    descending((area) => area.totalLookMs),
    byAoiId,
  );
  if (found === undefined) return undefined;

  const { aoi } = found;
  const onStep = reading.areas.filter((area) => area.aoi.step === aoi.step);
  const mostReRead = onStep.every((area) => area.returns <= found.returns);
  // Who it cost us: everybody who gave up or failed at this step or past it. A run where
  // the late charge is re-read and nobody leaves over it is a real result, and the claim
  // then says what did happen rather than reporting nought of eleven.
  const left = [
    ...new Set(
      reading.outcomes
        .filter((outcome) => reading.steps.indexOf(outcome.step) >= reading.steps.indexOf(aoi.step))
        .flatMap((outcome) => [...outcome.abandonedBy, ...outcome.failedBy]),
    ),
  ].sort();

  return {
    ruleId: 'value-changed-between-steps',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: left.length === 0 ? found.lookedBy : left,
    claim:
      left.length === 0
        ? `${quoted(aoi.label)} appears for the first time on ${stepSaid(aoi.step)}, once people have already committed, and the ${people(found.lookedBy.length)} who saw it had to read it again ${timesSaid(found.returns)} each.`
        : `${quoted(aoi.label)} appears for the first time on ${stepSaid(aoi.step)}, once people have already committed, and ${outOf(left.length, found.reachedBy.length)} who got that far left without ordering.`,
    evidence: said(
      found.firstLookMs === null
        ? undefined
        : `It holds the eye for ${millisecondsSaid(found.firstLookMs)} the first time and people come back to it ${timesSaid(found.returns)} each${mostReRead ? ' — the most re-read thing on the step' : ''}.`,
      `Nothing with its name is on any of the steps before it.`,
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * One step is where people give up.
 *
 * The reading is the share of the people who **reached** that step and gave up there, as
 * `scoringConfig.thresholds.highAbandonmentShare` describes it. The run-wide abandonment
 * rate is already the friction score's 20% component, so a finding repeating it would add
 * nothing; what this says is *where* it happened.
 */
const highAbandonmentAtStep: VariantRule = (reading) => {
  const gaveUpAnywhere = reading.outcomes.flatMap((outcome) => outcome.abandonedBy).length;
  const candidates = reading.outcomes.filter(
    (outcome) =>
      outcome.reachedBy.length > 0 &&
      outcome.abandonedBy.length / outcome.reachedBy.length > thresholds.highAbandonmentShare,
  );
  const found = worst(
    candidates,
    descending((outcome) => outcome.abandonedBy.length / outcome.reachedBy.length),
    ascending((outcome) => reading.steps.indexOf(outcome.step)),
  );
  if (found === undefined) return undefined;

  const share = found.abandonedBy.length / found.reachedBy.length;
  return {
    ruleId: 'high-abandonment-at-step',
    variant: reading.variant,
    step: found.step,
    aoiId: null,
    sessionIds: found.abandonedBy,
    claim: `${outOf(found.abandonedBy.length, found.reachedBy.length)} who reached ${stepSaid(found.step)} ${onVariant(reading.variant)} gave up there instead of going on.`,
    evidence: said(
      `That is ${percentSaid(share)} of the people who got that far, and ${found.abandonedBy.length} of the ${gaveUpAnywhere} who gave up anywhere ${onVariant(reading.variant)} gave up here.`,
      recordedReason(reading, found.abandonedBy),
    ),
    attribution: 'product',
    evidenceLink: sessionsLink({ variant: reading.variant, outcome: 'abandoned' }),
  };
};

/**
 * One step is where the task fails with the product at fault.
 *
 * Distinct from the rule above, and never merged with it: somebody who chose to leave and
 * somebody who thought they were finished and were not are two different results
 * (`docs/FLOW.md` section 8), and the fix for each is a different fix.
 */
const taskFailureAtStep: VariantRule = (reading) => {
  const candidates = reading.outcomes.filter((outcome) => outcome.failedBy.length > 0);
  const found = worst(
    candidates,
    descending((outcome) => outcome.failedBy.length),
    ascending((outcome) => reading.steps.indexOf(outcome.step)),
  );
  if (found === undefined) return undefined;

  return {
    ruleId: 'task-failure-at-step',
    variant: reading.variant,
    step: found.step,
    aoiId: controlOf(reading, found.step)?.aoi.id ?? null,
    sessionIds: found.failedBy,
    claim: `${outOf(found.failedBy.length, found.reachedBy.length)} who reached ${stepSaid(found.step)} ${onVariant(reading.variant)} ended there with no order placed, and leaving was not their choice.`,
    evidence: said(
      `All ${found.failedBy.length} stopped on that step with the task unfinished and the product at fault — a failure, not someone choosing to leave.`,
      recordedReason(reading, found.failedBy),
    ),
    attribution: 'product',
    evidenceLink: sessionsLink({ variant: reading.variant, outcome: 'failed' }),
  };
};

/**
 * The control that advances the task was found, but slowly.
 *
 * Only where it was found: never found is the critical rule, and the two readings share a
 * threshold at the six-second cap that the friction score normalises over.
 */
const slowPrimaryActionFixation: VariantRule = (reading, run) => {
  const candidates = primaryActions(reading).filter(
    (area) =>
      !area.neverLookedAt &&
      area.secondsToFirstLook !== null &&
      area.secondsToFirstLook > thresholds.slowPrimaryActionSeconds,
  );
  const found = worst(
    candidates,
    descending((area) => area.secondsToFirstLook ?? 0),
    byAoiId,
  );
  if (found === undefined || found.secondsToFirstLook === null) return undefined;

  const { aoi } = found;
  const completes = aoi.step === reading.completingStep;
  return {
    ruleId: 'slow-primary-action-fixation',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: found.lookedBy,
    claim: `${outOf(found.lookedBy.length, found.reachedBy.length)} ${onVariant(reading.variant)} took ${secondsSaid(found.secondsToFirstLook)} to find ${primaryActionSaid(aoi.step, completes)}, time they spent on everything around it instead.`,
    evidence: said(
      `${outOf(found.lookedBy.length, found.reachedBy.length)} who reached ${stepSaid(aoi.step)} looked at ${quoted(aoi.label)} at all, after a median of ${secondsSaid(found.secondsToFirstLook)}.`,
      counterpartSentence(reading, run, aoi.step),
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * Something the task needs was looked at by few of the people who could have used it.
 *
 * "Needs" is read from the area's role: a field, a button or a link is something somebody
 * has to use, and a heading or a block of text nobody read is a fact about a page rather
 * than about whether the task could be done. Controls that advance the task have their own
 * two rules above and are left to them.
 */
const lowLookedAtShare: VariantRule = (reading) => {
  const candidates = reading.areas.filter(
    (area) =>
      !area.aoi.isPrimaryAction &&
      area.aoi.role !== null &&
      INTERACTIVE_ROLES.has(area.aoi.role) &&
      area.reachedBy.length > 0 &&
      area.lookedAtShare <= thresholds.lowLookedAtShare,
  );
  const found = worst(
    candidates,
    ascending((area) => area.lookedAtShare),
    byAoiId,
  );
  if (found === undefined) return undefined;

  const { aoi } = found;
  return {
    ruleId: 'low-looked-at-share',
    variant: reading.variant,
    step: aoi.step,
    aoiId: aoi.id,
    sessionIds: found.reachedBy,
    claim:
      found.lookedBy.length === 0
        ? `Not one of the ${people(found.reachedBy.length)} who reached ${stepSaid(aoi.step)} ${onVariant(reading.variant)} ever looked at ${quoted(aoi.label)}, so it did no work at all.`
        : `Only ${outOf(found.lookedBy.length, found.reachedBy.length)} who reached ${stepSaid(aoi.step)} ${onVariant(reading.variant)} ever looked at ${quoted(aoi.label)}, so it did no work for the rest of them.`,
    evidence: said(
      `It is one of the things the task needs somebody to use.`,
      found.totalLookMs === 0
        ? `${percentSaid(found.lookedAtShare)} of the ${people(found.reachedBy.length)} who got that far looked at it at all, and it held none of their attention across the step.`
        : `${percentSaid(found.lookedAtShare)} of the ${people(found.reachedBy.length)} who got that far looked at it at all, and it held ${secondsSaid(found.totalLookMs / 1000)} of their attention across the step.`,
    ),
    attribution: 'product',
    evidenceLink: attentionLink(reading.variant, aoi.step, aoi.id),
  };
};

/**
 * What the run has to say about itself: the sessions our own automation lost.
 *
 * It is the one finding attributed to `automation`, it names no variant, and it is the
 * place the exclusion is **said in words** — the friction score already read the exclusion
 * from each session and left those sessions out of every component. No rule above can
 * reach them: `readRun` hands the rules the scored sessions only.
 */
const informationalNote = (run: RunReading): RuleHit | undefined => {
  const { sessions, totalSessionCount } = run.excluded;
  if (sessions.length === 0) return undefined;

  const byStep = new Map<string, number>();
  for (const session of sessions)
    byStep.set(session.outcome.step, (byStep.get(session.outcome.step) ?? 0) + 1);
  const step = [...byStep.entries()].sort(
    ([stepA, nA], [stepB, nB]) => nB - nA || stepA.localeCompare(stepB),
  )[0][0];

  // The per-version counts and the retries are the ones that belong to **that** step. A
  // run whose exclusions are spread over several steps would otherwise describe all of
  // them in a sentence that names one, and say of a session that broke on the basket that
  // it broke on the payment step. The rest are counted, not described.
  const onStep = sessions.filter((session) => session.outcome.step === step);
  const elsewhere = sessions.length - onStep.length;

  const perVariant = new Map<string, number>();
  for (const session of onStep)
    perVariant.set(session.variant, (perVariant.get(session.variant) ?? 0) + 1);
  const retries = onStep.reduce((total, session) => total + session.integrity.retries, 0);

  return {
    ruleId: 'informational-note',
    variant: null,
    step,
    aoiId: null,
    sessionIds: sessions.map((session) => session.sessionId).sort(),
    claim: `${outOf(sessions.length, totalSessionCount)} could not be simulated to the end, and are excluded from both figures.`,
    evidence: said(
      `Our own browser automation gave up on ${stepSaid(step)} (${perVariantSaid(perVariant)})${retries === 0 ? '' : ` after ${retries === 1 ? 'one retry' : `${retries} retries`}`}${elsewhere === 0 ? '' : `, and on other steps for ${people(elsewhere)}`}.`,
      `This is a weakness of the simulation, never evidence against your checkout.`,
    ),
    attribution: 'automation',
    evidenceLink: sessionsLink({ outcome: 'automation_failure' }),
  };
};

/**
 * Every rule, in the order `docs/FLOW.md` section 6 and #9 list them. The order here is
 * documentation only: the findings list is ranked by severity and session count, never by
 * the order the rules happen to be written in.
 */
const VARIANT_RULES: readonly VariantRule[] = [
  neverFixatedPrimaryAction,
  primaryActionBelowFold,
  competingFirstFixation,
  valueChangedBetweenSteps,
  highAbandonmentAtStep,
  taskFailureAtStep,
  slowPrimaryActionFixation,
  lowLookedAtShare,
];

/** Every rule that fired, unranked. */
export const fire = (run: RunReading): RuleHit[] => {
  const hits = run.variants.flatMap((reading) =>
    VARIANT_RULES.flatMap((rule) => {
      const hit = rule(reading, run);
      return hit === undefined ? [] : [hit];
    }),
  );
  const note = informationalNote(run);
  return note === undefined ? hits : [...hits, note];
};
