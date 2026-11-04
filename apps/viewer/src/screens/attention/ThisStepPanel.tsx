import type { Run } from '@personavision/contract';
import { clicksOnArea } from './screenSlices';
import type { AttentionArea } from './useAttentionAreas';
import type { ScreenFiguresView } from './useScreenFigures';
import styles from './attentionPage.module.css';

/**
 * The *This screen* panel of `#screen-heatmaps`: what this screen amounts to for the people
 * the filters leave, in five readings.
 *
 * **Every one of them is read, and none is computed** — which is the whole reason this file
 * is shorter than the *This step* panel it replaces. That one took medians across the
 * sessions it had in memory; `aggregate.json` stores these five pre-sliced, so composing two
 * filters is picking a row rather than re-aggregating a hundred people in a browser. A
 * screen that re-derived them could disagree with the Summary about the same audience, which
 * `docs/adr/0001` forbids and `docs/FLOW.md` section 14 is written against.
 *
 * Two of the prototype's readings say less here than the mock does, and both deliberately:
 *
 * - *Left here* prints the stored count alone. The prototype writes *"33 · 22 of them inside
 *   20 s"*, and the aggregate carries no twenty-second figure: counting it in the browser is
 *   exactly the re-derivation this screen exists not to do (decision 135).
 * - The fifth row is *Clicks on <the primary action>*, not the prototype's *Second click on
 *   Generate*. What is stored is clicks on an area, and whether a click is a repeat depends
 *   on whether that control was already pressed to get here — true of a waiting screen, false
 *   of a cart. Printing "second click" over a count of first clicks is the mistakable number
 *   `docs/FLOW.md` section 8 forbids (decision 137).
 *
 * A figure the file does not carry reads in words. `medianMsOnIt` is `null` for a screen
 * nobody was timed on, which is not nought seconds, and the row says so.
 */

const seconds = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** A duration as this panel reads it: `41.0 s`. The pipeline's precision is not the reader's. */
export const onItFor = (ms: number): string => `${seconds.format(ms / 1000)} s`;

/**
 * The control this step was for, as `run.json` marks it.
 *
 * One area per step carries `isPrimaryAction`, and it is the one the clicks row is about:
 * *did they press the thing this screen is for, and how often*. A step that marks none — a
 * receipt has no control that advances it (decision 43) — has no such row, and the panel
 * says which area it is reading instead of implying every step has one.
 */
export const primaryArea = (areas: readonly AttentionArea[]): AttentionArea | null =>
  areas.find((area) => area.aoi.isPrimaryAction) ?? null;

export interface ThisStepPanelProps {
  readonly step: Run['steps'][number];
  /** The aggregate's figures for this screen and these filters. Every row is read here. */
  readonly screen: ScreenFiguresView;
  readonly areas: readonly AttentionArea[];
}

export function ThisStepPanel({ step, screen, areas }: ThisStepPanelProps) {
  const { figures, sessionCount } = screen;
  const primary = primaryArea(areas);
  const clicks = primary === null ? null : clicksOnArea(figures, primary.aoi.id);

  return (
    <dl className={styles.kv} data-section="this-screen">
      <dt>Reached it</dt>
      <dd className="num" data-reading="reached">
        <Figure screen={screen}>
          {figures === null || sessionCount === null
            ? null
            : `${figures.reached} of ${sessionCount}`}
        </Figure>
      </dd>

      <dt>Left here</dt>
      <dd className="num" data-reading="left-here">
        <Figure screen={screen}>
          {figures === null
            ? null
            : `${figures.leftHere} of the ${figures.reached} who reached it`}
        </Figure>
      </dd>

      <dt>Median time on it</dt>
      <dd className="num" data-reading="median-time">
        <Figure screen={screen}>
          {figures === null ? null : figures.medianMsOnIt === null ? (
            // Not nought seconds: nobody on this screen was timed on it.
            <span className="faint">nobody was timed on it</span>
          ) : (
            onItFor(figures.medianMsOnIt)
          )}
        </Figure>
      </dd>

      <dt>Scrolled past the fold</dt>
      <dd className="num" data-reading="past-fold">
        <Figure screen={screen}>
          {figures === null
            ? null
            : `${figures.scrollDepth.pastFoldSessions} of ${figures.reached}`}
        </Figure>
      </dd>

      <dt>
        {primary === null
          ? `Clicks on this screen`
          : `Clicks on ${primary.aoi.label}`}
      </dt>
      <dd className="num" data-reading="primary-clicks">
        <Figure screen={screen}>
          {figures === null ? null : primary === null ? (
            <span className="faint">
              the {step.label} screen marks no control as its primary action
            </span>
          ) : clicks === null ? (
            <span className="faint">no clicks recorded for it</span>
          ) : (
            `${clicks} of ${sessionCount ?? figures.reached} people`
          )}
        </Figure>
      </dd>
    </dl>
  );
}

/**
 * One reading, or the reason there is none.
 *
 * The five states that are not a figure are said in words, once, here: a panel of five rows
 * each inventing its own sentence for *the aggregate is still coming back* is five chances
 * to word it differently. A number is never printed that a later read would change, and
 * never a zero where the answer is that nothing was measured.
 */
function Figure({ screen, children }: { screen: ScreenFiguresView; children: React.ReactNode }) {
  switch (screen.status) {
    case 'loading':
      return <span className="faint">reading this test’s figures…</span>;
    case 'none':
      return <span className="faint">this test computed none</span>;
    case 'unreadable':
      return <span className="faint">could not be read</span>;
    case 'no-people':
      return <span className="faint">nobody matches both filters</span>;
    case 'no-screen':
      return <span className="faint">none of them reached it</span>;
    case 'ready':
      return <>{children}</>;
  }
}
