import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { siteName, verificationWords } from '@/screens/sites/words';
import { createSite, verifySite } from '@/sites/store';
import { refreshSites, useSite } from '@/sites/useSites';
import { capWords, checkWords, METHODS } from './words';
import styles from './site.module.css';
import type { MethodId, VerifyMethod } from './words';
import type { SiteIssue, SiteRecord } from '@/sites/store';

/**
 * `/sites/new` and `/sites/:siteId` — the URL the feature starts on, and proving the site is
 * yours. One screen, because adding and proving are the same conversation.
 *
 * `#screen-site` of `docs/design/prototype.html`: the breadcrumb, the heading, the URL
 * field, the state line, the four methods of `docs/FLOW.md` section 13 — each with the exact
 * line to copy for this site's own token — and the footnote that promises what a failed
 * check will say.
 *
 * **The platform does the checking.** Every button here posts the name of a method and
 * renders what came back; there is no box to tick, and nothing in this file decides whether
 * a site is verified. A check that **failed is a result, not an error**: it is printed
 * beside the method that ran, in the platform's own words, with the time it ran — the one
 * sentence this screen reserves for an error is a platform it could not reach at all.
 *
 * **No figure here is a cap.** The three numbers on the state line arrive as `caps` on the
 * platform's answer and are the same whether or not the site is verified: decision 71, as
 * the owner settled it on **2026-11-03** — _no gate on testing_. What verification unlocks
 * is **Improve my site**, which is a line of words rather than a bigger number.
 */
/** The prototype's `.pagehead`, which is the heading from the moment a site exists. */
const PROVE_IT = 'Prove this site is yours';

export function SiteScreen({ siteId }: { siteId: string | null }) {
  const state = useSite(siteId);
  const navigate = useNavigate();
  const urlId = useId();
  const hintId = useId();

  /**
   * The site as it now stands — the platform's answer to the read, and then to every check,
   * which answers the whole record beside the result. Held here so a passing check verifies
   * the site in front of the reader without a reload.
   */
  const [site, setSite] = useState<SiteRecord | null>(null);
  const [url, setUrl] = useState('');
  const [issues, setIssues] = useState<readonly SiteIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<MethodId | null>(null);
  /** The one sentence for a platform that could not be reached. Never a check's own result. */
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== 'ready') return;
    setSite(state.site);
    setUrl(state.site.url);
  }, [state]);

  const isNew = siteId === null;
  const field = issues.find((issue) => issue.path === 'url')?.message;
  // One sentence, whichever call could not be reached: the read of the site, a check, or
  // the save on `/sites/new`. A check that *failed* is not one of them — it is a result.
  const unreachable = problem ?? (state.status === 'unreadable' ? state.problem : null);

  if (!isNew && state.status === 'not-found') {
    return (
      <Frame title={PROVE_IT} breadcrumb={null}>
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

  /** Add the site, and go to its own screen — which is this screen, with the methods on it. */
  const add = async (): Promise<void> => {
    setProblem(null);
    setSaving(true);
    const answer = await createSite(url);
    setSaving(false);
    if (answer.ok) {
      setIssues([]);
      refreshSites();
      await navigate(paths.site(answer.value.id));
      return;
    }
    if (answer.kind === 'refused') {
      setIssues(answer.issues);
      return;
    }
    setProblem(answer.problem);
  };

  /** Ask the platform to run one of the four checks, and render what it found. */
  const check = async (method: MethodId): Promise<void> => {
    if (site === null) return;
    setProblem(null);
    setRunning(method);
    const answer = await verifySite(site.id, method);
    setRunning(null);
    if (answer.ok) {
      setSite(answer.value.site);
      // The list a reader returns to must be the one they just changed.
      refreshSites();
      return;
    }
    setProblem(
      answer.kind === 'refused'
        ? (answer.issues[0]?.message ?? 'That check could not be run.')
        : answer.problem,
    );
  };

  // Which block is marked as the current one: the method that proved this site, then the one
  // last checked, and otherwise the recommended one — as the prototype draws it.
  const current: MethodId | null =
    (site?.verification.method as MethodId | null | undefined) ??
    (site?.lastCheck?.method as MethodId | undefined) ??
    METHODS[0]?.id ??
    null;

  return (
    <Frame
      title={isNew && site === null ? 'Add a site' : PROVE_IT}
      breadcrumb={site === null ? (isNew ? 'Add a site' : null) : siteName(site.url)}
    >
      <p className="lede">
        {isNew && site === null
          ? 'The URL of the page the feature starts on. Once it is added we ask you to prove it is yours — any one of four ways, and we check each of them ourselves.'
          : 'Any one of these four. We check it ourselves — there is no box to tick.'}
      </p>

      {unreachable === null ? null : (
        <p className="notice" role="alert">
          {unreachable}
          {site === null
            ? ' Nothing you typed has been lost — try again when it is back.'
            : ' The lines to copy below are this site’s own — put one in place and check again when the platform is back.'}
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
            value={url}
            readOnly={!isNew}
            aria-invalid={field !== undefined}
            aria-describedby={isNew ? hintId : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
          {field === undefined ? null : (
            <span className={styles.err} role="alert">
              {field}
            </span>
          )}
          {isNew ? (
            <span className={styles.hint} id={hintId}>
              The whole address, scheme and all — like https://app.example.com/create. It is the
              address we check, and the address a test drives.
            </span>
          ) : null}
        </div>
        {isNew ? (
          <div className={styles.formfoot}>
            <Button type="submit" disabled={saving}>
              Add the site
            </Button>
            <span className="faint">The four ways to prove it appear once the site is added.</span>
          </div>
        ) : null}
      </form>

      {isNew && site === null ? null : (
        <>
          <div className={styles.sitestate}>
            {site === null ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <span
                className={`tag ${site.verification.state === 'verified' ? 'tag-success' : 'tag-abandoned'}`}
              >
                {verificationWords(site.verification)}
              </span>
            )}
            {site === null ? (
              <Skeleton className="h-4 w-72" />
            ) : (
              <>
                <span className="faint">{capWords(site.caps)}</span>
                <span className="faint">
                  {site.verification.state === 'verified' ? (
                    <>
                      <b>Improve my site</b> is unlocked
                    </>
                  ) : (
                    <>
                      Testing is not held back · verifying unlocks <b>Improve my site</b>
                    </>
                  )}
                </span>
              </>
            )}
          </div>

          <div className={styles.verify}>
            {METHODS.map((method) => (
              <Method
                key={method.id}
                method={method}
                site={site}
                current={method.id === current}
                running={running === method.id}
                // One check at a time: a reader who presses two buttons would be shown one
                // answer and left wondering which of them it belongs to.
                disabled={site === null || running !== null}
                onCheck={() => void check(method.id)}
              />
            ))}
          </div>
        </>
      )}

      <p className="footnote">
        A failed check says what it looked for, where, and what it found instead. Nothing here is
        “something went wrong”.
      </p>
    </Frame>
  );
}

/**
 * One of the four methods: what to publish, the exact line to copy, and the check.
 *
 * `site === null` is the loading frame — the four blocks and their buttons are drawn, so the
 * page is the shape it will be, and nothing is invented in place of the token: a line to
 * copy with a guess in it is a line that does not verify anything.
 */
function Method({
  method,
  site,
  current,
  running,
  disabled,
  onCheck,
}: {
  method: VerifyMethod;
  site: SiteRecord | null;
  current: boolean;
  running: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const found =
    site !== null && site.lastCheck !== null && site.lastCheck.method === method.id
      ? site.lastCheck
      : null;

  return (
    <section
      className={`${styles.method}${running ? ` ${styles.running}` : ''}`}
      {...(current ? { 'aria-current': true as const } : {})}
      {...(running ? { 'aria-busy': true as const } : {})}
    >
      <header>
        <h2>{method.heading}</h2>
        {method.tag === null ? null : (
          <span className={`tag tag-${method.tag.kind}`}>{method.tag.words}</span>
        )}
      </header>
      {site === null ? <Skeleton className="h-4 w-full" /> : <p>{method.explain(site)}</p>}
      {method.line === null ? null : site === null ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        // Focusable, because it scrolls: the line is one unbroken word and a reader on a
        // phone, or on a keyboard, has to be able to reach the end of it.
        <code className={styles.tokenline} tabIndex={0}>
          {method.line(site)}
        </code>
      )}
      <div className={styles.formfoot}>
        {method.id === 'connected-repository' ? (
          <Button asChild variant="outline" size="sm">
            <Link to={paths.githubSettings}>Connect GitHub</Link>
          </Button>
        ) : null}
        <Button
          variant={current ? 'default' : 'outline'}
          size="sm"
          disabled={disabled}
          onClick={onCheck}
        >
          {method.check}
        </Button>
        {running ? (
          <span className="faint" role="status">
            Checking…
          </span>
        ) : null}
        {!running && found !== null ? (
          <span className="faint" role="status">
            {checkWords(found)}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** The screen around it: the breadcrumb back to the list, and the heading. */
function Frame({
  title,
  breadcrumb,
  children,
}: {
  /**
   * The one question this screen is answering. On `/sites/new` that is still _what is the
   * URL_ — the route table's own name for it — and it becomes the prototype's _"Prove this
   * site is yours"_ the moment there is a site to prove.
   */
  title: string;
  breadcrumb: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="strip strip-sm">
      <div className="wrap-narrow">
        <p className="breadcrumb">
          <Link to={paths.sites}>Sites</Link>
          {breadcrumb === null ? null : ` / ${breadcrumb}`}
        </p>
        <div className="pagehead">
          <h1>{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
