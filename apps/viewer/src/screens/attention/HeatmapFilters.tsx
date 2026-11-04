import { Toggle } from '@/components/ui/toggle';
import { isOutcomeStatus, outcomeWords } from '@/session';
import { peopleShown } from './attentionWording';
import { ALL_OPTION, outcomeOptions, segmentOptions } from './screenSlices';
import type { FilterOption } from './screenSlices';
import type { AttentionSelection, HeatmapOverlay } from './useAttentionSelection';
import type { ScreenFiguresView } from './useScreenFigures';
import { OVERLAY_LAYERS } from './stage/overlayLayers';
import styles from './attentionPage.module.css';

/**
 * The control row of `#screen-heatmaps`: the overlay strip, the outcome strip, the segment
 * strip, and the `.microlabel` line stating which people are being shown.
 *
 * **Three strips and one sentence**, and the sentence is the important half. The strips say
 * what was pressed; the line says what the composition amounts to — the prototype writes it
 * *"Clicks of the 41 people who gave up · phone · the 7 our automation broke are excluded"*,
 * and this one reads *"Clicks of 8 people · Abandoned · mobile · in a hurry · the 2 our
 * automation broke are excluded"* over the committed run. Either way a reader looking at a
 * heatmap can tell, without working it out, whose heatmap it is.
 * That the automation failures are not among them is part of the same sentence and not a
 * footnote: a figure that quietly averaged our own broken sessions would be the one
 * dishonest thing this screen could do (`docs/FLOW.md` section 11).
 *
 * Every count on every button is the aggregate's own: each option carries the `sessionCount`
 * and the words of the slice that narrows to it (`screenSlices.ts`). The two strips' counts
 * are run-wide and do not narrow each other, which is what the prototype draws — *All 93 ·
 * Gave up 41* beside *Phone 67 · Desktop 26* — and what the line above the stage then
 * resolves into one statement.
 *
 * The overlay strip and the Overlays panel beside the stage are **two renderings of one
 * state** (decision 134): both read `?overlay=`, so they cannot disagree about what is on
 * the page. Pressing an overlay here selects that one alone, which is what a strip of three
 * means and what a citation naming one overlay opens on; the panel's switches then add and
 * remove them one at a time.
 */

export interface HeatmapFiltersProps {
  readonly selection: AttentionSelection;
  readonly screen: ScreenFiguresView;
}

export function HeatmapFilters({ selection, screen }: HeatmapFiltersProps) {
  const { aggregate } = screen;

  return (
    <div className={styles.controls} data-section="heatmap-filters">
      <OverlayStrip selection={selection} />

      {/* No aggregate, no filters: the two strips are the slices of a file this run has
          none of, and a strip of buttons that narrow nothing is not a control. The line
          beside them still states who is being shown, from the run's own figures. */}
      {aggregate === null ? null : (
        <>
          <FilterStrip
            label="Outcome"
            section="outcome"
            options={outcomeOptions(aggregate)}
            chosen={selection.outcome}
            onChoose={selection.setOutcome}
          />
          <FilterStrip
            label="Segment"
            section="segment"
            options={segmentOptions(aggregate)}
            chosen={selection.segment}
            onChoose={selection.setSegment}
          />
        </>
      )}

      <span className="grow" />
      <span className="microlabel" data-section="people-shown">
        {peopleShown({
          overlays: selection.overlays.map(overlayLabel),
          outcome: outcomeSaid(selection.outcome),
          segment: selection.segment,
          sessionCount: screen.sessionCount,
          scoredSessionCount: screen.scoredSessionCount,
          excludedAutomationFailures: screen.excludedAutomationFailures,
        })}
      </span>
    </div>
  );
}

/** What an overlay is called in a sentence: the registry's label, not the URL's word. */
const overlayLabel = (overlay: HeatmapOverlay): string =>
  OVERLAY_LAYERS.find((layer) => layer.overlay === overlay)?.label ?? overlay;

/**
 * How the outcome reads in the line above the stage: the product's own word for the status.
 *
 * Not the strip button's label, which carries a count: the line states the count once, of
 * the composition, and `Clicks of 8 people · Gave up 8` would say eight twice about two
 * different populations. A value that is not one of the four statuses is passed through, so
 * a link asking for something this product has no word for says what it asked for.
 */
const outcomeSaid = (outcome: string | null): string | null =>
  outcome === null ? null : isOutcomeStatus(outcome) ? outcomeWords(outcome).label : outcome;

/**
 * The overlay strip: three states of one view, so three `aria-pressed` buttons.
 *
 * Pressing one draws that overlay alone. Pressing the one already alone on the page is not
 * nothing — it is the only way back from two overlays to one — so unlike the version switch
 * it is not short-circuited; what it writes is the URL it already has, which React Router
 * replaces rather than pushes.
 */
function OverlayStrip({ selection }: { selection: AttentionSelection }) {
  const named = OVERLAY_LAYERS.filter((layer) => layer.overlay !== undefined);

  return (
    <div className={styles.seg} role="group" aria-label="Overlay" data-section="overlay-strip">
      {named.map((layer) => {
        const overlay = layer.overlay as HeatmapOverlay;
        return (
          <Toggle
            key={overlay}
            data-overlay={overlay}
            pressed={selection.overlays.includes(overlay)}
            onPressedChange={() => {
              selection.setOverlays([overlay]);
            }}
          >
            {layer.label}
          </Toggle>
        );
      })}
    </div>
  );
}

/**
 * One filter strip: every option the aggregate sliced, each with its own count.
 *
 * `All` is a value rather than an absence here because a button needs one; what reaches the
 * URL is still an absence, which is what `setOutcome(null)` writes. An option the aggregate
 * has no slice for is not in this list at all — the aggregate stores no row for a filter
 * nobody falls in — so pressing a button always lands on people, and the composition of two
 * buttons is the thing that can land on none.
 */
function FilterStrip({
  label,
  section,
  options,
  chosen,
  onChoose,
}: {
  label: string;
  section: string;
  options: readonly FilterOption[];
  chosen: string | null;
  onChoose: (value: string | null) => void;
}) {
  if (options.length <= 1) return null;

  return (
    <div className={styles.seg} role="group" aria-label={label} data-section={`${section}-strip`}>
      {options.map((option) => {
        const isAll = option.value === ALL_OPTION;
        return (
          <Toggle
            key={option.value}
            data-filter={option.value}
            pressed={isAll ? chosen === null : chosen === option.value}
            onPressedChange={() => {
              onChoose(isAll ? null : option.value);
            }}
          >
            {option.label}
          </Toggle>
        );
      })}
    </div>
  );
}
