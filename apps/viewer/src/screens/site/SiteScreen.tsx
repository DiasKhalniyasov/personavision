import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { capWords, siteName } from '@/screens/sites/words';
import { createSite, removeSite } from '@/sites/store';
import { refreshSites, useSite } from '@/sites/useSites';
import { siteFootnote } from './words';
import styles from './site.module.css';
import type { SiteIssue, SiteRecord } from '@/sites/store';

/**
 * `/sites/new` and `/sites/:siteId` — the URL the feature starts on, and the site it became.
 * One screen, because adding a site and reading one are the same short conversation.
 *
 * `#screen-site` of `docs/design/prototype.html`: the breadcrumb, the URL as the heading, the
 * URL read-only with *Remove this site* beside it, the figures this site is bound by, and the
 * one footnote about **Improve my site**.
 *
 * **There is nothing to prove about a site** (`docs/FLOW.md` section 13, as the owner's input
 * of **2026-11-04** settles it). A site is a URL that belongs to a workspace; this screen
 * adds one, shows one and removes one, and no state on it is about who controls the address.
 *
 * **No figure here is this screen's.** The three numbers arrive as `caps` on the platform's
 * answer and are the same for every site, because they protect the site being driven rather
 * than the person who asked (decision 71, settled **2026-11-03** — _no gate on testing_).
 *
 * **The URL is read-only.** No route updates a site's URL, which #269 settled and this input
 * does not change, so a wrong address is a new site and the footnote says so.
 */

/** The heading on `/sites/new`, which is the route table's own name for that screen. */
const ADD_A_SITE = 'Add a site';

/**
 * The heading while the site in the path is being read, and for one that could not be read.
 *
 * The page is headed by the site's own URL, which is the one thing a frame drawn before the
 * answer arrives cannot know — and inventing it from the id in the path would head the page
 * with something that is not the site's address. The noun is what `/audiences/:audienceId`
 * stands in with for the same reason.
 */
const A_SITE = 'Site';

/** The one sentence above the form, and whether what it says is the platform being away. */
interface Trouble {
  readonly sentence: string;
  /** `true` only for a platform that could not be reached — never for an answer it gave. */
  readonly outage: boolean;
}

/**
 * What is added to an outage's sentence: what is still here, and so what to do next.
 *
 * Only ever one of these, and only for an outage. A refusal the platform answered gets the
 * platform's own sentence and nothing of ours after it.
 */
const outageSuffix = (isNew: boolean): string =>
  isNew
    ? // `/sites/new`, where the reader has typed something and it is still in the field.
      ' Nothing you typed has been lost — try again when it is back.'
    : ' Try again when it is back.';

export function SiteScreen({ siteId }: { siteId: string | null }) {
  const state = useSite(siteId);
  const navigate = useNavigate();
  const urlId = useId();
  const hintId = useId();

  /** What has been typed on `/sites/new`. An existing site's field is the stored URL. */
  const [url, setUrl] = useState('');
  const [issues, setIssues] = useState<readonly SiteIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  /**
   * The one sentence above the form: a platform that could not be reached, and a refusal the
   * platform did answer. Telling a reader to wait for a platform that has just answered them
   * would be the generic wording `docs/FLOW.md` section 13 rules out, so the two are told
   * apart rather than printed the same way.
   */
  const [trouble, setTrouble] = useState<Trouble | null>(null);

  const isNew = siteId === null;
  const site = state.status === 'ready' ? state.site : null;
  const field = issues.find((issue) => issue.path === 'url')?.message;
  // One sentence, whichever call it came from: the read of the site, the save on
  // `/sites/new`, or the removal.
  const said: Trouble | null =
    trouble ?? (state.status === 'unreadable' ? { sentence: state.problem, outage: true } : null);

  if (!isNew && state.status === 'not-found') {
    return (
      <Frame title="No site with that id" breadcrumb={null}>
        <div className="empty">
          <p>
            This workspace has no site at <span className="mono">{paths.site(state.siteId)}</span>.
          </p>
          <div className="actions">
            <Link to={paths.sites}>Back to your sites</Link>
          </div>
        </div>
      </Frame>
    );
  }

  /** Add the site, and go to its own page — which is this screen, opened on it. */
  const add = async (): Promise<void> => {
    setTrouble(null);
    setIssues([]);
    setSaving(true);
    const answer = await createSite(url);
    setSaving(false);
    if (answer.ok) {
      refreshSites();
      await navigate(paths.site(answer.value.id));
      return;
    }
    if (answer.kind === 'refused') {
      setIssues(answer.issues);
      // A refusal the URL field cannot show is a refusal with nowhere to go, and a button
      // that does nothing when it is pressed. The platform names the `url` field today; a
      // message about anything else is said above the form rather than swallowed.
      const unplaced = answer.issues.filter((issue) => issue.path !== 'url');
      if (unplaced.length > 0) {
        setTrouble({ sentence: unplaced.map((issue) => issue.message).join(' '), outage: false });
      }
      return;
    }
    setTrouble({
      sentence: answer.problem,
      outage: answer.kind === 'unreachable' && answer.answered !== true,
    });
  };

  /** Remove the site, and go back to the list the reader came from. */
  const remove = async (record: SiteRecord): Promise<void> => {
    setTrouble(null);
    setRemoving(true);
    const answer = await removeSite(record.id);
    setRemoving(false);
    if (answer.ok) {
      // The list a reader returns to must be the one they just changed.
      refreshSites();
      await navigate(paths.sites);
      return;
    }
    setTrouble({
      sentence:
        answer.kind === 'refused'
          ? (answer.issues[0]?.message ?? 'That site could not be removed.')
          : answer.problem,
      // A site already gone answers 404, which is an answer: the reader is not asked to
      // wait for a platform that just told them something.
      outage: answer.kind === 'unreachable' && answer.answered !== true,
    });
  };

  return (
    <Frame
      title={isNew ? ADD_A_SITE : site === null ? A_SITE : siteName(site.url)}
      breadcrumb={isNew ? ADD_A_SITE : site === null ? null : siteName(site.url)}
    >
      <p className="lede">
        {isNew
          ? 'The URL of the page the feature starts on. A site is a URL and nothing more — there is nothing to prove about it, and you can add more later.'
          : 'A site is a URL and nothing more. There is nothing to prove about it — this is what the site is, and what it is allowed.'}
      </p>

      {said === null ? null : (
        <p className="notice" role="alert">
          {said.sentence}
          {said.outage ? outageSuffix(isNew) : ''}
        </p>
      )}

      <form
        className={`${styles.form} card card-lg`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (isNew) void add();
        }}
      >
        <div className={styles.fieldGroup}>
          <Label htmlFor={urlId}>The URL the feature starts on</Label>
          <Input
            id={urlId}
            type="url"
            value={isNew ? url : (site?.url ?? '')}
            readOnly={!isNew}
            // Nothing is in it and nothing can be done with it until the site is read.
            disabled={!isNew && site === null}
            aria-invalid={field !== undefined}
            aria-describedby={isNew ? hintId : undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              // The refusal was about what was in the field; it is not about what is in it
              // now, and a red line under a URL being retyped is a line that is not true.
              if (issues.length > 0) setIssues([]);
            }}
          />
          {field === undefined ? null : (
            <span className={styles.err} role="alert">
              {field}
            </span>
          )}
          {isNew ? (
            <span className={styles.hint} id={hintId}>
              The whole address, scheme and all — like https://app.example.com/create. It is the
              address a test drives.
            </span>
          ) : site === null ? (
            <Skeleton className="h-4 w-64" />
          ) : (
            <span className={styles.hint}>{siteFootnote(site)}</span>
          )}
        </div>
        <div className={styles.formfoot}>
          {isNew ? (
            <Button type="submit" disabled={saving}>
              Add the site
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={site === null || removing}
              onClick={() => {
                if (site !== null) void remove(site);
              }}
            >
              Remove this site
            </Button>
          )}
        </div>
      </form>

      {isNew ? null : (
        <div className={styles.sitestate}>
          {site === null ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <span className="faint">{capWords(site.caps)}</span>
          )}
        </div>
      )}

      {isNew ? null : (
        <p className="footnote">
          <b>Improve my site</b> needs the PersonaVision app installed on the repository that
          deploys this site, which is also the only proof of control this product asks for.{' '}
          <Link to={paths.githubSettings}>Connect GitHub</Link>.
        </p>
      )}
    </Frame>
  );
}

/** The screen around it: the breadcrumb back to the list, and the heading. */
function Frame({
  title,
  breadcrumb,
  children,
}: {
  /**
   * The site's own URL, which is the prototype's `.pagehead` — or, on `/sites/new`, the one
   * question that screen is answering, which is the route table's own name for it.
   */
  title: string;
  breadcrumb: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="strip strip-sm">
      <div className="wrap-narrow">
        <p className={`breadcrumb ${styles.crumb}`}>
          <Link to={paths.sites}>Sites</Link>
          {breadcrumb === null ? null : ` / ${breadcrumb}`}
        </p>
        <div className="pagehead">
          <h1 className={styles.heading}>{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
