import { Link } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CompletionFigures } from '@/screens/verdict/CompletionFigures';
import { HeroEvidence } from '@/screens/verdict/HeroEvidence';
import { paths } from '@/shell/paths';
import { SimulatedDisclaimer } from '@/shell/SimulatedDisclaimer';
import { useRun } from '@/shell/useRun';
import styles from './landing.module.css';

/**
 * `/` for a visitor with no session: the product's public face.
 *
 * A business decision-maker who has heard of PersonaVision and wants to know, in fifteen
 * seconds, what it does and whether to believe it (`docs/FLOW.md` sections 1 and 3). The
 * page answers both in its own order: what the product answers, then the answer it
 * produced on a real test, then the evidence under that answer, then how it is done.
 *
 * **Nothing on this page is written into it.** The sentence, the two completion figures,
 * the populations behind them and the version marked as the one to ship are all read from
 * the committed example run through `packages/contract`, by the same components the
 * Verdict screen reads them with — `CompletionFigures` (#15), `HeroEvidence` (#108) and
 * the shell's `SimulatedDisclaimer`. Changing a field in the fixture changes this page,
 * and `LandingPage.test.tsx` asserts that.
 *
 * The page's one invented layout is the hero's two columns at desktop width; everything
 * else is the step's own primitives. The animated moments the visual direction gives this
 * page are #125's components, imported once they exist: the page itself animates nothing,
 * so under `prefers-reduced-motion` it is already complete and still on first paint.
 */

/**
 * The committed example run, which is what this page and `/demo` (#124) both read.
 *
 * The run directory's name is its id in the contract, and it is the one test the seeded
 * demo workspace ships with. It is named here rather than taken from `/runs/index.json`
 * deliberately: the latest test of a workspace is somebody's own, and this page is public.
 * A deployment without that directory falls to the unreadable state below, which is the
 * state the ticket specifies, rather than publishing a customer's result.
 */
export const EXAMPLE_RUN_ID = '2026-10-24-1402-northwind-demo';

/** The one thing the page promises, in the reader's own words. It is the page's one `h1`. */
const HEADLINE = 'Know which version your customers can actually use';

/** The three steps, as `docs/FLOW.md` sections 1 and 2 walk them. */
const STEPS: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: 'Describe your audience',
    body: 'Their ages, where they are, what they came to do, which devices they use and how much price matters. PersonaVision generates the simulated people from that description — not from stock personas.',
  },
  {
    name: 'Point at two versions and a task',
    body: 'The page you have and the redesign somebody has proposed, and the one thing a customer came to get done.',
  },
  {
    name: 'Read the verdict',
    body: 'One sentence naming the version your audience completes, the share of them who finished on each, and the moment the answer turns on.',
  },
];

/** *See the demo* and *Sign in*: the page's only two actions, wherever they appear. */
function Actions() {
  return (
    <div className={styles.actions}>
      <Button size="lg" asChild>
        <Link to={paths.demo}>See the demo</Link>
      </Button>
      <Button size="lg" variant="outline" asChild>
        <Link to={paths.signIn}>Sign in</Link>
      </Button>
    </div>
  );
}

/** The bar: the wordmark and the two actions. There is no marketing navigation. */
function Bar() {
  return (
    <header className="appbar">
      <div className="wrap">
        <Link className="logo" to={paths.home}>
          PersonaVision
        </Link>
        <span className="grow" />
        <div className={styles.barActions}>
          <Button variant="ghost" asChild>
            <Link to={paths.demo}>See the demo</Link>
          </Button>
          <Button asChild>
            <Link to={paths.signIn}>Sign in</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

/** The one line that stands where the evidence would be when the example run cannot be read. */
function Unavailable() {
  return (
    <p className={styles.unavailable}>
      The example test could not be read just now, so its figures are not on this page &mdash; every
      number here is a test&rsquo;s own or it is not shown.
    </p>
  );
}

/** The evidence panel while the run is still being read: the shape it will have, quietly. */
function Waiting() {
  return (
    <div className={styles.waiting} aria-busy="true">
      <Skeleton className={styles.waitingSentence} />
      <Skeleton className={styles.waitingFigure} />
    </div>
  );
}

/**
 * The answer the product produced on a real test: the run's own headline sentence, then
 * the two completion figures with the version to ship marked and the number of simulated
 * people under each.
 */
function Evidence({ run }: { run: Run }) {
  return (
    <div className={styles.evidence} data-section="landing-evidence">
      <p className="microlabel">From a real test &middot; {run.audience.name}</p>
      <p className={styles.evidenceSentence}>{run.verdict.audienceSentence}</p>
      <CompletionFigures run={run} />
    </div>
  );
}

export function LandingPage() {
  const state = useRun(EXAMPLE_RUN_ID);
  const run = state.status === 'ready' ? state.run : null;
  const unreadable = state.status === 'not-found' || state.status === 'unreadable';

  return (
    <>
      <Bar />

      <main>
        <div className="strip strip-lg">
          <div className={`wrap ${styles.hero}`}>
            <div className={styles.heroText}>
              <h1 className={styles.headline}>{HEADLINE}</h1>
              <p className="lede">
                Two versions of a page, one audience you describe, and the answer before the
                meeting. PersonaVision simulates your customers on both, watches where they look and
                where they give up, and names the version they finish &mdash; without a week of real
                traffic and real customers.
              </p>
              <Actions />
              {unreadable ? <Unavailable /> : null}
            </div>
            {run !== null ? <Evidence run={run} /> : null}
            {run === null && !unreadable ? <Waiting /> : null}
          </div>
        </div>

        {/* The single piece of evidence that is a picture, in the one tinted band. */}
        {unreadable ? null : (
          <div className="strip strip-tint">
            <div className="wrap">
              {run === null ? (
                <div className={styles.waitingMat} aria-busy="true">
                  <Skeleton className={styles.waitingShot} />
                </div>
              ) : (
                <HeroEvidence run={run} />
              )}
            </div>
          </div>
        )}

        <div className="strip">
          <div className="wrap">
            <h2 className={styles.howHeading}>How it works</h2>
            <ol className={styles.steps}>
              {STEPS.map((step) => (
                <li key={step.name}>
                  <p className={styles.stepName}>{step.name}</p>
                  <p className={styles.stepBody}>{step.body}</p>
                </li>
              ))}
            </ol>
            <SimulatedDisclaimer run={run} />
          </div>
        </div>

        <div className={`strip strip-lg strip-dark ${styles.closingBand}`}>
          <div className={`wrap ${styles.closing}`}>
            <p className={styles.closingHeadline}>{HEADLINE}</p>
            <Actions />
          </div>
        </div>
      </main>
    </>
  );
}
