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
      <p className="lede">
        <Skeleton className={styles.loadingLede} />
      </p>
      <div className={styles.findings} aria-busy="true" aria-label="Loading the findings">
        {[0, 1, 2].map((slot) => (
          <Skeleton className={styles.loading} key={slot} />
        ))}
      </div>
    </>
  );
}

function ReadyFindings({ run, findings }: { run: Run; findings: readonly FindingItem[] }) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  // The verdict's own order, its own choice, and never more than three of them.
  const headline = run.verdict.headlineFindingIds
    .slice(0, HEADLINE_CAP)
    .map((id) => byId.get(id))
    .filter((finding): finding is FindingItem => finding !== undefined);
  const variantNames = new Map(run.variants.map((variant) => [variant.id, variant.name]));
  const total = findings.length;

  if (headline.length === 0) {
    return (
      <>
        <p className="lede">
          {total === 0
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
