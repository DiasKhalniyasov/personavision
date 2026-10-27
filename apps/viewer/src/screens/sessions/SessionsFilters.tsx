import { useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { outcomeWords } from '@/session';
import type { OutcomeStatus, SessionFilter } from '@/session';
import { countsLine, isScored, sessionCounts } from './counts';
import {
  ALL,
  AOI_PARAM,
  OUTCOME_PARAM,
  VARIANT_PARAM,
  aoiLabel,
  isFiltered,
  shownOfLine,
  withFilter,
} from './filters';
import type { Aoi } from './filters';
import styles from './sessionsFilters.module.css';

/**
 * The control row of `#screen-sessions`: the version segment, the outcome segment, the
 * area-of-interest chip a reader arrived with, and the counts line.
 *
 * Every control **writes the URL** and reads nothing back out of itself: a filtered list is
 * a link that survives a reload and can be shared (`docs/FLOW.md` section 3), so there is
 * no state here for a reload to lose. Picking an option replaces one parameter and leaves
 * the others, which is what makes the filters combine.
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
  filter,
  aoi,
  shown,
}: {
  run: Run;
  filter: SessionFilter;
  aoi: Aoi | null;
  /** How many of the run's sessions the current filter shows. */
  shown: number;
}) {
  const [query, setQuery] = useSearchParams();

  const pick = (param: string, value: string): void => {
    setQuery(withFilter(query, param, value));
  };

  return (
    <>
      <Segment
        label="Filter by version"
        active={filter.variant ?? ALL}
        onPick={(value) => {
          pick(VARIANT_PARAM, value);
        }}
        options={[
          { value: ALL, label: 'All variants' },
          ...run.variants.map((variant) => ({ value: variant.id, label: variant.id })),
        ]}
      />
      <Segment
        label="Filter by outcome"
        active={filter.outcome ?? ALL}
        onPick={(value) => {
          pick(OUTCOME_PARAM, value);
        }}
        options={[
          { value: ALL, label: 'All outcomes' },
          ...OUTCOMES.map((outcome) => ({ value: outcome, label: outcomeWords(outcome).label })),
        ]}
      />
      {aoi === null ? null : (
        <button
          type="button"
          className={styles.chip}
          aria-pressed="true"
          onClick={() => {
            pick(AOI_PARAM, ALL);
          }}
        >
          Fixated: {aoiLabel(aoi)}{' '}
          <span aria-hidden="true" className="faint">
            ×
          </span>
        </button>
      )}
      <span className="grow" />
      <span className="microlabel">
        {isFiltered(filter)
          ? shownOfLine(shown, run.sessionIds.length)
          : countsLine(sessionCounts(run), isScored(run))}
      </span>
    </>
  );
}

interface Option {
  readonly value: string;
  readonly label: string;
}

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
      // again is not a filter — it leaves the list exactly as the reader is seeing it.
      onValueChange={(next: string[]) => {
        onPick(next.find((value) => value !== active) ?? active);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
