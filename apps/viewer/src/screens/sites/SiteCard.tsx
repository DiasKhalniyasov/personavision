import { Link } from 'react-router';
import { paths } from '@/shell/paths';
import {
  agentsNoun,
  browsersNoun,
  lastCheckWords,
  lastTestWords,
  runsNoun,
  siteName,
  verificationWords,
} from './words';
import styles from './sites.module.css';
import type { SiteRecord } from '@/sites/store';

/**
 * One site, as `#screen-sites` draws it: how it stands, its address, what binds it, and the
 * test it last ran.
 *
 * **Every figure is the platform's.** `caps` arrives on the site and is printed; nothing
 * here composes, scales or defaults a number, and there is no branch anywhere in this file
 * on `verification.state` that reaches a figure. That is decision 71 as the owner settled it
 * on **2026-11-03** — _no gate on testing_ — expressed as code rather than as a comment: an
 * unverified site's card reads the same three numbers as a verified one, because the caps
 * protect the site being driven rather than the person who asked.
 *
 * What verification does change is one line. An unverified card adds _"Verify it to unlock
 * **Improve my site**"_, which is the thing proof of control really buys (`docs/FLOW.md`
 * section 13) — and the whole card is the way in to proving it.
 */
export function SiteCard({
  site,
  lastTestName,
  ranTheLatestTest,
}: {
  site: SiteRecord;
  /**
   * What the last test against this site was called, from the workspace's run listing, or
   * `null` while that listing is still being read or for a test it does not name.
   */
  lastTestName: string | null;
  /** The site the workspace's most recent test ran against. */
  ranTheLatestTest: boolean;
}) {
  const { caps } = site;
  const failedCheck = lastCheckWords(site.lastCheck);
  const lastTest = lastTestWords(site.lastTest, lastTestName);

  return (
    <Link
      to={paths.site(site.id)}
      className={`card ${styles.siteCard}`}
      {...(ranTheLatestTest ? { 'aria-current': true as const } : {})}
    >
      <span className="microlabel">{verificationWords(site.verification)}</span>
      <h2 className={styles.siteName}>{siteName(site.url)}</h2>
      <div className={styles.siteFacts}>
        <span>
          <b>{caps.agentsPerRun}</b> {agentsNoun(caps.agentsPerRun)}
        </span>
        <span>
          <b>{caps.runsPerSitePerHour}</b> {runsNoun(caps.runsPerSitePerHour)}
          {' · '}
          <b>{caps.concurrentSessionsPerSite}</b> {browsersNoun(caps.concurrentSessionsPerSite)}
        </span>
        {site.verification.state === 'verified' ? null : (
          <span>
            Verify it to unlock <b>Improve my site</b>
          </span>
        )}
        {failedCheck === null ? null : <span>{failedCheck}</span>}
        {lastTest === null ? null : <span className="faint">{lastTest}</span>}
      </div>
    </Link>
  );
}
