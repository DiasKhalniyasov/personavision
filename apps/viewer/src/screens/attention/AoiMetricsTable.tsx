import { Link } from 'react-router';
import type { MouseEvent, ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { sessionsWithArea } from '@/shell/paths';
import {
  areaSource,
  elapsedSeconds,
  firstFixationDuration,
  lookedAtShare,
  medianCaveat,
  neverFixatedLabel,
  neverFixatedProblem,
  noFiguresRecorded,
  notPresentInVariant,
  unknownAreaProblem,
} from './attentionWording';
import type { Aoi, AttentionArea, AttentionAreas } from './useAttentionAreas';
import { useAttentionSelection } from './useAttentionSelection';
import styles from './aoiMetricsTable.module.css';
import isolate from './isolatedArea.module.css';

/**
 * The "Areas of interest" section of `#screen-attention`: the numbers behind the heatmap,
 * and the accessible representation of it.
 *
 * The overlays say *where* the audience looked; this table is the same thing said in
 * figures, and for a reader who cannot see a heatmap it is the only form of it there is.
 * That is what its caption claims, and it is why the table is not an optional detail below
 * the fold: the six columns `docs/FLOW.md` section 3 names are the evidence the screen
 * exists to show.
 *
 * Nothing here is computed. Every figure is the pipeline's own `aoiMetrics` row, joined to
 * its area by `useAttentionAreas`, and every word is `attentionWording.ts`'s — so the table,
 * the isolate caption and a finding can never read differently about the same area.
 *
 * Three things this table will not do, each because the alternative misleads:
 *
 * - An area nobody ever fixated reads `never` and `0%`, never `0 ms` and never a blank. A
 *   fast first look and no look at all are opposite findings and must never share a cell.
 * - A row whose two halves of "never" disagree prints no figure at all, and says which area
 *   the artifact is wrong about. Either figure would be a claim the test did not make.
 * - An area this version does not have keeps its row and says so, and figures naming no
 *   area keep theirs. A row quietly missing reads as a zero nobody wrote down.
 *
 * Clicking a row isolates that area, and clicking the isolated row again shows every area
 * once more. The state of it is not held here: it is `?aoi=` in the URL, read and written
 * through `useAttentionSelection`, so the stage, this table's selected row and the caption
 * under the stage are three readings of one fact and a reload keeps all three. A reader
 * with a keyboard isolates through the area's own name, which is a real button rather than
 * a handler on a cell, and leaves the row through the link, which is a real anchor.
 *
 * There is no loading state here, and none to invent: every figure the table draws is the
 * run's own, and `AttentionPage` renders nothing at all until the run has been read. So the
 * section is never mounted without its figures, the headers never stand over a region that
 * is waiting for one, and nothing on it moves when an unrelated read settles.
 */

/** The nine columns, in the order the prototype's `thead` draws them. */
const COLUMNS = [
  'Area of interest',
  'Source',
  'Time to first fixation',
  'First fixation',
  'Total dwell',
  'Fixations',
  'Revisits',
  'Looked at it',
] as const;

/** Every column a reader compares down its own column, which is the six metrics. */
const FIGURES: ReadonlySet<string> = new Set(COLUMNS.slice(2));

/** Nine: the eight named columns and the unnamed one the link sits in. */
const ALL_COLUMNS = COLUMNS.length + 1;

/** How many columns a stated fault spans when the area's own two cells still stand. */
const AFTER_THE_AREA = ALL_COLUMNS - 2;

export interface AoiMetricsTableProps {
  readonly runId: string;
  /** The version the table is about, as the URL names it. */
  readonly variant: string;
  /** The areas of this version's step, joined to their figures by `useAttentionAreas`. */
  readonly areas: AttentionAreas;
}

export function AoiMetricsTable({ runId, variant, areas }: AoiMetricsTableProps) {
  const { aoi: isolatedAoiId, setAoi } = useAttentionSelection();
  // Clicking the area already isolated clears the isolation: the row is a switch, and the
  // way back to every area is the row the reader has their pointer on.
  const toggle = (aoiId: string) => {
    setAoi(isolatedAoiId === aoiId ? null : aoiId);
  };
  // What this step holds, and what the artifact is wrong about, are counted apart.
  //
  // Figures naming no area have no step to belong to, so they are stated wherever the
  // reader happens to be. Folding them into this step's own count would mean a step that
  // really has nothing of its own stopped saying so — the honest sentence replaced by a
  // nine-column table holding one upstream fault. Both are true here, and both are said.
  // One row per id, however many `aoiMetrics` rows carry it.
  const onThisStep = areas.areas.length + areas.presentOnOtherVariantOnly.length;
  const orphans = [...new Set(areas.unknownMetricAoiIds)];

  return (
    <div className="section" data-section="areas-of-interest">
      <h2>Areas of interest</h2>
      <p className="lede">
        One row per area of the page. Click a row to isolate it, or open the people who looked at
        it. Boundaries come from the page&rsquo;s own markup where it has any, and from image
        segmentation where it does not.
      </p>

      {onThisStep === 0 ? (
        <p className="notice" role="status" data-section="no-areas">
          This test marked no areas of interest on this step of variant {variant}, so there are no
          figures to show for it.
        </p>
      ) : null}

      {onThisStep + orphans.length === 0 ? null : (
        // The one scroll region of this section, and a reader with no pointer has to be able
        // to reach it: nine columns do not fit a phone, and the column that goes off the
        // edge is the share of the audience who looked at the area at all.
        <div
          className={styles.tablewrap}
          tabIndex={0}
          role="region"
          aria-label="Areas of interest and their figures"
        >
          <Table>
            <TableCaption className="sr-only">
              The figures behind the heatmap, scanpath and area overlays above: one row per area of
              interest on this step of this version, and the accessible equivalent of those
              overlays.
            </TableCaption>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => (
                  <TableHead
                    key={column}
                    className={FIGURES.has(column) ? styles.figure : undefined}
                  >
                    {column}
                  </TableHead>
                ))}
                <TableHead>
                  {/* The prototype leaves this header empty. A table header with no name is
                      one a screen reader announces as nothing at all, so the name is here
                      and only the sighted layout is empty. */}
                  <span className="sr-only">The people who looked at it</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {areas.areas.map((area) => (
                <AreaRow
                  key={area.aoi.id}
                  runId={runId}
                  area={area}
                  selected={area.aoi.id === isolatedAoiId}
                  onIsolate={toggle}
                />
              ))}
              {areas.presentOnOtherVariantOnly.map((aoi) => (
                <NotHereRow key={`elsewhere-${aoi.id}`} aoi={aoi} variant={variant} />
              ))}
              {orphans.map((aoiId) => (
                <UnknownAreaRow key={`unknown-${aoiId}`} aoiId={aoiId} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="footnote">{medianCaveat()}</p>
    </div>
  );
}

/** What every row of a real area of this step is given, so that each of them isolates. */
interface Isolating {
  /** Whether this is the area the screen is isolated to. */
  readonly selected: boolean;
  /** Isolate this area, or clear the isolation when it is the one already isolated. */
  onIsolate(aoiId: string): void;
}

/** One area of this version's step: its boundary, its six figures, and its people. */
function AreaRow({
  runId,
  area,
  selected,
  onIsolate,
}: { runId: string; area: AttentionArea } & Isolating) {
  const { aoi, metric } = area;
  const isolating = { selected, onIsolate };

  if (metric === null) {
    return (
      <AreaFault aoi={aoi} problem={noFiguresRecorded(aoi.id)} kind="no-figures" {...isolating} />
    );
  }

  const problem = neverFixatedProblem(metric);
  if (problem !== null) {
    return <AreaFault aoi={aoi} problem={problem} kind="inconsistent" {...isolating} />;
  }

  // Narrowed here rather than through `isNeverFixated`, which a type cannot see through:
  // the predicate is published for the isolate caption and a finding, and this is the one
  // place that also needs the number the absence of `null` leaves behind.
  const firstFixationAt = metric.timeToFirstFixationMs;
  const firstFixationFor = firstFixationDuration(metric.firstFixationDurationMs);

  return (
    <IsolatingRow aoi={aoi} selected={selected} onIsolate={onIsolate}>
      <TableCell className="faint">{areaSource(aoi)}</TableCell>
      <TableCell className={styles.figure}>
        {firstFixationAt === null ? (
          <span className={styles.never}>{neverFixatedLabel()}</span>
        ) : (
          elapsedSeconds(firstFixationAt)
        )}
      </TableCell>
      <TableCell className={styles.figure}>
        {metric.firstFixationDurationMs === null ? (
          <span className="faint">{firstFixationFor}</span>
        ) : (
          firstFixationFor
        )}
      </TableCell>
      <TableCell className={styles.figure}>{elapsedSeconds(metric.totalDwellMs)}</TableCell>
      <TableCell className={styles.figure}>{metric.fixationCount}</TableCell>
      <TableCell className={styles.figure}>{metric.revisits}</TableCell>
      <TableCell className={styles.figure}>
        {metric.lookedAtShare === 0 ? (
          <span className={styles.never}>{lookedAtShare(0)}</span>
        ) : (
          lookedAtShare(metric.lookedAtShare)
        )}
      </TableCell>
      <TableCell className={styles.door}>
        <Link to={sessionsWithArea(runId, aoi.variant, aoi.id)}>
          sessions &rarr;
          <span className="sr-only"> who looked at {aoi.label}</span>
        </Link>
      </TableCell>
    </IsolatingRow>
  );
}

/**
 * A row that isolates its own area: the switch, and what the switch is saying.
 *
 * The whole row is the pointer target the prototype draws, and the area's name inside it is
 * the same switch for a keyboard — a real button, whose activation reaches the row as the
 * click it already handles. Only the row carries the state a reader is told about twice:
 * `aria-selected` for the row they are on, `aria-pressed` for the control they just
 * operated. A click on the link out of the row is the link's, not the row's.
 */
function IsolatingRow({
  aoi,
  selected,
  onIsolate,
  children,
  fault,
}: { aoi: Aoi; children: ReactNode; fault?: string } & Isolating) {
  return (
    <TableRow
      data-aoi-row={aoi.id}
      data-area-fault={fault}
      className={isolate.row}
      aria-selected={selected}
      onClick={(event: MouseEvent<HTMLTableRowElement>) => {
        if ((event.target as HTMLElement).closest('a') !== null) return;
        onIsolate(aoi.id);
      }}
    >
      <TableCell>
        <button type="button" className={isolate.isolate} aria-pressed={selected}>
          {aoi.label}
        </button>
      </TableCell>
      {children}
    </TableRow>
  );
}

/**
 * An area whose figures cannot be printed, with the reason in their place.
 *
 * The area and its source still stand, because neither of them is in doubt: what the run is
 * wrong about is the numbers, and naming the area is how a reader finds the row again.
 */
function AreaFault({
  aoi,
  problem,
  kind,
  selected,
  onIsolate,
}: { aoi: Aoi; problem: string; kind: string } & Isolating) {
  return (
    <IsolatingRow aoi={aoi} selected={selected} onIsolate={onIsolate} fault={kind}>
      <TableCell className="faint">{areaSource(aoi)}</TableCell>
      <Stated span={AFTER_THE_AREA}>{problem}</Stated>
    </IsolatingRow>
  );
}

/** An area the other version has and this one does not: the comparison, stated. */
function NotHereRow({ aoi, variant }: { aoi: Aoi; variant: string }) {
  return (
    <TableRow data-aoi-row={aoi.id} data-not-present={variant}>
      <TableCell>{aoi.label}</TableCell>
      <TableCell className="faint">{areaSource(aoi)}</TableCell>
      <Stated span={AFTER_THE_AREA}>{notPresentInVariant(variant)}</Stated>
    </TableRow>
  );
}

/** Figures naming an area this run has no entry for anywhere. */
function UnknownAreaRow({ aoiId }: { aoiId: string }) {
  return (
    <TableRow data-area-fault="unknown-area">
      <Stated span={ALL_COLUMNS}>{unknownAreaProblem(aoiId)}</Stated>
    </TableRow>
  );
}

/** What a row says instead of a number. */
function Stated({ span, children }: { span: number; children: ReactNode }) {
  return (
    <TableCell className="faint" colSpan={span}>
      {children}
    </TableCell>
  );
}
