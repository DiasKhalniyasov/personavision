import type { Run } from '@personavision/contract';
import { isOutcomeStatus } from '@/session';
import type { SessionFilter } from '@/session';

/**
 * The three filters of `/runs/:runId/sessions?variant=&outcome=&aoi=`, read out of the URL.
 *
 * They are **URL state and nothing else** (`docs/FLOW.md` section 3): a filtered list is a
 * link, it survives a reload, and the screen holds no selection beside the query string.
 * So this module is the one place the query string becomes a filter, and the screen reads
 * what the run holds rather than what the URL claims.
 *
 * A value naming nothing in this run — an area of interest `run.json` has no entry for, a
 * version the test never ran, a word that is not one of the four outcomes — is **dropped**
 * rather than applied. The alternative is a screen filtered by something that cannot match,
 * which reads as "nobody did this" when the truth is "that filter is a typo".
 */

/** One area of interest, as `run.json`'s `aois` records it. */
export type Aoi = Run['aois'][number];

/** The query parameters, in the order `docs/FLOW.md` section 3 writes them. */
export const VARIANT_PARAM = 'variant';
export const OUTCOME_PARAM = 'outcome';
export const AOI_PARAM = 'aoi';

/**
 * The value a segmented control's "All …" option carries. A filter is *absent* from the
 * URL rather than set to a word meaning everything, so the sentinel never reaches the query
 * string; it exists because a toggle group's options each need a value of their own, and no
 * version id or outcome is spelled `*`.
 */
export const ALL = '*';

export interface ActiveFilter {
  /** What the list is narrowed by, carrying only values this run holds. */
  readonly filter: SessionFilter;
  /** The area of interest `aoi` names, for the chip and the no-match screen. */
  readonly aoi: Aoi | null;
  /** The parameters naming nothing this run holds, for the URL to be rid of. */
  readonly unknown: readonly string[];
}

export function readFilter(run: Run, query: URLSearchParams): ActiveFilter {
  const unknown: string[] = [];
  const asked = (param: string): string => query.get(param) ?? '';

  // An unset filter is the empty string a cleared control leaves behind (`?variant=`) as
  // much as an absent parameter, and neither is an unknown value.
  const variant = asked(VARIANT_PARAM);
  const named = run.variants.some((candidate) => candidate.id === variant);
  if (variant !== '' && !named) unknown.push(VARIANT_PARAM);

  const outcome = asked(OUTCOME_PARAM);
  if (outcome !== '' && !isOutcomeStatus(outcome)) unknown.push(OUTCOME_PARAM);

  const area = asked(AOI_PARAM);
  const aoi = run.aois.find((candidate) => candidate.id === area) ?? null;
  if (area !== '' && aoi === null) unknown.push(AOI_PARAM);

  return {
    filter: {
      variant: named ? variant : null,
      outcome: isOutcomeStatus(outcome) ? outcome : null,
      aoiId: aoi?.id ?? null,
    },
    aoi,
    unknown,
  };
}

/** Whether the list is narrowed at all — what decides the counts line and the empty state. */
export function isFiltered(filter: SessionFilter): boolean {
  return [filter.variant, filter.outcome, filter.aoiId].some(
    (value) => value !== null && value !== undefined && value !== '',
  );
}

/** The same query without the parameters named, for a bad value to leave the URL. */
export function without(query: URLSearchParams, params: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(query);
  for (const param of params) next.delete(param);
  return next;
}

/** The same query with one filter set, or cleared when the value is the "All …" sentinel. */
export function withFilter(query: URLSearchParams, param: string, value: string): URLSearchParams {
  const next = new URLSearchParams(query);
  if (value === ALL || value === '') next.delete(param);
  else next.set(param, value);
  return next;
}

/**
 * The counts line while the list is narrowed, as the prototype's `microlabel` prints it:
 * `0 of 24 sessions`. Unfiltered, the line is the run's own totals (`counts.ts`) — this one
 * answers the other question, which is how much of the test the reader is looking at.
 */
export function shownOfLine(shown: number, total: number): string {
  return `${shown} of ${total} ${total === 1 ? 'session' : 'sessions'}`;
}

/**
 * What an area of interest is called on screen.
 *
 * A region that both versions have under different words carries both in one label —
 * `Completing action — A: "Place order", B: "Confirm purchase"` — because the label is
 * written once for the pair while `run.json`'s `aois` hold one entry per version. An area
 * belongs to exactly one version, so the screen prints that version's own words for it and
 * leaves the other version's out: a filter on the redesign reads `Confirm purchase`. A
 * label not written that way is printed whole.
 */
export function aoiLabel(aoi: Aoi): string {
  const prefix = `${aoi.variant}: `;
  const named = aoi.label
    .split(/[—,]/)
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return named === undefined ? aoi.label : named.slice(prefix.length).replace(/^"|"$/g, '');
}
