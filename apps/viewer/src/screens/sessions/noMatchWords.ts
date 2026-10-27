import type { Run } from '@personavision/contract';
import { stepLabel, variantName } from '@/screens/replay/runWords';
import type { OutcomeStatus, SessionFilter } from '@/session';
import { aoiLabel } from './filters';
import type { Aoi } from './filters';

/**
 * The words of the no-match screen — `#screen-sessions-empty` of
 * `docs/design/prototype.html`.
 *
 * This screen is **not an error**. On the redesign no session both fixated "Confirm
 * purchase" and finished the task, and saying that plainly is the finding: the sentence
 * names the version and the area the reader asked for, and then states what the run holds
 * about that area — how many people reached its step and how many of them never looked at
 * it. Every number in it is read from `run.json`'s `aoiMetrics`, the same row the Attention
 * screen and the scoring step read, so the screen cannot disagree with the heatmap it sends
 * the reader to.
 */

/** What each outcome reads as in the middle of a sentence. */
const DID: Readonly<Record<OutcomeStatus, string>> = {
  success: 'finished the task',
  abandoned: 'gave up',
  failed: 'ended without the task done',
  automation_failure: 'ran into our own automation breaking',
};

export interface NoMatchWords {
  /** The sentence up to the area's name. */
  readonly before: string;
  /** The area, which the screen prints in bold. `null` when no area was asked for. */
  readonly area: string | null;
  /** The rest of the sentence. */
  readonly after: string;
  /** What the run holds about the area. `null` when it holds no figures for it. */
  readonly detail: string | null;
}

const capitalise = (sentence: string): string =>
  `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;

const people = (count: number): string => `${count} ${count === 1 ? 'person' : 'people'}`;

export function noMatchWords(run: Run, filter: SessionFilter, aoi: Aoi | null): NoMatchWords {
  // An area exists on one version, so a filter naming one names its version too, whether or
  // not `?variant=` was set as well.
  const variant = filter.variant ?? aoi?.variant ?? null;
  const on = variant === null ? '' : `On ${variantName(run, variant)}, `;
  const outcome = filter.outcome ?? null;
  const did = outcome === null ? null : DID[outcome];

  const clause = (opening: string): string => (on === '' ? capitalise(opening) : `${on}${opening}`);

  if (aoi === null) {
    // No area to name: the filter is a version, an outcome, or both.
    const sentence =
      did === null
        ? // A version alone can only match nothing when the test ran nobody on it.
          clause('this test recorded nobody.')
        : clause(`nobody ${did}.`);
    return { before: sentence, area: null, after: '', detail: null };
  }

  return {
    before: clause(did === null ? 'nobody looked at ' : 'nobody both looked at '),
    area: aoiLabel(aoi),
    after: did === null ? '.' : ` and ${did}.`,
    detail: areaDetail(run, aoi),
  };
}

/**
 * The second sentence: the reading behind the empty list.
 *
 * `lookedAtShare` is the share of the people who reached that step and fixated the area, so
 * the people who reached it and never did are the rest of them — which is the whole finding
 * when the share is zero.
 */
function areaDetail(run: Run, aoi: Aoi): string | null {
  const metric = run.aoiMetrics.find((candidate) => candidate.aoiId === aoi.id);
  if (metric === undefined) return null;

  const step = stepLabel(run, aoi.step);
  const opening = 'That is the finding, not an empty table:';
  if (metric.sessionCount === 0) return `${opening} nobody ever reached the ${step} step.`;

  const looked = Math.round(metric.lookedAtShare * metric.sessionCount);
  return `${opening} of the ${people(metric.sessionCount)} who reached the ${step} step, ${lookedPhrase(metric.sessionCount, looked)}.`;
}

/** How many of the people who reached the step never looked at the area. */
function lookedPhrase(reached: number, looked: number): string {
  if (looked === 0) return 'not one ever looked at it';
  if (looked === reached) return 'every one of them looked at it';
  return `${reached - looked} never looked at it`;
}
