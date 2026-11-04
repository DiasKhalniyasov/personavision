import { useId } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { CONNECT_CALL, CONNECT_PROMISE, CONNECTION_UNREADABLE } from '@/screens/settings/words';
import { useGithubConnection } from '@/screens/settings/connection';
import type { GithubConnectionState } from '@/screens/settings/connection';
import { newTestStep, paths } from '@/shell/paths';
import { ExampleTests } from '@/screens/newtest/ExampleTests';
import { useWizardDraft } from '../draft';
import styles from './path.module.css';

/**
 * `/new?step=path` — **what would you like us to do?**
 *
 * `#screen-newtest-paths` of `docs/design/prototype.html`: the two paths of `docs/FLOW.md`
 * section 11, side by side, and **the locked one is the point of the screen**. Path 2 is
 * shown and locked without a connected repository and is never hidden, because a user has to
 * be able to see what they do not have yet and why.
 *
 * A card is a **group with one real control**, not a button the size of the card. The
 * prototype draws the whole card as a `<button>`, and the locked one as a `<button>` that is
 * `aria-disabled` — which is a control that does nothing. What a reader can see is the same;
 * what they can press is one thing per card, and the locked card's one control is the way to
 * the connection screen rather than a dead press on the card itself.
 *
 * The connection state is read once, by `screens/settings/connection.ts`, and this screen
 * renders it. It decides nothing: whether the GitHub App exists at all is the platform's
 * answer, and locked is what every answer but a connection renders.
 *
 * Under the two cards sit **the five example tests** (#417), so a first visit can run one on
 * a real public site in one click instead of inventing a site, a feature, a task and a
 * criterion before seeing a single result. They are read from
 * `screens/newtest/templates.ts`, which the **No tests** state reads too, and this screen
 * spells none of them; choosing one fills this wizard's own draft and lands on the audience
 * step with everything editable.
 */

/** What path 1 delivers, in the prototype's three lines and its order. */
const DELIVERS = [
  'Up to 100 people attempt the feature, each recorded on video',
  'Completion, time, where they gave up, click and attention heatmaps',
  'Ranked recommendations, each citing the session and the second it happened',
] as const;

/** What path 2 adds, in the prototype's three lines and its order. */
const THEN_THE_CHANGE = [
  'One targeted change, written as a pull request on your repository',
  'The same audience and the same seeds on the before and the after, plus a holdout set',
  'The before/after verdict, on the platform and as a comment on the pull request',
] as const;

export function PathStep() {
  const connection = useGithubConnection();
  const { update } = useWizardDraft();

  return (
    <>
      <div className="pagehead">
        <h1>What would you like us to do?</h1>
      </div>
      <p className="lede">
        Both paths put a hundred simulated people through your site. The second one also writes the
        change.
      </p>

      <div className={styles.paths}>
        <TestMySite />
        <ImproveMySite connection={connection} />
      </div>

      {/* The draft is this wizard's own held copy, so the step the templates land on reads
          what was just written rather than a remembered copy of what it was before. */}
      <ExampleTests fill={update} />
    </>
  );
}

function TestMySite() {
  const nameId = useId();

  return (
    <div className={styles.pathCard} role="group" aria-labelledby={nameId} aria-current="true">
      <span className="microlabel">Path 1</span>
      <h2 id={nameId}>Test my site</h2>
      <p className={`lede ${styles.cardLede}`}>
        A URL and the feature you want tested, in your own words.
      </p>
      <ul className={styles.delivers}>
        {DELIVERS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Button size="sm" className={styles.control} asChild>
        {/* The next step of this wizard, which keeps the draft: the step is in the query. */}
        <Link to={newTestStep('audience')}>Start here</Link>
      </Button>
    </div>
  );
}

/**
 * Path 2, shown and locked.
 *
 * Locked is the answer to everything but a connection — the App not registered, no
 * repository, and a state that could not be read — because an unlocked path that cannot open
 * a pull request is the one mistake this card must not make. The lock's reason sits beside
 * it rather than in a tooltip, and is named by `aria-describedby` so it is read out with the
 * card rather than only seen. The card is `aria-disabled`; its one control states
 * `aria-disabled="false"`, because the lock is the card and not the way out of it.
 *
 * Connected, the card names the repository and **still starts nothing here**: the test that
 * uses it is path 2's own step.
 */
function ImproveMySite({ connection }: { connection: GithubConnectionState }) {
  const nameId = useId();
  const reasonId = useId();
  const locked = connection.status !== 'connected';

  return (
    <div
      className={styles.pathCard}
      role="group"
      aria-labelledby={nameId}
      {...(locked
        ? { 'data-locked': true, 'aria-disabled': true, 'aria-describedby': reasonId }
        : {})}
    >
      <span className="microlabel">Path 2</span>
      <h2 id={nameId}>{locked ? 'Improve my site · locked' : 'Improve my site'}</h2>
      <p className={`lede ${styles.cardLede}`}>Everything in path 1, and then the change itself.</p>
      <ul className={styles.delivers}>
        {THEN_THE_CHANGE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <span className={styles.lockbar} id={reasonId}>
        {connection.status === 'connected' ? (
          <span>
            Connected to <b>{connection.repository}</b>. The pull request goes there.
          </span>
        ) : connection.status === 'unreadable' ? (
          <span>{CONNECTION_UNREADABLE}</span>
        ) : (
          <span>
            <b>{CONNECT_CALL}</b>
            {CONNECT_PROMISE}
          </span>
        )}
      </span>
      <Button size="sm" variant="outline" className={styles.control} asChild>
        {/*
         * `aria-disabled` on a container is inherited by its focusable descendants, and a
         * descendant takes it back by stating `false`. Without that, the one control the
         * locked card exists for — the way to the connection screen — would be announced as
         * unavailable, which is the control that does nothing this card is written to avoid.
         */}
        <Link to={paths.githubSettings} aria-disabled="false">
          {connection.status === 'connected' ? 'GitHub connection' : 'Connect GitHub'}
        </Link>
      </Button>
    </div>
  );
}
