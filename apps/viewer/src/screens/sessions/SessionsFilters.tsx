import { useSearchParams } from 'react-router';
import type { ReactNode } from 'react';
import type { Run } from '@personavision/contract';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { outcomeWords } from '@/session';
import type { OutcomeStatus } from '@/session';
import { countsLine, isScored, outcomeSlice, sessionCounts, tally } from './counts';
import {
  ALL,
  AOI_PARAM,
  OUTCOME_PARAM,
  SEGMENT_PARAM,
  STEP_PARAM,
  VARIANT_PARAM,
  aoiLabel,
  isFiltered,
  runSegments,
  showingLine,
  shownOfLine,
  withFilter,
} from './filters';
import type { Aoi, ScreenFilter, Step } from './filters';
import styles from './sessionsFilters.module.css';
import type { SessionRowState } from './useSessionRows';

/**
 * The control row of both Sessions views: three segmented controls, a chip for every other
 * filter the URL carries, and the line that says how much of the test is on screen.
 *
 * Every control **writes the URL** and reads nothing back out of itself: a filtered list is
 * a link that survives a reload and can be shared (`docs/FLOW.md` section 3), so there is
 * no state here for a reload to lose. Picking an option replaces one parameter and leaves
 * the others, which is what makes the filters combine — and what makes them survive the
 * switch between the grid and the rows, which is one more parameter of the same query.
 *
 * **Each view draws its own three and chips the rest.** The grid's three are the ones
 * `docs/FLOW.md` section 14.2 names — outcome, segment and failure step — and the rows'
 * three are the version, the outcome and the area of interest of section 3. A filter the
 * other view set, or one an evidence link carried in, is still applied and is drawn as a
 * dismissible chip: a narrowing with no control to clear it would be a list a reader cannot
 * widen again.
 *
 * **The outcome counts are the aggregate's** (`counts.ts`), which is why they are on the
 * options at all: `scores[].outcomeCounts` is a figure the pipeline stored, per version, so
 * the count beside *Success* is right before a single session has been read and cannot
 * drift from the Verdict's. The segment and the step have no such slice, so theirs are
 * tallied over the sessions and stated only once every one of them is in — a count over
 * half a run is a figure that would change under the reader while they looked at it.
 *
 * The segments are the registry's `toggle-group` in its **multiple** mode, not its single
 * one: a single-select group is a radio group to a screen reader, and these are the
 * prototype's pressed buttons, which is what `aria-pressed` says. Only one option of a
 * group is ever on, and the "All …" option is how a reader widens the list again — so an
 * already-pressed option cannot be unpressed into a filter nobody asked for.
 */

/** The four outcomes, in the prototype's order, with the Automation failure #23 adds. */
const OUTCOMES: readonly OutcomeStatus[] = ['success', 'abandoned', 'failed', 'automation_failure'];

export function SessionsFilters({
  run,
  rows,
  filter,
  aoi,
  endedOn,
  grid,
  shown,
  onPage,
  read,
}: {
  run: Run;
  /** Every row of the run, for the segment and step tallies. */
  rows: readonly SessionRowState[];
  filter: ScreenFilter;
  aoi: Aoi | null;
  endedOn: Step | null;
  /** Which view is on screen: the grid's three controls, or the rows'. */
  grid: boolean;
  /**
   * How many of the run's sessions the current filter shows, or `null` while sessions the
   * filter has not been able to judge yet are still being read. Then the line states the
   * run's own totals, which are true at every moment of the reading.
   */
  shown: number | null;
  /** How many tiles the grid has on screen, for its showing line. */
  onPage: number;
  /** Whether every session has been read, which is what lets a tally be stated at all. */
  read: boolean;
}) {
  const [query, setQuery] = useSearchParams();

  const pick = (param: string, value: string): void => {
    setQuery(withFilter(query, param, value));
  };
  const clear =
    (param: string): (() => void) =>
    () => {
      pick(param, ALL);
    };

  const slice = outcomeSlice(run, filter.variant);
  const outcomes = {
    label: 'Filter by outcome',
    param: OUTCOME_PARAM,
    active: filter.outcome ?? ALL,
    options: [
      { value: ALL, label: 'All outcomes', count: slice?.all ?? null },
      ...OUTCOMES.map((outcome) => ({
        value: outcome,
        label: outcomeWords(outcome).label,
        count: slice?.[outcome] ?? null,
      })),
    ],
  };

  const segments = tally(
    rows.map((state) => (state.status === 'ready' ? state.row.segment : null)),
  );
  const steps = tally(
    rows.map((state) => (state.status === 'ready' ? state.row.endedOn.step : null)),
  );
  const tallied = (counts: ReadonlyMap<string, number>, key: string): number | null =>
    read ? (counts.get(key) ?? 0) : null;

  return (
    <>
      {grid ? (
        <>
          <Segment
            {...outcomes}
            onPick={(value) => {
              pick(outcomes.param, value);
            }}
          />
          <Segment
            label="Filter by segment"
            active={filter.segment ?? ALL}
            onPick={(value) => {
              pick(SEGMENT_PARAM, value);
            }}
            options={[
              { value: ALL, label: 'Every segment', count: run.sessionIds.length },
              ...runSegments(run).map((segment) => ({
                value: segment,
                label: segment,
                count: tallied(segments, segment),
              })),
            ]}
          />
          <Segment
            label="Filter by the step it ended on"
            active={filter.step ?? ALL}
            onPick={(value) => {
              pick(STEP_PARAM, value);
            }}
            options={[
              { value: ALL, label: 'Any step', count: run.sessionIds.length },
              ...run.steps.map((step) => ({
                value: step.id,
                label: step.label,
                count: tallied(steps, step.id),
              })),
            ]}
          />
          {filter.variant === null ? null : (
            <Chip onDismiss={clear(VARIANT_PARAM)}>Version: {filter.variant}</Chip>
          )}
          {aoi === null ? null : <Chip onDismiss={clear(AOI_PARAM)}>Fixated: {aoiLabel(aoi)}</Chip>}
        </>
      ) : (
        <>
          <Segment
            label="Filter by version"
            active={filter.variant ?? ALL}
            onPick={(value) => {
              pick(VARIANT_PARAM, value);
            }}
            options={[
              { value: ALL, label: 'All variants', count: null },
              ...run.variants.map((variant) => ({
                value: variant.id,
                label: variant.id,
                count: null,
              })),
            ]}
          />
          <Segment
            {...outcomes}
            // The rows are read down a column of figures rather than scanned, and the
            // prototype's own `#screen-sessions` draws its options bare; the counts belong
            // to the grid, where an option is how a reader decides what to look at.
            options={outcomes.options.map((option) => ({ ...option, count: null }))}
            onPick={(value) => {
              pick(outcomes.param, value);
            }}
          />
          {aoi === null ? null : <Chip onDismiss={clear(AOI_PARAM)}>Fixated: {aoiLabel(aoi)}</Chip>}
          {filter.segment === null ? null : (
            <Chip onDismiss={clear(SEGMENT_PARAM)}>Segment: {filter.segment}</Chip>
          )}
          {endedOn === null ? null : (
            <Chip onDismiss={clear(STEP_PARAM)}>Ended on: {endedOn.label}</Chip>
          )}
        </>
      )}
      <span className="grow" />
      <span className="microlabel">
        {grid && shown !== null
          ? showingLine(onPage, shown)
          : isFiltered(filter) && shown !== null
            ? shownOfLine(shown, run.sessionIds.length)
            : countsLine(sessionCounts(run), isScored(run))}
      </span>
    </>
  );
}

interface Option {
  readonly value: string;
  readonly label: string;
  /** The figure beside the word, or `null` for an option with no figure to state yet. */
  readonly count: number | null;
}

/** `Success 38`, as `#screen-grid` prints it: the word, then what it leaves. */
const optionLabel = (option: Option): string =>
  option.count === null ? option.label : `${option.label} ${option.count}`;

function Segment({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: readonly Option[];
  active: string;
  onPick: (value: string) => void;
}) {
  return (
    <ToggleGroup
      type="multiple"
      aria-label={label}
      className={styles.seg}
      value={[active]}
      // One option of the group is on at a time, so the pick is whichever value the group
      // came back with that was not already the active one. Pressing the active option
      // again comes back empty — it is not a filter and not a navigation either, so it
      // leaves the list and the history exactly as the reader is seeing them.
      onValueChange={(next: string[]) => {
        const picked = next.find((value) => value !== active);
        if (picked !== undefined) onPick(picked);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {optionLabel(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * A filter this view has no segmented control for, drawn so that it can be seen and
 * dismissed. It is a button because it does something; the prototype's pressed chip is the
 * only state it has, because an unpressed one is a chip that is not there.
 */
function Chip({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <button type="button" className={styles.chip} aria-pressed="true" onClick={onDismiss}>
      {children}{' '}
      <span aria-hidden="true" className="faint">
        ×
      </span>
    </button>
  );
}
