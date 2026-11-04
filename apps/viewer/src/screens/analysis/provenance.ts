import type { Aggregate, SampleProvenance } from '@personavision/contract';

/**
 * The two lines around the write-up: the provenance the card opens with, and the footnote
 * the screen closes with.
 *
 * Both are **read, never assembled**: every figure in them is a stored field of the file it
 * belongs to — how much of the run was read from the sample block of `recommendations.json`,
 * how many sessions the figures are of and when they were computed from `aggregate.json` —
 * and nothing here counts, divides or re-derives one. A provenance line that was worked out
 * in the browser would be a provenance line that can disagree with the write-up above it.
 *
 * Words, not markup: `AnalysisPage.tsx` renders them, and a test can hold one to the stored
 * fields it is made of without a DOM.
 */

/**
 * The product's own name for the model that writes the analysis, in the prototype's own
 * spelling (`#screen-analysis`).
 *
 * **Copy, not data**, for the same reason `screens/runstatus/engine.ts` keeps `Muse Spark
 * 1.3` as copy: the artifact records no analysis model, and a screen that read a name out
 * of a model id would start guessing the day a new id arrives. The product has one model
 * that writes a write-up, this screen's own title already names it, and the Summary's lede
 * attributes the recommendations to it.
 */
export const ANALYSIS_MODEL = 'muse-wonder';

/**
 * `3 Nov`, in the reader's own time zone and in the locale every figure in this app uses.
 *
 * Day then month, as the prototype's line prints it, which is why the two are formatted
 * apart: `en-US` writes the pair the other way round in one format.
 */
const dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
const month = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** `09:41`, on the twenty-four-hour clock the rest of the product prints. */
const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** An instant as a reader reads it, or `null` for one that is not an instant at all. */
const whenWords = (at: string): string | null => {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? null
    : `${dayOfMonth.format(parsed)} ${month.format(parsed)} ${clock.format(parsed)}`;
};

/** What the line is made of: the sample that was read, and the figures it rests on. */
export interface Provenance {
  /** How much of the run Muse Wonder read, as `recommendations.json` stores it. */
  readonly sample: SampleProvenance;
  /** The figures the claims argue from, or `null` for a run that computed none. */
  readonly aggregate: Aggregate | null;
}

/**
 * The `.microlabel` the card opens with — *"Read 20 of 93 sessions · stratified by outcome,
 * then segment · the aggregate of all 93 · 3 Nov 09:41 · muse-wonder"*.
 *
 * Four clauses and a name, in the prototype's order, each from the file that owns it:
 *
 * - **how much was read**, from the sample block, which is the one place that figure exists;
 * - **how the sample was drawn**, in the sampler's own stored phrase, printed and never
 *   parsed (the owner's decision 86, which is why the clause is in the line at all). A run
 *   small enough to be read whole stores *"every session of the run"* and says that, so the
 *   line never claims a draw that did not happen;
 * - **what the aggregate is of**, from the aggregate's own `scoredSessionCount`, because the
 *   claims above argue from those sessions and the sample is only the ones read whole;
 * - **when**, from the aggregate's `computedAt`: the write-up is generated from those
 *   figures, in the same pass of the pipeline that computed them, and it is the latest
 *   instant any file behind this screen records. The recommendations file stores no time of
 *   its own (`recommendationsSchema`), and a time this screen invented would be a worse
 *   answer than the one the figures carry.
 *
 * A run whose aggregate is absent or unreadable loses the two clauses that come from it
 * rather than having them guessed at: the line states what the product knows.
 */
export const provenanceLine = ({ sample, aggregate }: Provenance): string => {
  const written = aggregate === null ? null : whenWords(aggregate.computedAt);

  return [
    `Read ${sample.read} of ${sample.of} sessions`,
    sample.strategy,
    ...(aggregate === null ? [] : [`the aggregate of all ${aggregate.scoredSessionCount}`]),
    ...(written === null ? [] : [written]),
    ANALYSIS_MODEL,
  ].join(' · ');
};

/**
 * The closing footnote on our own breakage — *"Automation failures — 2 of the 24 — are
 * excluded from every number above, and no claim rests on one."*
 *
 * The count and the total are the aggregate's two stored fields (`docs/FLOW.md` section 11:
 * an automation failure is ours, is excluded from every figure, and is never silently
 * dropped). The screen holds the second half of that sentence to be true rather than
 * assuming it — a claim resting on an excluded session is not rendered at all, which is
 * `Claim.tsx`'s `publishable`.
 *
 * `null` where there is nothing to state: a run that excluded nobody, which never reads as
 * a zero, and a run with no aggregate, whose excluded count no file on this screen carries.
 */
export const excludedFootnote = (aggregate: Aggregate | null): string | null => {
  if (aggregate === null) return null;
  const excluded = aggregate.excludedAutomationFailures;
  if (excluded === 0) return null;

  const total = aggregate.scoredSessionCount + excluded;
  return `Automation failures — ${excluded} of the ${total} — are excluded from every number above, and no claim rests on one.`;
};
