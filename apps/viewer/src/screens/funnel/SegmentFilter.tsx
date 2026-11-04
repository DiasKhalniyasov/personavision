import { Link } from 'react-router';
import type { Aggregate, FunnelSlice } from '@personavision/contract';
import { funnelLink } from '@/shell/paths';
import { scoredLine } from './funnelWords';
import styles from './funnel.module.css';

/**
 * The segment filter of `#screen-funnel`: the prototype's `.seg` group, and the line that
 * says which sessions every figure below it is over.
 *
 * **The options are the slices the pipeline stored**, in the stored order, and each one
 * carries the words the pipeline stored with it — *Every segment*, *Mobile · in a hurry 6*
 * (the owner's decision 119: the count travels with the label so two screens cannot word or
 * round one filter two ways). A segment nobody is in has no slice and therefore no button:
 * a filter over nobody is not a filter.
 *
 * **Each option is a link, not a toggle.** The filter is `?segment=` in the URL
 * (`docs/FLOW.md` section 3), built by `funnelLink` with every other link in the product, so
 * a narrowed funnel survives a reload, can be shared, and can be opened in a new window from
 * the keyboard — and the pressed option is `aria-current`, which is what the prototype's own
 * markup says. The step the reader is on travels with the filter, so switching segment keeps
 * the step a citation landed them on.
 *
 * This screen filters by segment only. The aggregate also slices by version, and the funnel
 * offers no version switch because that is the Score breakdown's comparison (the owner's
 * decision 80).
 */

export function SegmentFilter({
  runId,
  aggregate,
  slices,
  current,
  step,
}: {
  runId: string;
  aggregate: Aggregate;
  /** The segment slices this screen offers, in the aggregate's own order. */
  slices: readonly FunnelSlice[];
  /** The segment the URL is narrowed to, or `null` for the whole run. */
  current: string | null;
  /** The step the URL is on, carried into every option so a filter does not lose it. */
  step: string | null;
}) {
  return (
    <div className={styles.toggles} data-funnel="filter">
      <nav className={styles.seg} aria-label="Filter the funnel by segment">
        {slices.map((slice) => (
          <Link
            key={slice.key}
            to={funnelLink(runId, { segment: slice.segment ?? undefined, step: step ?? undefined })}
            aria-current={slice.segment === current ? 'page' : undefined}
          >
            {slice.label}
          </Link>
        ))}
      </nav>
      <span className="microlabel" data-funnel="scored">
        {scoredLine(aggregate)}
      </span>
    </div>
  );
}
