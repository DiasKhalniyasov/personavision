import type { FunnelSlice, Run } from '@personavision/contract';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  barHeights,
  clock,
  distributionAlternative,
  spreadLede,
  stepLabel,
  untimedLine,
} from './funnelWords';
import type { Distribution } from './funnelWords';
import styles from './funnel.module.css';

/**
 * *How long each screen took* — the four stored quantiles per step, and the stored bars they
 * were read off, with the median marked.
 *
 * **A distribution, and never a mean.** The pipeline stores the 25th, the median, the 75th
 * and the 90th, the bin width, every bin count and which bin the median falls in; this table
 * prints those and nothing else. No percentile is worked out here and no average is printed
 * anywhere on the screen — a mean would hide the tail, and on a hundred-session run the tail
 * is the finding.
 *
 * The bars are a drawing of the bins, so they are a single `role="img"` carrying the bins in
 * words: the four quantiles are already in the cells beside them, and the bin counts are
 * nowhere else on the screen. The dark bar is the stored `medianBin` and is never inferred
 * from the bars' own heights.
 *
 * **A step nothing was measured on has no row.** A distribution of nothing is not stored, so
 * such a step is named in a line under the table rather than drawn as four dashes or a zero.
 */

/** The columns of the prototype's table, in its order. */
const FIGURES = ['25th', 'Median', '75th', '90th'] as const;

/** One row of the table: the step's words, and the spread stored for it. */
interface TimedStep {
  readonly step: string;
  readonly label: string;
  readonly distribution: Distribution;
}

export function TimingTable({
  run,
  slice,
  markedStep,
}: {
  run: Run;
  slice: FunnelSlice;
  /** The step the URL opened on, drawn as the prototype draws the step it is about. */
  markedStep: string | null;
}) {
  const stored = new Map(slice.timing.perStep.map((row) => [row.step, row.distribution]));
  // The funnel's own order, so the rows line up with the bars above them. A distribution
  // stored for a step the funnel does not carry still gets a row rather than being dropped.
  const inFunnel = slice.funnel.map((row) => row.step);
  const order = [...inFunnel, ...[...stored.keys()].filter((step) => !inFunnel.includes(step))];
  const rows: TimedStep[] = order.flatMap((step) => {
    const distribution = stored.get(step);
    return distribution === undefined ? [] : [{ step, label: stepLabel(run, step), distribution }];
  });
  const untimed = untimedLine(
    inFunnel.filter((step) => !stored.has(step)).map((step) => stepLabel(run, step)),
  );

  return (
    <div className="section" data-funnel="timing">
      <h2>How long each screen took</h2>
      <p className="lede">{spreadLede(slice)}</p>
      {rows.length === 0 ? null : (
        <div
          className={styles.tablewrap}
          tabIndex={0}
          role="region"
          aria-label="How long each screen took"
        >
          <Table>
            <TableCaption className="sr-only">
              The time each screen cost one person: the 25th, the median, the 75th and the 90th, and
              the spread they were read off.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Screen</TableHead>
                {FIGURES.map((figure) => (
                  <TableHead key={figure} className={styles.figure}>
                    {figure}
                  </TableHead>
                ))}
                <TableHead>Spread</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.step}
                  data-step={row.step}
                  aria-current={row.step === markedStep ? 'step' : undefined}
                >
                  <TableCell>{row.step === markedStep ? <b>{row.label}</b> : row.label}</TableCell>
                  <TableCell className={styles.figure}>{clock(row.distribution.p25Ms)}</TableCell>
                  <TableCell className={styles.figure}>{clock(row.distribution.p50Ms)}</TableCell>
                  <TableCell className={styles.figure}>{clock(row.distribution.p75Ms)}</TableCell>
                  <TableCell className={styles.figure}>{clock(row.distribution.p90Ms)}</TableCell>
                  <TableCell>
                    <Spread distribution={row.distribution} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {untimed === null ? null : (
        <p className="footnote" data-funnel="untimed">
          {untimed}
        </p>
      )}
    </div>
  );
}

/** The bins, drawn — with the stored median bar dark, and the bins said in words. */
function Spread({ distribution }: { distribution: Distribution }) {
  return (
    <span
      className={styles.dist}
      role="img"
      aria-label={distributionAlternative(distribution)}
      data-funnel="spread"
    >
      {barHeights(distribution).map((height, index) => (
        <i
          // The bins are a list of numbers and nothing addresses one of them but its place.
          key={index}
          data-median={index === distribution.medianBin ? '' : undefined}
          style={{ height }}
        />
      ))}
    </span>
  );
}
