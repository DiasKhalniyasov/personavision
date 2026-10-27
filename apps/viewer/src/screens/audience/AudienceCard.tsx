import { Link } from 'react-router';
import { paths } from '@/shell/paths';
import { ageWords, behaviourWords, deviceShares, listWords, NOTHING, peopleWords } from './words';
import styles from './audience.module.css';
import type { AudienceRecord } from './store';

/**
 * One audience, as `#screen-audiences` draws it: the age range and the regions, the device
 * split, the roles, how price-aware and tech-confident they are, and how many people it
 * generates. Five lines, in that order.
 *
 * The people are the store's own count — the generator's output for this audience and its
 * seed — so the card states what a test would really run on rather than echoing `size`
 * back. An audience this build cannot generate from says so in that line instead, because
 * one such record must not take the list down with it.
 */
export function AudienceCard({
  record,
  usedByLatestTest,
}: {
  record: AudienceRecord;
  /** The audience the workspace's most recent test ran for. */
  usedByLatestTest: boolean;
}) {
  const { audience } = record;
  const shares = deviceShares(audience.devices);

  return (
    <Link
      to={paths.audience(record.id)}
      className={`card ${styles.audCard}`}
      {...(usedByLatestTest ? { 'aria-current': true as const } : {})}
    >
      <span className="microlabel">
        {usedByLatestTest ? 'Used by the latest test' : 'Not used yet'}
      </span>
      <h2>{audience.name}</h2>
      <div className={styles.audFacts}>
        <span>
          <b>{ageWords(audience.ageRange)}</b>
          {' · '}
          {listWords(audience.regions, '&') || NOTHING}
        </span>
        <span>
          {shares.map((share, index) => (
            <span key={share.name}>
              {index > 0 ? ' · ' : ''}
              <b>{share.percent}%</b> {share.name}
            </span>
          ))}
        </span>
        <span>{listWords(audience.roles, 'and') || NOTHING}</span>
        <span>{behaviourWords(audience)}</span>
        <span className="faint">
          {record.issues.length > 0
            ? `No people: ${record.issues[0]?.message ?? 'this audience cannot be generated from'}`
            : `${peopleWords(record.people.length)} · seed ${String(audience.generatedFrom.seed)}`}
        </span>
      </div>
    </Link>
  );
}
