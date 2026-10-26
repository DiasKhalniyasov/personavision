import { Link } from 'react-router';
import type { FindingItem } from './evidenceLink';
import styles from './finding.module.css';

/**
 * One finding: a claim the owner of the shop could say out loud, its evidence underneath,
 * and the tags that say how bad it is, which version it is about, whose fault it is, where
 * it happened and how many people are behind it (`docs/FLOW.md` section 6).
 *
 * The `.finding` of `docs/design/prototype.html`, and **one implementation for two
 * screens**: the Verdict shows the three the verdict named, the Score breakdown shows the
 * whole list. The difference between them is which findings they are handed — never how a
 * finding looks — so nothing here reads a run, a route or a session. It is handed its
 * position, the version's own name and the URL its evidence link resolved to.
 *
 * It is a link rather than a button because activating it goes somewhere: that is what
 * makes it reachable, operable and announced by a keyboard and a screen reader without a
 * handler of its own. A finding whose evidence link names no route the table accepts is
 * rendered without that link and says so, rather than offering a click that goes nowhere.
 */

export interface FindingProps {
  finding: FindingItem;
  /** Its position in the list it is shown in, counted from 1. The caller ranks; this does not. */
  rank: number;
  /** The version's own name, as the run calls it, or `null` for a finding about the run itself. */
  variantName?: string | null;
  /** Where its evidence is, from `evidenceUrl`. `null` renders the finding without its action. */
  href: string | null;
}

/** The severity words the tokens carry a colour for. Anything else is styled as information. */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** The two version ids the tokens carry a colour for; a third reads as information. */
const VARIANT_TAGS = ['a', 'b'] as const;

const tagFor = (value: string, known: readonly string[]): string =>
  known.includes(value.toLowerCase()) ? `tag-${value.toLowerCase()}` : 'tag-info';

const people = (count: number): string => (count === 1 ? '1 person' : `${count} people`);

const text = (value: string | null | undefined): string => value?.trim() ?? '';

export function Finding({ finding, rank, variantName = null, href }: FindingProps) {
  const claim = text(finding.claim);
  const evidence = text(finding.evidence);
  // A finding the pipeline wrote without one of its two sentences is still the best
  // evidence there is for whatever it found: it is shown with what it has and marked, so
  // that a hole in the artifact is visible rather than a finding quietly missing.
  const incomplete = claim === '' || evidence === '';

  const body = (
    <>
      <span className={styles.rank}>{rank}</span>
      <span>
        {claim !== '' && <span className={styles.claim}>{claim}</span>}
        {evidence !== '' && <span className={styles.evidence}>{evidence}</span>}
        <span className={styles.meta}>
          {/* The word is the severity, beside its colour: severity is never colour alone. */}
          <span className={`tag ${tagFor(finding.severity, SEVERITIES)}`}>{finding.severity}</span>
          {finding.variant === null ? (
            <span className="tag tag-info">both versions</span>
          ) : (
            <span className={`tag ${tagFor(finding.variant, VARIANT_TAGS)}`}>
              {variantName ?? finding.variant}
            </span>
          )}
          {/* Whose fault it was, in words: a bare "product" or "automation" would leave the
              reader guessing which of the two is being blamed. */}
          {finding.attribution === 'automation' ? (
            <span className="tag tag-automation">our simulation · excluded</span>
          ) : (
            <span className="tag tag-product">your checkout</span>
          )}
          {incomplete && <span className="tag tag-info">incomplete</span>}
          <span className={styles.aoi}>
            {finding.aoiId === null ? finding.step : `${finding.step} / ${finding.aoiId}`}
          </span>
        </span>
      </span>
      <span className={styles.side}>
        <span className="microlabel">{people(finding.sessionCount)}</span>
        <span className={styles.open}>
          {href === null ? 'no page to open for this one' : 'see the evidence →'}
        </span>
      </span>
    </>
  );

  const className = styles.finding;
  if (href === null) {
    return (
      <div className={className} data-sev={finding.severity}>
        {body}
      </div>
    );
  }
  return (
    <Link className={className} data-sev={finding.severity} to={href}>
      {body}
    </Link>
  );
}
