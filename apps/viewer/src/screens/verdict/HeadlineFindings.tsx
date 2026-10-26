import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { useFindings } from '@/shell/useRun';
import { evidenceUrl } from './evidenceLink';
import type { FindingItem } from './evidenceLink';
import { Finding } from './Finding';
import styles from './finding.module.css';

/**
 * *What to fix first*: the findings the verdict named, at most three, in its order.
 *
 * The three are **the pipeline's decision**, not this screen's: `verdict.headlineFindingIds`
 * names them, and this section looks each one up by id. It does not rank, re-sort or
 * filter, so changing a finding's `rank` without changing that list changes nothing here
 * (`docs/FLOW.md` section 6). The cap is the contract's own — the whole list is one click
 * deeper, on the Score breakdown screen, which reuses the same `Finding` component.
 *
 * The `.section` of `#screen-verdict` in `docs/design/prototype.html`: a heading, a lede,
 * the list, and the link out to every finding there is.
 */

/** At most three findings reach this screen, whatever the verdict names. */
const HEADLINE_CAP = 3;

const lede = (count: number): string =>
  count === 1
    ? 'The thing that cost you the most. Open it to see the people behind it.'
    : `The ${count === 2 ? 'two' : 'three'} things that cost you the most, in order. Open one to see the people behind it.`;

const allFindings = (total: number): string =>
  total === 1
    ? 'See the one finding and the full score breakdown →'
    : `See all ${total} findings and the full score breakdown →`;

export function HeadlineFindings({ run }: { run: Run }) {
  const state = useFindings(run.runId);

  return (
    <div className="section" data-section="headline-findings">
      <h2>What to fix first</h2>
      {state.status === 'loading' && <LoadingFindings />}
      {state.status === 'unreadable' && (
        <p className="lede">The findings for this test could not be read: {state.problem}.</p>
      )}
      {state.status === 'ready' && <ReadyFindings run={run} findings={state.findings.findings} />}
    </div>
  );
}

/** The list before it has arrived: the space it will take, and no claim about what is in it. */
function LoadingFindings() {
  return (
    <>
      {/* A `div` rather than a `p`: `Skeleton` is itself a `div`, which a paragraph cannot
          hold, and `.section > .lede` styles whichever element carries the class. */}
      <div className="lede">
        <Skeleton className={styles.loadingLede} />
      </div>
      <div
        className={styles.findings}
        aria-busy="true"
        role="status"
        aria-label="Loading the findings"
      >
        {[0, 1, 2].map((slot) => (
          <Skeleton className={styles.loading} key={slot} />
        ))}
      </div>
    </>
  );
}

function ReadyFindings({ run, findings }: { run: Run; findings: readonly FindingItem[] }) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const named = run.verdict.headlineFindingIds;
  // The verdict's own order, its own choice, and never more than three of them. The cap is
  // applied to the findings that were *found*, so an id naming nothing does not spend one
  // of the three places and quietly cost the reader a finding that is on disk.
  const headline = named
    .map((id) => byId.get(id))
    .filter((finding): finding is FindingItem => finding !== undefined)
    .slice(0, HEADLINE_CAP);
  const variantNames = new Map(run.variants.map((variant) => [variant.id, variant.name]));
  const total = findings.length;

  if (headline.length === 0) {
    return (
      <>
        <p className="lede">
          {/* Named findings that are not in the findings file are a hole in the run, not an
              editorial choice: saying the verdict led with nothing would be a claim about a
              test whose two files disagree. */}
          {named.length > 0
            ? `This test names ${named.length === 1 ? 'a finding' : `${named.length} findings`} to lead with that its findings file does not hold.`
            : total === 0
              ? 'This test turned up nothing to fix on either version of your checkout.'
              : 'No finding was serious enough for this test to lead with.'}
        </p>
        {total > 0 && <AllFindingsLink runId={run.runId} total={total} />}
      </>
    );
  }

  return (
    <>
      <p className="lede">{lede(headline.length)}</p>
      <div className={styles.findings}>
        {headline.map((finding, position) => (
          <Finding
            finding={finding}
            href={evidenceUrl(run.runId, finding.evidence_link)}
            key={finding.id}
            rank={position + 1}
            variantName={finding.variant === null ? null : variantNames.get(finding.variant)}
          />
        ))}
      </div>
      <AllFindingsLink runId={run.runId} total={total} />
    </>
  );
}

/** The way out to the rest: the full list lives on the Score breakdown screen. */
function AllFindingsLink({ runId, total }: { runId: string; total: number }) {
  return (
    <p className={`lede ${styles.allFindings}`}>
      <Link to={paths.breakdown(runId)}>{allFindings(total)}</Link>
    </p>
  );
}
