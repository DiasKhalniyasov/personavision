import type { Run } from '@personavision/contract';
import { isOutcomeStatus } from '@/session';
import type { SessionFilter } from '@/session';

/**
 * The filters of `/runs/:runId/sessions?variant=&outcome=&aoi=&segment=&step=`, and which of
 * the screen's two views a URL asks for, read out of the URL.
 *
 * They are **URL state and nothing else** (`docs/FLOW.md` section 3): a filtered list is a
 * link, it survives a reload, and the screen holds no selection beside the query string.
 * So this module is the one place the query string becomes a filter, and the screen reads
 * what the run holds rather than what the URL claims.
 *
 * A value naming nothing in this run — an area of interest `run.json` has no entry for, a
 * version the test never ran, a word that is not one of the four outcomes, a segment nobody
 * in this audience belongs to, a step the task never planned — is **dropped** rather than
 * applied. The alternative is a screen filtered by something that cannot match, which reads
 * as "nobody did this" when the truth is "that filter is a typo".
 *
 * `view` is the one parameter here that narrows nothing: it says whether the reader asked
 * for the grid of video thumbnails or the rows of the same people. It is URL state for the
 * same reason the filters are — a view is a link somebody can send — and it is **not** one
 * of the contract's evidence-link parameters, because no citation names a view: a
 * recommendation cites people, and which way a reader looks at them is their own business.
 */

/** One area of interest, as `run.json`'s `aois` records it. */
export type Aoi = Run['aois'][number];

/** The query parameters, in the order `docs/FLOW.md` sections 3 and 14 write them. */
export const VARIANT_PARAM = 'variant';
export const OUTCOME_PARAM = 'outcome';
export const AOI_PARAM = 'aoi';
/** The audience segment, as `personas[].segment` spells it. */
export const SEGMENT_PARAM = 'segment';
/** The step a session ended on, as `run.steps[].id` spells it. */
export const STEP_PARAM = 'step';

/**
 * Which view of the same people a URL asks for. The grid of video thumbnails is the
 * default and carries no parameter at all (`docs/FLOW.md` section 14.2), so the rows are
 * the one view with a spelling: `?view=rows`.
 */
export const VIEW_PARAM = 'view';
export const ROWS_VIEW = 'rows';

/**
 * The value a segmented control's "All …" option carries. A filter is *absent* from the
 * URL rather than set to a word meaning everything, so the sentinel never reaches the query
 * string; it exists because a toggle group's options each need a value of their own, and no
 * version id or outcome is spelled `*`.
 */
export const ALL = '*';

/**
 * What the two Sessions views are narrowed by: the three filters of `#screen-sessions` and
 * the two more `#screen-grid` adds. One filter set and not one per view, because the views
 * are the same people — a reader who narrowed the grid to one segment and then asked for
 * the rows is looking at the people they just chose.
 *
 * `segment` and `step` are evaluated over the **row**, not over the session: a persona's
 * segment lives in `run.personas` and the step's own label in `run.steps`, and the session
 * module has already looked both up (`sessionRow`). Nothing is re-derived here.
 */
export interface ScreenFilter extends SessionFilter {
  /** The audience segment, exactly as `personas[].segment` spells it. */
  readonly segment: string | null;
  /** The step a session ended on, as `outcome.step` names it. */
  readonly step: string | null;
}

/** One step of the task, as `run.json`'s `steps` records it. */
export type Step = Run['steps'][number];

export interface ActiveFilter {
  /** What the list is narrowed by, carrying only values this run holds. */
  readonly filter: ScreenFilter;
  /** The area of interest `aoi` names, for the chip and the no-match screen. */
  readonly aoi: Aoi | null;
  /** The step `step` names, for the chip and the filter group's own label. */
  readonly endedOn: Step | null;
  /** The parameters naming nothing this run holds, for the URL to be rid of. */
  readonly unknown: readonly string[];
}

/**
 * The segments this audience has, once each, in the order the run lists its people.
 *
 * Read from `run.personas` rather than from the audience block, which declares a device
 * mix and an age range but no segments: a segment is a label the persona generator wrote
 * onto each person, so the people are where the list of them is.
 */
export function runSegments(run: Run): readonly string[] {
  return [...new Set(run.personas.map((persona) => persona.segment))];
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
  const found = run.aois.find((candidate) => candidate.id === area) ?? null;
  if (area !== '' && found === null) unknown.push(AOI_PARAM);

  const segment = asked(SEGMENT_PARAM);
  const inAudience = runSegments(run).includes(segment);
  if (segment !== '' && !inAudience) unknown.push(SEGMENT_PARAM);

  const step = asked(STEP_PARAM);
  const endedOn = run.steps.find((candidate) => candidate.id === step) ?? null;
  if (step !== '' && endedOn === null) unknown.push(STEP_PARAM);

  // An area of interest belongs to one version, so an area of the redesign and a filter on
  // the current checkout is a combination no session can satisfy — and the pair would be
  // read as a finding ("on the current checkout, nobody looked at Confirm purchase") over
  // the other version's figures. It happens the moment a reader who arrived from an area
  // picks the other version, so the area is the half that goes: the version is what they
  // just asked for, and the area was a filter they carried in.
  const mismatched = found !== null && named && found.variant !== variant;
  if (mismatched) unknown.push(AOI_PARAM);
  const aoi = mismatched ? null : found;

  return {
    filter: {
      variant: named ? variant : null,
      outcome: isOutcomeStatus(outcome) ? outcome : null,
      aoiId: aoi?.id ?? null,
      segment: inAudience ? segment : null,
      step: endedOn?.id ?? null,
    },
    aoi,
    endedOn,
    unknown,
  };
}

/** Whether the list is narrowed at all — what decides the counts line and the empty state. */
export function isFiltered(filter: ScreenFilter): boolean {
  return [filter.variant, filter.outcome, filter.aoiId, filter.segment, filter.step].some(
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
 * Which view the URL asks for. Anything other than `rows` — absent, empty, a word from a
 * stale link — is the grid, because the grid is the default and a view nobody asked for is
 * not a reason to show a reader nothing.
 */
export function isRowsView(query: URLSearchParams): boolean {
  return query.get(VIEW_PARAM) === ROWS_VIEW;
}

/**
 * The same screen in the other view, **with every filter kept**: that is the whole promise
 * of the switch (`docs/FLOW.md` section 14.2). The grid carries no `view` at all, so
 * switching to it deletes the parameter rather than spelling a second word for the default.
 */
export function withView(query: URLSearchParams, rows: boolean): URLSearchParams {
  const next = new URLSearchParams(query);
  if (rows) next.set(VIEW_PARAM, ROWS_VIEW);
  else next.delete(VIEW_PARAM);
  return next;
}

/** `?outcome=success&view=rows`, as a link's `to` takes it: the empty query is no query. */
export function search(query: URLSearchParams): string {
  const written = query.toString();
  return written === '' ? '' : `?${written}`;
}

/**
 * The grid's showing line, as `#screen-grid` prints it: `Showing 1–8 of 100 · newest first`.
 *
 * The range is the tiles on screen and the total is how many the filter leaves, so the line
 * answers the paging question — how much of this am I looking at — and not a question about
 * the site. The order is the run's manifest read backwards (`SessionsGrid`), which is what
 * makes *newest first* a fact rather than a word: `sessionIds` is the order the test ran
 * them, so its last entry is the person recorded most recently.
 *
 * An en dash and not a hyphen, as the prototype writes it.
 */
export function showingLine(shown: number, total: number): string {
  if (total === 0) return 'Showing none of 0 · newest first';
  return `Showing 1–${Math.min(shown, total)} of ${total} · newest first`;
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
