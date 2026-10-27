import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EXAMPLE_RUN_ID } from '@/screens/landing/LandingPage';
import { AudienceLine } from '@/screens/verdict/AudienceLine';
import { CompletionFigures } from '@/screens/verdict/CompletionFigures';
import { ExcludedBanner } from '@/screens/verdict/ExcludedBanner';
import { HeadlineFindings } from '@/screens/verdict/HeadlineFindings';
import { Headline } from '@/screens/verdict/Headline';
import { HeroEvidence } from '@/screens/verdict/HeroEvidence';
import { Reasons } from '@/screens/verdict/Reasons';
import { paths } from '@/shell/paths';
import { SimulatedBadge, SimulatedBadgePlaceholder } from '@/shell/SimulatedBadge';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import styles from './demo.module.css';

/**
 * `/demo` — the committed example run's Verdict, public and read-only.
 *
 * A visitor who will not fill in a form to find out whether the product works can still
 * see it work (`docs/FLOW.md` section 3, the **Demo** row): the same answer a signed-in
 * customer reads, over the artifact this repository commits, with no account and no
 * session on the server.
 *
 * **It is the Verdict screen, not a page about it.** Every section is imported from
 * `src/screens/verdict/` — the audience line, the headline sentence, the two completion
 * figures, the reasons, the one heatmap and at most three findings, in that order — so a
 * change to the Verdict screen is a change to this page, and nothing here can drift into a
 * second, prettier version of the product's own answer. `DemoPage.test.tsx` holds it to
 * that by rendering this page and the signed-in screen and comparing the sections it finds.
 *
 * Two replacements, which `#screen-verdict` of `docs/design/prototype.html` and this
 * ticket's screen contract fix between them, and nothing else:
 *
 * 1. **The product chrome becomes the public bar** — the wordmark, the simulated badge and
 *    *Sign in*. No workspace name, no test picker, no account menu, no New test button and
 *    no tab bar: none of them has anything to name for somebody with no workspace.
 * 2. **The `.doors` block becomes one action.** Score breakdown, Attention, Sessions and
 *    Session replay are behind sign-in, so the page says so in a line and offers *Sign in
 *    to run this on your own pages* in their place. Four doors that cannot open are worse
 *    than one that does.
 *
 * The sections between the two are the signed-in screen unchanged, which is what the
 * screen contract asks for — including the links a finding, the heatmap's caption and the
 * audience chip carry. Those lead to screens that need a session, and for a visitor with
 * none `RequireSession` sends them to `/signin` carrying where they were going, so every
 * link on this page resolves to the page's one action and signing in finishes the journey.
 * Nothing here is a door that fails: that is asserted, not assumed.
 *
 * **One run, fixed.** The route takes no run id and this page reads `EXAMPLE_RUN_ID` and
 * nothing else, so no workspace's data can be reached through `/demo` whatever is typed at
 * it. The id is the landing page's, imported, because the two public pages must read the
 * same test.
 *
 * The page animates nothing of its own: the heatmap warming up and the figures counting up
 * are #125's components, which the sections above import once they exist. Under
 * `prefers-reduced-motion` it is therefore already complete and still on first paint.
 */

/** The badge the public bar carries, which the run is the only source of. */
function Badge({ run, reading }: { run: Run | null; reading: boolean }) {
  if (run !== null) return <SimulatedBadge calibration={run.calibration} />;
  // While the run is read the badge holds its shape; with no run to read there is no
  // figure on the page to label, so a badge there would be a promise about nothing.
  return reading ? <SimulatedBadgePlaceholder /> : null;
}

/**
 * The public bar: the wordmark, the badge and the one way in.
 *
 * `.appbar` is the chrome's own bar from `src/styles/chrome.css`, carrying three things
 * instead of seven. The badge is in it because the word *Simulated* belongs wherever the
 * product shows a figure (`docs/FLOW.md` section 3), and this page shows figures.
 */
function PublicBar({ run, reading }: { run: Run | null; reading: boolean }) {
  return (
    <header className="appbar" data-shell="public-bar">
      <div className="wrap">
        <Link className="logo" to={paths.home}>
          PersonaVision
        </Link>
        <span className="grow" />
        <Badge run={run} reading={reading} />
        <Button asChild>
          <Link to={paths.signIn}>Sign in</Link>
        </Button>
      </div>
    </header>
  );
}

/**
 * What stands where the four doors stand on the signed-in screen: the line saying where
 * the detail is, and the one action this page offers.
 */
function BehindSignIn() {
  return (
    <div className={styles.behind} data-section="behind-sign-in">
      <p className={styles.behindLine}>
        The detail behind this answer &mdash; the score breakdown, every heatmap, all the simulated
        people and a replay of one person&rsquo;s session &mdash; is behind sign-in.
      </p>
      <Button size="lg" asChild>
        <Link to={paths.signIn}>Sign in to run this on your own pages</Link>
      </Button>
    </div>
  );
}

/**
 * The example run could not be read: one stated line, naming the file that was looked for.
 *
 * There is no empty state on this page and no second thing to try — the route serves one
 * test — so this says what is missing and leaves the bar's way in above it.
 */
function Unreadable({ url, problem }: { url: string; problem?: string }) {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h1>The example test could not be read</h1>
          <p>
            PersonaVision looked for <span className="mono">{url}</span>, which is the one test this
            page shows{problem === undefined ? ', and it is not there.' : '.'}
          </p>
          {problem === undefined ? null : <p className="mono">{problem}</p>}
          <div className="actions">
            <Button asChild>
              <Link to={paths.signIn}>Sign in to run this on your own pages</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The page while the run is being read: the three strips, each already the height of the
 * section that will fill it, so nothing moves when the artifact arrives.
 */
function Waiting() {
  return (
    <div aria-busy="true" data-section="demo-waiting">
      <div className="strip strip-sm">
        <div className="wrap">
          <Skeleton className={styles.waitingAudience} />
          <Skeleton className={styles.waitingHeadline} />
          <div className={styles.waitingFigures}>
            <Skeleton className={styles.waitingFigure} />
            <Skeleton className={styles.waitingFigure} />
          </div>
        </div>
      </div>

      <div className="strip strip-tint">
        <div className="wrap">
          <div className={styles.waitingMat}>
            <Skeleton className={styles.waitingShot} />
          </div>
        </div>
      </div>

      <div className="strip">
        <div className="wrap">
          <Skeleton className={styles.waitingFindings} />
        </div>
      </div>
    </div>
  );
}

/** The Verdict, section for section, as `#screen-verdict` orders it. */
function Verdict({ run }: { run: Run }) {
  return (
    <>
      <div className="strip strip-sm">
        <div className="wrap">
          <AudienceLine run={run} />
          <ExcludedBanner run={run} />
          <Headline run={run} />
          <CompletionFigures run={run} />
          <Reasons run={run} />
        </div>
      </div>

      {/* The single piece of evidence on this screen, in the one tinted band. */}
      <div className="strip strip-tint">
        <div className="wrap">
          <HeroEvidence run={run} />
        </div>
      </div>

      <div className="strip">
        <div className="wrap">
          <HeadlineFindings run={run} />
          <BehindSignIn />
          {/* The run is handed over because the route names no test: the disclaimer names
              the audience the figures above are true of, not no audience at all. */}
          <SimulatedDisclaimer run={run} />
        </div>
      </div>
    </>
  );
}

export function DemoPage() {
  const state = useRun(EXAMPLE_RUN_ID);
  const run = state.status === 'ready' ? state.run : null;

  return (
    <>
      <PublicBar run={run} reading={state.status === 'loading'} />
      <main>
        {state.status === 'loading' ? <Waiting /> : null}
        {state.status === 'not-found' ? <Unreadable url={state.url} /> : null}
        {state.status === 'unreadable' ? (
          <Unreadable problem={state.problem} url={state.url} />
        ) : null}
        {run === null ? null : <Verdict run={run} />}
      </main>
    </>
  );
}
