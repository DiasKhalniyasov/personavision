import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { useRunIndex } from '@/shell/useRun';
import { useSites } from '@/sites/useSites';
import { SiteCard } from './SiteCard';
import styles from './sites.module.css';

/**
 * `/sites` — which of my sites can I test, and what is each allowed?
 *
 * `#screen-sites` of `docs/design/prototype.html`: the workspace's sites as cards, each
 * reading its own figures rather than the word "limited", and a card for adding one. The
 * screen a new workspace lands on, and the only way in to `/sites/new`.
 *
 * **There is nothing to prove about a site** (`docs/FLOW.md` section 13, as the owner's input
 * of **2026-11-04** settles it): no card carries a state, because a site is a URL that
 * belongs to a workspace and every one of them is bound by the same figures.
 *
 * **It states no cap of its own.** The three figures on a card are `caps` on the platform's
 * answer, composed in `packages/platform/src/caps.ts` and served per site. A screen holding
 * its own copy of a cap is a screen that will one day disagree with the thing that enforces
 * it, so there is no number in this file at all.
 *
 * The one thing it joins is the **name of a test**: the platform says which run last ran
 * against each site and when (`lastTest`), and the workspace's run listing says what each
 * run was asked for. Both are reads this app already makes in one place each, so the join
 * happens here, on the screen that wants the sentence.
 */
export function SitesPage() {
  const list = useSites();
  const listing = useRunIndex();

  // The listing is newest first, as `readRunIndex` sorts it, so the first entry is the
  // workspace's most recent test — which is the card `#screen-sites` marks as current.
  const latestRunId = listing.status === 'ready' ? (listing.runs[0]?.runId ?? null) : null;
  const nameOf = (runId: string | null): string | null =>
    runId === null || listing.status !== 'ready'
      ? null
      : (listing.runs.find((run) => run.runId === runId)?.name ?? null);

  const sites = list.status === 'ready' ? list.sites : [];
  // A workspace with no sites is the first-run screen: the heading, the lede and the one
  // card, laid out as the one card rather than as a grid with a gap where the others go.
  // The grid is never drawn around nothing — not while the platform is being read, which
  // draws the cards it is about to replace, and not on an error, which still offers the way
  // in to adding a site.
  const addCardAlone = sites.length === 0 && list.status !== 'loading';

  const addCard = (
    <Link to={paths.newSite} className={`card ${styles.siteCard}`}>
      <h2 className={styles.siteName}>+ Add a site</h2>
      <p className={`lede ${styles.addBlurb}`}>
        The URL of the page the feature starts on. You can add more later.
      </p>
    </Link>
  );

  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <div className="pagehead">
          <h1>Your sites</h1>
        </div>
        <p className="lede">
          A site is a URL in this workspace — the page the feature starts on. Every site is bound by
          the same figures, because they protect the site being driven rather than the person who
          asked.
        </p>

        {list.status === 'unreadable' ? (
          <p className="notice" role="alert">
            {list.problem}
          </p>
        ) : null}

        <div className={`section ${styles.sites}`}>
          {list.status === 'loading' ? (
            // Announced and not drawn: the skeletons below are what a sighted reader sees,
            // and a line of text that appears and then goes away is the page moving under
            // the reader the moment the sites arrive.
            <p className="sr-only" role="status">
              Reading your sites…
            </p>
          ) : null}
          {addCardAlone ? (
            <div className={styles.firstRun}>{addCard}</div>
          ) : (
            <div className={styles.siteGrid}>
              {list.status === 'loading' ? <LoadingCards /> : null}
              {sites.map((site) => (
                <SiteCard
                  key={site.id}
                  site={site}
                  lastTestName={nameOf(site.lastTest?.runId ?? null)}
                  ranTheLatestTest={latestRunId !== null && site.lastTest?.runId === latestRunId}
                />
              ))}
              {addCard}
            </div>
          )}
        </div>

        <p className="footnote">
          <b>Improve my site</b> needs the PersonaVision app installed on the repository that
          deploys a site — being able to install it is the proof that matters there. Nothing else
          about a site is proved.
        </p>
      </div>
    </div>
  );
}

/**
 * The space two cards will take, while the platform is being read.
 *
 * The grid must not move once the answer arrives, so the placeholders are the shape of the
 * cards they stand in for — a microlabel, the address, and the lines of figures under it —
 * and they are the grid's **only** other children: the card for adding a site is already
 * there, and the line that says a read is in flight is announced rather than drawn, so the
 * grid holds the same number of cells before and after.
 */
function LoadingCards() {
  return (
    <>
      {[0, 1].map((index) => (
        <div key={index} className="card" aria-hidden="true" data-loading="site">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-5 w-48" />
          <Skeleton className="mt-4 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-5/6" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </>
  );
}
