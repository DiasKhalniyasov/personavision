import type { Aoi, AoiMetric } from './useAttentionAreas';

/**
 * The words the areas-of-interest figures are read in — written once, here.
 *
 * One rule runs through all of them, and it is the reason this module exists rather than a
 * handful of ternaries in a table cell. **An area nobody ever fixated is a result, not a
 * gap** (`docs/FLOW.md` section 3): it reads `never` and `0%`, never `0 ms` and never a
 * blank, so that a fast first look and no look at all can never be mistaken for each other.
 * The table, the isolate caption and a finding all say it the same way because they all say
 * it from here.
 *
 * The other half of the rule is that every field saying "never" has to agree with the
 * others. The pipeline writes `timeToFirstFixationMs: null`, `firstFixationDurationMs:
 * null` and `lookedAtShare: 0` together — no first fixation, no first look to time, and
 * nobody who looked are one fact recorded three times. A row where they disagree is a fault
 * in the artifact, and the honest answer is to say so and print no figure, because either
 * figure would be a claim the run does not support.
 *
 * Nothing here computes anything. Every number is the pipeline's own, formatted.
 */

/** `0%` … `100%`: the share of the audience who looked inside the area at least once. */
const share = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
/** A millisecond reading, whole: the pipeline's precision is not the reader's. */
const ms = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** A seconds reading, as the prototype's table draws it: `2.3 s`. */
const secs = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** What the three boundary sources are called on screen, from `aois[].source`. */
const SOURCE: Readonly<Record<Aoi['source'], string>> = {
  dom: 'DOM',
  a11y: 'Accessibility tree',
  sam: 'SAM 3.1 segment',
};

/** The word for an area no fixation ever landed in. Never `0 ms`, never blank. */
export const neverFixatedLabel = (): string => 'never';

/**
 * The share of the audience who looked at it at all, from `lookedAtShare`.
 *
 * Rounding never carries a share across either end of the scale. `0%` means nobody — the
 * other half of `never` — and `100%` means everybody, so a share that is neither can print
 * as neither: an area one person in two hundred looked at, reading exactly like an area
 * nobody ever did, is the one confusion this screen exists to prevent.
 */
export function lookedAtShare(value: number): string {
  const rounded = share.format(value);
  if (value > 0 && rounded === share.format(0)) return '<1%';
  if (value < 1 && rounded === share.format(1)) return '>99%';
  return rounded;
}

/** `480 ms`, or an em dash for an area that was never fixated and so has no first look. */
export const firstFixationDuration = (value: number | null): string =>
  value === null ? '—' : `${ms.format(value)} ms`;

/** A time or a duration in seconds, as the table compares them: `2.3 s`. */
export const elapsedSeconds = (value: number): string => `${secs.format(value / 1000)} s`;

/**
 * Where this area's boundary came from, and whether it is the step's primary action.
 *
 * The prototype writes the two in one cell — `DOM · primary action` — because the source is
 * how much to trust the boundary and the primary action is what the step was for, and a
 * reader scanning the column wants both in one glance.
 */
export const areaSource = (aoi: Aoi): string =>
  aoi.isPrimaryAction ? `${SOURCE[aoi.source]} · primary action` : SOURCE[aoi.source];

/** An area this version does not have: the comparison, where a missing row would not be. */
export const notPresentInVariant = (variantName: string): string =>
  `Not present in variant ${variantName} — nothing to compare`;

/** The figures, in words: medians across the scored sessions, and what "looked at it" means. */
export const medianCaveat = (): string =>
  'Medians across the people whose session was scored, never one person’s own numbers. ' +
  '“Looked at it” is the share of those people who looked inside the area at least once.';

/** Whether no fixation ever landed in this area. `null` is a result, not a missing number. */
export const isNeverFixated = (metric: AoiMetric): boolean => metric.timeToFirstFixationMs === null;

export interface NeverFixated {
  /** The area, in this version's own words. */
  readonly aoiLabel: string;
  /** The version it was never looked at on, as the screen names it. */
  readonly variantName: string;
  /** How many of the audience reached this step at all — the denominator of the `0%`. */
  readonly reachedCount: number;
}

/**
 * The never-fixated finding, said in words rather than left in a table to be noticed.
 *
 * This is the sentence `docs/FLOW.md` section 3 names as the moment the product has to
 * land: the thing the team was about to ship was never seen. It ends by saying that nothing
 * is missing, because the one way a reader could misread `never` is as a hole in the data.
 */
export const neverFixatedSentence = ({
  aoiLabel,
  variantName,
  reachedCount,
}: NeverFixated): string =>
  `No fixation ever landed in “${aoiLabel}” on variant ${variantName}. ` +
  `0 of ${reachedCount} people in your audience who reached this step looked at it. ` +
  'Nothing is missing from the data: the area was simply never seen.';

const disagree = (aoiId: string, about: string): string =>
  `These figures disagree about ${aoiId}: ${about}. No number is shown, because either one would be a claim this test did not make.`;

/**
 * What is wrong with a metrics row whose fields disagree about "never", or `null` for one
 * that holds together.
 *
 * Three ways to disagree, and each misleads differently. A `null` first fixation beside a
 * share above zero would print `never` for an area people looked at. A recorded first
 * fixation beside a zero share would print a time for an area nobody ever saw. And a
 * `null` time to first fixation beside a recorded *duration* would print `never` and
 * `480 ms` in one row — the two readings this module exists to keep apart, side by side.
 *
 * The one asymmetry is deliberate: a recorded fixation whose duration the run does not
 * carry is a missing figure, not a contradiction, and an em dash says so honestly.
 */
export function neverFixatedProblem(metric: AoiMetric): string | null {
  const noFixation = metric.timeToFirstFixationMs === null;
  const nobodyLooked = metric.lookedAtShare === 0;

  if (noFixation !== nobodyLooked) {
    return disagree(
      metric.aoiId,
      noFixation
        ? `no fixation was ever recorded there, yet ${lookedAtShare(metric.lookedAtShare)} of the audience is reported as having looked at it`
        : 'a first fixation is recorded there, yet nobody is reported as having looked at it',
    );
  }
  if (noFixation && metric.firstFixationDurationMs !== null) {
    return disagree(
      metric.aoiId,
      `no fixation was ever recorded there, yet a first fixation is said to have lasted ${firstFixationDuration(metric.firstFixationDurationMs)}`,
    );
  }
  return null;
}

/** The same check for a caller that cannot render a row: every "never" field, or none. */
export function assertNeverFixatedConsistent(metric: AoiMetric): void {
  const problem = neverFixatedProblem(metric);
  if (problem !== null) throw new Error(problem);
}

/** An area the run holds no figures for: a gap in the artifact, kept as a row and named. */
export const noFiguresRecorded = (aoiId: string): string =>
  `This test recorded no figures for ${aoiId}. The area is kept here rather than dropped, because a row missing is not the same statement as a row with nothing in it.`;

/** Figures attached to no area at all: a fault in the artifact, stated rather than dropped. */
export const unknownAreaProblem = (aoiId: string): string =>
  `These figures name ${aoiId}, which is not an area of this test. They are shown as a fault rather than dropped, because a figure attached to nothing is wrong somewhere upstream.`;
