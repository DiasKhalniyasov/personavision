import type { Run } from '@personavision/contract';
import { scoringConfig } from '@personavision/scoring';
import { stepLabel } from '@/screens/replay/runWords';
import { readScoreThreshold, scoreBand } from '@/tokens';
import type { ScoreBand } from '@/tokens';

/**
 * Everything the Score breakdown screen needs to *draw* a friction score, and nothing that
 * decides one.
 *
 * The score, its spread, its four components and the per-seed-group figures are all read
 * from `run.json` exactly as the pipeline wrote them (`docs/FLOW.md` section 5). What is
 * here is the arithmetic of putting those stored numbers on a scale — where the marker
 * sits, how wide the ± 1σ band is — and the words and raw readings that go beside them.
 *
 * Two things it refuses to own:
 *
 * - **The band.** Which of `clean` / `some friction` / `defective` a score falls in comes
 *   from `src/tokens.ts`, which reads `--score-threshold-good` and `--score-threshold-bad`
 *   off the document. Overriding a threshold moves the band, the legend and the colour
 *   together, and no number from `docs/design/tokens.css` is restated here.
 * - **The weights and the normalisation.** They are `@personavision/scoring`'s
 *   `scoringConfig` — the object its own docstring asks a screen to import rather than
 *   writing `30` beside a label — so changing a weight is one edit in that package.
 */

/** One version's score for one task, as `run.json` carries it. */
export type VariantScore = Run['scores'][number];

/**
 * The scale the friction score lives on, which is the artifact contract's: `points` is
 * 0–100, higher is worse. The two thresholds *inside* it are the tokens' and are read, not
 * written; these two ends are the scale itself and are what `0 · no friction` and
 * `100 · unusable` label.
 */
export const SCALE_MIN = 0;
export const SCALE_MAX = 100;

/** The word each band carries on screen, as `docs/design/tokens.css` names the bands. */
const BAND_WORD: Record<ScoreBand, string> = {
  good: 'clean',
  warn: 'some friction',
  bad: 'defective',
};

/** `Friction score · clean`, the `.score-band` of the prototype's card. */
export const bandLabel = (band: ScoreBand): string => `Friction score · ${BAND_WORD[band]}`;

/** The band's own word, for a sentence or an accessible name. */
export const bandWord = (band: ScoreBand): string => BAND_WORD[band];

/**
 * Points as the product prints them: whole where they are whole, one decimal where they
 * are not — the same rule the pipeline's own verdict line uses, so `+45` is `+45` and a gap
 * of 42.5 is not rounded up to 43.
 */
export const points = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/**
 * Whether this score has a spread at all.
 *
 * A friction score is **never rendered without its spread** (`docs/FLOW.md` section 5), so
 * the screen asks this before it draws a number. The contract requires `sd`, which means a
 * score reaching here without a usable one is a broken artifact rather than a run with less
 * to say — and it is read off disk, so the check is worth making where the number is shown.
 */
export const hasSpread = (score: VariantScore): boolean => {
  const { sd } = score.frictionScore;
  return Number.isFinite(sd) && sd >= 0;
};

/** One variant's ± 1σ band, in points. */
export interface Spread {
  readonly low: number;
  readonly high: number;
}

const clamp = (value: number): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));

/**
 * The ± 1σ band, held on the 0–100 scale.
 *
 * A band of friction scores is a range of friction scores, and `-12` is not one: seed
 * groups scoring 0, 0 and 20 have a median of 0 and a deviation near 12, which would
 * otherwise draw half the band off the left of the scale. Clamping can only pull a bound
 * towards the middle, so it never turns a band that overlapped into one that does not —
 * the same rule `@personavision/scoring`'s `bandOf` applies to the figures it writes.
 */
export const spreadOf = (score: VariantScore): Spread => {
  const { median, sd } = score.frictionScore;
  return { low: clamp(median - sd), high: clamp(median + sd) };
};

/** Where a figure sits across the scale, as a CSS percentage. */
export const atScale = (value: number): string =>
  `${((clamp(value) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100}%`;

/** How wide a span of points is across the scale, as a CSS percentage. */
export const spanOfScale = (from: number, to: number): string =>
  `${((clamp(to) - clamp(from)) / (SCALE_MAX - SCALE_MIN)) * 100}%`;

/** The band this score falls in, by the thresholds the tokens declare. */
export const bandOfScore = (score: VariantScore): ScoreBand =>
  scoreBand(score.frictionScore.median);

/** The two numbers the scale is labelled with between its ends: the tokens' own. */
export const scaleThresholds = (): { good: number; bad: number } => ({
  good: readScoreThreshold('good'),
  bad: readScoreThreshold('bad'),
});

/** One of the four weighted components, ready to draw. */
export interface ComponentRow {
  /** Its field name in `components`, which is also its React key. */
  readonly key: string;
  /** What it is, in the business reader's words — the prototype's own labels. */
  readonly label: string;
  /** `weight 35%`, from `scoringConfig.weights` and never written beside the label. */
  readonly weight: string;
  /** `worst step: Review`, where the component has one. `null` otherwise. */
  readonly note: string | null;
  /** The stored 0..1 component, which is the bar's width and nothing else. */
  readonly fill: number;
  /** The raw reading beside the bar. */
  readonly reading: string;
  /** True when the reading is `never`: a control nobody ever looked at. */
  readonly never: boolean;
}

const percentOfWeight = (weight: number): string => `weight ${Math.round(weight * 100)}%`;

const figure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/**
 * `2 / 11`: the people a component is a share of, back from the component itself.
 *
 * The count is **not** taken from `outcomeCounts`, and the difference matters on one row:
 * `taskFailureRate` is the sessions that failed *with the product at fault*
 * (`packages/scoring/src/score.ts`), while `outcomeCounts.failed` also carries a failure
 * our own automation caused. Reading the count off the component is what keeps the number
 * beside a bar and the width of that bar the same claim. The outcome counts have their own
 * line under the card, where they mean what they say.
 */
const outOf = (share: number, of: number): string => `${Math.round(share * of)} / ${of}`;

/**
 * The time to the primary action, in the three shapes it comes in.
 *
 * `medianSeconds` is `null` when **no session ever fixated** the control that advances the
 * task. That is the worst case and not a missing value, so it reads `never` — never `0 s`,
 * never a blank, and never a large number standing in for infinity.
 */
const fixationReading = (
  component: VariantScore['components']['timeToFirstFixationPrimary'],
): string =>
  component.medianSeconds === null ? 'never' : `${figure.format(component.medianSeconds)} s`;

/**
 * Dead-end revisits per person, back from the normalised component.
 *
 * The artifact stores the component and not the count behind it, and
 * `scoringConfig.normalisation` holds what it was divided by — so the reading is the
 * component times that cap, as the scoring package's own docstring says a screen should
 * take it. A component of exactly 1 is **the cap or more**, because the cap threw the rest
 * away and printing `5` would claim a number nobody measured.
 */
const revisitsReading = (component: number): string => {
  const cap = scoringConfig.normalisation.deadEndRevisitsPerSession;
  return component >= 1 ? `${figure.format(cap)} or more` : figure.format(component * cap);
};

/**
 * The four components of one score, in the order the prototype's card lists them, each with
 * its weight, the bar's width and its raw reading.
 *
 * `run` is here for one word only: the step the time-to-fixation component is worst on is
 * stored as an id, and the run holds the label a reader sees.
 */
export function componentRows(run: Run, score: VariantScore): ComponentRow[] {
  const { components, scoredSessionCount } = score;
  const { weights } = scoringConfig;
  const fixation = components.timeToFirstFixationPrimary;

  return [
    {
      key: 'taskFailureRate',
      label: 'Task failure rate',
      weight: percentOfWeight(weights.taskFailureRate),
      // Said on the row, because the card's outcome line counts failures of both kinds and
      // the two numbers would otherwise read as a contradiction.
      note: 'the product’s own failures',
      fill: components.taskFailureRate,
      reading: outOf(components.taskFailureRate, scoredSessionCount),
      never: false,
    },
    {
      key: 'abandonment',
      label: 'Gave up',
      weight: percentOfWeight(weights.abandonment),
      note: null,
      fill: components.abandonment,
      reading: outOf(components.abandonment, scoredSessionCount),
      never: false,
    },
    {
      key: 'timeToFirstFixationPrimary',
      label: 'Time before anyone looked at the main button',
      weight: percentOfWeight(weights.timeToFirstFixationPrimary),
      note: `worst step: ${stepLabel(run, fixation.worstStep)}`,
      fill: fixation.value,
      reading: fixationReading(fixation),
      never: fixation.medianSeconds === null,
    },
    {
      key: 'deadEndRevisits',
      label: 'Dead-end revisits per person',
      weight: percentOfWeight(weights.deadEndRevisits),
      note: null,
      fill: components.deadEndRevisits,
      reading: revisitsReading(components.deadEndRevisits),
      never: false,
    },
  ];
}

/** The scores of the run's own task: what the verdict line compared, or did not. */
export const scoresOfTask = (run: Run): VariantScore[] =>
  run.scores.filter((score) => score.taskId === run.task.id);

/**
 * How many seed groups the two versions could be compared in: the seeds every scored
 * version has a figure for.
 *
 * The run stores how many groups **agreed** and not how many there were to agree, and a
 * bare count reads as a result either way — `0` as a disagreement when there was nothing
 * to compare, and `1` as unanimity when it was one of five. So the denominator is counted
 * here, from the stored per-seed-group lists and by the same rule the pipeline counts the
 * numerator with (`packages/scoring/src/verdict.ts`): only seeds both versions were run
 * under can be compared. Nothing is re-scored; what is counted is how many figures there
 * are, never what any of them says.
 */
export function comparableSeedGroups(run: Run): number {
  const scored = scoresOfTask(run);
  if (scored.length < 2) return 0;
  const seedSets = scored.map((score) => new Set(score.perSeedGroup.map((group) => group.seed)));
  const [first, ...rest] = seedSets as [Set<number>, ...Set<number>[]];
  return [...first].filter((seed) => rest.every((seeds) => seeds.has(seed))).length;
}
