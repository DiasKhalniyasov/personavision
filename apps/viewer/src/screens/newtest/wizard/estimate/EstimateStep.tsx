import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { startSiteTest } from '@/screens/newtest/start';
import type { LaunchResult, RunEstimate } from '@/screens/newtest/start';
import { newTestStep, paths } from '@/shell/paths';
import { useAudiences } from '@/shell/useAudiences';
import { useSites } from '@/sites/useSites';
import { canLaunch, useWizardDraft } from '../draft';
import type { WizardDraft } from '../draft';
import type { CrumbStep } from '../steps';
import {
  agentsLine,
  capLabel,
  clockTime,
  costArithmetic,
  costFigure,
  costLine,
  hostOf,
  MODEL_API_DOC,
  observedLabel,
  storageArithmetic,
  timeArithmetic,
  timeFigure,
  timeLine,
} from './figures';
import { useEstimate } from './useEstimate';
import type { EstimateState } from './useEstimate';
import styles from './estimate.module.css';

/**
 * `/new?step=estimate` — **the last step before a hundred browsers open**.
 *
 * `#screen-newtest-estimate` of `docs/design/prototype.html`: the heading naming the run the
 * user is about to start, the three figures with the arithmetic under them, and the one
 * control on this wizard that starts anything.
 *
 * **No figure on this screen is computed here.** The agents, the time and the cost come from
 * `POST /runs/estimate` already multiplied up (#283); the participants are the audience's own
 * `size` as the audience store answers it; the concurrency the question is asked with is the
 * site's own cap as `GET /sites` states it (#267), and the one the screen *prints* is the one
 * the platform answered with — a deployment that holds itself below the cap is quoted at the
 * speed it will really run at (decision 118). `figures.ts` chooses units and words and
 * nothing else.
 *
 * **The button is the only thing here that starts anything**, and it refuses in two ways
 * that are not the same:
 *
 * - the draft's audience has not been reviewed, which is the wizard's own rule (`canLaunch`,
 *   stated once against the draft) and is said beside the button;
 * - a **cap** refused the launch, which is the platform's answer and is rendered in the
 *   platform's own words with the figures it sent — the cap, its limit, and when a launch
 *   like this one next passes. Every site is bound by the same three figures, so no refusal
 *   on this screen is ever about who controls the site (`docs/FLOW.md` section 13).
 *
 * A refusal leaves the step standing with everything the user chose still in it, and offers
 * what can be done instead. A launch goes to `/runs/:runId`, where the Running screen (#281)
 * takes over from the artifact the platform starts writing.
 */

/** A draft with everything a launch needs: the four fields, each already filled in. */
interface LaunchDraft {
  readonly site: NonNullable<WizardDraft['site']>;
  readonly feature: string;
  readonly audience: NonNullable<WizardDraft['audience']>;
  readonly goal: NonNullable<WizardDraft['goal']>;
}

/**
 * The draft as something that can be estimated and launched, or `null`.
 *
 * `reviewed` is deliberately **not** checked here: an audience the user has not seen yet is
 * a reason the button refuses, not a reason this step cannot be drawn — they are standing on
 * it to find out what the test will take.
 */
const launchable = (draft: WizardDraft): LaunchDraft | null =>
  draft.site === null ||
  draft.feature.trim() === '' ||
  draft.audience === null ||
  draft.goal === null
    ? null
    : {
        site: draft.site,
        feature: draft.feature,
        audience: draft.audience,
        goal: draft.goal,
      };

/**
 * The step a draft is missing something from, which is where the user is sent.
 *
 * The site, the feature and the audience are all collected on the Audience & feature step
 * (`#screen-newtest-feature`), and the goal on the one after it — so a draft that cannot be
 * launched has one step to go back to rather than an estimate of nothing.
 */
const stepThatIsMissing = (draft: WizardDraft): CrumbStep =>
  draft.site === null || draft.feature.trim() === '' || draft.audience === null
    ? 'audience'
    : 'goal';

/** Which step of the wizard owns a field the platform refused. */
const stepForField = (path: string): CrumbStep | null => {
  if (path === 'site' || path === 'siteId' || path === 'feature' || path === 'audienceId') {
    return 'audience';
  }
  return path === 'goal' || path.startsWith('goal.') ? 'goal' : null;
};

export function EstimateStep() {
  const { draft } = useWizardDraft();
  const ready = launchable(draft);

  // The two reads this step composes. Both are the app's own one place for the question
  // (`shell/useAudiences.ts`, `sites/useSites.ts`), so this screen adds no network of its own.
  const audiences = useAudiences();
  const sites = useSites();
  const record =
    audiences.status === 'ready' && ready !== null
      ? (audiences.audiences.find((candidate) => candidate.id === ready.audience.audienceId) ??
        null)
      : null;
  const site =
    sites.status === 'ready' && ready !== null
      ? (sites.sites.find((candidate) => candidate.id === ready.site.id) ?? null)
      : null;

  const participants = record?.audience.size ?? null;
  const siteCap = site?.caps.concurrentSessionsPerSite ?? null;
  const quoted = useEstimate(
    ready === null || participants === null || siteCap === null
      ? null
      : { participants, siteUrl: ready.site.url, concurrency: siteCap },
  );

  // A draft that cannot be launched is sent back to the step that is missing rather than
  // being quoted an estimate of nothing. The address is replaced, as every other correction
  // in this wizard is, so Back still leaves the wizard rather than bouncing here again.
  if (ready === null) return <Navigate to={newTestStep(stepThatIsMissing(draft))} replace />;

  const host = hostOf(ready.site.url);
  const reading = audiences.status === 'loading' || sites.status === 'loading';
  const state: EstimateState =
    participants !== null && siteCap !== null
      ? quoted
      : reading
        ? { status: 'loading' }
        : { status: 'unreadable', problem: whyNotQuoted(participants, siteCap) };

  return (
    <>
      <div className="pagehead">
        <h1>
          {participants === null
            ? `Launch on ${host}`
            : `${String(participants)} agents on ${host}`}
        </h1>
      </div>
      <p className="lede">
        {sentenceCase(ready.feature)}
        {record === null ? '' : `, for ${record.audience.name}`}. Here is what it will take.
      </p>

      {state.status === 'unreadable' ? (
        <p className={`notice info ${styles.made}`} role="status">
          {state.problem} The test can still be launched.
        </p>
      ) : (
        <>
          <Figures state={state} siteCap={siteCap} />
          <MadeOf state={state} />
        </>
      )}

      <LaunchFoot
        draft={ready}
        participants={participants}
        reviewed={canLaunch(draft)}
        waiting={state.status === 'loading'}
      />
    </>
  );
}

/** Why there is no estimate, naming the read that did not land rather than "something". */
const whyNotQuoted = (participants: number | null, siteCap: number | null): string =>
  participants === null
    ? 'The audience this test is for could not be read, so the estimate could not be quoted.'
    : siteCap === null
      ? 'This site’s limits could not be read, so the estimate could not be quoted.'
      : 'The estimate could not be quoted.';

/** The user's own sentence, with its first letter raised: the lede reads it back as one. */
const sentenceCase = (feature: string): string =>
  feature.charAt(0).toUpperCase() + feature.slice(1);

/* ---- the three figures -------------------------------------------------- */

/**
 * The `.estimate` triplet: **Agents**, **Time** and **Model cost**.
 *
 * The three cells are the same three cells in both states, because every key of the answer
 * is present whatever the figure's state (#283): the skeletons stand in the boxes the
 * figures arrive in, so nothing on the screen moves when they land.
 */
function Figures({
  state,
  siteCap,
}: {
  state: Exclude<EstimateState, { status: 'unreadable' }>;
  siteCap: number | null;
}) {
  const estimate = state.status === 'ready' ? state.estimate : null;

  return (
    // `aria-busy` rather than a label on each skeleton: a reader is told the row is being
    // worked out, and `aria-label` on an element with no role is an attribute axe forbids.
    <div className={styles.estimate} aria-busy={estimate === null}>
      <Cell
        name="agents"
        label="Agents"
        figure={estimate === null ? null : String(estimate.agents.participants)}
        line={
          estimate === null || siteCap === null
            ? null
            : agentsLine(estimate.agents.concurrency, siteCap)
        }
      />
      <Cell
        name="time"
        label="Time"
        figure={estimate === null ? null : timeFigure(estimate.time)}
        line={estimate === null ? null : timeLine(estimate.time)}
      />
      <Cell
        name="cost"
        label="Model cost"
        figure={estimate === null ? null : costFigure(estimate.cost)}
        line={estimate === null ? null : costLine(estimate.cost)}
      />
    </div>
  );
}

/** One figure under its label, with the line that says what it was computed from. */
function Cell({
  name,
  label,
  figure,
  line,
}: {
  name: string;
  label: string;
  figure: string | null;
  line: string | null;
}) {
  return (
    <div className={styles.cell} data-figure={name}>
      <span className={`microlabel ${styles.label}`}>{label}</span>
      {figure === null ? (
        <Skeleton className={styles.figureWaiting} data-waiting={name} />
      ) : (
        <b className={`num ${styles.figure}`}>{figure}</b>
      )}
      {line === null ? (
        <Skeleton className={styles.lineWaiting} data-waiting={`${name}-line`} />
      ) : (
        <span className={`faint ${styles.line}`}>{line}</span>
      )}
    </div>
  );
}

/* ---- what the estimate is made of -------------------------------------- */

/** The card under the figures: the time, the cost and the storage, each as its arithmetic. */
function MadeOf({ state }: { state: Exclude<EstimateState, { status: 'unreadable' }> }) {
  const estimate: RunEstimate | null = state.status === 'ready' ? state.estimate : null;

  return (
    <div className={`card ${styles.made}`}>
      <span className="microlabel">What the estimate is made of</span>
      <dl className={styles.kv}>
        <dt>Time</dt>
        <dd>
          {estimate === null ? (
            <Skeleton className={styles.lineWaiting} />
          ) : (
            timeArithmetic(estimate.time)
          )}
        </dd>
        <dt>Cost</dt>
        <dd>
          {estimate === null ? (
            <Skeleton className={styles.lineWaiting} />
          ) : (
            <Cited text={costArithmetic(estimate.cost)} cited={MODEL_API_DOC} />
          )}
        </dd>
        <dt>Storage</dt>
        <dd>
          {estimate === null ? (
            <Skeleton className={styles.lineWaiting} />
          ) : (
            storageArithmetic(estimate.storage)
          )}
        </dd>
      </dl>
    </div>
  );
}

/** A sentence that names a file of this repository, with the path set in the mono family. */
function Cited({ text, cited }: { text: string; cited: string }) {
  const at = text.indexOf(cited);
  if (at < 0) return <>{text}</>;

  return (
    <>
      {text.slice(0, at)}
      <span className="mono">{cited}</span>
      {text.slice(at + cited.length)}
    </>
  );
}

/* ---- the launch -------------------------------------------------------- */

/**
 * The `.formfoot`: the one control that starts a test, and the product's standing disclaimer
 * beside it.
 *
 * The button is disabled in two cases, and only one of them has a reason worth words: while
 * the audience has not been reviewed — the rule is the draft's (`canLaunch`) and the reason
 * is stated beside the button rather than in a tooltip, because a reason that only appears on
 * hover is invisible on a phone — and while the estimate is still being worked out, which the
 * skeletons above the button are already saying and `aria-busy` says to a reader who cannot
 * see them. An estimate that could not be read is **not** one of them: an unknown estimate is
 * not a reason to block a test.
 */
function LaunchFoot({
  draft,
  participants,
  reviewed,
  waiting,
}: {
  draft: LaunchDraft;
  participants: number | null;
  reviewed: boolean;
  waiting: boolean;
}) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<Exclude<LaunchResult, { ok: true }> | null>(null);
  const reasonId = useId();

  const launch = async (): Promise<void> => {
    setRefused(null);
    setStarting(true);
    const answer = await startSiteTest({
      site: draft.site.url,
      siteId: draft.site.id,
      feature: draft.feature,
      // The wizard spells a goal `{ task, success, author }` and the platform spells it
      // `{ task, successCriterion, lastWrittenBy }`: the screen maps it, and the contract's
      // spelling is the one that travels.
      goal: {
        task: draft.goal.task,
        successCriterion: draft.goal.success,
        lastWrittenBy: draft.goal.author,
      },
      audienceId: draft.audience.audienceId,
    });
    setStarting(false);
    if (answer.ok) {
      void navigate(paths.run(answer.runId));
      return;
    }
    setRefused(answer);
  };

  return (
    <>
      {refused === null ? null : <Refusal refused={refused} />}
      <div className={styles.formfoot}>
        <Button
          type="button"
          size="lg"
          disabled={!reviewed || starting || waiting}
          aria-busy={waiting}
          aria-describedby={reviewed ? undefined : reasonId}
          onClick={() => {
            void launch();
          }}
        >
          {starting
            ? 'Launching…'
            : participants === null
              ? 'Launch the test'
              : `Launch ${String(participants)} agents`}
        </Button>
        {reviewed ? null : (
          <span className={styles.why} id={reasonId}>
            You have not seen the audience this test would run with yet.{' '}
            <Link to={newTestStep('audience')}>Review it</Link> and the launch is yours.
          </span>
        )}
        <span className="faint">
          Every number this test produces is simulated, and none of it is a conversion-lift
          estimate.
        </span>
      </div>
    </>
  );
}

/**
 * A launch the platform did not start, in the platform's own words.
 *
 * A cap keeps its figures — the cap, its limit, what was asked for and when a launch like
 * this one next passes — and the retry time is drawn from the instant beside the sentence, so
 * the clock a reader is told to come back at is the clock on their wall (decision 111).
 */
function Refusal({ refused }: { refused: Exclude<LaunchResult, { ok: true }> }) {
  if (refused.kind === 'cap') {
    const { error, cap, limit, observed, retryAt } = refused.refusal;
    const retry = retryAt === null ? null : clockTime(retryAt);

    return (
      <div className={styles.refusal}>
        <p className="notice" role="alert">
          {error}
        </p>
        <p className={styles.refusalFigures}>
          <span>
            Cap · <b>{capLabel(cap)}</b>
          </span>
          <span className="num">Limit · {limit}</span>
          <span className="num">
            {observedLabel(cap)} · {observed}
          </span>
          {retry === null ? null : <span className="num">Next allowed · {retry} your time</span>}
        </p>
        <p className={styles.why}>
          {retry === null ? (
            <>
              Launch within the cap instead:{' '}
              <Link to={newTestStep('audience')}>lower the participant count</Link>, or split it
              across two tests. Nothing you chose has been lost.
            </>
          ) : (
            <>
              Wait until <b className="num">{retry}</b> and launch then. Nothing you chose has been
              lost.
            </>
          )}
        </p>
      </div>
    );
  }

  if (refused.kind === 'fields') {
    return (
      <div className={styles.refusal}>
        <p className="notice" role="alert">
          {refused.problem} Nothing you chose has been lost.
        </p>
        <ul className={styles.refused}>
          {refused.issues.map((issue) => {
            const step = stepForField(issue.path);
            return (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.message}
                {step === null ? null : (
                  <>
                    {' — '}
                    <Link to={newTestStep(step)}>go back to that step</Link>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className={styles.refusal}>
      <p className="notice" role="alert">
        {refused.problem} Nothing you chose has been lost.
      </p>
    </div>
  );
}
