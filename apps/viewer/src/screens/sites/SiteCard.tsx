import { Link } from 'react-router';
import { paths } from '@/shell/paths';
import { addedWords, agentsNoun, browsersNoun, lastTestWords, runsNoun, siteName } from './words';
import styles from './sites.module.css';
import type { SiteRecord } from '@/sites/store';

/**
 * One site, as `#screen-sites` draws it: when it was added, its address, what binds it, and
 * the test it last ran.
 *
 * **Every figure is the platform's.** `caps` arrives on the site and is printed; nothing here
 * composes, scales or defaults a number. Every site in a workspace reads the same three
 * figures, because the caps protect the site being driven rather than the person who asked —
 * decision 71, settled by the owner on **2026-11-03** as _no gate on testing_.
 *
 * **There is no state on a card.** A site is a URL that belongs to a workspace and nothing
 * more (`docs/FLOW.md` section 13, as the owner's input of **2026-11-04** settles it), so a
 * card has nothing to say about who controls the address — and the whole card is the way in
 * to the site's own page.
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
  const added = addedWords(site.createdAt);
  const lastTest = lastTestWords(site.lastTest, lastTestName);

  return (
    <Link
      to={paths.site(site.id)}
      className={`card ${styles.siteCard}`}
      {...(ranTheLatestTest ? { 'aria-current': true as const } : {})}
    >
      {added === null ? null : <span className="microlabel">{added}</span>}
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
        {lastTest === null ? null : <span className="faint">{lastTest}</span>}
      </div>
    </Link>
  );
}
