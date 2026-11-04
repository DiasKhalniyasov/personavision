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

/* ===========================================================================
   The Heatmaps screen's own words (#272).

   Everything above is about one area of interest. What follows is about the
   people a figure is of — which the Heatmaps screen has to say out loud,
   because it composes two filters over a pre-sliced aggregate and the reader
   cannot be asked to work out whose heatmap they are looking at.
   ======================================================================== */

export interface PeopleShown {
  /** What is drawn, in the overlays' own labels — `Clicks`, `Attention`. */
  readonly overlays: readonly string[];
  /** The outcome filter's words, or `null` for every outcome. */
  readonly outcome: string | null;
  /** The segment filter's words, or `null` for every segment. */
  readonly segment: string | null;
  /** How many people the composition narrows to, as the slice states it. */
  readonly sessionCount: number | null;
  /** How many the run scored in all. */
  readonly scoredSessionCount: number | null;
  /** How many our own automation broke, which no figure here is about. */
  readonly excludedAutomationFailures: number | null;
}

/**
 * The line above the stage: what is drawn, who it is of, and who is not among them.
 *
 * It is one sentence because it is one fact. The prototype writes it as *"Clicks of the 41
 * people who gave up · phone · the 7 our automation broke are excluded"*, and the last
 * clause is the half that is not decoration: every figure on this screen is of the scored
 * sessions, and a reader who is not told so could reasonably assume a heatmap of "everybody"
 * includes the people whose session our own browsing broke. `docs/FLOW.md` section 11 says
 * those are shown and marked, never silently folded in — and this is where this screen
 * marks them.
 *
 * Nothing here is counted. Every number is the aggregate's own, and a figure the screen does
 * not have yet is left out of the sentence rather than printed as a zero.
 */
export function peopleShown({
  overlays,
  outcome,
  segment,
  sessionCount,
  scoredSessionCount,
  excludedAutomationFailures,
}: PeopleShown): string {
  const drawn = overlays.length === 0 ? 'No overlay' : overlays.join(' and ');
  const narrowed = [outcome, segment].filter((part) => part !== null);

  // Who they are. With no filter at all the people are the run's own scored sessions, and
  // the count beside them is the run's; with a filter they are the slice's.
  const count = narrowed.length === 0 ? scoredSessionCount : sessionCount;
  const who =
    count === null
      ? narrowed.length === 0
        ? 'your audience'
        : narrowed.join(' · ')
      : narrowed.length === 0
        ? `all ${count} people`
        : `${count} people · ${narrowed.join(' · ')}`;

  const excluded =
    excludedAutomationFailures === null
      ? null
      : excludedAutomationFailures === 0
        ? 'our automation broke on nobody'
        : `the ${excludedAutomationFailures} our automation broke ${excludedAutomationFailures === 1 ? 'is' : 'are'} excluded`;

  return [`${drawn} of ${who}`, excluded].filter((part) => part !== null).join(' · ');
}

/**
 * A composition of filters no session satisfies, said in words rather than drawn as an
 * empty frame.
 *
 * `aggregate.json` stores **no row for a filter nobody falls in**, which is the rule that
 * makes every share on this screen have a denominator. So the absence of a slice is a
 * reading about the audience — nobody is both of these things — and it is stated as one.
 * Two filters are named apart from one, because *nobody gave up on a phone* and *this test
 * has no phone segment* are different facts and the reader can only tell them apart if the
 * sentence does.
 */
export const noPeopleMatch = (outcome: string | null, segment: string | null): string => {
  if (outcome !== null && segment !== null) {
    return `Nobody in “${segment}” ended as “${outcome}”. The two filters compose, and no session in this test satisfies both, so there are no figures to show rather than an empty page.`;
  }
  if (segment !== null) {
    return `This test scored nobody in “${segment}”, so there are no figures for them.`;
  }
  if (outcome !== null) {
    return `No session in this test ended as “${outcome}”, so there are no figures for them.`;
  }
  return 'This test scored nobody, so there are no figures to show for anybody.';
};

/**
 * A step these people reached but nobody of them stood on, with the filters named.
 *
 * It is not the same sentence as *nobody reached this step*: these people exist and this
 * screen is about a narrower set of them, so the way out is to widen the filters rather
 * than to look somewhere else.
 */
export const noneOfThemReached = (stepLabel: string): string =>
  `None of the people these filters leave reached the ${stepLabel} screen, so there is nothing of theirs to draw on it. Widening either filter is the way to the people who did.`;

/** This run computed no aggregate, so two of the three overlays have nothing to read. */
export const noAggregate = (): string =>
  'This test computed no click or scroll-depth figures — it ran before either was measured — so those two overlays have nothing to draw. The attention overlay reads the sessions themselves and still works.';

/** The aggregate is there and will not parse: named, with the problem, never swallowed. */
export const unreadableAggregate = (problem: string): string =>
  `This test’s figures could not be read: ${problem}. No figure on this screen is shown rather than one being guessed at.`;

/**
 * The footnote under the stage: what the clicks on this screen amount to.
 *
 * The prototype's own — *"26 of the 41 clicks on this screen landed on Generate a second
 * time, and 9 landed on empty space where a progress indicator would be"* — read from the
 * slice's `clicksByAoi` rather than written. The empty-space clause is the one that carries
 * a finding: a press that landed on nothing the page explains is a person reaching for a
 * control that is not there.
 */
export interface ClicksFootnote {
  /** The busiest area and its count, or `null` when no area was pressed. */
  readonly busiest: { readonly label: string; readonly clicks: number } | null;
  /** How many clicks landed on nothing the page explains. */
  readonly nowhere: number;
  /** Every click on this screen, areas and empty space alike. */
  readonly total: number;
}

export function clicksFootnote({ busiest, nowhere, total }: ClicksFootnote): string | null {
  if (total === 0) return null;
  const parts: string[] = [];
  if (busiest !== null) {
    parts.push(`${busiest.clicks} of the ${total} clicks on this screen landed on ${busiest.label}`);
  }
  if (nowhere > 0) {
    parts.push(
      `${nowhere} landed on empty space the page does not explain${busiest === null ? ` — every one of the ${total} clicks on this screen` : ''}`,
    );
  }
  return parts.length === 0 ? null : `${parts.join(', and ')}.`;
}

/** The areas table's footnote on this screen, in `#screen-heatmaps`' own words. */
export const areasOnThisScreenCaveat = (): string =>
  'A row that reads never and 0% is a result, not missing data: there was nothing there to look at. ' +
  'Clicks are the people these filters leave; the gaze figures are medians across everybody whose session was scored. ' +
  'Every number here is simulated for this audience.';
